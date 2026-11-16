#!/usr/bin/env node
/**
 * cli/calibrate.mjs — calibrat3 without a browser: the app's pipeline in plain Node, with
 * ffmpeg decoding the videos (so HEVC works on machines whose browser cannot decode it).
 *
 *   node cli/calibrate.mjs <session-folder> --out calibration.toml [--target 600] [...]
 *
 * Same session folder the app opens (one video per camera + board.toml; flat or
 * anipose-style nested layout — loading/folder-loader.js), same stages and defaults as the
 * app's buttons, same code: the app's worker scripts (loading/detect-worker.js,
 * loading/calib-worker.js) and pool clients run unchanged in worker_threads
 * (cli/web-worker.mjs), bundle adjustment is calib/refine.js, the TOML is
 * import-export/toml.js. Only the frames come from elsewhere: ffmpeg's gray (luma) plane
 * instead of a WebCodecs VideoFrame drawn on a canvas (cli/ffmpeg-video.mjs).
 *
 * Frame numbers are 0-based everywhere (arguments, logs, the session/report files) and
 * are the app's: frame N is the N-th picture in presentation order.
 */
import { parseArgs } from 'node:util';
import { readdir, writeFile } from 'node:fs/promises';
import { openAsBlob, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installWebWorker } from './web-worker.mjs';
import { probeVideo, grayFrames, grayFrameAt, ffmpegVersion } from './ffmpeg-video.mjs';
import { DetectorPool } from '../loading/detect-pool.js';
import { CalibWorker } from '../loading/calib-client.js';
import { buildSession, VIDEO_EXT } from '../loading/folder-loader.js';
import { DetectionStore } from '../calib/detection-store.js';
import { normalizeBoard, DEFAULT_BOARD, legacyPatternDiffers, numCorners, DICT_NAMES } from '../calib/board.js';
import { stridedFrames } from '../calib/frame-selection.js';
import { distortionFlags, intrinsicsSamples } from '../calib/intrinsics.js';
import { boardMotionScores, framesAboveMotion, motionSummary } from '../calib/motion.js';
import { refineCalibration, sbaResultRecord, reevaluatePerFrame, DEFAULT_REFINE_OPTIONS, fmtMs } from '../calib/refine.js';
import { cameraCenter, rodriguesToMatrix } from '../calib/geometry.js';
import { calibrationTomlFromResults } from '../import-export/toml.js';
import { serializeSession } from '../import-export/session-save.js';

const HELP = `calibrat3 command line — multi-camera ChArUco calibration without a browser.

Usage:
  node cli/calibrate.mjs <session-folder> --out calibration.toml [options]

The session folder is what the app opens: one video per camera (flat: <cam>.mp4, or
anipose-style <cam>/calibration_images/*.mp4) and a board.toml. Videos are decoded by
ffmpeg (any codec it supports, e.g. HEVC). Frame numbers are 0-based.

Output:
  -o, --out FILE              calibration.toml (sleap-anipose format, as the app's Export) [required]
  --session-out FILE          also save a session (.calibrat3.json) the app can load
                              (open the same folder in the app, then "Load session")
  --report FILE               JSON summary: detections, intrinsics, reprojection errors, timings

Sampling and detection (stage 2):
  --target N                  frames to sample, evenly strided over the video (default 100)
  --all-frames                detect on every frame
  --fast-markers              search markers at half resolution on frames >= 1400 px (off)
  --board-x N --board-y N     board squares (default: board.toml, else 8 x 11)
  --square L --marker L       square / marker side, any unit (default: board.toml, else 24 / 18.75)
  --dict NAME                 ArUco dictionary, e.g. DICT_4X4_1000
  --board-pattern P           auto | new | legacy (OpenCV < 4.6 layout). Default: board.toml's
                              legacy_pattern when there is a board.toml, else auto (probe both)

Intrinsics (stage 3):
  --min-corners N             min corners per frame (default 6)
  --max-calib-frames N        frames per camera for calibrateCamera, 0 = all (default 50)
  --dist-model M              k1 | k1k2 | k1k2k3 | full (default k1)

Extrinsics and bundle adjustment (stage 4):
  --reference CAM             reference camera, name or 0-based index (default 0)
  --min-covisible N           min covisible corners for a camera pair (default 10)
  --max-pair-frames N         frames per camera pair for the initial poses, 0 = all (default 300)
  --max-motion PX             exclude frames whose board moves faster (px/frame), 0 = off (default 0)
  --no-sba                    stop after the initial extrinsics
  --sba-model M               fxfy-c-k1-k2 | f-k1-k2 | f-c-k1 | f-k1 | wasm (default fxfy-c-k1-k2)
  --sba-fixed-intrinsics      refine extrinsics and points only
  --sba-policy P              aggressive | conservative (default aggressive)
  --sba-rounds N              rejection rounds (default 6)
  --sba-threshold PX          last round's per-point error threshold, 0 = keep all (default 1)
  --sba-start PX              first round's threshold, 0 = automatic (default 0)
  --sba-max-points N          points sent to the solver, 0 = all (default 20000)
  --sba-max-iterations N      per round (default 100)
  --sba-loss L                none | huber | cauchy (default none)
  --sba-board-rigidity R      anipose | strong | off (default anipose)
  --sba-principal P           centre | keep (default centre)

Resources:
  --workers N                 detection threads (default: CPUs - 1, max 32; CPUs = SLURM_CPUS_PER_TASK
                              or the CPUs this process may use)
  --calib-workers N           calibration threads (default: min(cameras, CPUs - 1))
  --ffmpeg PATH               ffmpeg binary (default: ffmpeg on PATH; ffprobe is taken from the same place)
  --ffmpeg-threads N          decoder threads per video, 0 = ffmpeg's choice (default: CPUs / cameras, 1..4)

  -v, --verbose               debug-level log lines
  -q, --quiet                 warnings and errors only
  -h, --help
`;

