/**
 * ui/stage-extrinsics.js — Stage 4: initial extrinsics (covisibility graph →
 * relative poses → chain), cross-view triangulation/reprojection, and bundle
 * adjustment. All heavy work runs in the calibration worker with progress.
 */

import { state, controllers, cameraColor } from './app-state.js';
import { log, fmtMs } from './log-panel.js';
import { $, el, intInput, numInput, setStageStatus, expandStage, setEnabled, showError, Progress, errorColor } from './stages.js';
import { FrameStrip, errorColormap } from './frame-strip.js';
import { SwarmPlot, ErrorHistogram, histogramAxisMax, drawLineChart } from './plots.js';
import { FrameGallery } from './gallery.js';
import { indexReprojectionByFrame } from '../calib/triangulation.js';
import { refineCalibration, sbaResultRecord } from '../calib/refine.js';
import { boardMotionScores, framesAboveMotion, motionSummary } from '../calib/motion.js';
import { reevaluateIntrinsics, renderResults as renderIntrinsicsResults } from './stage-intrinsics.js';
import { cameraCenter } from '../calib/geometry.js';
import { emit, on } from './events.js';

let progress = null, sbaProgress = null;
let initialSec = null, refinedSec = null;   // {strip, plot, hist, gallery, summaryEl, rootEl}
let preSba = null;   // {intrinsics, extrinsics} before the last SBA run

export function setupExtrinsicsStage() {
    progress = new Progress('extrinsicsProgress');
    sbaProgress = new Progress('sbaProgress');
    $('computeExtrinsicsBtn').addEventListener('click', () => computeExtrinsics());
    $('runSbaBtn').addEventListener('click', () => runSba());
    $('revertSbaBtn').addEventListener('click', () => revertSba());
    $('referenceCamera').addEventListener('change', (e) => { state.referenceView = parseInt(e.target.value, 10) || 0; });
    $('clearExtrinsicsExclusionsBtn').addEventListener('click', () => { state.exclusions.extrinsics.clear(); emit('exclusions-changed', { kind: 'extrinsics' }); });

    initialSec = buildSection({ strip: 'extrinsicsStrip', stripTip: 'extrinsicsStripTooltip', plot: 'extrinsicsPlot', plotTip: 'extrinsicsPlotTooltip', hist: 'extrinsicsHist', histTip: 'extrinsicsHistTooltip', gallery: 'extrinsicsGallery', summary: 'reprojSummary', root: 'extrinsicsResults' });
    refinedSec = buildSection({ strip: 'refinedStrip', stripTip: 'refinedStripTooltip', plot: 'refinedPlot', plotTip: 'refinedPlotTooltip', hist: 'refinedHist', histTip: 'refinedHistTooltip', gallery: 'refinedGallery', summary: 'refinedSummary', root: 'refinedResults' });
    $('stage4').addEventListener('mousedown', () => { if (state.reproj) setActive(); });

    on('frame', ({ frame }) => { for (const sec of [initialSec, refinedSec]) { sec.strip.setCurrent(frame); sec.gallery.setCurrent(frame); sec.galleryBest.setCurrent(frame); } });
    on('exclusions-changed', ({ kind }) => { if (kind === 'extrinsics') refreshExclusionViews(); });
    on('intrinsics-changed', () => { hideResults(); });
    on('detections-changed', () => { hideResults(); setEnabled('computeExtrinsicsBtn', false); });
    on('session-loaded', () => { hideResults(); setEnabled('computeExtrinsicsBtn', false); setStageStatus('stage4', 'Waiting for intrinsics'); });
}

