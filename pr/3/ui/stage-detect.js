/**
 * ui/stage-detect.js — Stage 2: board configuration, single-frame detection,
 * and the batch detection runner.
 *
 * Batch detection = one sequential decode pass per view (loading/video.js
 * iterateFrames) feeding the worker pool (loading/detect-pool.js) with a
 * per-view in-flight cap. Nothing is drawn to the display canvases during
 * the run; the DOM sees one throttled progress update at a time.
 */

import { state, controllers, resetDownstreamOfDetection, viewNames, cameraColor } from './app-state.js';
import { DetectionStore } from '../calib/detection-store.js';
import { normalizeBoard, numCorners, numMarkers, legacyPatternDiffers } from '../calib/board.js';
import { CALIBIO_PRESETS, presetById, presetBoard, presetForBoard } from '../calib/board-presets.js';
import { identifyCalibioBoard, AUTO_SEARCH, sizeAmbiguityText } from '../calib/board-identify.js';
import { stridedFrames } from '../calib/frame-selection.js';
import { log, fmtMs } from './log-panel.js';
import { $, el, intInput, numInput, setStageStatus, expandStage, setEnabled, showError, Progress, errorColor } from './stages.js';
import { FrameStrip, viridisLike } from './frame-strip.js';
import { VirtualTable } from './virtual-table.js';
import { emit, on } from './events.js';
import { registerKeyHandler } from './video-panel.js';

const MAX_INFLIGHT_PER_VIEW = 2;   // frames handed to the pool but not yet returned, per view
const THUMB_WIDTH = 160;
const BOARD_FIELDS = ['boardX', 'boardY', 'squareLength', 'markerLength', 'arucoDict', 'boardPattern'];
// Auto (calib.io): dictionaries searched, in order (stop at the first with AUTO_ENOUGH markers), and
// how many frames (current first, then spread over the sampled ones) it may look at. Shared with
// the command line (calib/board-identify.js AUTO_SEARCH).
const AUTO_DICTS = AUTO_SEARCH.dicts;
const AUTO_ENOUGH = AUTO_SEARCH.enough;
const AUTO_MAX_FRAMES = AUTO_SEARCH.maxFrames;

let urlPreset = null;          // ?board= in the page URL: wins over a board.toml
let autoObservations = null;   // Auto's marker detections so far (cleared when a session opens)

let strip = null, table = null, progress = null;

export function setupDetectStage() {
    progress = new Progress('detectionProgress');
    for (const id of BOARD_FIELDS) $(id).addEventListener('change', onBoardFormChanged);
    buildPresetSelect();
    $('boardPreset').addEventListener('change', () => applyPresetChoice($('boardPreset').value));
    applyUrlBoard();
    onBoardFormChanged();
    $('targetSamples').addEventListener('input', updateSamplingInfo);
    $('allFramesCheck').addEventListener('change', updateSamplingInfo);
    $('detectCurrentBtn').addEventListener('click', () => detectCurrentFrame());
    $('runDetectionBtn').addEventListener('click', () => runBatchDetection());
    $('cancelDetectionBtn').addEventListener('click', () => state.detectionAbort && state.detectionAbort.abort());
    $('prevSampledBtn').addEventListener('click', () => stepSampled(-1));
    $('nextSampledBtn').addEventListener('click', () => stepSampled(1));
    $('tableMinCommon').addEventListener('input', renderTable);
    $('tableFilter').addEventListener('change', renderTable);

    strip = new FrameStrip($('detectionStrip'), {
        height: 40,
        tooltipEl: $('detectionStripTooltip'),
        tooltip: (f) => {
            const s = state.detections;
            const parts = state.views.map((v, i) => `${v.name.padEnd(10)} ${s.count(f, i)}`);
            return `frame ${f} · common ${s.commonCount(f)}\n${parts.join('\n')}`;
        },
        onClick: (f) => controllers.video.seekToFrame(f),
    });
    table = new VirtualTable($('detectionTable'), {
        columns: [],   // set when views are known
        height: 300,
        rowHeight: 24,
        onRowClick: (row) => controllers.video.seekToFrame(row.frame),
        emptyText: 'No frames match the filter',
    });

    on('session-loaded', () => { autoObservations = null; updateSamplingInfo(); buildTableColumns(); state.liveDetection = null; $('detectionResults').style.display = 'none'; $('detectCurrentResult').textContent = ''; });
    on('frame', ({ frame }) => { strip.setCurrent(frame); if (state.detections && state.detections.has(frame)) table.setSelected(frame, { scroll: true }); });

    registerKeyHandler((e) => {
        if (e.key === '[') { stepSampled(-1); return true; }
        if (e.key === ']') { stepSampled(1); return true; }
        if (e.key === 'd' || e.key === 'D') { detectCurrentFrame(); return true; }
        return false;
    });
}

