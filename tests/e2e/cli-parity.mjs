/**
 * tests/e2e/cli-parity.mjs — the command line (cli/calibrate.mjs, ffmpeg + Node) against the
 * app (headless Chromium: WebCodecs, canvas, Web Workers) on the same session.
 *
 *   [SESSION=sample_session] [TARGET=100] [BASE=http://localhost:8080] [OUT=dir] \
 *   node tests/e2e/cli-parity.mjs
 *
 * 1. Frame numbering on B-frame videos: H.264 videos whose frames show their own number as a
 *    barcode (tests/cli/barcode-video.mjs; regular and fragmented MP4) are decoded by the app's
 *    OnDemandVideoDecoder.iterateFrames in the browser and by cli/ffmpeg-video.mjs; frame N must
 *    show N in both.
 * 2. Pixels: for frames of the session's own videos, the gray image the app's detect worker
 *    sees (VideoFrame -> canvas -> RGBA -> OpenCV's RGB2GRAY weights) vs ffmpeg's gray plane:
 *    mean / max abs difference, and frame N must match ffmpeg's frame N better than N±1, N±2.
 * 3. Pipeline: tests/e2e/real-session.mjs (the app, OUT_TOML / OUT_SESSION) and the CLI
 *    (--out / --session-out / --report) on SESSION with TARGET samples; compared:
 *    per-camera detection counts, corner ids and positions, intrinsics, camera positions,
 *    and the cross-view reprojection error of both calibrations on both detection sets
 *    (scored here with calib/triangulation.js, not with either run's own numbers).
 *
 * Without BASE, starts `python3 server.py` on a free port. Exit code 0 = within tolerances.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grayFrames, probeVideo } from '../../cli/ffmpeg-video.mjs';
import { makeBarcodeVideo, readBarcode } from '../cli/barcode-video.mjs';
import { DetectionStore } from '../../calib/detection-store.js';
import { computeCrossViewReprojection } from '../../calib/triangulation.js';
import { parseCalibrationToml } from '../../import-export/toml.js';
import { rodriguesToMatrix, cameraCenter, norm3, sub3, rotationAngle, percentile } from '../../calib/geometry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SESSION = path.resolve(process.env.SESSION || path.join(ROOT, 'sample_session'));
const TARGET = process.env.TARGET || '100';
const OUT = process.env.OUT || path.join(tmpdir(), `calibrat3-parity-${Date.now()}`);
const PIXEL_FRAMES = parseInt(process.env.PIXEL_FRAMES || '6', 10);   // per view
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); step(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// ---- server -----------------------------------------------------------------------
let server = null;
let BASE = process.env.BASE;
if (!BASE) {
    const port = await new Promise((resolve) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    server = spawn('python3', ['server.py', String(port)], { cwd: ROOT, stdio: 'ignore' });
    BASE = `http://localhost:${port}`;
    for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/index.html`); break; } catch (_) { await new Promise(r => setTimeout(r, 200)); } }
}
const run = (cmd, args, env, logFile) => new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => { writeFileSync(logFile, out); code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}; log: ${logFile}\n${out.split('\n').slice(-15).join('\n')}`)); });
});

const browser = await chromium.launch({ headless: !process.env.HEADFUL });
try {
    const page = await browser.newPage();
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof MP4Box !== 'undefined');

    // In the page: the gray image detect-worker.js computes from each wanted frame, as base64.
    const browserGray = (fileB64OrView, frames) => page.evaluate(async ({ src, frames }) => {
        const { OnDemandVideoDecoder } = await import('./loading/video.js');
        let dec, own = false;
        if (typeof src === 'number') dec = window.__calibrat3.state.views[src].decoder;
        else {
            const bytes = Uint8Array.from(atob(src), c => c.charCodeAt(0));
            dec = new OnDemandVideoDecoder({ name: 'probe' }); own = true;
            await dec.init(new File([bytes], 'clip.mp4', { type: 'video/mp4' }));
        }
        const w = dec.info.width, h = dec.info.height;
        const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true });
        const out = [];
        for await (const { frame, videoFrame } of dec.iterateFrames(frames, { maxPending: 2 })) {
            ctx.drawImage(videoFrame, 0, 0, w, h);
            videoFrame.close();
            const rgba = ctx.getImageData(0, 0, w, h).data;
            const g = new Uint8Array(w * h);
            // cv.cvtColor(COLOR_RGBA2GRAY): fixed-point 0.299 / 0.587 / 0.114 (<< 14)
            for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 4899 + rgba[j + 1] * 9617 + rgba[j + 2] * 1868 + 8192) >> 14;
            let s = '';
            for (let i = 0; i < g.length; i += 0x8000) s += String.fromCharCode.apply(null, g.subarray(i, i + 0x8000));
            out.push({ frame, b64: btoa(s) });
        }
        const info = { width: w, height: h, totalFrames: dec.info.totalFrames, hasBFrames: dec.info.hasBFrames };
        if (own) dec.close();
        return { info, frames: out };
    }, { src: fileB64OrView, frames });
    const fromB64 = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));

    // ---- 1. frame numbering on barcode videos --------------------------------------------
    for (const fragmented of [false, true]) {
        const n = 120;
        const file = await makeBarcodeVideo(path.join(OUT, `barcode-h264${fragmented ? '-frag' : ''}.mp4`), { n, codec: 'h264', fragmented });
        const all = Array.from({ length: n }, (_, i) => i);
        const b = await browserGray(readFileSync(file).toString('base64'), all);
        const info = await probeVideo(file);
        const ff = [];
        for await (const { frame, gray } of grayFrames(file, { width: info.width, height: info.height, totalFrames: info.totalFrames })) ff.push({ frame, code: readBarcode(gray, info.width) });
        const bCodes = b.frames.map(f => readBarcode(fromB64(f.b64), b.info.width));
        const label = `barcode H.264${fragmented ? ' fragmented' : ''} (B-frames: app ${b.info.hasBFrames}, cli ${info.hasBFrames})`;
        check(b.info.totalFrames === n && info.totalFrames === n, `${label}: ${b.info.totalFrames} frames in the app, ${info.totalFrames} in the CLI's table`);
        check(bCodes.length === n && bCodes.every((c, i) => c === i), `${label}: app frame N shows N for all ${bCodes.length} frames${bCodes.every((c, i) => c === i) ? '' : ` (first mismatch at ${bCodes.findIndex((c, i) => c !== i)})`}`);
        check(ff.length === n && ff.every((f, i) => f.code === i && f.frame === i), `${label}: CLI (ffmpeg) frame N shows N for all ${ff.length} frames`);
    }

    // ---- 2. pixels: session frames, app vs ffmpeg ----------------------------------------
    await page.setInputFiles('#folderInput', SESSION);
    await page.waitForFunction(() => window.__calibrat3.state.views.length >= 2 && window.__calibrat3.state.totalFrames > 0, null, { timeout: 600000 });
    const views = await page.evaluate(() => window.__calibrat3.state.views.map(v => ({ name: v.name, path: v.path, w: v.info.width, h: v.info.height, n: v.info.totalFrames, b: v.info.hasBFrames })));
    const pixelRows = [];
    for (const [v, view] of views.entries()) {
        const file = path.join(SESSION, view.path);
        const picks = Array.from({ length: PIXEL_FRAMES }, (_, k) => Math.min(view.n - 1, Math.round((k + 0.5) * view.n / PIXEL_FRAMES)));
        const b = await browserGray(v, picks);
        const near = new Set(picks.flatMap(f => [f - 2, f - 1, f, f + 1, f + 2]).filter(f => f >= 0 && f < view.n));
        const ff = new Map();
        for await (const { frame, gray } of grayFrames(file, { width: view.w, height: view.h, totalFrames: view.n, wanted: near })) ff.set(frame, gray);
        for (const { frame, b64 } of b.frames) {
            const g = fromB64(b64);
            const mad = (x) => { let s = 0, m = 0, big = 0; for (let i = 0; i < g.length; i++) { const d = Math.abs(g[i] - x[i]); s += d; if (d > m) m = d; if (d > 2) big++; } return { mean: s / g.length, max: m, over2: big / g.length }; };
            const same = mad(ff.get(frame));
            const others = [frame - 2, frame - 1, frame + 1, frame + 2].filter(f => ff.has(f)).map(f => ({ f, ...mad(ff.get(f)) }));
            const nearest = others.length ? Math.min(...others.map(o => o.mean)) : Infinity;
            pixelRows.push({ view: view.name, frame, ...same, nearest });
        }
    }
    const meanMad = pixelRows.reduce((a, r) => a + r.mean, 0) / pixelRows.length;
    step(`pixels, app gray vs ffmpeg gray on ${pixelRows.length} session frames: mean |Δ| ${meanMad.toFixed(3)} grey levels (per frame ${Math.min(...pixelRows.map(r => r.mean)).toFixed(3)}–${Math.max(...pixelRows.map(r => r.mean)).toFixed(3)}), max |Δ| ${Math.max(...pixelRows.map(r => r.max))}, pixels off by > 2: ${(100 * pixelRows.reduce((a, r) => a + r.over2, 0) / pixelRows.length).toFixed(3)} %`);
    const orderOk = pixelRows.every(r => r.mean < r.nearest);
    check(orderOk, `pixels: every checked frame matches ffmpeg's same frame number best (worst margin: same ${pixelRows.map(r => r.mean).reduce((a, b) => Math.max(a, b)).toFixed(2)} vs nearest other ${Math.min(...pixelRows.map(r => r.nearest)).toFixed(2)})`);
    check(meanMad < 3, `pixels: mean |Δ| ${meanMad.toFixed(3)} < 3 grey levels`);
    await page.close();
} finally {
    await browser.close();
}

// ---- 3. full pipeline: app vs CLI --------------------------------------------------------
const app = { toml: path.join(OUT, 'app.toml'), session: path.join(OUT, 'app.calibrat3.json'), log: path.join(OUT, 'app.log') };
const cli = { toml: path.join(OUT, 'cli.toml'), session: path.join(OUT, 'cli.calibrat3.json'), report: path.join(OUT, 'cli-report.json'), log: path.join(OUT, 'cli.log') };
try {
    let ta = Date.now();
    const appOut = await run(process.execPath, ['tests/e2e/real-session.mjs'], { BASE, SESSION, TARGET, PLAY_SECONDS: '0', OUT_TOML: app.toml, OUT_SESSION: app.session }, app.log);
    step(`app (real-session.mjs) in ${((Date.now() - ta) / 1000).toFixed(0)} s`);
    for (const line of appOut.split('\n').filter(l => /detection:|intrinsics in|extrinsics \+ reprojection|SBA in/.test(l))) console.log(`    app: ${line.replace(/^\[[^\]]*\] /, '').slice(0, 260)}`);
    ta = Date.now();
    await run(process.execPath, ['cli/calibrate.mjs', SESSION, '--target', TARGET, '--out', cli.toml, '--session-out', cli.session, '--report', cli.report], {}, cli.log);
    step(`CLI in ${((Date.now() - ta) / 1000).toFixed(0)} s`);
} finally {
    if (server) server.kill();
}

const loadSession = (f) => { const s = JSON.parse(readFileSync(f, 'utf8')); return { raw: s, store: DetectionStore.fromJSON(s.detections) }; };
const A = loadSession(app.session), C = loadSession(cli.session);
const names = A.raw.session.views.map(v => v.name);
check(names.join() === C.raw.session.views.map(v => v.name).join(), `same views: ${names.join(', ')}`);
check(JSON.stringify(A.raw.sampledFrames) === JSON.stringify(C.raw.sampledFrames), `same sampled frames (${A.raw.sampledFrames.length}, 0-based ${A.raw.sampledFrames[0]}..${A.raw.sampledFrames[A.raw.sampledFrames.length - 1]})`);

// detections
const det = names.map((name, v) => {
    let framesA = 0, framesC = 0, cornersA = 0, cornersC = 0, both = 0, sameIds = 0, idsA = 0, idsC = 0, idsCommon = 0;
    const dists = [];
    for (const f of A.raw.sampledFrames) {
        const a = A.store.get(f, v), c = C.store.get(f, v);
        const na = a ? a.ids.length : 0, nc = c ? c.ids.length : 0;
        if (na) framesA++; if (nc) framesC++;
        cornersA += na; cornersC += nc;
        if (!na || !nc) continue;
        both++;
        const ma = new Map(); for (let i = 0; i < na; i++) ma.set(a.ids[i], i);
        let common = 0;
        for (let k = 0; k < nc; k++) {
            const i = ma.get(c.ids[k]);
            if (i === undefined) continue;
            common++;
            dists.push(Math.hypot(a.corners[2 * i] - c.corners[2 * k], a.corners[2 * i + 1] - c.corners[2 * k + 1]));
        }
        idsA += na; idsC += nc; idsCommon += common;
        if (common === na && common === nc) sameIds++;
    }
    dists.sort((x, y) => x - y);
    return { name, framesA, framesC, cornersA, cornersC, both, sameIds, idsA, idsC, idsCommon, dMed: percentile(dists, 0.5), dP95: percentile(dists, 0.95), dP99: percentile(dists, 0.99), dMax: dists[dists.length - 1] ?? NaN, n: dists.length };
});
console.log('\nDetections (app = browser, cli = ffmpeg), per camera:');
console.log('  camera      frames app/cli   corners app/cli   same id set   corner |Δ| px: median   p95     p99     max');
for (const d of det) console.log(`  ${d.name.padEnd(10)}  ${String(d.framesA).padStart(5)}/${String(d.framesC).padEnd(5)}     ${String(d.cornersA).padStart(6)}/${String(d.cornersC).padEnd(6)}    ${d.sameIds}/${d.both} frames      ${d.dMed.toFixed(4)}  ${d.dP95.toFixed(4)}  ${d.dP99.toFixed(4)}  ${d.dMax.toFixed(3)}`);
const totA = det.reduce((x, d) => x + d.cornersA, 0), totC = det.reduce((x, d) => x + d.cornersC, 0);
check(det.every(d => Math.abs(d.framesA - d.framesC) <= Math.max(1, 0.01 * d.framesA)), 'detections: frames with a board per camera agree within 1 %');
check(Math.abs(totA - totC) <= 0.01 * totA, `detections: total corners ${totA} (app) vs ${totC} (cli), within 1 %`);
check(det.every(d => d.dMed < 0.05), `detections: median corner difference < 0.05 px on every camera (max median ${Math.max(...det.map(d => d.dMed)).toFixed(4)})`);

// calibrations
const tomlA = parseCalibrationToml(readFileSync(app.toml, 'utf8')), tomlC = parseCalibrationToml(readFileSync(cli.toml, 'utf8'));
const byName = (t) => new Map(t.cameras.map(c => [c.name, c]));
const ca = byName(tomlA), cc = byName(tomlC);
console.log('\nCalibration, per camera (app vs cli):');
console.log('  camera      fx app / cli          cx app / cli        k1 app / cli          centre |Δ| mm   rotation Δ°');
const centreD = [];
for (const n of names) {
    const a = ca.get(n), c = cc.get(n);
    if (!a || !c) { console.log(`  ${n.padEnd(10)}  missing in ${a ? 'cli' : 'app'}`); failures.push(`${n} missing`); continue; }
    const Ra = rodriguesToMatrix(a.rvec), Rc = rodriguesToMatrix(c.rvec);
    const d = norm3(sub3(cameraCenter(Ra, a.tvec), cameraCenter(Rc, c.tvec)));
    centreD.push(d);
    console.log(`  ${n.padEnd(10)}  ${a.K[0][0].toFixed(2).padStart(8)} / ${c.K[0][0].toFixed(2).padEnd(8)}   ${a.K[0][2].toFixed(2).padStart(7)} / ${c.K[0][2].toFixed(2).padEnd(7)}   ${a.dist[0].toFixed(5).padStart(8)} / ${c.dist[0].toFixed(5).padEnd(8)}   ${d.toFixed(3).padStart(8)}        ${(rotationAngle(Ra, Rc) * 180 / Math.PI).toFixed(4)}`);
}
const spread = Math.max(...names.map(n => ca.get(n)).filter(Boolean).map(c => norm3(cameraCenter(rodriguesToMatrix(c.rvec), c.tvec))));
check(Math.max(...centreD) <= Math.max(2, 0.01 * spread), `camera positions: max |Δ| ${Math.max(...centreD).toFixed(3)} (units of the board) <= max(2, 1 % of the rig size ${spread.toFixed(0)})`);

// reprojection, scored here on both detection sets
const asCalib = (t) => {
    const m = byName(t);
    return {
        intr: names.map(n => m.get(n) ? { K: m.get(n).K, dist: m.get(n).dist } : null),
        extr: names.map(n => m.get(n) ? { R: rodriguesToMatrix(m.get(n).rvec), tvec: m.get(n).tvec } : null),
    };
};
const score = async (t, store) => { const k = asCalib(t); return (await computeCrossViewReprojection(null, store, k.intr, k.extr, { minCorners: 4, minViews: 2 })).summary.overall; };
const grid = {
    appOnApp: await score(tomlA, A.store), cliOnCli: await score(tomlC, C.store),
    appOnCli: await score(tomlA, C.store), cliOnApp: await score(tomlC, A.store),
};
console.log('\nCross-view reprojection error, scored with calib/triangulation.js (median / mean / p95 px):');
console.log(`                       on app detections         on cli detections`);
const fmt = (s) => `${s.median.toFixed(3)} / ${s.mean.toFixed(3)} / ${s.p95.toFixed(2)}`.padEnd(26);
console.log(`  app calibration      ${fmt(grid.appOnApp)}${fmt(grid.appOnCli)}`);
console.log(`  cli calibration      ${fmt(grid.cliOnApp)}${fmt(grid.cliOnCli)}`);
const rel = (x, y) => Math.abs(x - y) / Math.max(1e-9, Math.max(x, y));
check(rel(grid.appOnApp.median, grid.cliOnCli.median) < 0.1 || Math.abs(grid.appOnApp.median - grid.cliOnCli.median) < 0.02,
    `reprojection: each run on its own detections, median ${grid.appOnApp.median.toFixed(3)} (app) vs ${grid.cliOnCli.median.toFixed(3)} (cli) px, within 10 % or 0.02 px`);
check(rel(grid.appOnApp.median, grid.cliOnApp.median) < 0.1 || Math.abs(grid.appOnApp.median - grid.cliOnApp.median) < 0.02,
    `reprojection: both calibrations on the app's detections, median ${grid.appOnApp.median.toFixed(3)} vs ${grid.cliOnApp.median.toFixed(3)} px, within 10 % or 0.02 px`);

const rep = JSON.parse(readFileSync(cli.report, 'utf8'));
console.log(`\nCLI timings: ${Object.entries(rep.timings).map(([k, v]) => `${k.replace(/Ms$/, '')} ${(v / 1000).toFixed(1)} s`).join(', ')}`);
writeFileSync(path.join(OUT, 'parity.json'), JSON.stringify({ session: SESSION, target: TARGET, detections: det, centreDelta: Object.fromEntries(names.map((n, i) => [n, centreD[i]])), reprojection: grid, failures }, null, 1));
console.log(`\noutputs in ${OUT}`);
if (failures.length) { console.log(`\nFAILED (${failures.length}):\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('\nPASS');