/** Strip + swarm plot + histogram + gallery bound to one reprojection result. */
function buildSection(ids) {
    const sec = { rootEl: $(ids.root), summaryEl: $(ids.summary), reproj: null, byFrame: new Map() };
    sec.strip = new FrameStrip($(ids.strip), {
        height: 40, tooltipEl: $(ids.stripTip),
        tooltip: (f) => {
            const rec = sec.byFrame.get(f);
            if (!rec) return `frame ${f}\nno triangulation`;
            const per = state.views.map((v, i) => `${v.name.padEnd(10)} ${rec.views[i] ? rec.views[i].mean.toFixed(2) + ' (' + rec.views[i].count + ')' : '–'}`).join('\n');
            return `frame ${f} · mean ${rec.meanErr.toFixed(2)} px · ${rec.n} pts${state.exclusions.extrinsics.has(f) ? ' · EXCLUDED' : ''}\n${per}`;
        },
        onClick: (f) => { setActive(); controllers.video.seekToFrame(f); },
    });
    sec.plot = new SwarmPlot($(ids.plot), $(ids.plotTip), {
        yLabel: 'mean reproj error / frame (px)', height: 250,
        formatTooltip: (p) => `${p.group}  frame ${p.frame}\nmean ${p.y.toFixed(3)} px over ${p.meta.count} pts (max ${p.meta.max.toFixed(2)})${p.excluded ? '\nEXCLUDED' : ''}\nclick to seek`,
        onClick: (p) => { setActive(); controllers.video.seekToFrame(p.frame); },
    });
    sec.hist = new ErrorHistogram($(ids.hist), $(ids.histTip), { height: 220 });
    const galleryOpts = { getThumb: (f) => state.thumbnails.get(f) || null, onSeek: (f) => { setActive(); controllers.video.seekToFrame(f); }, onToggleExclude: (f) => toggleExtrinsicsExclusion(f), limit: 30 };
    sec.gallery = new FrameGallery($(ids.gallery), galleryOpts);
    sec.galleryBest = new FrameGallery($(ids.gallery + 'Best'), galleryOpts);
    return sec;
}

/** Per-camera observation error arrays (Float32Array each) from a reprojection result. */
function perCameraErrors(rp) {
    const nV = state.views.length;
    const counts = new Array(nV).fill(0);
    for (const r of rp.frames) for (let v = 0; v < nV; v++) if (r.views[v]) counts[v] += r.views[v].count;
    const out = counts.map(c => new Float32Array(c)), pos = new Array(nV).fill(0);
    for (const r of rp.frames) for (let v = 0; v < nV; v++) {
        const vr = r.views[v]; if (!vr) continue;
        for (let i = 0; i < r.n; i++) if (vr.mask[i] && Number.isFinite(vr.err[i])) out[v][pos[v]++] = vr.err[i];
    }
    return out.map((a, v) => a.subarray(0, pos[v]));
}

function concatAll(arrs) {
    const n = arrs.reduce((a, b) => a + b.length, 0), out = new Float32Array(n); let p = 0;
    for (const a of arrs) { out.set(a, p); p += a.length; }
    return out;
}

/** Render strip/plot/histogram/gallery of a section from a reprojection result. */
function renderSection(sec, rp, { histSeries = null, histNote = '', thresholds = [], xMax = null } = {}) {
    sec.reproj = rp;
    sec.byFrame = indexReprojectionByFrame(rp);
    sec.rootEl.style.display = '';
    const s = rp.summary;
    sec.summaryEl.textContent = `${s.frames} frames · ${s.points} points · mean ${s.overall.mean.toFixed(3)} px · median ${s.overall.median.toFixed(3)} · p95 ${s.overall.p95.toFixed(2)}`;
    const frames = rp.frames.map(r => r.frame);
    sec.strip.setData({ frames, colorFn: (f) => errorColormap(sec.byFrame.get(f)?.meanErr), excluded: state.exclusions.extrinsics });
    sec.plot.setData(state.views.map((v, i) => ({
        label: v.name, color: cameraColor(i),
        points: rp.frames.filter(r => r.views[i] && isFinite(r.views[i].mean)).map(r => ({ y: r.views[i].mean, frame: r.frame, excluded: state.exclusions.extrinsics.has(r.frame), meta: { count: r.views[i].count, max: r.views[i].max } })),
    })), { thresholds: [1], note: `mean ${s.overall.mean.toFixed(2)} · median ${s.overall.median.toFixed(2)} · n=${s.observations}` });
    // Both histograms (initial per-camera, refined initial-vs-refined) share one x axis,
    // set from the INITIAL error distribution so the improvement is visible at a glance.
    const perCam = perCameraErrors(rp);
    if (!xMax) { xMax = histogramAxisMax(concatAll(perCam)); state.histXMax = xMax; }
    if (histSeries) sec.hist.setData(histSeries, { thresholds, note: histNote, xMax });
    else sec.hist.setData(perCam.map((a, i) => ({ label: state.views[i].name, color: cameraColor(i), values: a })), { note: histNote, xMax });
    const items = rp.frames.map(r => ({
        frame: r.frame, value: r.meanErr, excluded: state.exclusions.extrinsics.has(r.frame),
        sub: state.views.map((v, i) => r.views[i] ? { name: v.name, m: r.views[i].mean } : null).filter(x => x && Number.isFinite(x.m)).sort((a, b) => b.m - a.m).slice(0, 3).map(x => `${x.name}:${x.m.toFixed(2)}`).join(' '),
    }));
    sec.gallery.setItems(items, { sort: 'desc' });
    sec.galleryBest.setItems(items.filter(i => !i.excluded), { sort: 'asc' });
    sec.gallery.setCurrent(state.currentFrame);
    sec.galleryBest.setCurrent(state.currentFrame);
    sec.strip.setCurrent(state.currentFrame);
}

