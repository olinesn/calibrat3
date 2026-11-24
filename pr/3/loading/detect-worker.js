/**
 * loading/detect-worker.js — ChArUco detection in a Web Worker.
 *
 * Classic worker (importScripts) because opencv.js is a UMD/global script.
 * The dictionary, board, parameters and both detectors are built ONCE per
 * board config and reused for every frame.
 *
 * Protocol (all messages carry `type`):
 *   -> {type:'configure', board}
 *   <- {type:'configured', key}
 *   -> {type:'detect', requestId, frame, view, image: VideoFrame|ImageBitmap, width, height,
 *          wantThumb?:boolean, thumbWidth?:number}
 *      or {type:'detect', requestId, frame, view, gray: Uint8Array(width*height), width, height}
 *          an 8-bit luma image (the command line's ffmpeg frames; no canvas, no thumbnail)
 *   <- {type:'result', requestId, frame, view, ids:Int32Array, corners:Float32Array,
 *          numMarkers, ms, timings:{convert,markers,charuco}, thumb: Blob|null}
 *   -> {type:'markers', requestId, frame, view, image | gray, width, height, dictNames:string[], enough?:number}
 *   <- {type:'markers', requestId, frame, view, ms, results:[{dictName, ids:Int32Array,
 *          corners:Float32Array(8 per marker, the detector's TL, TR, BR, BL order)}]}
 *      ArUco markers only (no board needed, nothing to configure first): each dictionary in
 *      turn, stopping after the first that finds `enough` markers. Used to identify a board.
 *   <- {type:'error', requestId?, error}
 *   <- {type:'ready'}   once OpenCV is initialized
 *   <- {type:'log', level, msg}
 */

/* global importScripts, cv, OffscreenCanvas */

importScripts('../lib/opencv/opencv.js');

let CV = null;
let M = null;            // { board } — the ESM board module (dynamic import works in classic workers)
let det = null;          // cached detector bundle
let canvas = null, ctx = null;
let thumbCanvas = null, thumbCtx = null;
const queue = [];
let ready = false;

const DICT_IDS = () => ({
    DICT_4X4_50: CV.DICT_4X4_50, DICT_4X4_100: CV.DICT_4X4_100, DICT_4X4_250: CV.DICT_4X4_250, DICT_4X4_1000: CV.DICT_4X4_1000,
    DICT_5X5_50: CV.DICT_5X5_50, DICT_5X5_100: CV.DICT_5X5_100, DICT_5X5_250: CV.DICT_5X5_250, DICT_5X5_1000: CV.DICT_5X5_1000,
    DICT_6X6_50: CV.DICT_6X6_50, DICT_6X6_100: CV.DICT_6X6_100, DICT_6X6_250: CV.DICT_6X6_250, DICT_6X6_1000: CV.DICT_6X6_1000,
});

function log(msg, level = 'info') { postMessage({ type: 'log', level, msg }); }

/**
 * Resolve the initialized OpenCV module. Emscripten's MODULARIZE build exposes
 * `cv.then(cb)` but that `then` RETURNS THE MODULE (a thenable) — so `await cv`
 * or `resolve(cv)` recurses forever. Never await the module directly; hand it
 * back wrapped in a plain object.
 */
function whenOpenCVReady(cvObj) {
    return new Promise((resolve, reject) => {
        if (!cvObj) { reject(new Error('cv global is undefined')); return; }
        const done = (m) => resolve({ module: m });
        if (typeof cvObj.Mat === 'function') { done(cvObj); return; }
        if (typeof cvObj.then === 'function') {
            cvObj.then((m) => done(m && typeof m.Mat === 'function' ? m : cvObj));
            return;
        }
        const prev = cvObj.onRuntimeInitialized;
        cvObj.onRuntimeInitialized = () => { if (typeof prev === 'function') prev(); done(cvObj); };
    });
}

