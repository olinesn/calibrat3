# calibrat3

Browser-based multi-camera **ChArUco calibration** GUI. Load synchronized calibration
videos, detect board corners across thousands of frames, estimate intrinsics and
extrinsics, refine with bundle adjustment, and export a
[Anipose](https://anipose.readthedocs.io/en/latest/index.html)-compatible `calibration.toml`.

**Live:** https://talmolab.github.io/calibrat3/ (deployed from `main`; PRs get previews at `/pr/<n>/`).

calibrat3 is the standalone successor of the `calibration-studio` vibe
(`talmolab/vibes`), rebuilt with the same architecture as
[luc3d](https://github.com/talmolab/luc3d): no build step, vanilla ES modules, vendored
and pinned dependencies, web workers for anything heavy.

Read the documentation at https://talmolab.github.io/luc3d-docs/#camera-calibration

## Features

- **Video loading** via WebCodecs + mp4box.js, frame-accurate, with streaming
  playback (one decode per displayed frame per view, even for 18 cameras with
  200-frame GOPs), from a local folder
  (File System Access API, with an `<input webkitdirectory>` fallback) or the bundled
  sample session. Two folder layouts:
  - flat: `{root}/{view}.mp4`
  - anipose-style: `{root}/{view}/calibration_images/*.mp4` (also `calibration/`)

  A `board.toml` next to the videos fills in the board form. A calib.io ChArUco board can be
  picked from *Board preset*, or found from its markers with *Auto* (`?board=auto`,
  `?board=CCT300200C`, or `preset = "…"` in board.toml for headless runs; the command line
  takes `--board CCT300200C` or `--board auto --square 20`).
- **Batch ChArUco detection that scales.** One sequential decode pass per view feeds
  a pool of OpenCV.js web workers (detectors built once per board config). Frames
  are never drawn to the display during the run, back-pressure keeps memory flat,
  and progress is one throttled bar. Thousands of frames are fine; the UI stays live.
- **Detection results without DOM bloat:** a canvas frame strip (one column per
  sampled frame) plus a virtualized, filterable table in a fixed-height scroller.
- **Intrinsics** per camera in a calibration worker with progress, selectable
  distortion model (k1-only by default, as anipose — it gave the best cross-view
  consistency on an 18-camera rig; k1k2 / k1k2k3 / full available), optional
  coverage-based frame subsampling (default 50 frames/camera chosen for image
  coverage), per-frame reprojection errors for *every* valid frame, swarm plot,
  worst-frames gallery with lazy thumbnails captured during detection, and
  frame exclusion keyed by video frame (`X`).
- **Old and new ChArUco layouts:** boards printed with opencv-contrib-python < 4.6
  (even row counts start with a white marker square) are detected via an emulated legacy
  layout; *Board pattern: auto* probes both conventions on the current frame. board.toml
  keys are read case-insensitively and units are free (mm or m).
- **Extrinsics** from a covisibility graph → BFS pose chain → per-pair relative
  poses (solvePnP both cameras, robust quaternion averaging with outlier
  rejection) → chained absolute poses. Cross-view triangulation (pure-JS DLT on
  undistorted normalized coordinates, as aniposelib) and reprojection with
  per-frame/per-camera aggregation.
- **Bundle adjustment** with a sparse Levenberg–Marquardt solver written in JS
  (`calib/bundle-adjust.js`: Schur elimination of points and per-frame board poses,
  analytic Jacobians) with a soft board-rigidity term. Default intrinsics model:
  fx, fy + principal point + k1 + k2 per camera (lowest cross-view error on every rig
  tested: 0.10 px on an 8-camera rig, 0.21 px on an 18-camera rig where aniposelib's
  own calibrations score 0.60 and 1.36 px on the same detections); aniposelib's model
  (one focal + k1, principal point at the image centre), f + c + k1, f + k1 + k2 and
  the original `@talmolab/sba-solver-wasm` engine (all 9 intrinsics) are selectable.
  Anipose-style iterative outlier rejection (per-point thresholds decreasing over
  rounds, re-triangulation each round), optional robust loss, choice of what to optimize,
  point cap, live iteration progress, a refined-reprojection section
  with an anipose-style error histogram (initial vs refined), before/after per-camera
  table, Best/Worst frame galleries (best shown first), convergence chart, one-click revert.
- **Export:** `calibration.toml` (sleap-anipose), a full `calibration_data.json`
  (all observations, triangulated points, per-camera errors), `board.toml`, and a
  **session save** (`*.calibrat3.json`) that restores detections and results
  without re-detecting.
- **Diagnostics everywhere:** a ring-buffered log with a verbose toggle, timing
  for every step, reprojection overlays layered on the video (detections,
  intrinsic reprojection, triangulated reprojection), per-frame badges.

## Usage

```bash
python3 server.py            # http://localhost:8080/  (adds HTTP Range support)
# or: python3 -m http.server 8080
```

1. **Load videos** — *Load sample session* (sleap-anipose `minimal_session`, 4 views)
   or *Open session folder…*.
2. **Detect** — check the board, optionally *Detect current frame (D)* to verify,
   set *Target samples* (or *every frame*), *Run batch detection*.
3. **Intrinsics** — *Compute intrinsics*. Inspect the strip / plot / worst frames,
   exclude bad frames (`X`, or ✕ on a card), recompute.
4. **Extrinsics** — choose the reference camera, *Compute extrinsics*, then
   *Refine (bundle adjustment)*. Exclude frames from the cross-view set if needed.
5. **Export** — download `calibration.toml` / JSON, or save the session.

### Command line (no browser)

`cli/calibrate.mjs` runs the same pipeline in plain Node, with **ffmpeg** decoding the
videos — for clusters, scripts, and codecs your browser cannot decode (headless
Chromium on Linux has no HEVC). It takes the same session folder and writes the same
`calibration.toml` as the app's Export, using the app's own code (detect/calib workers in
`worker_threads`, same OpenCV.js build, same defaults as the app's buttons).

```bash
node cli/calibrate.mjs <session-folder> --out calibration.toml [--target 600]
node cli/calibrate.mjs <session-folder> --out calibration.toml --all-frames \
    --session-out session.calibrat3.json --report report.json
node cli/calibrate.mjs <session-folder> --out calibration.toml --report report.json --board CCT300200C
node cli/calibrate.mjs <session-folder> --out calibration.toml --report report.json --board auto --square 20
node cli/calibrate.mjs --list-boards   # the calib.io presets: ids, SKUs, sizes
node cli/calibrate.mjs --help          # every option (board, intrinsics, SBA, threads)
```

**Board.** Without `--board`, the board comes from the session's `board.toml` (the file the
app reads and its Export writes), read as the app reads it: `preset = "<id or SKU>"` fills the
values the file leaves out (the file's own values win), `preset = "auto"` identifies the board
(its `square_length` is the size hint). `--board-x`, `--board-y`, `--square`, `--marker` and
`--dict` override the file's values. Without a `board.toml` and without `--board`, all five are
required: the CLI never guesses a board.

- `--board <preset id | SKU>` (e.g. `calibio-300x200-coarse` or `CCT300200C`) uses that calib.io
  board as sold. It replaces `board.toml`, which is then not read for the board (the log and
  the report say so). `--square` is ignored with a note; the other board flags are refused.
- `--board auto` identifies the calib.io board as the app's *Auto* does: ArUco markers only, in
  every view, on up to 12 frames spread over the sampled ones, until
  `calib/board-identify.js` decides. Most calib.io grids are sold in two or three sizes that
  look the same in a video, so give the square size in mm with `--square` (with board.toml's
  `preset = "auto"`, `--square` replaces `square_length`).
- When Auto can't settle the board, the run stops with exit status 3 and the app's message,
  naming the sizes, e.g. `Auto (calib.io): the board is a 9 × 14 calib.io grid, sold as
  600 × 400 mm (40 mm squares) or 300 × 200 mm (20 mm squares); the video can't tell these
  sizes apart. Pick yours with --board calibio-600x400-coarse or --board
  calibio-300x200-coarse, or give its square size with --square.` A board that is not a
  calib.io one (another dictionary, or markers that don't line up as any calib.io grid) also
  stops with status 3: describe it in `board.toml` or with the five board flags instead.

Exit status: 0 calibrated, 1 failed, 2 bad arguments, 3 board not settled (Auto).

**report.json** (`--report`), written also when the run fails once the arguments are
accepted. The first keys answer "did it work, with which board, which cameras":

| Field | Meaning |
| --- | --- |
| `ok`, `exitCode`, `error` | `true` / 0 / `null` when calibration.toml was written; otherwise the exit status and the message |
| `board.preset`, `board.sku`, `board.label` | the calib.io preset the board used is, value for value (`null` for any other board) |
| `board.source` | where the board came from: `"flag"` (`--board`), `"board.toml"`, or `"board-flags"` (the five board flags, no board.toml) |
| `board.requested` | what was asked for: a preset id, `"auto"`, or `"custom"` (values) |
| `board.method` | `"preset"` (a named preset, as sold), `"auto"` (Auto picked the preset), `"custom"` (values; `board.preset` still names a preset they equal) |
| `board.boardToml`, `board.boardTomlUsed` | the board.toml found in the session (path relative to it, or `null`) and whether it set the board |
| `board.overrides`, `board.notes` | board flags that replaced board.toml values; notes such as "board.toml not used", "--square ignored" |
| `board.boardX`, `boardY`, `squareLength`, `markerLength`, `dictName`, `legacyPattern` | the board detected (absent when Auto failed) |
| `board.auto` | `null` unless Auto ran: `status` (`match`, `size-ambiguous`, `undecided`, `no-match`), `reason` (the evidence in words), `picked` (preset id or `null`), `candidates` (preset ids still possible), `grid` (`{rows, cols}`), `dictName`, `squareHint` (mm or `null`) and `squareHintFrom` (`"flag"`, `"board.toml"`, `null`), `markersSeen`, `maxId`, `framesSearched` (frame numbers), `framesWithMarkers`, `images`, `scores` (per calib.io grid: `rows`, `cols`, `markers`, `agree`, `pairs`, `fraction`, `outOfRange`, `ruledOut`), `ms` |
| `cameras[]` | one row per video: `name`; `inCalibration` (the camera is in calibration.toml) and `reason` when not; `framesSampled`, `framesWithBoard` (sampled frames where the board was detected), `framesUsable` (with at least `--min-corners` corners); `reprojectionPx` — the final cross-view reprojection error over all its observations, `{median, p95, mean, max, observations}` in px (after bundle adjustment when it improved), or `null`; `intrinsicsRmsPx` |
| `options`, `timings`, `detection`, `intrinsics`, `initial`, `sba`, `final`, `session`, `referenceView` | the run's settings, stage times (ms), detection counts, per-camera intrinsics, reprojection summaries and camera poses before and after bundle adjustment, the videos |

Needs Node ≥ 20 and `ffmpeg` / `ffprobe` on the `PATH` (or `--ffmpeg /path/to/ffmpeg`);
nothing to install (`npm install` is not needed). Frame numbers are 0-based and are the
app's: frame N is the N-th picture in presentation order, B-frames included
(`tests/cli/test-ffmpeg-frames.mjs`). `--session-out` writes a session file the app can
open (open the same folder, then *Load session*) to inspect detections, errors and
overlays; `--report` writes the JSON above. Progress goes to stderr, one line every 10 s
during detection.

Parity with the app (`tests/e2e/cli-parity.mjs`, same session, same sampled frames):
the gray image ffmpeg gives differs from the one the app's detect worker gets from the
browser by 0.006 grey levels on average; corner positions differ by 0.002 px (median);
camera positions by < 0.1 mm; the cross-view reprojection error is the same to 3
decimals (sample session 0.112 px, 4-camera synthetic session 0.124 px).

#### On a Slurm cluster (Princeton Spock)

CPU only; ffmpeg decodes HEVC in software. One-time setup in your home directory:

```bash
# Node (any >= 20; a prebuilt tarball, no root needed)
mkdir -p ~/opt && cd ~/opt
curl -LO https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz
tar xf node-v22.11.0-linux-x64.tar.xz
echo 'export PATH=$HOME/opt/node-v22.11.0-linux-x64/bin:$PATH' >> ~/.bashrc
git clone https://github.com/talmolab/calibrat3.git ~/calibrat3
```

Then submit a job (`cli/spock-calibrate.sbatch` is a template):

```bash
sbatch -p all --cpus-per-task 16 --mem 12G --time 2:00:00 \
    ~/calibrat3/cli/spock-calibrate.sbatch /path/to/session /path/to/calibration.toml --target 600
```

The job runs `module load ffmpeg/6.1` and uses the CPUs Slurm gave it
(`SLURM_CPUS_PER_TASK`): one detection thread per CPU (minus one), each with its own
OpenCV runtime (~150 MB). Memory: about 4 GB plus 0.25 GB per CPU. Do not run large
sessions on the login node.

### Keyboard

| Key | Action |
| --- | --- |
| ← / → , ↑ / ↓ | ±1 / ±10 frames |
| Space, Home, End | play/pause, first, last |
| `[` / `]` | previous / next sampled frame |
| `{` / `}` | previous / next worst frame (active stage) |
| `X` | toggle exclusion of the current frame (intrinsics or extrinsics, whichever stage you touched last) |
| `D` | detect the current frame |
| `+` / `-` / `0`, wheel, drag, double-click | zoom / pan views |

## Repository layout

```
index.html, app.js, styles.css     markup, 2-line ESM entry, styles
calib/          pure logic (board, geometry, detection store, covisibility, frame
                selection, intrinsics, extrinsics, triangulation, sba) + initialization
ui/             app state, log panel, stages, video panel, overlays, frame strip,
                virtual table, plots, gallery, per-stage controllers
loading/        video decoder + batch iterator, detect worker + pool, calib worker + client,
                folder loader
import-export/  toml, calibration JSON, session save/load
cli/            command line: calibrate.mjs, ffmpeg frame reader, Web Worker API over worker_threads
lib/            vendored deps with PROVENANCE.txt: opencv (4.13.0), sba-solver-wasm (0.2.0), mp4box (0.5.2)
sample_session/ sleap-anipose minimal_session (4 short videos + board.toml)
tests/          Node ESM unit tests (node tests/run-mjs-tests.mjs; tests/cli/ = command line, needs ffmpeg)
.github/workflows/  Pages deploy from main + PR previews
```

See `MODULES.md` for per-module details and `CLAUDE.md` for architecture notes,
dependency pins and gotchas.

## Tests

```bash
node tests/run-mjs-tests.mjs           # pure-logic unit tests in Node (no browser needed)
# same tests in the browser (also on the deployed site):
#   http://localhost:8080/tests/test-runner.html
#   https://talmolab.github.io/calibrat3/tests/test-runner.html

# real-browser end-to-end tests (headless Chromium via Playwright; see tests/e2e/README.md)
python3 server.py 8080 &
node tests/e2e/smoke-pipeline.mjs                                   # sample session, full pipeline
SESSION=/tmp/synthetic_session node tests/e2e/stress-synthetic.mjs  # 4 cams × 1200 frames vs ground truth
SESSION=/path/to/real/session TARGET=600 node tests/e2e/real-session.mjs  # playback smoothness + pipeline report (+ anipose reference comparison)
SESSION=/path/to/session TARGET=100 node tests/e2e/cli-parity.mjs        # command line vs app on the same session (starts its own server)
```

The stress session is generated by `scripts/make_synthetic_session.py` (numpy,
opencv-contrib-python-headless, imageio-ffmpeg; `uv run --with …` works). It renders
a moving ChArUco board seen by N virtual cameras with known intrinsics/extrinsics
into an anipose-style folder, plus `calibration_gt.toml`.

## Export format

```toml
[cam_0]
name = "back"
size = [1280, 1024]
matrix = [[fx, 0, cx], [0, fy, cy], [0, 0, 1]]
distortions = [k1, k2, p1, p2, k3]
rotation = [rx, ry, rz]        # Rodrigues, world (= reference camera) -> camera
translation = [tx, ty, tz]     # board units (mm)
```

## Browser support

Chromium-based browsers (Chrome, Edge) — WebCodecs, OffscreenCanvas in workers, and
the File System Access API. Firefox works for the sample session and the
`webkitdirectory` fallback where WebCodecs is enabled.