function hideResults() {
    $('extrinsicsResults').style.display = 'none';
    $('refinedResults').style.display = 'none';
    state.reprojInitial = null;
    $('sbaPanel').style.display = 'none';
    $('sbaResult').style.display = 'none';
    $('revertSbaBtn').style.display = 'none';
    setEnabled('runSbaBtn', false);
    preSba = null;
    state.reprojInitialSummary = null;
}

function setActive() { if (state.activeExclusion !== 'extrinsics') { state.activeExclusion = 'extrinsics'; emit('active-exclusion', { kind: 'extrinsics' }); } }

/** Frames excluded from fitting: the user's manual exclusions plus motion-filtered frames. */
function fitExclusions() {
    const set = new Set(state.exclusions.extrinsics);
    if (state.motionExcluded) for (const f of state.motionExcluded) set.add(f);
    return set;
}

function intrinsicsPayload() { return state.intrinsics.map(r => r ? { K: r.K, dist: r.dist } : null); }
function extrinsicsPayload() { return state.extrinsics.map(e => (e && !e.error) ? { R: e.R, tvec: e.tvec } : null); }

// ---- compute initial extrinsics -----------------------------------------------

export async function computeExtrinsics() {
    const store = state.detections;
    const calibrated = state.intrinsics.filter(Boolean).length;
    if (!store || calibrated < 2) { showError('Compute intrinsics for at least two cameras first.'); return; }
    const cw = controllers.calib;
    const refIdx = state.referenceView = parseInt($('referenceCamera').value, 10) || 0;
    if (!state.intrinsics[refIdx]) { showError('The reference camera has no intrinsics.'); return; }
    const minCovisible = intInput('minCovisible', 10);
    const maxFramesPerPair = intInput('maxPairFrames', 300);
    const minCorners = intInput('minCorners', 6);
    const maxMotion = numInput('maxMotion', 0);
    // Board motion per frame: frames above the threshold are excluded from the graph and from SBA
    // (kept separate from the user's manual exclusions; still evaluated in the reprojection report).
    const motion = boardMotionScores(store, { minCorners });
    state.motionScores = motion;
    state.motionExcluded = framesAboveMotion(motion, maxMotion);
    const ms = motionSummary(motion);
    if (ms) log(`Board motion (px/frame, max over cameras): median ${ms.median.toFixed(1)}, p25 ${ms.p25.toFixed(1)}, p75 ${ms.p75.toFixed(1)}, p90 ${ms.p90.toFixed(1)}` + (maxMotion > 0 ? ` — ${state.motionExcluded.size} frames above ${maxMotion} excluded from extrinsics/SBA` : ' — motion filter off'));
    setEnabled('computeExtrinsicsBtn', false);
    setEnabled('runSbaBtn', false);
    setStageStatus('stage4', 'Computing…', 'active');
    progress.show('building covisibility graph');
    const t0 = performance.now();
    log(`Extrinsics: reference=${state.views[refIdx].name}, minCovisible=${minCovisible}, maxFrames/pair=${maxFramesPerPair || 'all'}, excluded=${state.exclusions.extrinsics.size}`);
    try {
        const res = await cw.request('extrinsics', {
            store: store.toPlain(), intrinsics: intrinsicsPayload(), board: state.board, refIdx,
            minCovisible, minCorners, excluded: Array.from(fitExclusions()), maxFramesPerPair,
        }, { onProgress: (f, msg) => progress.set(f * 0.5, msg) });

        state.extrinsics = res.extrinsics;
        state.extrinsicsMeta = { pairCounts: res.pairCounts, chain: res.chain, relativePoses: new Map(res.relativePoses), refIdx };
        state.sbaResult = null; preSba = null;
        const names = state.views.map(v => v.name);
        for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
            const c = res.pairCounts[a][b];
            log(`covisibility ${names[a]}–${names[b]}: ${c} frames`, c ? 'debug' : 'warn');
        }
        for (const [key, rp] of state.extrinsicsMeta.relativePoses) {
            const [p, c] = key.split('->').map(Number);
            if (rp.error) { log(`relative pose ${names[p]}→${names[c]}: ${rp.error}`, 'error'); continue; }
            log(`relative pose ${names[p]}→${names[c]}: ${rp.inliers}/${rp.framesUsed} inlier frames, |t|=${Math.hypot(...rp.tvec).toFixed(1)} mm, σt=${rp.tStd.toFixed(2)} mm, σrot=${rp.rotStdDeg.toFixed(3)}°`, rp.tStd > 5 ? 'warn' : 'info');
        }
        for (const u of res.chain.unreachable) log(`${names[u]} is not reachable from ${names[refIdx]} — increase sampling or lower min covisible corners`, 'error');
        log(`Initial extrinsics in ${fmtMs(res.timings.totalMs)} (graph ${fmtMs(res.timings.graphMs)})`, 'success');
        renderPoseTables();

        await computeReprojection((f, msg) => progress.set(0.5 + 0.5 * f, msg));
        state.reprojInitialSummary = state.reproj.summary;   // kept for the before/after table
        state.reprojInitial = state.reproj;                   // kept for the initial plots
        $('refinedResults').style.display = 'none';
        state.histXMax = null;
        renderSection(initialSec, state.reproj);
        renderStatsTable();
        progress.hide();
        const s = state.reproj.summary;
        setStageStatus('stage4', `initial · mean ${s.overall.mean.toFixed(2)} px (median ${s.overall.median.toFixed(2)})`, s.overall.median < 1 ? 'complete' : 'warn');
        $('sbaPanel').style.display = '';
        setEnabled('runSbaBtn', true);
        setActive();
        emit('extrinsics-changed', {});
        expandStage('stage5');
        setStageStatus('stage5', 'Ready');
    } catch (e) {
        progress.fail(e.message);
        setStageStatus('stage4', 'Failed', 'error');
        showError(`Extrinsics failed: ${e.message}`);
        log(`Extrinsics failed: ${e.stack || e.message}`, 'error');
    } finally {
        setEnabled('computeExtrinsicsBtn', true);
    }
}