// ---- board form --------------------------------------------------------------

/** 'auto' | 'new' | 'legacy' as selected; resolvePattern() turns 'auto' into a concrete choice. */
export function boardPatternChoice() { return $('boardPattern') ? $('boardPattern').value : 'new'; }

export function getBoardFromForm() {
    return normalizeBoard({
        boardX: intInput('boardX', 8), boardY: intInput('boardY', 11),
        squareLength: numInput('squareLength', 24), markerLength: numInput('markerLength', 18.75),
        dictName: $('arucoDict').value,
        legacyPattern: boardPatternChoice() === 'legacy',
    });
}

/**
 * Fill the form from a board config (board.toml, saved session). The preset select follows:
 * board.preset 'auto' selects Auto; values that are a calib.io board, value for value, select
 * that preset; anything else is Custom.
 */
export function setBoardForm(board, sourceLabel = '') {
    if (board.boardX) $('boardX').value = board.boardX;
    if (board.boardY) $('boardY').value = board.boardY;
    if (board.squareLength) $('squareLength').value = board.squareLength;
    if (board.markerLength) $('markerLength').value = board.markerLength;
    if (board.dictName) $('arucoDict').value = board.dictName;
    if ($('boardPattern') && board.legacyPattern !== undefined) $('boardPattern').value = board.legacyPattern ? 'legacy' : (sourceLabel ? 'new' : $('boardPattern').value);
    $('boardSource').textContent = sourceLabel ? `(from ${sourceLabel})` : '';
    let choice = 'custom';
    if (board.preset === 'auto') choice = 'auto';
    else { try { const p = presetForBoard(getBoardFromForm()); if (p) choice = p.id; } catch (_) { /* invalid values: Custom */ } }
    applyPresetChoice(choice, { fill: false });
}

// ---- board presets (calib/board-presets.js) ---------------------------------------

/** 'custom' | 'auto' | a preset id. */
export function boardPresetChoice() { return $('boardPreset') ? $('boardPreset').value : 'custom'; }

/** The ?board= of the page URL when it set a preset or Auto (a board.toml then doesn't), else null. */
export function boardSetByUrl() { return urlPreset; }

function buildPresetSelect() {
    const sel = $('boardPreset');
    const groups = [];
    for (const p of CALIBIO_PRESETS) {
        const name = `calib.io ChArUco, ${p.pattern}${p.material === 'ceramic' ? ' (ceramic)' : ''}`;
        let g = groups.find(x => x.name === name);
        if (!g) { g = { name, items: [] }; groups.push(g); }
        g.items.push(el('option', { value: p.id, title: `${p.label}, ${p.markerLength} mm markers, ${p.dictName} (${p.sku}; ${p.source})` },
            `${p.plate[0]} × ${p.plate[1]} mm — ${p.rows} × ${p.cols}, ${p.squareLength} mm squares (${p.sku})`));
    }
    sel.replaceChildren(
        el('option', { value: 'custom' }, 'Custom (enter below)'),
        el('option', { value: 'auto' }, 'Auto: identify a calib.io board'),
        ...groups.map(g => el('optgroup', { label: g.name }, g.items)),
    );
    sel.value = 'custom';
}

/**
 * Select a preset choice. A preset fills the fields (unless `fill` is false: they already hold
 * its values) and locks them; Custom and Auto unlock them (Auto reads Square as a size hint).
 */
