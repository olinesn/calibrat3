/**
 * calib/refine.js — bundle-adjustment orchestration (anipose-style), shared by the app
 * (ui/stage-extrinsics.js runSba) and the command line (cli/calibrate.mjs).
 *
 * Pure: no DOM, no workers. The caller passes the two expensive steps as callbacks —
 * `reproject(intrinsics, extrinsics)` (cross-view triangulation + reprojection, the calib
 * worker's `reprojection` request) and `solve(input, config, onProgress)` (its `sba`
 * request) — plus `log(msg, level)` and `progress(fraction, msg)`.
 *
 * What it does (see CLAUDE.md "Bundle adjustment"):
 *   1. start point: for the shared-focal models f = mean(fx, fy); principal point at the
 *      image centre unless the model frees it; re-triangulate from there;
 *   2. threshold schedule (aggressive 15 → 1 px with aniposelib's per-pair clamp, or
 *      conservative ≤ 20 % rejected per round);
 *   3. rounds of reject-per-point → solve → apply → re-triangulate ALL observations;
 *   4. model selection: if free intrinsics did not improve the re-triangulated median,
 *      retry with intrinsics fixed; never accept a result worse than the initial one.
 */

import { prepareSbaInput, applySbaResults, sbaReferenceIndex, filterSbaInput, outlierSchedule, pairErrorBounds } from './sba.js';
import { percentile, norm3, sub3, rotationAngle } from './geometry.js';