/** Triangulate + reproject for arbitrary intrinsics/extrinsics arrays (no state change). */
async function requestReprojection(intr, extr, onProgress) {
    return controllers.calib.request('reprojection', {
        store: state.detections.toPlain(),
        intrinsics: intr.map(r => r ? { K: r.K, dist: r.dist } : null),
        extrinsics: extr.map(e => (e && !e.error) ? { R: e.R, tvec: e.tvec } : null),
        opts: { minCorners: 4, minViews: 2 },
    }, { onProgress });
}

/** Triangulate + reproject with the current intrinsics/extrinsics; updates strip/plot/gallery. */
async function computeReprojection(onProgress) {
    const t0 = performance.now();
    const res = await requestReprojection(state.intrinsics, state.extrinsics, onProgress);
    state.reproj = res;
    state.reprojByFrame = indexReprojectionByFrame(res);
    const s = res.summary;
    log(`Cross-view reprojection: ${s.frames} frames, ${s.points} points, ${s.observations} observations in ${fmtMs(performance.now() - t0)} | ` +
        `mean ${s.overall.mean.toFixed(3)} px, median ${s.overall.median.toFixed(3)}, p95 ${s.overall.p95.toFixed(2)}, max ${s.overall.max.toFixed(1)} | ` +
        `per camera: ${state.views.map((v, i) => `${v.name}=${s.perView[i].mean.toFixed(2)}`).join(' ')}`, s.overall.median < 1 ? 'success' : 'warn');
    controllers.video.redraw();
}