function applyPresetChoice(choice, { fill = true } = {}) {
    const p = presetById(choice);
    const value = p ? p.id : (choice === 'auto' ? 'auto' : 'custom');
    $('boardPreset').value = value;
    if (p && fill) {
        const b = presetBoard(p);
        $('boardX').value = b.boardX; $('boardY').value = b.boardY;
        $('squareLength').value = b.squareLength; $('markerLength').value = b.markerLength;
        $('arucoDict').value = b.dictName;
        $('boardPattern').value = b.legacyPattern ? 'legacy' : 'new';
    }
    for (const id of BOARD_FIELDS) $(id).disabled = !!p;
    $('boardPresetInfo').textContent = p
        ? `${p.sku} · ${p.material} · ${p.markerLength} mm markers · ${p.dictName} — Custom to edit`
        : value === 'auto'
            ? 'identified from the markers when you detect; if Square holds one of calib.io\'s square sizes, it picks the size'
            : '';
    onBoardFormChanged();
}

/** ?board=<preset id | SKU | auto | custom> (and ?square=<mm>, Auto's size hint) from the page URL. */
function applyUrlBoard() {
    let params;
    try { params = new URLSearchParams(globalThis.location ? location.search : ''); } catch (_) { return; }
    const v = params.get('board');
    const square = params.get('square');
    if (square !== null) {
        if (Number(square) > 0) $('squareLength').value = Number(square);
        else showError(`?square=${square}: not a square size`);
    }
    if (v === null) return;
    const key = v.trim().toLowerCase();
    if (key !== 'auto' && key !== 'custom' && !presetById(key)) {
        showError(`?board=${v}: unknown board preset (known: auto, custom, ${CALIBIO_PRESETS.map(p => p.id).join(', ')}, or a calib.io SKU)`);
        return;
    }
    const choice = presetById(key) ? presetById(key).id : key;
    applyPresetChoice(choice);
    if (choice === 'custom') return;          // nothing to hold: a board.toml still fills the form
    urlPreset = choice;
    $('boardSource').textContent = '(from the page URL)';
    log(`Board preset from the page URL: ${choice}${presetById(key) ? ` — ${presetById(key).label}` : ''} (a board.toml in the session folder won't replace it)`);
}

/** The Square field as Auto's size hint, or null. */
function squareHint() {
    const v = parseFloat($('squareLength').value);
    return Number.isFinite(v) && v > 0 ? v : null;
}

/** Frames Auto may look at: the current one, then up to AUTO_MAX_FRAMES - 1 spread over the planned ones. */
function autoFrames() {
    const out = [state.currentFrame];
    const planned = state.totalFrames ? plannedFrames().frames : [];
    const want = Math.min(AUTO_MAX_FRAMES - 1, planned.length);
    for (let k = 0; k < want; k++) {
        const f = planned[Math.floor(((k + 0.5) * planned.length) / want)];
        if (f !== undefined && !out.includes(f)) out.push(f);
    }
    return out;
}

/**
 * Find which calib.io board the videos show: ArUco markers of each view on the current frame,
 * then on more frames until calib/board-identify.js decides (or AUTO_MAX_FRAMES).
 */
async function identifyBoardFromVideo() {
    const pool = controllers.pool;
    await pool.init();
    const obs = autoObservations || [];
    const done = new Set(obs.map(o => o.frame));
    let r = identifyCalibioBoard(obs, { squareHint: squareHint() });
    if (r.status === 'match' || r.status === 'size-ambiguous') return r;
    let framesWithMarkers = new Set(obs.filter(o => o.ids.length).map(o => o.frame)).size;
    for (const frame of autoFrames()) {
        if (done.has(frame)) continue;
        done.add(frame);
        const res = await Promise.all(state.views.map(async (view, v) => {
            const fr = await view.decoder.getFrame(frame);
            if (!fr) return null;
            const copy = await createImageBitmap(fr.bitmap);   // the cached bitmap must not be transferred away
            return pool.markers({ frame, view: v, image: copy, width: view.canvas.width, height: view.canvas.height, dictNames: AUTO_DICTS, enough: AUTO_ENOUGH });
        }));
        let any = false;
        for (const m of res) {
            if (!m) continue;
            for (const x of m.results) { obs.push({ frame, view: m.view, dictName: x.dictName, ids: x.ids, corners: x.corners }); if (x.ids.length) any = true; }
        }
        if (any) framesWithMarkers++;
        autoObservations = obs;
        r = identifyCalibioBoard(obs, { squareHint: squareHint() });
        log(`Auto (calib.io), frame ${frame}: ${r.status} — ${r.reason}`, 'debug');
        if (r.status === 'match' || r.status === 'size-ambiguous') break;
        if (r.status === 'no-match' && framesWithMarkers >= 3) break;
    }
    return r;
}