(async () => {
    try {
        const [{ module: m }, board] = await Promise.all([whenOpenCVReady(cv), import('../calib/board.js')]);
        CV = m; M = { board };
        ready = true;
        postMessage({ type: 'ready' });
        while (queue.length) handle(queue.shift());
    } catch (e) {
        postMessage({ type: 'error', error: `OpenCV init failed: ${e.message || e}` });
    }
})();

onmessage = (e) => { if (!ready) queue.push(e.data); else handle(e.data); };

function handle(msg) {
    try {
        switch (msg.type) {
            case 'configure': configure(msg.board, msg.options || {}); break;
            case 'detect': detect(msg); break;
            case 'markers': findMarkers(msg); break;
            case 'close': dispose(); disposeMarkerDetectors(); close(); break;
            default: postMessage({ type: 'error', error: `unknown message type ${msg.type}` });
        }
    } catch (err) {
        if (msg.image && typeof msg.image.close === 'function') { try { msg.image.close(); } catch (_) { /* */ } }
        postMessage({ type: 'error', requestId: msg.requestId, error: err.message || String(err) });
    }
}

function boardKey(b) { return `${b.boardX}x${b.boardY}|${b.squareLength}|${b.markerLength}|${b.dictName}${b.legacyPattern ? '|legacy' : ''}`; }

function dispose() {
    if (!det) return;
    for (const k of ['charucoDetector', 'arucoDetector', 'charucoParams', 'refineParams', 'detectorParams', 'board', 'dictionary']) {
        try { det[k] && det[k].delete(); } catch (_) { /* */ }
    }
    det = null;
}

let fastMarkers = true;    // search markers on a half-resolution image when the frame is large; corners are refined at full resolution

function configure(board, options) {
    fastMarkers = options.fastMarkers !== false;
    const key = boardKey(board);
    if (det && det.key === key) { postMessage({ type: 'configured', key }); return; }
    dispose();
    const dictId = DICT_IDS()[board.dictName];
    if (dictId === undefined) throw new Error(`Unknown dictionary ${board.dictName}`);
    const dictionary = CV.getPredefinedDictionary(dictId);
    // Legacy (OpenCV < 4.6) boards are emulated with a one-row-taller board and placeholder ids
    // in the phantom row; detected corner ids are shifted back in detect(). See calib/board.js.
    const layout = M.board.detectorLayout(board);
    const ids = layout.ids ? CV.matFromArray(layout.ids.length, 1, CV.CV_32S, layout.ids) : new CV.Mat();
    const cvBoard = new CV.aruco_CharucoBoard(new CV.Size(layout.sizeX, layout.sizeY), board.squareLength, board.markerLength, dictionary, ids);
    ids.delete();
    const detectorParams = new CV.aruco_DetectorParameters();
    // Subpixel corner refinement makes a measurable difference for calibration.
    if ('cornerRefinementMethod' in detectorParams && CV.CORNER_REFINE_SUBPIX !== undefined) {
        try { detectorParams.cornerRefinementMethod = CV.CORNER_REFINE_SUBPIX; } catch (_) { /* read-only in some builds */ }
    }
    const refineParams = new CV.aruco_RefineParameters(10.0, 3.0, true);
    const arucoDetector = new CV.aruco_ArucoDetector(dictionary, detectorParams, refineParams);
    const charucoParams = new CV.aruco_CharucoParameters();
    const charucoDetector = new CV.aruco_CharucoDetector(cvBoard, charucoParams, detectorParams, refineParams);
    det = { key, dictionary, board: cvBoard, detectorParams, refineParams, arucoDetector, charucoParams, charucoDetector, cornerIdOffset: layout.cornerIdOffset };
    postMessage({ type: 'configured', key });
}

function ensureCanvas(w, h) {
    if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h);
        ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
}