/** Format milliseconds for log lines (also used by ui/log-panel.js). */
export function fmtMs(ms) {
    if (ms < 1000) return `${ms.toFixed(0)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

/** The SBA panel's defaults (index.html). */
export const DEFAULT_REFINE_OPTIONS = Object.freeze({
    policy: 'aggressive',            // sbaRejectPolicy: aggressive | conservative
    rounds: 6,                       // sbaOutlierRounds
    finalThreshold: 1,               // sbaOutlierThreshold (px, 0 = keep everything)
    startThreshold: 0,               // sbaOutlierStart (px, 0 = automatic)
    maxIterations: 100,              // sbaMaxIterations
    maxPoints: 20000,                // sbaMaxPoints (0 = all)
    intrinsicsModel: 'fxfy-c-k1-k2', // sbaIntrModel: fxfy-c-k1-k2 | f-k1-k2 | f-c-k1 | f-k1 | wasm
    principal: 'centre',             // sbaPrincipal: centre | keep
    boardRigidity: 'anipose',        // sbaBoardRigidity: anipose | strong | off
    robustLoss: 'none',              // sbaRobustLoss: none | huber | cauchy
    robustLossParam: 1.0,            // sbaLossParam
    optimizeExtrinsics: true,        // sbaOptExtrinsics
    optimizeIntrinsics: true,        // sbaOptIntrinsics
    optimizePoints: true,            // sbaOptPoints
    costTolerance: 1e-6,             // sbaCostTol
    parameterTolerance: 1e-8,        // sbaParamTol
    gradientTolerance: 1e-10,        // sbaGradTol
    chunkIters: 10,                  // sbaChunkIters (progress granularity)
});

/**
 * Run the whole refinement. Inputs are never modified.
 *
 * @param {object} p
 * @param {object[]} p.intrinsics   per view {K, dist, fx, fy, cx, cy, ...} or null
 * @param {object[]} p.extrinsics   per view {R, rvec, tvec} or {error}
 * @param {object} p.reproj         cross-view reprojection of (intrinsics, extrinsics)
 * @param {object} [p.initialSummary]   summary to beat (the initial calibration's); default p.reproj.summary
 * @param {object[]} [p.baselineExtrinsics]  for the "moved N mm" log; default p.extrinsics
 * @param {Array<{width:number, height:number}>} p.imageSizes  per view
 * @param {string[]} p.viewNames
 * @param {object} p.board
 * @param {number} p.referenceView
 * @param {Set<number>} [p.excludedFrames]   frames kept out of the fit (manual + motion)
 * @param {object} [p.options]      overrides of DEFAULT_REFINE_OPTIONS
 * @param {(intr:object[], extr:object[]) => Promise<object>} p.reproject
 * @param {(input:object, config:object, chunkIters:number, onProgress:Function) => Promise<object>} p.solve
 * @param {(msg:string, level?:string) => void} [p.log]
 * @param {(fraction:number, msg:string) => void} [p.progress]
 * @param {(costHistory:number[], round:number) => void} [p.onLiveCost]
 * @returns {Promise<{improved:boolean, best:object, attempts:object[], s0:object, schedule:number[], ms:number}>}
 *   `best` = {label, config, intr, extr, reproj, input, lastResult, lastInput, lastMu, roundLog, costHistory}
 */
export async function refineCalibration(p) {
    const o = { ...DEFAULT_REFINE_OPTIONS, ...(p.options || {}) };
    const log = p.log || (() => {});
    const progress = p.progress || (() => {});
    const names = p.viewNames;
    const refIdx = p.referenceView;
    const excludedFrames = p.excludedFrames || new Set();
    const s0 = p.initialSummary || p.reproj.summary;
    const baseline = p.baselineExtrinsics || p.extrinsics;
    const prep = (reproj, intr, extr) => prepareSbaInput(reproj, intr, extr, { excludedFrames, maxPoints: o.maxPoints });
    const intrModel = o.intrinsicsModel;
    const engine = intrModel === 'wasm' ? 'wasm' : 'js';
    const boardWeight = o.boardRigidity === 'off' ? 0 : o.boardRigidity === 'strong' ? 1 : 2 / p.board.squareLength;
    const optIntr = !!o.optimizeIntrinsics;
    // Principal point handling: the anipose-style models keep cx, cy fixed; pin them at the image centre
    // (what aniposelib does) unless the user asked to keep the per-camera estimate.
    const resetPrincipal = engine === 'js' && optIntr && o.principal === 'centre' && !['f-c-k1', 'fxfy-c-k1-k2'].includes(intrModel);
    const sharedFocal = engine === 'js' && optIntr && ['f-k1', 'f-c-k1', 'f-k1-k2'].includes(intrModel);
    let startPoint = { intr: p.intrinsics, extr: p.extrinsics, reproj: p.reproj };
    const t0 = performance.now();

    if (resetPrincipal || sharedFocal) {
        // anipose-style starting point: one focal length (mean of fx, fy) and, unless the model
        // frees it, the principal point at the image centre. The per-camera k1-only fit on a
        // planar board leaves both poorly determined (fx/fy several % apart, cx off by ~50 px).
        const intr = p.intrinsics.map((r, v) => {
            if (!r) return r;
            const w = p.imageSizes[v].width, h = p.imageSizes[v].height;
            const cx = resetPrincipal ? (w - 1) / 2 : r.cx, cy = resetPrincipal ? (h - 1) / 2 : r.cy;
            const f = sharedFocal ? (r.fx + r.fy) / 2 : null;
            const fx = f ?? r.fx, fy = f ?? r.fy;
            if (Math.abs(r.cx - cx) < 1e-9 && Math.abs(r.cy - cy) < 1e-9 && Math.abs(r.fx - fx) < 1e-9 && Math.abs(r.fy - fy) < 1e-9) return r;
            const K = r.K.map(row => row.slice()); K[0][0] = fx; K[1][1] = fy; K[0][2] = cx; K[1][2] = cy;
            return { ...r, K, fx, fy, cx, cy, principalReset: resetPrincipal, focalShared: sharedFocal };
        });
        if (intr.some((r, v) => r !== p.intrinsics[v])) {
            progress(0.01, 'shared-focal start (f = mean(fx, fy), principal point at centre), re-triangulating');
            const reproj = await p.reproject(intr, p.extrinsics);
            startPoint = { intr, extr: p.extrinsics, reproj };
            log(`SBA start (shared focal / centred principal point): ${names.map((n, i) => p.intrinsics[i] ? `${n} fx/fy ${p.intrinsics[i].fx.toFixed(0)}/${p.intrinsics[i].fy.toFixed(0)} → ${intr[i].fx.toFixed(0)}, c (${p.intrinsics[i].cx.toFixed(0)}, ${p.intrinsics[i].cy.toFixed(0)}) → (${intr[i].cx.toFixed(1)}, ${intr[i].cy.toFixed(1)})` : null).filter(Boolean).join('; ')}; initial median ${p.reproj.summary.overall.median.toFixed(2)} → ${reproj.summary.overall.median.toFixed(2)} px before refinement`);
        }
    }
    const input0 = prep(startPoint.reproj, startPoint.intr, startPoint.extr);
    if (input0.points.length < 10) throw new Error('Not enough triangulated points for bundle adjustment.');
    const baseConfig = {
        engine,
        intrinsics_model: intrModel === 'wasm' ? 'full' : intrModel,
        board: p.board,
        board_weight: engine === 'js' ? boardWeight : 0,
        max_iterations: o.maxIterations,
        robust_loss: o.robustLoss,
        robust_loss_param: o.robustLossParam,
        outlier_threshold: 0,                       // rejection is done here (anipose-style, per point), not inside the solver
        optimize_extrinsics: !!o.optimizeExtrinsics,
        optimize_intrinsics: optIntr,
        optimize_points: !!o.optimizePoints,
        cost_tolerance: o.costTolerance,
        parameter_tolerance: o.parameterTolerance,
        gradient_tolerance: o.gradientTolerance,
        reference_camera: sbaReferenceIndex(input0, refIdx),
    };
    const policy = o.policy, finalThr = o.finalThreshold, startThr = o.startThreshold;
    const finite0 = input0.meta.pointErr.filter(Number.isFinite);
    const start = startThr > 0 ? startThr : (policy === 'aggressive' ? 15 : Math.max(finalThr * 3, percentile(finite0, 0.95)));
    const schedule = finalThr > 0 ? outlierSchedule(Math.max(start, finalThr), finalThr, Math.max(1, o.rounds)) : [Infinity];
    log(`SBA: ${input0.meta.numCameras} cameras, ${input0.meta.numPoints} points (${input0.meta.numFrames} frames${input0.meta.frameStride > 1 ? `, every ${input0.meta.frameStride}th` : ''}), ${input0.meta.numObservations} observations; ` +
        `${schedule.length} round(s), rejection policy ${policy}, point-error thresholds ${schedule.map(t => Number.isFinite(t) ? t.toFixed(1) : 'none').join(' → ')} px, loss ${baseConfig.robust_loss}(${baseConfig.robust_loss_param}), ref=${names[refIdx]}, ` +
        `engine ${engine}${engine === 'js' ? ` (intrinsics ${optIntr ? intrModel : 'fixed'}, board rigidity ${boardWeight ? boardWeight.toFixed(3) + ' px/mm' : 'off'})` : ' (sba-solver-wasm, all 9 intrinsics)'}; ` +
        `optimize: ${['extrinsics', 'intrinsics', 'points'].filter((k, i) => [baseConfig.optimize_extrinsics, baseConfig.optimize_intrinsics, baseConfig.optimize_points][i]).join('+')}; ` +
        `initial per-point error median ${percentile(finite0, 0.5).toFixed(2)} px, p95 ${percentile(finite0, 0.95).toFixed(2)} px`);

    const attemptArgs = { schedule, prep, policy, numViews: names.length, names, chunkIters: o.chunkIters, reproject: p.reproject, solve: p.solve, log, progress, onLiveCost: p.onLiveCost };
    // Model selection: try the configured fit; if the re-triangulated error over ALL
    // observations gets worse and intrinsics were free, retry with intrinsics fixed.
    // Never accept a result worse than the initial calibration.
    const attempts = [];
    const a1 = await sbaAttempt({ ...attemptArgs, config: baseConfig, progressBase: 0, progressSpan: baseConfig.optimize_intrinsics ? 0.5 : 1, start: startPoint });
    attempts.push(a1);
    const median = (r) => r.reproj.summary.overall.median;
    if (baseConfig.optimize_intrinsics && median(a1) > s0.overall.median * 0.98) {
        log(`SBA with free intrinsics did not improve the re-triangulated error (${s0.overall.median.toFixed(2)} → ${median(a1).toFixed(2)} px); retrying with intrinsics fixed`, 'warn');
        attempts.push(await sbaAttempt({ ...attemptArgs, config: { ...baseConfig, optimize_intrinsics: false }, progressBase: 0.5, progressSpan: 0.5, start: { intr: p.intrinsics, extr: p.extrinsics, reproj: p.reproj } }));
    }
    attempts.sort((a, b) => median(a) - median(b));
    const best = attempts[0];
    const improved = median(best) < s0.overall.median * 0.995;
    const ms = performance.now() - t0;
    if (!improved) {
        log(`Bundle adjustment could not improve on the initial calibration (${attempts.map(a => `${a.label}: ${median(a).toFixed(2)} px`).join(', ')} vs ${s0.overall.median.toFixed(2)} px). ` +
            `The solver lowers its own cost by moving free 3D points, so the 2D observations are not mutually consistent across cameras (camera timing / board motion / bad frames). ` +
            `Try: exclude fast frames (max board motion), fewer rounds, check that the videos are frame-synchronized.`, 'warn');
        return { improved, best, attempts, s0, schedule, ms };
    }
    const s = best.reproj.summary;
    const nPts = best.input.points.length, kept = best.lastInput.points.length;
    log(`Bundle adjustment per camera (initial → refined): ${names.map((n, vi) => { const a = s0.perView[vi], b = s.perView[vi]; const e0 = baseline[vi], e1 = best.extr[vi]; const mv = (e0 && e1 && !e0.error && !e1.error) ? `, moved ${norm3(sub3(e1.tvec, e0.tvec)).toFixed(1)} mm / ${(rotationAngle(e0.R, e1.R) * 180 / Math.PI).toFixed(2)}°` : ''; return `${n}: median ${a ? a.median.toFixed(2) : '–'} → ${b ? b.median.toFixed(2) : '–'} px, p95 ${a ? a.p95.toFixed(1) : '–'} → ${b ? b.p95.toFixed(1) : '–'}${mv}`; }).join('; ')}`);
    if (attempts.length > 1) log(`Model selection: ${attempts.map(a => `${a.label} → median ${median(a).toFixed(2)} px`).join('; ')} → kept "${best.label}"`);
    log(`Bundle adjustment done in ${fmtMs(ms)} (${best.label}): cross-view reprojection median ${s0.overall.median.toFixed(2)} → ${s.overall.median.toFixed(2)} px, mean ${s0.overall.mean.toFixed(2)} → ${s.overall.mean.toFixed(2)} px over all observations; ${nPts - kept} points excluded from the final fit`, 'success');
    return { improved, best, attempts, s0, schedule, ms };
}

/**
 * The `state.sbaResult` record the app keeps (and session-save writes) for an accepted refinement.
 */
export function sbaResultRecord(refined) {
    const { best, attempts, schedule } = refined;
    const median = (r) => r.reproj.summary.overall.median;
    const nPts = best.input.points.length, kept = best.lastInput.points.length;
    return {
        result: best.lastResult, rounds: best.roundLog,
        attempts: attempts.map(a => ({ label: a.label, median: median(a) })),
        config: { ...best.config, rounds: schedule.length, thresholds: schedule, finalThreshold: best.lastMu },
        meta: { ...best.lastInput.meta, pointsTotal: nPts, pointsExcluded: nPts - kept, observationsTotal: best.input.observations.length, observationsExcluded: best.input.observations.length - best.lastInput.observations.length },
    };
}

/**
 * One SBA attempt: rounds of per-point rejection + solve + re-triangulation, starting
 * from `start` ({intr, extr, reproj}). Returns refined arrays; inputs are untouched.
 */
export async function sbaAttempt({ config, schedule, prep, progressBase, progressSpan, policy = 'aggressive', start, numViews, names, chunkIters = 10, reproject, solve, log = () => {}, progress = () => {}, onLiveCost = null }) {
    const intrLabel = config.optimize_intrinsics ? (config.engine === 'wasm' ? 'intrinsics(all 9)' : `intrinsics(${config.intrinsics_model})`) : null;
    const label = `optimize ${[config.optimize_extrinsics ? 'extrinsics' : null, intrLabel, config.optimize_points ? 'points' : null].filter(Boolean).join('+')}`;
    let intr = start.intr, extr = start.extr, reproj = start.reproj;
    let input = prep(reproj, intr, extr);
    let lastResult = null, lastInput = null, lastMu = Infinity;
    const roundLog = [];
    const costHistory = [];   // all rounds concatenated (for the final chart)
    const P = (f, msg) => progress(progressBase + progressSpan * f, `${label}: ${msg}`);
    for (let r = 0; r < schedule.length; r++) {
        const tRound = performance.now();
        const prevIntr = intr, prevExtr = extr, prevReproj = reproj, input0Obs = input.observations;
        const errs = input.meta.pointErr;
        const finite = errs.filter(Number.isFinite);
        let mu, clampNote = '';
        if (policy === 'aggressive') {
            // Same clamp as aniposelib: mu = max(min(max_error, mus[i]), min_error) with per-pair p75 / p15 bounds.
            const b = pairErrorBounds(reproj, numViews);
            mu = Math.max(Math.min(b.maxError, schedule[r]), b.minError);
            if (mu !== schedule[r]) clampNote = ` — schedule asked ${schedule[r].toFixed(1)}, clamped to [worst-pair p15 ${b.minError.toFixed(1)}, worst-pair p75 ${b.maxError.toFixed(1)}]`;
        } else {
            const floor = percentile(finite, 0.8);   // never reject more than ~20 % of points in one round
            mu = Math.max(schedule[r], Number.isFinite(floor) ? floor : 0);
            if (mu > schedule[r]) clampNote = ` — schedule asked ${schedule[r].toFixed(1)}, raised to the 80th percentile so ≤20 % of points are rejected`;
        }
        lastMu = mu;
        const keepObs = new Uint8Array(input.observations.length);
        for (let i = 0; i < input.observations.length; i++) { const e = errs[input.observations[i].point_idx]; keepObs[i] = (Number.isFinite(e) && e <= mu) ? 1 : 0; }
        const filtered = filterSbaInput(input, keepObs);
        P(r / schedule.length, `round ${r + 1}/${schedule.length}: ${filtered.points.length}/${input.points.length} points ≤ ${Number.isFinite(mu) ? mu.toFixed(1) : '∞'} px`);
        if (filtered.points.length < 10) { log(`SBA round ${r + 1}: only ${filtered.points.length} points left; stopping`, 'warn'); break; }
        const tSolve = performance.now();
        let lastLoggedIter = 0;
        const result = await solve(filtered, config, chunkIters, (f, msg, detail) => {
            P((r + 0.05 + 0.75 * f) / schedule.length, `round ${r + 1}/${schedule.length}: ${msg || ''}`);
            if (detail && detail.costHistory && onLiveCost) onLiveCost(detail.costHistory, r + 1);
            if (detail && detail.iteration > lastLoggedIter && detail.cost !== undefined) {
                lastLoggedIter = detail.iteration;
                log(`  ${label}, round ${r + 1}: iteration ${detail.iteration}/${detail.maxIters}, cost ${detail.cost.toFixed(1)} (−${((detail.initialCost - detail.cost) / Math.max(1e-9, detail.initialCost) * 100).toFixed(2)}% so far), fit RMS ≈ ${Number.isFinite(detail.rms) ? detail.rms.toFixed(3) : '?'} px, ${detail.status}, ${fmtMs(detail.ms)}`, 'debug');
            }
        });
        const solveMs = performance.now() - tSolve;
        lastResult = result; lastInput = filtered;
        costHistory.push(...(result.cost_history || []));
        const applied = applySbaResults(result, filtered, intr, extr);
        intr = applied.intrinsics; extr = applied.extrinsics;
        const fitRms = Math.sqrt(result.final_cost / Math.max(1, result.num_observations_used));
        P((r + 0.85) / schedule.length, `round ${r + 1}/${schedule.length}: re-triangulating`);
        reproj = await reproject(intr, extr);
        input = prep(reproj, intr, extr);
        const fin = input.meta.pointErr.filter(Number.isFinite);
        roundLog.push({ round: r + 1, label, threshold: mu, pointsFit: filtered.points.length, pointsTotal: errs.length, obsFit: filtered.observations.length, iterations: result.iterations, status: result.status, initialCost: result.initial_cost, finalCost: result.final_cost, fitRms, medianAll: percentile(fin, 0.5), p95All: percentile(fin, 0.95), medianObs: reproj.summary.overall.median, ms: result.ms });
        // Verbose per-round detail: how much each camera moved and how its own error changed.
        const before = prevReproj.summary.perView, after = reproj.summary.perView;
        const rejectedPerCam = new Array(numViews).fill(0);
        for (let i = 0; i < input0Obs.length; i++) if (!keepObs[i]) rejectedPerCam[input.meta.cameraViews[input0Obs[i].camera_idx]]++;
        log(`  round ${r + 1} timings: rejection ${fmtMs(tSolve - tRound)}, solve ${fmtMs(solveMs)} (${result.iterations} iterations${result.chunks ? ` in ${result.chunks} chunks` : ''}), re-triangulation ${fmtMs(performance.now() - tSolve - solveMs)}`, 'debug');
        names.forEach((n, vi) => {
            const e0 = prevExtr[vi], e1 = extr[vi], i0 = prevIntr[vi], i1 = intr[vi];
            if (!e0 || !e1 || e0.error || e1.error) return;
            const dt = norm3(sub3(e1.tvec, e0.tvec));
            const drot = rotationAngle(e0.R, e1.R) * 180 / Math.PI;
            const intrTxt = config.optimize_intrinsics && i0 && i1 ? ` | fx ${i0.fx.toFixed(1)}→${i1.fx.toFixed(1)}, cx ${i0.cx.toFixed(1)}→${i1.cx.toFixed(1)}, cy ${i0.cy.toFixed(1)}→${i1.cy.toFixed(1)}, k1 ${i0.k1.toFixed(4)}→${i1.k1.toFixed(4)}${config.engine === 'wasm' || /k2/.test(config.intrinsics_model || '') ? `, k2 ${i0.k2.toFixed(4)}→${i1.k2.toFixed(4)}` : ''}` : '';
            log(`    ${n.padEnd(10)} moved ${dt.toFixed(2)} mm, rotated ${drot.toFixed(3)}°, ${rejectedPerCam[vi]} obs rejected | median err ${before[vi] ? before[vi].median.toFixed(2) : '–'} → ${after[vi] ? after[vi].median.toFixed(2) : '–'} px (p95 ${before[vi] ? before[vi].p95.toFixed(1) : '–'} → ${after[vi] ? after[vi].p95.toFixed(1) : '–'})${intrTxt}`, 'debug');
        });
        log(`SBA ${label}, round ${r + 1}/${schedule.length} (threshold ${Number.isFinite(mu) ? mu.toFixed(1) : 'none'} px${clampNote}; point-error distribution before: median ${percentile(finite, 0.5).toFixed(2)}, p80 ${percentile(finite, 0.8).toFixed(2)}, p95 ${percentile(finite, 0.95).toFixed(2)} px): fit on ${filtered.points.length}/${errs.length} points / ${filtered.observations.length} obs, ` +
            `${result.iterations} iters, cost ${result.initial_cost.toFixed(0)} → ${result.final_cost.toFixed(0)} (${result.status}, fit RMS ≈ ${fitRms.toFixed(2)} px) in ${fmtMs(result.ms)}; ` +
            `re-triangulated all observations: median ${reproj.summary.overall.median.toFixed(2)} px, p95 ${reproj.summary.overall.p95.toFixed(2)} px`, 'info');
    }
    if (!lastResult) throw new Error('bundle adjustment produced no result');
    return { label, config, intr, extr, reproj, input, lastResult, lastInput, lastMu, roundLog, costHistory };
}

/**
 * After bundle adjustment changed K / dist, re-solve every valid frame's board pose with the
 * refined intrinsics so the per-frame errors describe the calibration actually in use.
 * Returns a NEW intrinsics array (inputs untouched); `used` / `counts` / `selectedFrames`
 * (which frames the original fit used) are kept. `request(payload, {onProgress})` is the
 * calib worker's `reprojectFrames` request.
 */
export async function reevaluatePerFrame(intrinsics, store, board, request, onProgress) {
    const out = intrinsics.slice();
    const fractions = new Array(intrinsics.length).fill(1);
    const report = () => onProgress && onProgress(fractions.reduce((a, b) => a + b, 0) / intrinsics.length);
    await Promise.all(intrinsics.map(async (r, v) => {
        if (!r || !r.perFrame) return;
        const frames = Array.from(r.perFrame.frames);
        const samples = frames.map(f => { const d = store.get(f, v); return { frame: f, ids: d.ids, corners: d.corners }; });
        fractions[v] = 0; report();
        const res = await request({ K: r.K, dist: r.dist, samples, board }, { onProgress: (f) => { fractions[v] = f; report(); } });
        fractions[v] = 1; report();
        const errors = res.errors instanceof Float32Array ? res.errors : Float32Array.from(res.errors);
        const rvecs = res.rvecs instanceof Float64Array ? res.rvecs : Float64Array.from(res.rvecs);
        const tvecs = res.tvecs instanceof Float64Array ? res.tvecs : Float64Array.from(res.tvecs);
        // RMS over the frames the original fit used, for the summary table
        let ss = 0, n = 0;
        for (let i = 0; i < errors.length; i++) if (r.perFrame.used[i] && Number.isFinite(errors[i])) { ss += errors[i] * errors[i]; n++; }
        out[v] = { ...r, perFrame: { ...r.perFrame, errors, rvecs, tvecs }, rmsError: n ? Math.sqrt(ss / n) : r.rmsError, perFrameRefreshed: true };
    }));
    return out;
}