/**
 * With Auto selected, identify the board and select its preset; otherwise do nothing.
 * Throws (with what to do) when it can't: no calib.io board (back to Custom), or a grid
 * calib.io sells in several sizes (stays on Auto: pick the size, or type it in Square).
 */
async function resolvePreset() {
    if (boardPresetChoice() !== 'auto') return;
    const t0 = performance.now();
    const r = await identifyBoardFromVideo();
    if (r.status === 'match') {
        applyPresetChoice(r.preset.id);
        log(`Auto (calib.io): ${r.preset.label} (${r.preset.sku}), found in ${fmtMs(performance.now() - t0)} — ${r.reason}`, 'success');
        return;
    }
    if (r.status === 'size-ambiguous') {
        log(`Auto (calib.io): ${r.reason}`, 'warn');
        throw new Error(`Auto (calib.io): ${sizeAmbiguityText(r)} Pick yours under Board preset, or type its square size in Square and detect again.`);
    }
    applyPresetChoice('custom');
    log(`Auto (calib.io): no calib.io board identified — ${r.reason}. Board preset is back on Custom.`, 'warn');
    throw new Error(`Auto (calib.io): no calib.io board identified (${r.reason}). Board preset is back on Custom: enter the board's values.`);
}

/**
 * Resolve the 'auto' board pattern by detecting the current frame in every view with both
 * conventions and keeping the one that finds more corners. Only matters for even-row boards.
 * Sets the select to the winner so batch detection and the exported board.toml are explicit.
 */
async function resolvePattern(board) {
    if (boardPatternChoice() !== 'auto') return board;
    if (!legacyPatternDiffers(board)) {
        log(`Board pattern: ${board.boardY} rows (odd) — legacy and current ChArUco layouts are identical, nothing to probe`);
        $('boardPattern').value = 'new';
        return normalizeBoard({ ...board, legacyPattern: false });
    }
    const pool = controllers.pool;
    const frame = state.currentFrame;
    const fast = $('fastDetectCheck').checked;
    const score = async (legacy) => {
        const b = normalizeBoard({ ...board, legacyPattern: legacy });
        await pool.configure(b, { fastMarkers: fast });
        const rs = await Promise.all(state.views.map(async (view, v) => {
            const r = await view.decoder.getFrame(frame);
            if (!r) return null;
            const copy = await createImageBitmap(r.bitmap);
            return pool.detect({ frame, view: v, image: copy, width: view.canvas.width, height: view.canvas.height });
        }));
        return { corners: rs.reduce((a, r) => a + (r ? r.ids.length : 0), 0), markers: rs.reduce((a, r) => a + (r ? r.numMarkers : 0), 0) };
    };
    const cur = await score(false), leg = await score(true);
    const legacy = leg.corners > cur.corners;
    $('boardPattern').value = legacy ? 'legacy' : 'new';
    log(`Board pattern probe on frame ${frame} (${board.boardX}x${board.boardY}, even rows): current layout ${cur.corners} corners / ${cur.markers} markers, legacy (< 4.6) layout ${leg.corners} corners / ${leg.markers} markers → using ${legacy ? 'legacy' : 'current'}${cur.corners === 0 && leg.corners === 0 ? ' (neither found the board on this frame — pick a frame that shows it and detect again)' : ''}`, cur.corners === 0 && leg.corners === 0 ? 'warn' : 'info');
    return normalizeBoard({ ...board, legacyPattern: legacy });
}

