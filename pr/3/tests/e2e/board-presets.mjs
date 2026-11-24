/**
 * tests/e2e/board-presets.mjs — calib.io board presets and Auto in the real app.
 *
 * Needs a synthetic session of calib.io's 300 x 200 mm coarse board whose board.toml says only
 * `preset = "auto"`:
 *   uv run --with numpy --with opencv-contrib-python-headless --with imageio-ffmpeg \
 *     scripts/make_synthetic_session.py --out /tmp/calibio_session --frames 60 --cams 2 \
 *     --board-x 14 --board-y 9 --square 20 --marker 15 --dict-bits 5 --board-toml auto
 *   SESSION=/tmp/calibio_session node tests/e2e/board-presets.mjs     (server on BASE)
 *
 * Checks, through the worker pool and OpenCV.js:
 *   1. The preset drop-down: Custom by default (today's default board), a preset fills and
 *      locks the fields, Custom unlocks them.
 *   2. board.toml `preset = "auto"` selects Auto; detecting finds the 9 x 14 grid, and stops
 *      (two sizes on sale) with a message naming both; with Square = 20 it picks
 *      calib.io 300 x 200 coarse and batch detection finds the board.
 *   3. ?board=auto&square=20 (headless callers): Auto picks it with nothing typed.
 *   4. ?board=CCT300200C: the preset is set before any folder, and the folder's board.toml
 *      doesn't replace it.
 *   5. Auto on the sample session (8 x 11, DICT_4X4, not a calib.io board): an error saying
 *      why, and the preset back on Custom.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8080';
const SESSION = process.env.SESSION;
if (!SESSION) { console.error('SESSION=/path/to/calibio_session is required'); process.exit(2); }

const browser = await chromium.launch({ headless: true });
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
let failures = 0;
const check = (ok, msg) => { if (ok) console.log(`  ok   ${msg}`); else { failures++; console.log(`  FAIL ${msg}`); } };

async function openApp(query = '') {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); if (process.env.VERBOSE) console.log(`[${m.type()}] ${m.text()}`); });
    await page.goto(`${BASE}/index.html${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('workerStatus').classList.contains('ok'), null, { timeout: 180000 });
    return { page, errors };
}
async function openFolder(page) {
    await page.setInputFiles('#folderInput', SESSION);
    await page.waitForFunction(() => window.__calibrat3.state.views.length >= 2 && window.__calibrat3.state.totalFrames > 0, null, { timeout: 180000 });
    // the folder's board.toml is applied (or set aside) just after the videos open
    await page.waitForFunction(() => /Board from |not used, the page URL/.test(document.getElementById('logBody').textContent), null, { timeout: 30000 });
}
const banner = (page) => page.evaluate(() => { const e = document.getElementById('errorMsg'); return e && e.style.display === 'block' ? e.textContent : ''; });
const clearBanner = (page) => page.evaluate(() => { const e = document.getElementById('errorMsg'); if (e) { e.style.display = 'none'; e.textContent = ''; } });
const form = (page) => page.evaluate(() => ({
    preset: document.getElementById('boardPreset').value,
    locked: ['boardX', 'boardY', 'squareLength', 'markerLength', 'arucoDict', 'boardPattern'].map(id => document.getElementById(id).disabled),
    board: window.__calibrat3.state.board,
}));
const logText = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#logBody .log-entry')).map(e => e.textContent).join('\n'));
async function detectCurrent(page) {
    await page.click('#detectCurrentBtn');
    await page.waitForFunction(() => { const t = document.getElementById('detectCurrentResult').textContent; return t && t !== 'detecting…'; }, null, { timeout: 300000 });
}

try {
    // 1. drop-down
    {
        const { page, errors } = await openApp();
        let f = await form(page);
        check(f.preset === 'custom' && f.locked.every(x => !x), 'Custom by default, fields editable');
        check(f.board.boardX === 8 && f.board.boardY === 11 && f.board.dictName === 'DICT_4X4_1000', 'default board unchanged (8 x 11, DICT_4X4_1000)');
        await page.click('#stage2 .stage-header');      // stage 2 starts collapsed until videos are open
        const n = await page.evaluate(() => document.querySelectorAll('#boardPreset option').length);
        check(n === 15, `15 choices (Custom, Auto, 13 calib.io boards): ${n}`);
        await page.selectOption('#boardPreset', 'calibio-800x600-fine');
        f = await form(page);
        check(f.locked.every(Boolean), 'a preset locks the fields');
        check(f.board.boardX === 24 && f.board.boardY === 17 && f.board.squareLength === 30 && f.board.markerLength === 22 && f.board.dictName === 'DICT_5X5_1000', `800 x 600 fine fills 24 x 17, 30/22 mm, 5x5: ${JSON.stringify(f.board)}`);
        await page.selectOption('#boardPreset', 'custom');
        f = await form(page);
        check(f.locked.every(x => !x) && f.board.squareLength === 30, 'Custom unlocks, keeping the values');
        check(errors.length === 0, `no page errors ${errors.join('; ')}`);
        await page.close();
    }
    // 2. board.toml preset = "auto"
    {
        const { page, errors } = await openApp();
        await openFolder(page);
        let f = await form(page);
        check(f.preset === 'auto', `board.toml preset = "auto" selects Auto (${f.preset})`);
        await detectCurrent(page);
        const msg = await banner(page);
        step(`Auto without a size: ${msg}`);
        check(/9 × 14/.test(msg) && /600 × 400/.test(msg) && /300 × 200/.test(msg), 'stops naming the grid and both sizes');
        check((await form(page)).preset === 'auto', 'stays on Auto');
        await clearBanner(page);
        await page.fill('#squareLength', '20');
        await page.dispatchEvent('#squareLength', 'change');
        await detectCurrent(page);
        f = await form(page);
        check(f.preset === 'calibio-300x200-coarse' && f.locked.every(Boolean), `Square 20 picks 300 x 200 coarse (${f.preset})`);
        check(f.board.boardX === 14 && f.board.boardY === 9 && f.board.markerLength === 15 && f.board.dictName === 'DICT_5X5_1000', JSON.stringify(f.board));
        const log = await logText(page);
        check(/Auto \(calib\.io\): calib\.io 300 × 200 mm coarse/.test(log), 'the log says what Auto picked and why');
        step((log.split('\n').find(l => /Auto \(calib\.io\): calib\.io/.test(l)) || '').slice(0, 400));
        await page.fill('#targetSamples', '20');
        await page.dispatchEvent('#targetSamples', 'input');
        await page.click('#runDetectionBtn');
        await page.waitForFunction(() => !window.__calibrat3.state.detectionRunning && window.__calibrat3.state.detections && window.__calibrat3.state.detections.size > 0, null, { timeout: 600000 });
        const s = await page.evaluate(() => window.__calibrat3.state.detections.summary(6));
        step(`batch: ${JSON.stringify(s)}`);
        check(s.framesWithAnyDetection >= 5, `batch detection finds the board (${s.framesWithAnyDetection} frames)`);
        check(!(await banner(page)), 'no error after picking');
        check(errors.length === 0, `no page errors ${errors.join('; ')}`);
        await page.close();
    }
    // 3. ?board=auto&square=20
    {
        const { page, errors } = await openApp('?board=auto&square=20');
        await openFolder(page);
        await detectCurrent(page);
        const f = await form(page);
        check(f.preset === 'calibio-300x200-coarse', `?board=auto&square=20 identifies it with nothing typed (${f.preset}) ${await banner(page)}`);
        check(errors.length === 0, `no page errors ${errors.join('; ')}`);
        await page.close();
    }
    // 4. ?board=CCT300200C wins over the folder's board.toml
    {
        const { page, errors } = await openApp('?board=CCT300200C');
        let f = await form(page);
        check(f.preset === 'calibio-300x200-coarse' && f.locked.every(Boolean), 'set from the URL before any folder');
        await openFolder(page);
        f = await form(page);
        check(f.preset === 'calibio-300x200-coarse', `board.toml doesn't replace it (${f.preset})`);
        check(/not used, the page URL/.test(await logText(page)), 'the log says the board.toml was not used');
        check(errors.length === 0, `no page errors ${errors.join('; ')}`);
        await page.close();
    }
    // 5. Auto on a board calib.io doesn't sell (the sample session: 8 x 11, DICT_4X4): back to Custom
    {
        const { page, errors } = await openApp('?board=auto');
        await page.click('#loadSampleBtn');
        await page.waitForFunction(() => window.__calibrat3.state.views.length === 4 && window.__calibrat3.state.totalFrames > 0, null, { timeout: 180000 });
        await detectCurrent(page);
        const msg = await banner(page);
        step(`Auto on the sample: ${msg}`);
        check(/no calib\.io board identified/.test(msg) && /DICT_4X4/.test(msg), 'says no calib.io board, and why (DICT_4X4)');
        const f = await form(page);
        check(f.preset === 'custom' && f.locked.every(x => !x), `back on Custom, fields editable (${f.preset})`);
        check(errors.length === 0, `no page errors ${errors.join('; ')}`);
        await page.close();
    }
} catch (e) {
    failures++;
    console.log(`  FAIL ${e.stack || e.message}`);
} finally {
    await browser.close();
}
step(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