function detect(msg) {
    if (!det) throw new Error('detector not configured');
    const t0 = performance.now();
    const { requestId, frame, view, image, width, height } = msg;
    if (msg.gray) return detectGray(msg, t0);
    const w = width || image.displayWidth || image.width;
    const h = height || image.displayHeight || image.height;
    ensureCanvas(w, h);
    ctx.drawImage(image, 0, 0, w, h);

    let thumb = null;
    let thumbPromise = null;
    if (msg.wantThumb) {
        const tw = msg.thumbWidth || 160;
        const th = Math.max(1, Math.round(h * tw / w));
        if (!thumbCanvas || thumbCanvas.width !== tw || thumbCanvas.height !== th) {
            thumbCanvas = new OffscreenCanvas(tw, th);
            thumbCtx = thumbCanvas.getContext('2d');
        }
        thumbCtx.drawImage(image, 0, 0, tw, th);
        thumbPromise = thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    }
    if (typeof image.close === 'function') image.close();

    const imageData = ctx.getImageData(0, 0, w, h);
    const src = CV.matFromImageData(imageData);
    const gray = new CV.Mat();
    CV.cvtColor(src, gray, CV.COLOR_RGBA2GRAY);
    src.delete();
    const t1 = performance.now();
    detectOnGray(gray, w, h, { requestId, frame, view, t0, t1, thumbPromise, thumb });
}

/** Command-line path: the frame is already an 8-bit gray image (ffmpeg -pix_fmt gray). */
function detectGray(msg, t0) {
    const { requestId, frame, view, width: w, height: h } = msg;
    if (msg.gray.length !== w * h) throw new Error(`gray image has ${msg.gray.length} bytes, expected ${w}x${h}`);
    const gray = new CV.Mat(h, w, CV.CV_8UC1);
    gray.data.set(msg.gray);
    detectOnGray(gray, w, h, { requestId, frame, view, t0, t1: performance.now(), thumbPromise: null, thumb: null });
}

/** Markers + ChArUco corners on a gray Mat (deleted here), then post the result. */
function detectOnGray(gray, w, h, { requestId, frame, view, t0, t1, thumbPromise, thumb }) {
    let markerCorners = new CV.MatVector();
    let markerIds = new CV.Mat();
    const rejected = new CV.MatVector();
    let searchScale = 1;
    if (fastMarkers && Math.max(w, h) >= 1400) {
        // Marker search at half resolution (~3-4x cheaper); the ChArUco corner interpolation +
        // subpixel refinement below still runs on the full-resolution gray image.
        searchScale = 0.5;
        const small = new CV.Mat();
        CV.resize(gray, small, new CV.Size(Math.round(w * searchScale), Math.round(h * searchScale)), 0, 0, CV.INTER_AREA);
        det.arucoDetector.detectMarkers(small, markerCorners, markerIds, rejected);
        small.delete();
        if (markerIds.rows >= 4) {
            for (let m = 0; m < markerCorners.size(); m++) {
                const c = markerCorners.get(m);
                const d = c.data32F;
                for (let k = 0; k < d.length; k++) d[k] /= searchScale;
                c.delete();
            }
        } else {
            // Too few markers at half resolution (small/far board): redo at full resolution.
            markerCorners.delete(); markerIds.delete();
            markerCorners = new CV.MatVector(); markerIds = new CV.Mat();
            searchScale = 1;
            det.arucoDetector.detectMarkers(gray, markerCorners, markerIds, rejected);
        }
    } else {
        det.arucoDetector.detectMarkers(gray, markerCorners, markerIds, rejected);
    }
    const numMarkers = markerIds.rows;
    const t2 = performance.now();

    let ids = new Int32Array(0), corners = new Float32Array(0);
    if (numMarkers > 0) {
        const cc = new CV.Mat(), ci = new CV.Mat();
        det.charucoDetector.detectBoard(gray, cc, ci, markerCorners, markerIds);
        const n = ci.rows;
        if (n > 0) {
            ids = new Int32Array(n);
            corners = new Float32Array(n * 2);
            let m = 0;
            for (let i = 0; i < n; i++) {
                const id = ci.intAt(i, 0) - det.cornerIdOffset;   // legacy emulation: drop the phantom corner row
                if (id < 0) continue;
                ids[m] = id;
                corners[m * 2] = cc.floatAt(i, 0);
                corners[m * 2 + 1] = cc.floatAt(i, 1);
                m++;
            }
            if (m < n) { ids = ids.slice(0, m); corners = corners.slice(0, m * 2); }
        }
        cc.delete(); ci.delete();
    }
    const t3 = performance.now();
    gray.delete(); markerCorners.delete(); markerIds.delete(); rejected.delete();

    const send = (blob) => {
        postMessage({
            type: 'result', requestId, frame, view, ids, corners, numMarkers,
            ms: t3 - t0, timings: { convert: t1 - t0, markers: t2 - t1, charuco: t3 - t2, searchScale },
            thumb: blob || null,
        }, [ids.buffer, corners.buffer]);
    };
    if (thumbPromise) thumbPromise.then(send, () => send(null)); else send(thumb);
}