// ---- SBA ----------------------------------------------------------------------

export async function runSba() {
    if (!state.reproj) return;
    const refIdx = state.referenceView;
    const options = {
        policy: $('sbaRejectPolicy') ? $('sbaRejectPolicy').value : 'aggressive',
        rounds: Math.max(1, intInput('sbaOutlierRounds', 6)),
        finalThreshold: numInput('sbaOutlierThreshold', 1),
        startThreshold: numInput('sbaOutlierStart', 0),
        maxIterations: intInput('sbaMaxIterations', 100),
        maxPoints: intInput('sbaMaxPoints', 20000),
        intrinsicsModel: $('sbaIntrModel') ? $('sbaIntrModel').value : 'fxfy-c-k1-k2',
        principal: $('sbaPrincipal') ? $('sbaPrincipal').value : 'centre',
        boardRigidity: $('sbaBoardRigidity') ? $('sbaBoardRigidity').value : 'anipose',
        robustLoss: $('sbaRobustLoss').value,
        robustLossParam: numInput('sbaLossParam', 1.0),
        optimizeExtrinsics: $('sbaOptExtrinsics').checked,
        optimizeIntrinsics: $('sbaOptIntrinsics').checked,
        optimizePoints: $('sbaOptPoints').checked,
        costTolerance: numInput('sbaCostTol', 1e-6),
        parameterTolerance: numInput('sbaParamTol', 1e-8),
        gradientTolerance: numInput('sbaGradTol', 1e-10),
        chunkIters: intInput('sbaChunkIters', 10),
    };
    setEnabled('runSbaBtn', false);
    setEnabled('computeExtrinsicsBtn', false);
    sbaProgress.show('preparing');
    const t0 = performance.now();
    try {
        if (!preSba) preSba = { intrinsics: state.intrinsics.slice(), extrinsics: state.extrinsics.slice() };
        // The orchestration (start point, rejection rounds, model selection) is calib/refine.js,
        // shared with the command line; the two expensive steps are calib-worker requests.
        const refined = await refineCalibration({
            intrinsics: state.intrinsics, extrinsics: state.extrinsics, reproj: state.reproj,
            initialSummary: state.reprojInitialSummary || state.reproj.summary,
            baselineExtrinsics: preSba.extrinsics,
            imageSizes: state.views.map(v => ({ width: v.info.width, height: v.info.height })),
            viewNames: state.views.map(v => v.name), board: state.board, referenceView: refIdx,
            excludedFrames: fitExclusions(), options,
            reproject: (intr, extr) => requestReprojection(intr, extr),
            solve: (input, config, chunkIters, onProgress) => controllers.calib.request('sba', { input, config, chunkIters }, { onProgress }),
            log, progress: (f, msg) => sbaProgress.set(f, msg),
            onLiveCost: (history, round) => drawLineChart($('sbaChart'), history, { label: `round ${round} cost, live (log)` }),
        });
        const { best, attempts, s0, schedule } = refined;
        const median = (r) => r.reproj.summary.overall.median;
        if (!refined.improved) {
            // Keep the initial calibration; report what was tried (refineCalibration logged why).
            sbaProgress.fail('no improvement');
            state.sbaResult = null;
            $('refinedResults').style.display = 'none';
            $('sbaResult').style.display = '';
            $('revertSbaBtn').style.display = 'none';
            $('sbaSummary').textContent = `No improvement: ${attempts.map(a => `${a.label} → median ${median(a).toFixed(2)} px`).join('; ')} vs initial ${s0.overall.median.toFixed(2)} px. Initial calibration kept. ${fmtMs(performance.now() - t0)}`;
            drawLineChart($('sbaChart'), best.costHistory, { label: `cost, ${best.label} (log)` });
            showError(`Bundle adjustment did not improve the cross-view error (best ${median(best).toFixed(2)} vs initial ${s0.overall.median.toFixed(2)} px median); the initial calibration was kept. See the log for suggestions.`);
            setStageStatus('stage4', `initial · mean ${s0.overall.mean.toFixed(2)} px (median ${s0.overall.median.toFixed(2)}) · SBA gave no improvement`, 'warn');
            preSba = null;
            emit('extrinsics-changed', {});
            return;
        }
        state.extrinsics = best.extr;
        state.reproj = best.reproj;
        // Per-frame intrinsic poses were solved under the pre-SBA K / dist; re-solve them so the
        // stage-3 plots and the red-X overlay match the refined intrinsics.
        if (best.config.optimize_intrinsics) {
            sbaProgress.set(0.97, 're-evaluating per-frame intrinsic errors');
            try { state.intrinsics = await reevaluateIntrinsics(best.intr); }
            catch (e) { log(`per-frame intrinsic re-evaluation failed: ${e.message}`, 'warn'); state.intrinsics = best.intr; }
            renderIntrinsicsResults();
            const rms = (arr) => arr.map((r, i) => r ? `${state.views[i].name} ${(preSba.intrinsics[i] ? preSba.intrinsics[i].rmsError : NaN).toFixed(3)}→${r.rmsError.toFixed(3)}` : null).filter(Boolean).join(', ');
            log(`Per-frame intrinsic RMS re-evaluated with the refined intrinsics (px): ${rms(state.intrinsics)}`, 'debug');
        } else state.intrinsics = best.intr;
        state.reprojByFrame = indexReprojectionByFrame(best.reproj);
        const nPts = best.input.points.length, kept = best.lastInput.points.length;
        const lr = best.lastResult;
        const improvement = (lr.initial_cost - lr.final_cost) / Math.max(1e-9, lr.initial_cost) * 100;
        state.sbaResult = sbaResultRecord(refined);
        sbaProgress.hide();
        renderPoseTables();
        renderRefined(best.lastMu);
        renderStatsTable();
        controllers.video.redraw();
        $('sbaResult').style.display = '';
        $('revertSbaBtn').style.display = '';
        $('sbaSummary').textContent = `${best.label} · ${schedule.length} round(s) · final fit on ${kept}/${nPts} points (threshold ${Number.isFinite(best.lastMu) ? best.lastMu.toFixed(1) : 'none'} px) · ` +
            `last round ${lr.iterations} iterations, cost ${lr.initial_cost.toFixed(0)} → ${lr.final_cost.toFixed(0)} (−${improvement.toFixed(1)}%) · ${lr.status}` +
            (attempts.length > 1 ? ` · also tried ${attempts.slice(1).map(a => `${a.label} (${median(a).toFixed(2)} px)`).join(', ')}` : '') + ` · ${fmtMs(performance.now() - t0)}`;
        drawLineChart($('sbaChart'), best.costHistory, { label: `cost over ${schedule.length} round(s) (log)` });
        const s = state.reproj.summary;
        setStageStatus('stage4', `refined · mean ${s.overall.mean.toFixed(2)} px (median ${s.overall.median.toFixed(2)})`, s.overall.median < 1 ? 'complete' : 'warn');
        emit('extrinsics-changed', {});
    } catch (e) {
        sbaProgress.fail(e.message);
        showError(`Bundle adjustment failed: ${e.message}`);
        log(`SBA failed: ${e.stack || e.message}`, 'error');
    } finally {
        setEnabled('runSbaBtn', true);
        setEnabled('computeExtrinsicsBtn', true);
    }
}