function onBoardFormChanged() {
    try {
        state.board = getBoardFromForm();
        const choice = boardPresetChoice();
        $('boardInfo').textContent = `${numCorners(state.board)} corners · ${numMarkers(state.board)} markers${choice === 'auto' ? ' (until Auto identifies the board)' : ''}`;
        $('boardInfo').style.color = '';
        emit('board-changed', { board: state.board });
    } catch (e) {
        $('boardInfo').textContent = e.message;
        $('boardInfo').style.color = 'var(--bad)';
    }
}

function updateSamplingInfo() {
    if (!state.totalFrames) { $('computedStride').textContent = '–'; $('framesToProcess').textContent = '–'; return; }
    const { frames, stride } = plannedFrames();
    $('computedStride').textContent = String(stride);
    $('framesToProcess').textContent = `${frames.length} × ${state.views.length} views`;
    $('poolInfo').textContent = controllers.pool ? `${controllers.pool.size}` : '–';
}

function plannedFrames() {
    if ($('allFramesCheck').checked) return { frames: Array.from({ length: state.totalFrames }, (_, i) => i), stride: 1 };
    return stridedFrames(state.totalFrames, Math.max(1, intInput('targetSamples', 100)));
}

// ---- single frame --------------------------------------------------------------

export async function detectCurrentFrame() {
    if (!state.views.length || state.detectionRunning) return;
    const pool = controllers.pool;
    const frame = state.currentFrame;
    const t0 = performance.now();
    try {
        $('detectCurrentResult').textContent = 'detecting…';
        await resolvePreset();
        const board = await resolvePattern(getBoardFromForm());
        state.board = board;
        await pool.configure(board, { fastMarkers: $('fastDetectCheck').checked });
        const results = await Promise.all(state.views.map(async (view, v) => {
            const r = await view.decoder.getFrame(frame);
            if (!r) return null;
            // Copy: the cached bitmap must not be transferred away.
            const copy = await createImageBitmap(r.bitmap);
            return pool.detect({ frame, view: v, image: copy, width: view.canvas.width, height: view.canvas.height });
        }));
        state.liveDetection = { frame, perView: results.map(r => r ? { ids: r.ids, corners: r.corners } : null) };
        const parts = results.map((r, v) => `${state.views[v].name}: ${r ? `${r.numMarkers} markers / ${r.ids.length} corners (${r.ms.toFixed(0)} ms)` : 'no frame'}`);
        $('detectCurrentResult').textContent = parts.join(' · ');
        log(`Frame ${frame}: ${parts.join('; ')} — total ${fmtMs(performance.now() - t0)}`, results.some(r => r && r.ids.length) ? 'success' : 'warn');
        controllers.video.redraw();
    } catch (e) {
        showError(`Detection failed: ${e.message}`);
        $('detectCurrentResult').textContent = e.message;
    }
}

// ---- batch --------------------------------------------------------------------

