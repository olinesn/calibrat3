# calibrat3 module reference

One entry per ES module: purpose, key exports, what it imports from the project.
Vendored globals (`MP4Box`, `DataStream`, `cv`) and `lib/` are not listed as imports.

---

## root

### app.js
Entry point: `import { initApp } from './calib/initialization.js'; initApp();`

### index.html / styles.css
All markup (stages 1–5, video panel, diagnostic log) and styling. Element ids are
the contract with the `ui/stage-*.js` modules.

---

## calib/ — pure logic

### calib/board.js
Board config + object points (single source of truth).
Exports: `DICT_NAMES`, `DEFAULT_BOARD`, `normalizeBoard`, `boardKey`, `numCorners`,
`numMarkers`, `cornerObjectPoint`, `objectPointsForIds` (flat Float64Array),
`allCornerObjectPoints`, `boardSize`, `dictNameFromToml`, `tomlFromDictName`.
Imports: none.

### calib/geometry.js
Rotations/poses/projection in pure JS. Exports: `rodriguesToMatrix`, `matrixToRodrigues`,
`matrixToQuaternion`, `quaternionToMatrix`, `quaternionToRodrigues`, `rodriguesToQuaternion`,
`quaternionAngle`, `averageQuaternions`, `robustAveragePoses`, `relativePose`,
`composePoses`, `invertPose`, `projectPoint`, `projectPoints`, `rmsPointError`,
`makeCamera`, `toWasmCamera`, `cameraCenter`, `median`, `percentile`, vector helpers.
Imports: none.

### calib/detection-store.js
`DetectionStore` — Map<frame, per-view {ids:Int32Array, corners:Float32Array}>.
`set/get/count/has/touch`, `frames()`, `framesForView`, `viewsWithMin`, `commonIds`
(true intersection), `commonCount`, `cornerForId`, `summary`, `toJSON/fromJSON`
(base64), `toPlain/fromPlain` (structured clone for workers). Also `b64FromTyped`,
`typedFromB64`. Imports: none.

### calib/covisibility.js
`buildCovisibilityGraph(store, minCovisible, excluded)` → `{numViews, edges, pairCounts}`;
`findPoseChain(graph, refIdx)` → `{parent, order, unreachable}` (BFS, most-covisible
neighbour first); `pairFrames`, `edgeKey`, `pathToRoot`. Imports: none.

### calib/frame-selection.js
`stridedFrames(total, target)`; `selectFramesForCoverage(samples, imageSize, {maxFrames, grid})`
greedy grid-coverage subset; `coverageFraction`. Imports: none.