export async function revertSba() {
    if (!preSba) return;
    state.intrinsics = preSba.intrinsics;
    state.extrinsics = preSba.extrinsics;
    state.sbaResult = null;
    preSba = null;
    renderIntrinsicsResults();
    $('sbaResult').style.display = 'none';
    $('revertSbaBtn').style.display = 'none';
    log('Reverted to the initial (pre-SBA) calibration');
    $('refinedResults').style.display = 'none';
    progress.show('recomputing reprojection');
    try {
        await computeReprojection((f, msg) => progress.set(f, msg));
        state.reprojInitial = state.reproj;
        state.histXMax = null;
        renderSection(initialSec, state.reproj);
        progress.hide();
        renderPoseTables();
        renderStatsTable();
        emit('extrinsics-changed', {});
    } catch (e) { progress.fail(e.message); }
}

// ---- render -------------------------------------------------------------------

function renderPoseTables() {
    $('extrinsicsResults').style.display = '';
    const names = state.views.map(v => v.name);
    const meta = state.extrinsicsMeta;
    // covisibility matrix
    if (meta) {
        const n = names.length;
        const grid = el('div', { class: 'covis-grid', style: { gridTemplateColumns: `auto repeat(${n}, 1fr)` } });
        grid.appendChild(el('div', { class: 'covis-cell head' }));
        for (let j = 0; j < n; j++) grid.appendChild(el('div', { class: 'covis-cell head', text: names[j], style: { color: cameraColor(j) } }));
        for (let i = 0; i < n; i++) {
            grid.appendChild(el('div', { class: 'covis-cell head', text: names[i], style: { color: cameraColor(i) } }));
            for (let j = 0; j < n; j++) {
                if (i === j) { grid.appendChild(el('div', { class: 'covis-cell diag' })); continue; }
                const c = meta.pairCounts[i][j];
                const isEdge = meta.chain.parent[j] === i || meta.chain.parent[i] === j;
                grid.appendChild(el('div', { class: `covis-cell${c === 0 ? ' zero' : ''}${isEdge ? ' edge' : ''}`, text: String(c), title: isEdge ? 'used in pose chain' : '' }));
            }
        }
        $('covisTable').replaceChildren(grid);
        const chainTxt = meta.chain.order.map(v => meta.chain.parent[v] === null ? `${names[v]} (ref)` : `${names[meta.chain.parent[v]]}→${names[v]}`).join(', ');
        $('chainInfo').textContent = `Pose chain: ${chainTxt}${meta.chain.unreachable.length ? ` · unreachable: ${meta.chain.unreachable.map(u => names[u]).join(', ')}` : ''}. Outlined cells are chain edges.`;
    }
    // poses
    const tbody = $('extrinsicsTableBody');
    tbody.replaceChildren(...state.views.map((v, i) => {
        const e = state.extrinsics[i];
        if (!e || e.error) return el('tr', {}, [el('td', { text: v.name, style: { color: cameraColor(i) } }), el('td', { text: e ? e.error : 'n/a', colspan: '8', style: { color: 'var(--bad)' } })]);
        const via = e.chain ? e.chain.map(k => names[k]).join('→') : '';
        const cells = [v.name, ...e.rvec.map(x => x.toFixed(5)), ...e.tvec.map(x => x.toFixed(2)), via, e.pairStd !== undefined ? e.pairStd.toFixed(2) : ''];
        const tr = el('tr', {}, cells.map(c => el('td', { text: c })));
        tr.children[0].style.color = cameraColor(i); tr.children[0].style.fontWeight = '600';
        const C = cameraCenter(e.R, e.tvec);
        tr.title = `camera center in world: [${C.map(x => x.toFixed(1)).join(', ')}] mm${e.refinedBySba ? ' · refined by SBA' : ''}`;
        return tr;
    }));
}