export async function runBatchDetection() {
    if (!state.views.length || state.detectionRunning) return;
    const pool = controllers.pool;
    const vc = controllers.video;
    if (state.isPlaying) vc.stopPlayback();
    let board;
    try { await resolvePreset(); }
    catch (e) { showError(e.message); return; }
    try { board = await resolvePattern(getBoardFromForm()); state.board = board; }
    catch (e) { showError(`Board pattern probe failed: ${e.message}`); return; }
    const { frames, stride } = plannedFrames();
    const nViews = state.views.length;
    const totalJobs = frames.length * nViews;

    state.detectionRunning = true;
    const abort = new AbortController();
    state.detectionAbort = abort;
    setEnabled('runDetectionBtn', false);
    setEnabled('detectCurrentBtn', false);
    setEnabled('computeIntrinsicsBtn', false);
    setEnabled('computeExtrinsicsBtn', false);
    $('cancelDetectionBtn').style.display = '';
    setStageStatus('stage2', 'Detecting…', 'active');
    progress.show(`0 / ${totalJobs}`);
    $('detectionResults').style.display = 'none';
    log(`Batch detection: ${frames.length} frames (stride ${stride}) × ${nViews} views = ${totalJobs} detections, board ${board.boardX}x${board.boardY} ${board.dictName}, ${pool.size} worker(s)`);

    const store = new DetectionStore(viewNames());
    state.detections = store;
    state.sampledFrames = frames.slice();
    state.thumbnails = new Map();
    state.liveDetection = null;
    resetDownstreamOfDetection();
    for (const f of frames) store.touch(f);

    const t0 = performance.now();
    let done = 0, failed = 0, lastUi = 0;
    const perViewDone = new Array(nViews).fill(0);
    const decodedAtStart = state.views.reduce((a, v) => a + v.decoder.stats.decoded, 0);
    const update = (force) => {
        const now = performance.now();
        if (!force && now - lastUi < 100) return;
        lastUi = now;
        const el = (now - t0) / 1000;
        const rate = done / Math.max(1e-3, el);
        const eta = rate > 0 ? (totalJobs - done) / rate : 0;
        progress.set(done / totalJobs, `${done} / ${totalJobs} · ${rate.toFixed(1)}/s · ETA ${fmtMs(eta * 1000)}`);
        $('detectionRate').textContent = `decoded ${state.views.reduce((a, v) => a + v.decoder.stats.decoded, 0) - decodedAtStart} frames for ${totalJobs} samples`;
    };
    const ticker = setInterval(() => update(false), 200);

    try {
        await pool.configure(board, { fastMarkers: $('fastDetectCheck').checked });
        const t1 = performance.now();
        await Promise.all(state.views.map(async (view, v) => {
            const inflight = new Set();
            const decoder = view.decoder;
            const decodedBefore = decoder.stats.decoded;
            try {
                for await (const { frame, videoFrame } of decoder.iterateFrames(frames, { maxPending: 2, signal: abort.signal })) {
                    if (abort.signal.aborted) { videoFrame.close(); break; }
                    while (inflight.size >= MAX_INFLIGHT_PER_VIEW) await Promise.race(inflight);
                    let p;
                    try {
                        p = pool.detect({ frame, view: v, image: videoFrame, width: view.info.width, height: view.info.height, wantThumb: v === 0, thumbWidth: THUMB_WIDTH });
                    } catch (e) {
                        try { videoFrame.close(); } catch (_) { /* */ }
                        throw e;
                    }
                    const job = p.then((res) => {
                        store.set(frame, v, res);
                        if (res.thumb) state.thumbnails.set(frame, res.thumb);
                    }, (err) => {
                        failed++;
                        store.set(frame, v, null);
                        log(`${view.name} frame ${frame}: detection error: ${err.message}`, 'debug');
                    }).finally(() => { inflight.delete(job); done++; perViewDone[v]++; });
                    inflight.add(job);
                }
            } catch (e) {
                if (!abort.signal.aborted) log(`${view.name}: decode error during batch: ${e.message}`, 'error');
            }
            await Promise.all(inflight);
            log(`${view.name}: decoded ${decoder.stats.decoded - decodedBefore} frames for ${frames.length} samples`, 'debug');
        }));
        const total = performance.now() - t0;
        clearInterval(ticker);
        update(true);
        const summary = store.summary(intInput('minCorners', 6));
        const avgMs = pool.stats.detections ? pool.stats.totalMs / pool.stats.detections : 0;
        const status = abort.signal.aborted ? 'cancelled' : 'complete';
        log(`Batch detection ${status} in ${fmtMs(total)} (configure ${fmtMs(t1 - t0)}): ${done} detections, ${failed} errors, ` +
            `${(done / (total / 1000)).toFixed(1)} det/s wall, ${avgMs.toFixed(0)} ms/detection in-worker; ` +
            `${summary.framesWithAnyDetection}/${frames.length} frames with a board, ${summary.framesAllViewsGood} good in all views; ` +
            `per view: ${state.views.map((v, i) => `${v.name}=${summary.perView[i]}`).join(' ')}`, abort.signal.aborted ? 'warn' : 'success');
        setStageStatus('stage2', `${summary.framesAllViewsGood} frames good in all views (${frames.length} sampled)`, abort.signal.aborted ? 'warn' : 'complete');
        if (abort.signal.aborted) progress.fail('Cancelled'); else progress.hide();
        renderResults();
        setStageStatus('stage3', 'Ready');
        setEnabled('computeIntrinsicsBtn', true);
        setEnabled('saveSessionBtn', true);
        expandStage('stage3');
        emit('detections-changed', {});
        vc.redraw();
    } catch (e) {
        clearInterval(ticker);
        progress.fail(e.message);
        setStageStatus('stage2', 'Failed', 'error');
        showError(`Batch detection failed: ${e.message}`);
        log(`Batch detection failed: ${e.stack || e.message}`, 'error');
    } finally {
        state.detectionRunning = false;
        state.detectionAbort = null;
        $('cancelDetectionBtn').style.display = 'none';
        setEnabled('runDetectionBtn', true);
        setEnabled('detectCurrentBtn', true);
    }
}