### calib/intrinsics.js  (needs `cv`)
`calibrateIntrinsics(cv, samples, imageSize, board, flags)` wraps
`calibrateCameraExtended`; `reprojectFrames(cv, K, dist, samples, board)` solvePnP +
pure-JS reprojection per frame; `computeIntrinsicsForCamera(cv, allSamples, imageSize,
board, {minCorners, exclusions, maxFrames, flags, onProgress})` = filter → select →
calibrate → evaluate all valid frames. Also (no `cv`): `distortionFlags(model)` (the
`Distortion model` choice → calibrateCamera flags), `intrinsicsSamples(store, view)` (a
view's frames with ≥ 4 corners). Imports: board, frame-selection, geometry.

### calib/extrinsics.js  (needs `cv`)
`solveBoardPose`, `computeRelativePoses(cv, store, graph, chain, intrinsics, board, opts)`
(pose cache per (frame,view), robust quaternion average, per-pair residuals),
`chainAbsoluteExtrinsics(relPoses, chain, refIdx, n)`. Imports: board, covisibility, geometry.

### calib/triangulation.js
`computeCrossViewReprojection(sba, store, intrinsics, extrinsics, opts)` — per frame,
ids seen by ≥2 cameras, pure-JS DLT (`triangulateDLT(obs, cams)` on
`undistortToNormalized` coordinates; the `sba` argument is kept for API compatibility
and unused — the WASM `triangulate_points` was measured to be off by ~3 mm / 1.5 px on
exact data), per-camera reprojection; compact typed-array records + summary.
`indexReprojectionByFrame`. Imports: geometry.

### calib/bundle-adjust.js
`bundleAdjust(input, config, {onIteration})` — sparse Levenberg–Marquardt bundle
adjustment in plain JS with the same input/output shapes as the WASM wrapper
(cameras as `{rotation (quaternion w,x,y,z), translation, focal, principal, distortion}`,
points, observations, `point_to_frame`, `meta.pointIds`). Camera model per
`INTRINSIC_MODELS` (`fxfy-c-k1-k2` = UI default, `f-k1` = aniposelib's model, `f-c-k1`, `f-k1-k2`,
`fixed`); optional soft board-rigidity term (`board_weight` px per mm, per-frame board
poses as unknowns, initialised with `fitRigidTransform` = Horn's quaternion method);
Schur elimination of points then boards, dense Cholesky on the camera block; IRLS
robust losses; reference camera fixed; metric scale re-anchored to the board when the
rigidity term is off. Also exports `projectWithJacobian`. Imports: geometry, board.

### calib/sba.js
`prepareSbaInput(reproj, intrinsics, extrinsics, {excludedFrames, maxPoints})` (with
`meta.pointErr` per point), `filterSbaInput(input, keepMask)`, `evaluateSbaObservations`,
`outlierSchedule(start, end, rounds)`, `sbaReferenceIndex`, `applySbaResults(result,
input, intrinsics, extrinsics)` → new arrays, `pairErrorBounds`, `DEFAULT_SBA_CONFIG`
(engine `js`, model `fxfy-c-k1-k2`, loss none). Imports: geometry.

### calib/refine.js
Bundle-adjustment orchestration shared by the app (`ui/stage-extrinsics.js` runSba) and
the command line. `refineCalibration({intrinsics, extrinsics, reproj, initialSummary,
imageSizes, viewNames, board, referenceView, excludedFrames, options, reproject, solve,
log, progress, onLiveCost})` → `{improved, best, attempts, s0, schedule}`: anipose-style
start point, threshold schedule, rounds of reject → solve → re-triangulate
(`sbaAttempt`), model selection; the expensive steps come in as callbacks (the calib
worker's `reprojection` / `sba` requests). `sbaResultRecord(refined)` = the
`state.sbaResult` record; `reevaluatePerFrame(intrinsics, store, board, request)` re-solves
per-frame poses with refined intrinsics; `DEFAULT_REFINE_OPTIONS` (the SBA panel's
defaults); `fmtMs`. Imports: sba, geometry.

### calib/initialization.js
`initApp()` — wires log panel, stages, video panel, loaders (sample / folder / saved
session), global hotkeys (`X`, `{ }`), starts `DetectorPool` + `CalibWorker`.
Imports: ui/app-state, ui/log-panel, ui/stages, ui/video-panel, ui/stage-*, ui/events,
loading/detect-pool, loading/calib-client, loading/folder-loader, import-export/session-save.

---

## ui/

### ui/app-state.js
`state` (views, board, detections, sampledFrames, thumbnails, intrinsics[],
extrinsics[], extrinsicsMeta, reproj, reprojByFrame, sbaResult, referenceView,
exclusions{intrinsics,extrinsics}, overlays, activeExclusion), `controllers`
{video, pool, calib}, `viewNames`, `cameraColor`, `resetCalibrationState`,
`resetDownstreamOfDetection`. Exposes `window.__calibrat3`. Imports: calib/board.

### ui/events.js
`on(type, fn)`, `emit(type, payload)`. Event names documented in the file header.

### ui/log-panel.js
Ring-buffer log with rAF-batched DOM flush. `initLogPanel`, `log(msg, level)`,
`debug`, `onLog`, `dumpLog`, `clearLog`, `setVerbose`, `fmtMs`.

### ui/stages.js
`toggleStage/expandStage/collapseStage`, `setStageStatus`, `setupStageHeaders`,
`Progress` (rAF-coalesced bar: show/set/hide/fail), `showError/hideError`, `$`, `el`,
`numInput/intInput`, `setEnabled`, `errorColor`, `nextTick`.

### ui/video-panel.js
`setupVideoPanel()` (VideoController, transport, seekbar, overlay toggles, resize
handle), `loadSession(sessionDesc)` (opens decoders in parallel, builds canvases,
emits `session-loaded`), `updateFrameInfo`, `registerKeyHandler`.
Imports: app-state, loading/video, log-panel, stages, overlays, events.

### ui/overlays.js
`drawAllOverlays(frame)` — detections (green), intrinsic reprojection (red X, via
geometry.projectPoints from stored rvec/tvec), triangulated reprojection (blue +),
legend + footer with per-frame errors and exclusion flags. `drawCorners`.
Imports: app-state, calib/board, calib/geometry.

### ui/frame-strip.js
`FrameStrip(canvas, {height, onClick, tooltip, tooltipEl})` — `setData({frames,
colorFn, excluded, marked})`, `setExcluded`, `setCurrent` (O(1) blit of a cached
base). Colormaps `viridisLike`, `errorColormap`.

### ui/virtual-table.js
`VirtualTable(container, {columns, rowHeight, height, onRowClick, rowKey, rowClass})`
— `setRows`, `setSelected(key, {scroll})`, `scrollToRow`. Only visible rows in the DOM.

### ui/plots.js
`SwarmPlot(canvas, tooltipEl, {yLabel, log, height, onClick, formatTooltip})` —
`setData(groups, {thresholds, note})`; grid-bucket hover index; medians.
`drawLineChart(canvas, values, opts)` for SBA cost history.

### ui/gallery.js
`FrameGallery(container, {getThumb, onSeek, onToggleExclude, limit})` — `setItems`,
`updateExclusions`, `setCurrent`; IntersectionObserver-lazy object URLs.

### ui/stage-detect.js
Board form (`getBoardFromForm`, `setBoardForm`), sampling info, `detectCurrentFrame`,
`runBatchDetection` (sequential decode → pool, in-flight cap, cancel, throttled
progress, summary log), `renderResults` (strip + virtual table + filters), `stepSampled`.
Imports: app-state, calib/detection-store, calib/board, calib/frame-selection, log-panel,
stages, frame-strip, virtual-table, events, video-panel.

### ui/stage-intrinsics.js
`setupIntrinsicsStage`, `computeIntrinsics` (per-camera worker requests with progress),
`renderResults` (table, strip of max error, swarm, gallery), `toggleIntrinsicsExclusion`,
`stepWorst`. Imports: app-state, log-panel, stages, frame-strip, plots, gallery, events.

### ui/stage-extrinsics.js
`setupExtrinsicsStage`, `computeExtrinsics` (worker: graph → poses → chain, then
reprojection), covisibility matrix + pose table, strip/plot/gallery of cross-view
errors, `runSba` / `revertSba`, `toggleExtrinsicsExclusion`, `stepWorst`.
Imports: app-state, log-panel, stages, frame-strip, plots, gallery, calib/triangulation,
calib/sba, calib/geometry, events.

### ui/stage-export.js
`setupExportStage`, `buildToml`, `updateTomlPreview`; downloads TOML / JSON /
board.toml / session. Imports: app-state, import-export/*, log-panel, stages, events.

---

## loading/

### loading/video.js
`OnDemandVideoDecoder` — `init(url|File)`, `getFrame(i)` (LRU ImageBitmap; streaming
display decode that keeps the decoder open between seeks, GOP byte cache, optional
reduced-resolution `bitmapScale`), `iterateFrames(frames, {maxPending, signal})`
(single sequential pass, GOP-grouped, back-pressured, yields `{frame, videoFrame}`),
`readSampleRange`, `close`, `stats`. `VideoController` — coalesced `seekToFrame`,
`redraw`, playback, seekbar, keyboard, zoom/pan. `info.fragmented` says whether the
file is a fragmented MP4. Imports: sample-table.

### loading/sample-table.js
Pure (no DOM): an MP4's sample table through mp4box.js. `readSampleTable(MP4Box,
readBytes, fileSize, {chunkSize})` reads until mp4box has the moov; for a FRAGMENTED
MP4 (empty moov, samples listed in each moof — campy's videos, ffmpeg `-movflags
frag_keyframe`) it then walks the rest box by box, giving mp4box every moof but only
each mdat's header, through a `chunkSize` read window (payloads of larger fragments
are skipped). `completeSamples(samples, fileSize)` drops frames cut off at the end of
a crashed file; `trackDurationSec(track, samples)` is the header's duration, or the
samples' when the header says 0. Exports: `readSampleTable`, `completeSamples`,
`trackDurationSec`, `CHUNK_SIZE`. Imports: none.

### loading/detect-worker.js  (classic worker)
`importScripts` opencv.js; caches dictionary/board/detectors per board key; `detect`
draws the transferred VideoFrame/ImageBitmap to an OffscreenCanvas, runs
`detectMarkers` + `detectBoard`, optional JPEG thumbnail; replies with transferred
typed arrays. A `detect` message with `gray` (Uint8Array luma, the command line's
ffmpeg frames) instead of `image` skips the canvas.

### loading/detect-pool.js
`DetectorPool({size, log})` — `init`, `configure(board)`, `detect({frame, view, image | gray,
width, height, wantThumb})` → Promise, least-loaded dispatch, `stats`, `terminate`.

### loading/calib-worker.js  (classic worker)
`importScripts` opencv.js + dynamic `import()` of calib modules and the sba wrapper.
Requests: `intrinsics`, `extrinsics`, `reprojection`, `sba`, `ping`; replies `progress`
/ `result` / `error` / `log`.

### loading/calib-client.js
`CalibWorker({log, size})` — a small pool (default `min(4, cores-2)`) so per-camera
intrinsics run in parallel; `init`, `request(type, payload, {onProgress})`, `terminate`.

### loading/folder-loader.js
`buildSession(entries)` (flat / nested layouts, board.toml discovery),
`scanDirectoryHandle`, `scanFileList`, `pickSessionFolder`, `loadSampleSession`,
`VIDEO_EXT`. Imports: import-export/toml.

### loading/opencv-ready.js
`waitForOpenCV(cvGlobal)` — resolves the initialized module for either UMD flavour.

---

## import-export/

### import-export/toml.js
`calibrationTomlFromResults({viewNames, intrinsics, extrinsics, referenceView, board,
sessionName, sampledFrames, refinedBySba, reproj})` (the Export stage's TOML, shared with
the command line), `generateCalibrationToml(cameras, meta)`, `parseCalibrationToml`, `generateBoardToml`,
`parseBoardToml`, `parseSimpleToml`, `parseTomlTables`. Imports: calib/board.

### import-export/sba-json.js
`generateCalibrationJson(state)` — cameras, board, observations, triangulated points,
SBA + reprojection metadata (flat arrays). Imports: calib/board.

### import-export/session-save.js
`serializeSession(state)`, `validateSession(saved, state)`, `restoreSession(saved, state)`,
`downloadText`, `SESSION_FORMAT_VERSION`. Imports: calib/detection-store.

---

## cli/ — command line (Node only)

### cli/calibrate.mjs
`node cli/calibrate.mjs <session-folder> --out calibration.toml [...]` — the app's pipeline
without a browser: scan the folder (`buildSession`), probe each video, stride the frames
(`stridedFrames`), batch detection (DetectorPool, gray frames from ffmpeg), intrinsics /
extrinsics / reprojection (CalibWorker requests), `refineCalibration`, then
`calibrationTomlFromResults`; optional `--session-out` (`serializeSession`) and `--report`
(JSON). Same defaults as the app's form. `--help` lists every option.

### cli/ffmpeg-video.mjs
`probeVideo(file)` — the app's frame table (sample-table.js + mp4box: count, size, fps,
B-frames), plus ffprobe's decoded size; `grayFrames(file, {width, height, totalFrames,
wanted, threads})` — async generator of `{frame, gray}` from `ffmpeg -ignore_editlist 1
-noautorotate -fps_mode passthrough -pix_fmt gray -f rawvideo`, back-pressured, checks that
ffmpeg emitted one picture per sample; `grayFrameAt(file, seconds)` (board-pattern probe);
`ffmpegVersion`.

### cli/web-worker.mjs, cli/worker-host.mjs
`NodeWebWorker` / `installWebWorker()` — the browser `Worker` API over `worker_threads`, so
DetectorPool / CalibWorker and `loading/detect-worker.js` / `loading/calib-worker.js` run
unchanged. The host provides `self`, `location`, `postMessage`, `onmessage`, `close`,
`importScripts` (classic-script eval, plus a `require` for Emscripten's Node probe) and
`fetch` for `file:` URLs (sba-solver-wasm's .wasm), then `import()`s the worker script.

### cli/spock-calibrate.sbatch
Slurm job template: `module load ffmpeg/6.1`, Node from `~/opt/node-*/bin`, runs calibrate.mjs
with `--session-out` / `--report` next to the TOML.

---

## tests/
- `harness.mjs` — environment-agnostic `test/run/assert/approx/loadText`; reports to
  `globalThis.__calibrat3TestReporter` when the browser runner installs one, else console.
- `run-mjs-tests.mjs` — runs each `test-*.mjs` in its own Node process.
- `test-runner.html` — imports the same `test-*.mjs` files in the browser
  (`/tests/test-runner.html`, also on GitHub Pages).
- `test-board`, `test-geometry`, `test-detection-store`, `test-covisibility`,
  `test-frame-selection`, `test-folder-loader`, `test-sba`, `test-toml`.
- `cli/test-ffmpeg-frames.mjs` (Node only, needs ffmpeg) — ffmpeg frame N is the app's frame N
  on B-frame videos (H.264, fragmented H.264, fragmented HEVC) whose frames show their own
  number as a barcode (`cli/barcode-video.mjs`).
- `e2e/smoke-pipeline.mjs`, `e2e/stress-synthetic.mjs`, `e2e/real-session.mjs` — Playwright,
  headless Chromium, real workers/WebCodecs/WASM. `e2e/cli-parity.mjs` — the command line vs
  the app on the same session (frame numbering, pixels, detections, calibration). See
  `e2e/README.md`.

## scripts/
- `make_synthetic_session.py` — renders an N-camera, M-frame synthetic ChArUco session
  (anipose-style layout) with `calibration_gt.toml` ground truth for the stress test.