/** Per-camera reprojection statistics: initial extrinsics vs after bundle adjustment. */
function renderStatsTable() {
    const tbody = $('reprojStatsBody');
    if (!tbody) return;
    const cur = state.reproj ? state.reproj.summary : null;
    const init = state.reprojInitialSummary || cur;
    const refined = state.sbaResult ? cur : null;
    const fmt = (v) => Number.isFinite(v) ? v.toFixed(3) : '–';
    const rows = state.views.map((v, i) => {
        const a = init ? init.perView[i] : null, b = refined ? refined.perView[i] : null;
        const tr = el('tr', {}, [
            el('td', { text: v.name, style: { color: cameraColor(i), fontWeight: '600' } }),
            el('td', { text: a ? String(a.n) : '–' }),
            el('td', { text: a ? fmt(a.mean) : '–' }), el('td', { text: a ? fmt(a.median) : '–' }), el('td', { text: a ? fmt(a.p95) : '–' }),
            el('td', { text: b ? fmt(b.mean) : '–' }), el('td', { text: b ? fmt(b.median) : '–' }), el('td', { text: b ? fmt(b.p95) : '–' }),
        ]);
        if (a) tr.children[3].style.color = errorColor(a.median);
        if (b) tr.children[6].style.color = errorColor(b.median);
        return tr;
    });
    if (init) {
        const a = init.overall, b = refined ? refined.overall : null;
        const tr = el('tr', { class: 'total' }, [
            el('td', { text: 'all', style: { fontWeight: '600' } }), el('td', { text: String(a.n) }),
            el('td', { text: fmt(a.mean) }), el('td', { text: fmt(a.median) }), el('td', { text: fmt(a.p95) }),
            el('td', { text: b ? fmt(b.mean) : '–' }), el('td', { text: b ? fmt(b.median) : '–' }), el('td', { text: b ? fmt(b.p95) : '–' }),
        ]);
        rows.push(tr);
    }
    tbody.replaceChildren(...rows);
}