const OPTIONS = {
    out: { type: 'string', short: 'o' }, 'session-out': { type: 'string' }, report: { type: 'string' },
    target: { type: 'string' }, 'all-frames': { type: 'boolean' }, 'fast-markers': { type: 'boolean' },
    'board-x': { type: 'string' }, 'board-y': { type: 'string' }, square: { type: 'string' }, marker: { type: 'string' },
    dict: { type: 'string' }, 'board-pattern': { type: 'string' },
    'min-corners': { type: 'string' }, 'max-calib-frames': { type: 'string' }, 'dist-model': { type: 'string' },
    reference: { type: 'string' }, 'min-covisible': { type: 'string' }, 'max-pair-frames': { type: 'string' }, 'max-motion': { type: 'string' },
    'no-sba': { type: 'boolean' }, 'sba-model': { type: 'string' }, 'sba-fixed-intrinsics': { type: 'boolean' }, 'sba-policy': { type: 'string' },
    'sba-rounds': { type: 'string' }, 'sba-threshold': { type: 'string' }, 'sba-start': { type: 'string' },
    'sba-max-points': { type: 'string' }, 'sba-max-iterations': { type: 'string' }, 'sba-loss': { type: 'string' },
    'sba-board-rigidity': { type: 'string' }, 'sba-principal': { type: 'string' },
    workers: { type: 'string' }, 'calib-workers': { type: 'string' }, ffmpeg: { type: 'string' }, 'ffmpeg-threads': { type: 'string' },
    verbose: { type: 'boolean', short: 'v' }, quiet: { type: 'boolean', short: 'q' }, help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

// ---- logging ------------------------------------------------------------------

const T0 = performance.now();
let VERBOSE = false, QUIET = false;
function log(msg, level = 'info') {
    if (level === 'debug' && !VERBOSE) return;
    if (QUIET && level !== 'warn' && level !== 'error') return;
    const tag = level === 'warn' ? 'WARN ' : level === 'error' ? 'ERROR ' : '';
    process.stderr.write(`[${((performance.now() - T0) / 1000).toFixed(1).padStart(6)}s] ${tag}${msg}\n`);
}

// ---- arguments ------------------------------------------------------------------

function intArg(v, name, def, min = 0) {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer >= ${min} (got ${v})`);
    return n;
}
function numArg(v, name, def, min = 0) {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) throw new UsageError(`--${name} must be a number >= ${min} (got ${v})`);
    return n;
}
function choiceArg(v, name, def, choices) {
    if (v === undefined) return def;
    if (!choices.includes(v)) throw new UsageError(`--${name} must be one of ${choices.join(', ')} (got ${v})`);
    return v;
}

function availableCpus() {
    const slurm = parseInt(process.env.SLURM_CPUS_PER_TASK || '', 10);
    if (slurm > 0) return slurm;
    return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

// ---- session ------------------------------------------------------------------

/** Like loading/folder-loader.js scanDirectoryHandle: videos and board.toml up to depth 3, no dot dirs. */
async function scanFolder(root, maxDepth = 3) {
    const entries = [];
    async function walk(dir, prefix, depth) {
        const items = await readdir(dir, { withFileTypes: true });
        for (const it of items) {
            const p = prefix ? `${prefix}/${it.name}` : it.name;
            const full = path.join(dir, it.name);
            if (it.isFile() || (it.isSymbolicLink() && statSync(full).isFile())) {
                if (VIDEO_EXT.test(it.name) || /^board\.toml$/i.test(it.name)) entries.push({ path: p, file: await openAsBlob(full), full });
            } else if ((it.isDirectory() || (it.isSymbolicLink() && statSync(full).isDirectory())) && depth < maxDepth && !it.name.startsWith('.')) {
                await walk(full, p, depth + 1);
            }
        }
    }
    await walk(root, '', 0);
    const session = await buildSession(entries);
    const fullOf = new Map(entries.map(e => [e.path, e.full]));
    for (const v of session.views) v.file = fullOf.get(v.path);
    session.rootName = path.basename(path.resolve(root));
    return session;
}

// ---- main -----------------------------------------------------------------------

async function main(argv) {
    let parsed;
    try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
    catch (e) { throw new UsageError(e.message); }
    const a = parsed.values;
    if (a.help) { process.stdout.write(HELP); return 0; }
    VERBOSE = !!a.verbose; QUIET = !!a.quiet && !a.verbose;
    if (parsed.positionals.length !== 1) throw new UsageError('give exactly one session folder');
    if (!a.out) throw new UsageError('--out calibration.toml is required');
    const root = parsed.positionals[0];
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`not a folder: ${root}`);

    const cpus = availableCpus();
    const ffmpeg = a.ffmpeg || 'ffmpeg';
    const opts = {
        target: intArg(a.target, 'target', 100, 1),
        allFrames: !!a['all-frames'],
        fastMarkers: !!a['fast-markers'],
        minCorners: intArg(a['min-corners'], 'min-corners', 6, 4),
        maxCalibFrames: intArg(a['max-calib-frames'], 'max-calib-frames', 50, 0),
        distModel: choiceArg(a['dist-model'], 'dist-model', 'k1', ['k1', 'k1k2', 'k1k2k3', 'full']),
        minCovisible: intArg(a['min-covisible'], 'min-covisible', 10, 4),
        maxPairFrames: intArg(a['max-pair-frames'], 'max-pair-frames', 300, 0),
        maxMotion: numArg(a['max-motion'], 'max-motion', 0, 0),
        sba: !a['no-sba'],
    };
    const refine = {
        ...DEFAULT_REFINE_OPTIONS,
        intrinsicsModel: choiceArg(a['sba-model'], 'sba-model', DEFAULT_REFINE_OPTIONS.intrinsicsModel, ['fxfy-c-k1-k2', 'f-k1-k2', 'f-c-k1', 'f-k1', 'wasm']),
        optimizeIntrinsics: !a['sba-fixed-intrinsics'],
        policy: choiceArg(a['sba-policy'], 'sba-policy', DEFAULT_REFINE_OPTIONS.policy, ['aggressive', 'conservative']),
        rounds: intArg(a['sba-rounds'], 'sba-rounds', DEFAULT_REFINE_OPTIONS.rounds, 1),
        finalThreshold: numArg(a['sba-threshold'], 'sba-threshold', DEFAULT_REFINE_OPTIONS.finalThreshold),
        startThreshold: numArg(a['sba-start'], 'sba-start', DEFAULT_REFINE_OPTIONS.startThreshold),
        maxPoints: intArg(a['sba-max-points'], 'sba-max-points', DEFAULT_REFINE_OPTIONS.maxPoints),
        maxIterations: intArg(a['sba-max-iterations'], 'sba-max-iterations', DEFAULT_REFINE_OPTIONS.maxIterations, 1),
        robustLoss: choiceArg(a['sba-loss'], 'sba-loss', DEFAULT_REFINE_OPTIONS.robustLoss, ['none', 'huber', 'cauchy']),
        boardRigidity: choiceArg(a['sba-board-rigidity'], 'sba-board-rigidity', DEFAULT_REFINE_OPTIONS.boardRigidity, ['anipose', 'strong', 'off']),
        principal: choiceArg(a['sba-principal'], 'sba-principal', DEFAULT_REFINE_OPTIONS.principal, ['centre', 'keep']),
    };
    const patternArg = choiceArg(a['board-pattern'], 'board-pattern', undefined, ['auto', 'new', 'legacy']);
    if (a.dict && !DICT_NAMES.includes(a.dict)) throw new UsageError(`--dict must be one of ${DICT_NAMES.join(', ')}`);
    const timings = {};
    const report = { generator: 'calibrat3-cli', created: new Date().toISOString(), options: { ...opts, sba: opts.sba ? refine : false }, timings };

    // ---- stage 1: session ----------------------------------------------------------
    const ff = ffmpegVersion(ffmpeg);
    log(`${ff.line}; ${cpus} CPU(s)${process.env.SLURM_CPUS_PER_TASK ? ' (SLURM_CPUS_PER_TASK)' : ''}; Node ${process.versions.node}`);
    const session = await scanFolder(root);
    for (const n of session.notes) log(n, 'warn');
    if (session.views.length < 2) throw new Error(`found ${session.views.length} video(s) in ${root} — need one per camera, at least two (layout: ${session.layout})`);
    log(`Opening session "${session.rootName}" — ${session.views.length} view(s), layout=${session.layout}`);
    const tProbe = performance.now();
    const views = await Promise.all(session.views.map(async (v) => {
        const info = await probeVideo(v.file, { ffmpeg });
        return { name: v.name, path: v.path, file: v.file, info };
    }));
    for (const v of views) {
        const i = v.info;
        log(`${v.name}: ${i.width}x${i.height}, ${i.totalFrames} frames @ ${i.fps.toFixed(2)} fps, ${i.keyframes} keyframes, codec ${i.codec}${i.hasBFrames ? ', B-frames present' : ''}${i.fragmented ? ', fragmented MP4' : ''} — ${v.path}`);
        if (i.source !== 'mp4box') log(`${v.name}: not an MP4/MOV — the app cannot open it; frame count from ffprobe`, 'warn');
    }
    const counts = views.map(v => v.info.totalFrames);
    const totalFrames = Math.min(...counts);
    if (Math.max(...counts) !== totalFrames) log(`Frame counts differ across views (${counts.join(', ')}); using the minimum ${totalFrames}`, 'warn');
    const fps = views[0].info.fps;
    timings.probeMs = performance.now() - tProbe;

    let board;
    {
        const fromToml = session.board || null;
        if (!fromToml) log(`No board.toml in ${root}; using ${a['board-x'] || a['board-y'] || a.square || a.marker || a.dict ? 'the command-line board' : `the default board ${DEFAULT_BOARD.boardX}x${DEFAULT_BOARD.boardY} ${DEFAULT_BOARD.dictName}, square ${DEFAULT_BOARD.squareLength}, marker ${DEFAULT_BOARD.markerLength}`}`, 'warn');
        else log(`Board from ${session.boardPath}`);
        const b = { ...DEFAULT_BOARD, ...(fromToml || {}) };
        if (a['board-x']) b.boardX = intArg(a['board-x'], 'board-x', 8, 3);
        if (a['board-y']) b.boardY = intArg(a['board-y'], 'board-y', 11, 3);
        if (a.square) b.squareLength = numArg(a.square, 'square', 24);
        if (a.marker) b.markerLength = numArg(a.marker, 'marker', 18.75);
        if (a.dict) b.dictName = a.dict;
        // The app: board.toml sets the pattern select explicitly; without one it stays on 'auto'.
        const pattern = patternArg || (fromToml && fromToml.legacyPattern !== undefined ? (fromToml.legacyPattern ? 'legacy' : 'new') : 'auto');
        b.legacyPattern = pattern === 'legacy';
        board = normalizeBoard(b);
        board.__pattern = pattern;
    }
    const pattern = board.__pattern; delete board.__pattern;

    const { frames, stride } = opts.allFrames ? { frames: Array.from({ length: totalFrames }, (_, i) => i), stride: 1 } : stridedFrames(totalFrames, opts.target);
    const nViews = views.length;
    const names = views.map(v => v.name);

    // ---- stage 2: detection ----------------------------------------------------------
    installWebWorker();
    const workers = intArg(a.workers, 'workers', Math.max(1, Math.min(32, cpus - 1)), 1);
    const ffThreads = intArg(a['ffmpeg-threads'], 'ffmpeg-threads', Math.max(1, Math.min(4, Math.floor(cpus / nViews))), 0);
    const pool = new DetectorPool({ size: workers, log });
    const calibWorkers = intArg(a['calib-workers'], 'calib-workers', Math.max(1, Math.min(nViews, cpus - 1)), 1);
    const calib = new CalibWorker({ size: calibWorkers, log });
    try {
        await pool.init();
        if (pattern === 'auto') board = await probePattern(board, views, pool, { ffmpeg, fastMarkers: opts.fastMarkers });
        await pool.configure(board, { fastMarkers: opts.fastMarkers });
        log(`Board ${board.boardX}x${board.boardY} ${board.dictName}, square ${board.squareLength}, marker ${board.markerLength}${board.legacyPattern ? ', legacy (< 4.6) pattern' : ''}: ${numCorners(board)} corners`);

        const store = new DetectionStore(names);
        for (const f of frames) store.touch(f);
        const totalJobs = frames.length * nViews;
        // The app caps each view at 2 frames in flight; with few cameras and many threads that
        // leaves threads idle, so allow enough to keep every thread busy (results do not depend on it).
        const maxInflight = Math.max(2, Math.ceil(workers / nViews) + 1);
        log(`Batch detection: ${frames.length} frames (stride ${stride}${opts.allFrames ? ', every frame' : `, target ${opts.target}`}) × ${nViews} views = ${totalJobs} detections, ${workers} detect thread(s), ffmpeg ${ffThreads || 'auto'} thread(s) per video`);
        const tDet = performance.now();
        let done = 0, failed = 0, lastReport = performance.now();
        const decoded = new Array(nViews).fill(0);
        const progress = () => {
            const now = performance.now();
            if (now - lastReport < 10000) return;
            lastReport = now;
            const rate = done / ((now - tDet) / 1000);
            log(`  detection ${done}/${totalJobs} (${(100 * done / totalJobs).toFixed(0)}%) · ${rate.toFixed(1)}/s · ETA ${fmtMs((totalJobs - done) / Math.max(1e-6, rate) * 1000)} · decoded ${decoded.reduce((x, y) => x + y, 0)} frames`);
        };
        await Promise.all(views.map(async (view, v) => {
            const inflight = new Set();
            const stats = {};
            const wanted = frames.filter(f => f < view.info.totalFrames);
            for await (const { frame, gray } of grayFrames(view.file, { width: view.info.width, height: view.info.height, decodedWidth: view.info.decodedWidth, decodedHeight: view.info.decodedHeight, totalFrames: view.info.totalFrames, wanted, ffmpeg, threads: ffThreads, stats })) {
                decoded[v] = stats.decoded;
                while (inflight.size >= maxInflight) await Promise.race(inflight);
                const job = pool.detect({ frame, view: v, gray, width: view.info.width, height: view.info.height }).then(
                    (res) => store.set(frame, v, res),
                    (err) => { failed++; store.set(frame, v, null); log(`${view.name} frame ${frame}: detection error: ${err.message}`, 'debug'); },
                ).finally(() => { inflight.delete(job); done++; progress(); });
                inflight.add(job);
            }
            decoded[v] = stats.decoded;
            await Promise.all(inflight);
            log(`${view.name}: decoded ${stats.decoded} frames for ${wanted.length} samples`, 'debug');
        }));
        timings.detectionMs = performance.now() - tDet;
        pool.terminate();
        const summary = store.summary(opts.minCorners);
        const avgMs = pool.stats.detections ? pool.stats.totalMs / pool.stats.detections : 0;
        log(`Batch detection complete in ${fmtMs(timings.detectionMs)}: ${done} detections, ${failed} errors, ` +
            `${(done / (timings.detectionMs / 1000)).toFixed(1)} det/s wall, ${avgMs.toFixed(0)} ms/detection in-worker; ` +
            `${summary.framesWithAnyDetection}/${frames.length} frames with a board, ${summary.framesAllViewsGood} good in all views; ` +
            `per view: ${names.map((n, i) => `${n}=${summary.perView[i]}`).join(' ')}`, 'success');
        report.detection = {
            frames: frames.length, stride, ...summary, errors: failed,
            cornersPerView: names.map((_, v) => frames.reduce((acc, f) => acc + store.count(f, v), 0)),
        };

        // ---- stage 3: intrinsics -----------------------------------------------------
        const tI = performance.now();
        const flags = distortionFlags(opts.distModel);
        log(`Intrinsics: minCorners=${opts.minCorners}, maxFrames/camera=${opts.maxCalibFrames || 'all'}, distortion model=${opts.distModel}, ${calibWorkers} calib thread(s)`);
        let intrinsics = await Promise.all(views.map(async (view, v) => {
            const samples = intrinsicsSamples(store, v);
            const imageSize = { width: view.info.width, height: view.info.height };
            let res;
            try {
                res = await calib.request('intrinsics', { samples, imageSize, board, opts: { minCorners: opts.minCorners, maxFrames: opts.maxCalibFrames, exclusions: [], flags } });
            } catch (e) { log(`${view.name}: intrinsics failed: ${e.message}`, 'error'); return null; }
            if (res.error) { log(`${view.name}: ${res.error}`, 'error'); return null; }
            res.distModel = opts.distModel;
            const med = medianOf(res.perFrame.errors);
            log(`${view.name}: RMS ${res.rmsError.toFixed(3)} px over ${res.framesUsed}/${res.framesValid} frames (coverage ${(res.coverage * 100).toFixed(0)}%), ` +
                `median per-frame ${med.toFixed(3)} px | fx=${res.fx.toFixed(1)} fy=${res.fy.toFixed(1)} cx=${res.cx.toFixed(1)} cy=${res.cy.toFixed(1)} ` +
                `k1=${res.k1.toFixed(4)} k2=${res.k2.toFixed(4)} p1=${res.p1.toFixed(5)} p2=${res.p2.toFixed(5)} k3=${res.k3.toFixed(4)} | ` +
                `calibrateCamera ${fmtMs(res.timings.calibrateMs)}, eval ${fmtMs(res.timings.reprojectMs)}`, res.rmsError < 1 ? 'success' : 'warn');
            return res;
        }));
        timings.intrinsicsMs = performance.now() - tI;
        const ok = intrinsics.filter(Boolean).length;
        log(`Intrinsics done for ${ok}/${nViews} cameras in ${fmtMs(timings.intrinsicsMs)}`, ok === nViews ? 'success' : 'warn');
        report.intrinsics = intrinsics.map((r, v) => r ? { name: names[v], rms: r.rmsError, framesUsed: r.framesUsed, framesValid: r.framesValid, coverage: r.coverage, K: r.K, dist: r.dist } : { name: names[v], error: true });
        if (ok < 2) throw new Error('intrinsics failed for all but one camera — nothing to calibrate');

        // ---- stage 4: extrinsics ----------------------------------------------------
        let refIdx = 0;
        if (a.reference !== undefined) {
            refIdx = /^\d+$/.test(a.reference) ? parseInt(a.reference, 10) : names.indexOf(a.reference);
            if (!(refIdx >= 0 && refIdx < nViews)) throw new UsageError(`--reference ${a.reference}: no such camera (${names.join(', ')})`);
        }
        if (!intrinsics[refIdx]) throw new Error(`the reference camera ${names[refIdx]} has no intrinsics; choose another with --reference`);
        const tE = performance.now();
        const motion = boardMotionScores(store, { minCorners: opts.minCorners });
        const motionExcluded = framesAboveMotion(motion, opts.maxMotion);
        const ms = motionSummary(motion);
        if (ms) log(`Board motion (px/frame, max over cameras): median ${ms.median.toFixed(1)}, p25 ${ms.p25.toFixed(1)}, p75 ${ms.p75.toFixed(1)}, p90 ${ms.p90.toFixed(1)}` + (opts.maxMotion > 0 ? ` — ${motionExcluded.size} frames above ${opts.maxMotion} excluded from extrinsics/SBA` : ' — motion filter off'));
        log(`Extrinsics: reference=${names[refIdx]}, minCovisible=${opts.minCovisible}, maxFrames/pair=${opts.maxPairFrames || 'all'}`);
        const intrPayload = (arr) => arr.map(r => r ? { K: r.K, dist: r.dist } : null);
        const extrPayload = (arr) => arr.map(e => (e && !e.error) ? { R: e.R, tvec: e.tvec } : null);
        const res = await calib.request('extrinsics', {
            store: store.toPlain(), intrinsics: intrPayload(intrinsics), board, refIdx,
            minCovisible: opts.minCovisible, minCorners: opts.minCorners, excluded: Array.from(motionExcluded), maxFramesPerPair: opts.maxPairFrames,
        });
        let extrinsics = res.extrinsics;
        const extrinsicsMeta = { pairCounts: res.pairCounts, chain: res.chain, relativePoses: new Map(res.relativePoses), refIdx };
        for (let x = 0; x < nViews; x++) for (let y = x + 1; y < nViews; y++) {
            const c = res.pairCounts[x][y];
            log(`covisibility ${names[x]}–${names[y]}: ${c} frames`, c ? 'debug' : 'warn');
        }
        for (const [key, rp] of extrinsicsMeta.relativePoses) {
            const [pp, cc] = key.split('->').map(Number);
            if (rp.error) { log(`relative pose ${names[pp]}→${names[cc]}: ${rp.error}`, 'error'); continue; }
            log(`relative pose ${names[pp]}→${names[cc]}: ${rp.inliers}/${rp.framesUsed} inlier frames, |t|=${Math.hypot(...rp.tvec).toFixed(1)}, σt=${rp.tStd.toFixed(2)}, σrot=${rp.rotStdDeg.toFixed(3)}°`, rp.tStd > 5 ? 'warn' : 'info');
        }
        for (const u of res.chain.unreachable) log(`${names[u]} is not reachable from ${names[refIdx]} — increase sampling (--target) or lower --min-covisible`, 'error');
        const reproject = (intr, extr) => calib.request('reprojection', { store: store.toPlain(), intrinsics: intrPayload(intr), extrinsics: extrPayload(extr), opts: { minCorners: 4, minViews: 2 } });
        let reproj = await reproject(intrinsics, extrinsics);
        const initialSummary = reproj.summary;
        logReprojection('Cross-view reprojection (initial)', reproj.summary, names);
        timings.extrinsicsMs = performance.now() - tE;
        report.initial = { reprojection: reproj.summary, cameras: camerasOf(names, intrinsics, extrinsics) };

        // ---- stage 4b: bundle adjustment -----------------------------------------------
        let sbaResult = null;
        if (opts.sba) {
            const tS = performance.now();
            let lastProgress = 0;
            const refined = await refineCalibration({
                intrinsics, extrinsics, reproj, initialSummary, baselineExtrinsics: extrinsics,
                imageSizes: views.map(v => ({ width: v.info.width, height: v.info.height })),
                viewNames: names, board, referenceView: refIdx, excludedFrames: motionExcluded, options: refine,
                reproject,
                solve: (input, config, chunkIters, onProgress) => calib.request('sba', { input, config, chunkIters }, { onProgress }),
                log,
                progress: (f, msg) => { const now = performance.now(); if (now - lastProgress > 15000) { lastProgress = now; log(`  SBA ${(f * 100).toFixed(0)}%: ${msg}`, 'debug'); } },
            });
            if (refined.improved) {
                const best = refined.best;
                extrinsics = best.extr;
                reproj = best.reproj;
                intrinsics = best.config.optimize_intrinsics
                    ? await reevaluatePerFrame(best.intr, store, board, (payload, o) => calib.request('reprojectFrames', payload, o))
                    : best.intr;
                for (const r of intrinsics) if (r && best.config.optimize_intrinsics) r.refinedBySba = true;
                sbaResult = sbaResultRecord(refined);
            }
            timings.sbaMs = performance.now() - tS;
            report.sba = {
                improved: refined.improved, attempts: refined.attempts.map(x => ({ label: x.label, median: x.reproj.summary.overall.median })),
                rounds: refined.best.roundLog, ms: timings.sbaMs,
            };
            if (refined.improved) logReprojection('Cross-view reprojection (refined)', reproj.summary, names);
        }
        report.final = { refinedBySba: !!sbaResult, reprojection: reproj.summary, cameras: camerasOf(names, intrinsics, extrinsics) };

        // ---- stage 5: export --------------------------------------------------------
        const toml = calibrationTomlFromResults({
            viewNames: names, intrinsics, extrinsics, referenceView: refIdx, board, sessionName: session.rootName,
            sampledFrames: frames.length, refinedBySba: !!sbaResult, reproj,
        });
        if (!toml) throw new Error('no camera has both intrinsics and extrinsics');
        const missing = names.filter((_, i) => !intrinsics[i] || !extrinsics[i] || extrinsics[i].error);
        if (missing.length) log(`not in the TOML (no calibration): ${missing.join(', ')}`, 'warn');
        await writeFile(a.out, toml);
        log(`wrote ${a.out}`, 'success');
        if (a['session-out']) {
            const state = {
                sessionName: session.rootName, sessionLayout: session.layout, totalFrames, fps,
                views: views.map(v => ({ name: v.name, path: v.path, info: { width: v.info.width, height: v.info.height, totalFrames: v.info.totalFrames } })),
                board, sampledFrames: frames, detections: store,
                exclusions: { intrinsics: new Set(), extrinsics: new Set() }, referenceView: refIdx,
                intrinsics, extrinsics, extrinsicsMeta, sbaResult,
            };
            await writeFile(a['session-out'], JSON.stringify(serializeSession(state)));
            log(`wrote ${a['session-out']}`, 'success');
        }
        timings.totalMs = performance.now() - T0;
        if (a.report) {
            report.session = { name: session.rootName, layout: session.layout, root: path.resolve(root), totalFrames, fps, views: views.map(v => ({ name: v.name, path: v.path, ...v.info })) };
            report.board = board;
            report.referenceView = refIdx;
            await writeFile(a.report, JSON.stringify(report, null, 1));
            log(`wrote ${a.report}`, 'success');
        }
        log(`done in ${fmtMs(timings.totalMs)} (detection ${fmtMs(timings.detectionMs)}, intrinsics ${fmtMs(timings.intrinsicsMs)}, extrinsics ${fmtMs(timings.extrinsicsMs)}${timings.sbaMs !== undefined ? `, SBA ${fmtMs(timings.sbaMs)}` : ''})`, 'success');
        return 0;
    } finally {
        pool.terminate();
        calib.terminate();
    }
}

/**
 * The app's 'auto' board pattern for even-row boards: detect with both layouts and keep the
 * one that finds more corners. The app probes the frame on screen; here a few frames spread
 * over each video (fast seek) are probed.
 */
async function probePattern(board, views, pool, { ffmpeg, fastMarkers, samples = 5 }) {
    if (!legacyPatternDiffers(board)) {
        log(`Board pattern: ${board.boardY} rows (odd) — legacy and current ChArUco layouts are identical, nothing to probe`);
        return normalizeBoard({ ...board, legacyPattern: false });
    }
    const images = [];
    for (const [v, view] of views.entries()) {
        const dur = view.info.duration || view.info.totalFrames / (view.info.fps || 30);
        for (let k = 0; k < samples; k++) {
            const t = dur * (k + 0.5) / samples;
            const gray = await grayFrameAt(view.file, t, { width: view.info.width, height: view.info.height, ffmpeg, decodedWidth: view.info.decodedWidth, decodedHeight: view.info.decodedHeight });
            if (gray) images.push({ v, gray, width: view.info.width, height: view.info.height });
        }
    }
    const score = async (legacy) => {
        await pool.configure(normalizeBoard({ ...board, legacyPattern: legacy }), { fastMarkers });
        const rs = await Promise.all(images.map((im, i) => pool.detect({ frame: i, view: im.v, gray: im.gray.slice(), width: im.width, height: im.height })));
        return { corners: rs.reduce((x, r) => x + r.ids.length, 0), markers: rs.reduce((x, r) => x + r.numMarkers, 0) };
    };
    const cur = await score(false), leg = await score(true);
    const legacy = leg.corners > cur.corners;
    const none = cur.corners === 0 && leg.corners === 0;
    log(`Board pattern probe on ${images.length} frames (${board.boardX}x${board.boardY}, even rows): current layout ${cur.corners} corners / ${cur.markers} markers, legacy (< 4.6) layout ${leg.corners} corners / ${leg.markers} markers → using ${legacy ? 'legacy' : 'current'}${none ? ' (neither found the board — check the board size/dictionary, or pass --board-pattern)' : ''}`, none ? 'warn' : 'info');
    return normalizeBoard({ ...board, legacyPattern: legacy });
}

function camerasOf(names, intrinsics, extrinsics) {
    return names.map((name, i) => {
        const r = intrinsics[i], e = extrinsics[i];
        if (!r || !e || e.error) return { name, error: (e && e.error) || 'not calibrated' };
        return { name, K: r.K, dist: r.dist, rvec: e.rvec, tvec: e.tvec, center: cameraCenter(rodriguesToMatrix(e.rvec), e.tvec) };
    });
}

function logReprojection(label, s, names) {
    log(`${label}: ${s.frames} frames, ${s.points} points, ${s.observations} observations | mean ${s.overall.mean.toFixed(3)} px, median ${s.overall.median.toFixed(3)}, p95 ${s.overall.p95.toFixed(2)}, max ${s.overall.max.toFixed(1)} | ` +
        `per camera median: ${names.map((n, i) => `${n}=${s.perView[i] ? s.perView[i].median.toFixed(2) : '–'}`).join(' ')}`, s.overall.median < 1 ? 'success' : 'info');
}

function medianOf(arr) {
    const x = Array.from(arr).filter(Number.isFinite).sort((p, q) => p - q);
    return x.length ? x[x.length >> 1] : NaN;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    if (e instanceof UsageError) { process.stderr.write(`calibrate: ${e.message}\n(see --help)\n`); process.exitCode = 2; return; }
    log(e.stack || e.message, 'error');
    process.exitCode = 1;
});