// ---- markers only (board identification) -------------------------------------------

const markerDetectors = new Map();   // dictName -> {dictionary, params, detector}

function disposeMarkerDetectors() {
    for (const d of markerDetectors.values()) {
        for (const k of ['detector', 'params', 'dictionary']) { try { d[k] && d[k].delete(); } catch (_) { /* */ } }
    }
    markerDetectors.clear();
}

function markerDetector(dictName) {
    let d = markerDetectors.get(dictName);
    if (d) return d;
    const dictId = DICT_IDS()[dictName];
    if (dictId === undefined) throw new Error(`Unknown dictionary ${dictName}`);
    const dictionary = CV.getPredefinedDictionary(dictId);
    const params = new CV.aruco_DetectorParameters();
    const refine = new CV.aruco_RefineParameters(10.0, 3.0, true);
    const detector = new CV.aruco_ArucoDetector(dictionary, params, refine);
    refine.delete();
    d = { dictionary, params, detector };
    markerDetectors.set(dictName, d);
    return d;
}

function findMarkers(msg) {
    const t0 = performance.now();
    const { requestId, frame, view, image, width, height } = msg;
    let gray;
    if (msg.gray) {
        // Command-line path: an 8-bit luma image from ffmpeg, as in `detectGray`.
        if (msg.gray.length !== width * height) throw new Error(`gray image has ${msg.gray.length} bytes, expected ${width}x${height}`);
        gray = new CV.Mat(height, width, CV.CV_8UC1);
        gray.data.set(msg.gray);
    } else {
        const w = width || image.displayWidth || image.width;
        const h = height || image.displayHeight || image.height;
        ensureCanvas(w, h);
        ctx.drawImage(image, 0, 0, w, h);
        if (typeof image.close === 'function') image.close();
        const src = CV.matFromImageData(ctx.getImageData(0, 0, w, h));
        gray = new CV.Mat();
        CV.cvtColor(src, gray, CV.COLOR_RGBA2GRAY);
        src.delete();
    }
    const results = [], transfer = [];
    try {
        for (const dictName of msg.dictNames || []) {
            const d = markerDetector(dictName);
            const mc = new CV.MatVector(), mi = new CV.Mat(), rej = new CV.MatVector();
            d.detector.detectMarkers(gray, mc, mi, rej);
            const n = mi.rows;
            const ids = new Int32Array(n), corners = new Float32Array(n * 8);
            for (let m = 0; m < n; m++) {
                ids[m] = mi.intAt(m, 0);
                const c = mc.get(m);
                corners.set(c.data32F.subarray(0, 8), m * 8);
                c.delete();
            }
            mc.delete(); mi.delete(); rej.delete();
            results.push({ dictName, ids, corners });
            transfer.push(ids.buffer, corners.buffer);
            if (msg.enough && n >= msg.enough) break;
        }
    } finally {
        gray.delete();
    }
    postMessage({ type: 'markers', requestId, frame, view, ms: performance.now() - t0, results }, transfer);
}