/** Refined section: current (post-SBA) reprojection, histogram overlaying initial vs refined. */
function renderRefined(finalThreshold) {
    const rp = state.reproj, rp0 = state.reprojInitial;
    if (!rp) return;
    const initialAll = rp0 ? concatAll(perCameraErrors(rp0)) : null;
    const refinedAll = concatAll(perCameraErrors(rp));
    const series = [];
    if (initialAll) series.push({ label: 'initial extrinsics', color: '#9a9a9a', values: initialAll, fill: true, width: 1.2 });
    series.push({ label: 'after bundle adjustment', color: '#60a5fa', values: refinedAll, fill: true, width: 2 });
    const thresholds = Number.isFinite(finalThreshold) ? [{ x: finalThreshold, label: `fit threshold ${finalThreshold.toFixed(1)} px` }] : [];
    renderSection(refinedSec, rp, { histSeries: series, thresholds, histNote: 'all observations', xMax: state.histXMax || null });
}

function currentSection() { return state.sbaResult ? refinedSec : initialSec; }

function refreshExclusionViews() {
    for (const sec of [initialSec, refinedSec]) {
        if (!sec.reproj) continue;
        sec.strip.setExcluded(state.exclusions.extrinsics);
        sec.gallery.updateExclusions(state.exclusions.extrinsics);
        sec.galleryBest.updateExclusions(state.exclusions.extrinsics);
        sec.plot.setData(sec.plot.groups.map(g => ({ ...g, points: g.points.map(p => ({ ...p, excluded: state.exclusions.extrinsics.has(p.frame) })) })), { thresholds: [1], note: sec.plot.note });
    }
    refreshExclusionInfo();
    controllers.video.redraw();
}

function refreshExclusionInfo() {
    const n = state.exclusions.extrinsics.size;
    $('extrinsicsExclusionInfo').textContent = n ? `${n} frame(s) excluded — recompute extrinsics / rerun SBA to apply` : '';
    $('clearExtrinsicsExclusionsBtn').style.display = n ? '' : 'none';
}

export function toggleExtrinsicsExclusion(frame) {
    if (!state.detections || !state.detections.has(frame)) { log(`Frame ${frame} is not a sampled frame`, 'warn'); return; }
    const set = state.exclusions.extrinsics;
    if (set.has(frame)) { set.delete(frame); log(`Frame ${frame} re-included for extrinsics`); }
    else { set.add(frame); log(`Frame ${frame} excluded from extrinsics/SBA (recompute to apply)`, 'warn'); }
    emit('exclusions-changed', { kind: 'extrinsics' });
}

export function stepWorst(dir) {
    const sec = currentSection();
    if (!sec.reproj) return;
    const order = sec.reproj.frames.map(r => r.frame).sort((a, b) => sec.byFrame.get(b).meanErr - sec.byFrame.get(a).meanErr);
    const i = order.indexOf(state.currentFrame);
    const next = i < 0 ? 0 : (i + dir + order.length) % order.length;
    controllers.video.seekToFrame(order[next]);
}