// ---- results ------------------------------------------------------------------

function buildTableColumns() {
    const cols = [{ key: 'frame', label: 'Frame', width: '80px', align: 'right' }];
    state.views.forEach((v, i) => cols.push({
        key: `c${i}`, label: v.name, width: '1fr', align: 'right',
        render: (r) => r.counts[i],
        color: (r) => (r.counts[i] >= 6 ? cameraColor(i) : (r.counts[i] > 0 ? '#fbbf24' : '#666')),
    }));
    cols.push({ key: 'common', label: 'Common', width: '90px', align: 'right', color: (r) => errorColor(-r.common, -6, -1) });
    cols.push({ key: 'views', label: 'Views', width: '70px', align: 'right' });
    table.columns = cols;
    table._build();
}

export function renderResults() {
    const store = state.detections;
    if (!store) return;
    $('detectionResults').style.display = '';
    const frames = store.frames();
    const maxCorners = numCorners(state.board);
    strip.setData({
        frames,
        colorFn: (f) => { const c = store.commonCount(f); return c === 0 ? '#2a2a2a' : viridisLike(Math.min(1, c / maxCorners)); },
        excluded: new Set(),
    });
    $('detectionStripLegend').replaceChildren(
        el('span', {}, [el('span', { class: 'sw', style: { background: '#2a2a2a' } }), 'no common corners']),
        el('span', {}, [el('span', { class: 'sw', style: { background: viridisLike(0.25) } }), `${Math.round(maxCorners * 0.25)}`]),
        el('span', {}, [el('span', { class: 'sw', style: { background: viridisLike(0.5) } }), `${Math.round(maxCorners * 0.5)}`]),
        el('span', {}, [el('span', { class: 'sw', style: { background: viridisLike(1) } }), `${maxCorners} common`]),
    );
    const s = store.summary(intInput('minCorners', 6));
    $('detectionSummary').textContent = `${frames.length} sampled · ${s.framesWithAnyDetection} with a board · ${s.framesAllViewsGood} good in all views`;
    if (table.columns.length === 0) buildTableColumns();
    renderTable();
}

function renderTable() {
    const store = state.detections;
    if (!store) return;
    const minCommon = intInput('tableMinCommon', 0);
    const filter = $('tableFilter').value;
    const nViews = state.views.length;
    const rows = [];
    for (const f of store.frames()) {
        const counts = state.views.map((_, i) => store.count(f, i));
        const views = counts.filter(c => c > 0).length;
        const common = store.commonCount(f);
        if (common < minCommon) continue;
        if (filter === 'any' && views === 0) continue;
        if (filter === 'allviews' && views < nViews) continue;
        if (filter === 'failed' && views === nViews) continue;
        rows.push({ frame: f, counts, common, views: `${views}/${nViews}` });
    }
    table.setRows(rows);
    $('tableCount').textContent = `${rows.length} rows`;
    if (store.has(state.currentFrame)) table.setSelected(state.currentFrame);
}

export function stepSampled(dir) {
    const frames = state.detections ? state.detections.frames() : state.sampledFrames;
    if (!frames || !frames.length) return;
    const cur = state.currentFrame;
    let target;
    if (dir > 0) target = frames.find(f => f > cur);
    else { for (let i = frames.length - 1; i >= 0; i--) if (frames[i] < cur) { target = frames[i]; break; } }
    if (target === undefined) target = dir > 0 ? frames[0] : frames[frames.length - 1];
    controllers.video.seekToFrame(target);
}
