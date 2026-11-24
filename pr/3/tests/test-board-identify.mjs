import { test, run, assert } from './harness.mjs';
import { identifyCalibioBoard, markerSquares, scoreGridsOnImage, dictFamily } from '../calib/board-identify.js';
import { presetById, presetGrids } from '../calib/board-presets.js';
import { detectorLayout, normalizeBoard } from '../calib/board.js';
import { rodriguesToMatrix } from '../calib/geometry.js';

// ---- synthetic marker detections -------------------------------------------------------
// A pinhole camera (f, principal point, radial k1) looking at a rows x cols board; each
// marker's 4 corners in the detector's order (TL, TR, BR, BL as printed, board y down, as
// OpenCV's CharucoBoard places them), plus deterministic pixel noise.

function lcg(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32) - 0.5; }

function observe({ rows, cols, square, marker, rvec = [0.25, -0.2, 0.05], z = null, f = 1000, cx = 640, cy = 512, k1 = 0,
    keep = () => true, noise = 0.3, seed = 1, dictName = 'DICT_5X5_1000', extra = [] }) {
    const R = rodriguesToMatrix(rvec);
    const W = cols * square, H = rows * square;
    const depth = z ?? (1.2 * f * Math.max(W, H)) / 1280;      // board ~ 80 % of the image width
    const rnd = lcg(seed);
    const proj = (X, Y) => {
        const p = [X - W / 2, Y - H / 2, 0];
        const c = [0, 1, 2].map(r => R[r][0] * p[0] + R[r][1] * p[1] + R[r][2] * p[2] + (r === 2 ? depth : 0));
        const x = c[0] / c[2], y = c[1] / c[2], d = 1 + k1 * (x * x + y * y);
        return [f * x * d + cx + noise * rnd(), f * y * d + cy + noise * rnd()];
    };
    const squares = markerSquares(rows, cols);
    const off = (square - marker) / 2;
    const ids = [], corners = [];
    squares.forEach(([sx, sy], id) => {
        if (!keep(sx, sy, id)) return;
        const x0 = sx * square + off, y0 = sy * square + off;
        ids.push(id);
        for (const [dx, dy] of [[0, 0], [marker, 0], [marker, marker], [0, marker]]) corners.push(...proj(x0 + dx, y0 + dy));
    });
    for (const e of extra) { ids.push(e.id); corners.push(...e.corners); }
    return { dictName, ids: Int32Array.from(ids), corners: Float32Array.from(corners) };
}

const fromPreset = (sku, o = {}) => { const p = presetById(sku); return observe({ rows: p.rows, cols: p.cols, square: p.squareLength, marker: p.markerLength, ...o }); };

// ---- layout ---------------------------------------------------------------------------

test('markerSquares follows OpenCV: white squares row-major, top-left black', () => {
    const s = markerSquares(9, 14);
    assert.equal(s.length, 63);
    assert.deepEqual(s.slice(0, 3), [[1, 0], [3, 0], [5, 0]]);
    assert.deepEqual(s[7], [0, 1]);       // row 1 starts in column 0
    assert.deepEqual(s[62], [13, 8]);
    for (const [x, y] of s) assert.ok((x + y) % 2 === 1);
});

test('legacy even-row layout = rows 1.. of a one-row-taller current board (calib/board.js detectorLayout)', () => {
    const X = 8, Y = 8;
    const legacy = markerSquares(Y, X, true), taller = markerSquares(Y + 1, X);
    const L = detectorLayout(normalizeBoard({ boardX: X, boardY: Y, legacyPattern: true }));
    const phantom = L.ids.filter(id => id >= 1000 - X).length;
    assert.equal(legacy.length, 32);
    legacy.forEach(([x, y], k) => assert.deepEqual(taller[phantom + k], [x, y + 1], `marker ${k}`));
    // odd rows: both layouts are the same board
    assert.deepEqual(markerSquares(9, 14, true), markerSquares(9, 14));
});

test('dictFamily', () => {
    assert.equal(dictFamily('DICT_5X5_1000'), 'DICT_5X5');
    assert.equal(dictFamily('DICT_4X4_50'), 'DICT_4X4');
});

// ---- identification ---------------------------------------------------------------------

test('the lab board (300 x 200 coarse): grid found, two sizes on sale, the square size picks one', () => {
    const obs = [fromPreset('CCT300200C')];
    const r = identifyCalibioBoard(obs);
    assert.equal(r.status, 'size-ambiguous', r.reason);
    assert.deepEqual(r.grid, { rows: 9, cols: 14 });
    assert.deepEqual(r.candidates.map(p => p.sku).sort(), ['CCT300200C', 'CCT600400C']);
    const s = r.scores.find(x => x.rows === 9 && x.cols === 14);
    assert.ok(s.fraction > 0.97, `${s.agree}/${s.pairs}`);
    for (const o of r.scores.filter(x => x.cols !== 14)) assert.ok(o.fraction < 0.6, `${o.rows}x${o.cols} ${o.agree}/${o.pairs}`);
    const hinted = identifyCalibioBoard(obs, { squareHint: 20 });
    assert.equal(hinted.status, 'match');
    assert.equal(hinted.preset.sku, 'CCT300200C');
    assert.ok(/20 mm/.test(hinted.reason), hinted.reason);
    assert.equal(identifyCalibioBoard(obs, { squareHint: 40 }).preset.sku, 'CCT600400C');
    assert.equal(identifyCalibioBoard(obs, { squareHint: 24 }).status, 'size-ambiguous', 'a square no candidate has picks nothing');
});

test('every grid is told from every other on a full view', () => {
    for (const g of presetGrids()) {
        const p = g.presets[0];
        const r = identifyCalibioBoard([observe({ rows: g.rows, cols: g.cols, square: p.squareLength, marker: p.markerLength, seed: g.rows * 100 + g.cols })], { squareHint: p.squareLength });
        assert.equal(r.status, 'match', `${g.rows}x${g.cols}: ${r.reason}`);
        assert.equal(r.preset, p, `${g.rows}x${g.cols}`);
    }
});

test('a board sold in one size needs no hint (100 x 75 ceramic, 15 x 22)', () => {
    const r = identifyCalibioBoard([fromPreset('CCT100075F')]);
    assert.equal(r.status, 'match', r.reason);
    assert.equal(r.preset.sku, 'CCT100075F');
});

test('a patch from the middle of the board (no edge in view) still gives the column count', () => {
    // A homography would fit this patch with a 12- or 14-column numbering alike (shear); the
    // markers' own squares are what tells them apart.
    const keep = (x, y) => x >= 3 && x <= 8 && y >= 2 && y <= 6;
    const obs = [fromPreset('CCT400300C', { keep })];
    assert.ok(obs[0].ids.length >= 12 && obs[0].ids.length < 20);
    const r = identifyCalibioBoard(obs, { squareHint: 30 });
    assert.equal(r.status, 'match', r.reason);
    assert.equal(r.preset.sku, 'CCT400300C');
    const wrong = r.scores.find(x => x.rows === 9 && x.cols === 14);
    assert.ok(wrong.fraction < 0.6, `9x14 ${wrong.agree}/${wrong.pairs}`);
});

test('strong lens distortion, a steep tilt, the board upside down or turned 90 degrees', () => {
    const cases = [
        { k1: -0.25, z: 330, rvec: [0.1, 0.1, 0] },              // fills a wide-angle image
        { rvec: [0.9, -0.3, 0.2] },                               // ~55 degrees of tilt
        { rvec: [0, 0, Math.PI] },                                // upside down
        { rvec: [0.2, 0.1, Math.PI / 2] },                        // portrait
        { rvec: [Math.PI, 0.2, 0.1], z: 400 },                    // seen through the back (mirror image)
    ];
    for (const c of cases) {
        const r = identifyCalibioBoard([fromPreset('CCT300200F', c)], { squareHint: 10 });
        assert.equal(r.status, 'match', `${JSON.stringify(c)}: ${r.reason}`);
        assert.equal(r.preset.sku, 'CCT300200F');
    }
});

test('17 vs 15 rows of 24: both stay candidates until an id past 179 is seen', () => {
    const top = (x, y) => y < 15;
    const r = identifyCalibioBoard([fromPreset('CCT400300F', { keep: top })]);
    assert.equal(r.status, 'size-ambiguous', r.reason);
    assert.deepEqual(r.candidates.map(p => p.sku).sort(), ['CCT075050F', 'CCT150100F', 'CCT200150F', 'CCT400300F', 'CCT800600F']);
    assert.ok(/15 or 17|17 or 15/.test(r.reason), r.reason);
    assert.equal(identifyCalibioBoard([fromPreset('CCT400300F', { keep: top })], { squareHint: 5 }).preset.sku, 'CCT150100F', 'the hint decides');
    const full = identifyCalibioBoard([fromPreset('CCT400300F')]);
    assert.equal(full.status, 'size-ambiguous');
    assert.deepEqual(full.candidates.map(p => p.sku).sort(), ['CCT200150F', 'CCT400300F', 'CCT800600F']);
    assert.equal(identifyCalibioBoard([fromPreset('CCT400300F')], { squareHint: 15 }).preset.sku, 'CCT400300F');
});

test('one board row in view decides nothing; a second image showing more does', () => {
    const row = [fromPreset('CCT300200C', { keep: (x, y) => y === 4 })];
    assert.equal(identifyCalibioBoard(row, { squareHint: 20 }).status, 'undecided');
    const r = identifyCalibioBoard([...row, fromPreset('CCT300200C', { keep: (x, y) => x < 7 && y < 5, seed: 5 })], { squareHint: 20 });
    assert.equal(r.status, 'match', r.reason);
    assert.equal(r.preset.sku, 'CCT300200C');
});

test('nothing yet: no markers, or too few', () => {
    assert.equal(identifyCalibioBoard([]).status, 'undecided');
    assert.equal(identifyCalibioBoard([{ dictName: 'DICT_5X5_1000', ids: new Int32Array(0), corners: new Float32Array(0) }]).status, 'undecided');
    const three = fromPreset('CCT300200C', { keep: (x, y, id) => id < 3 });
    assert.equal(identifyCalibioBoard([three]).status, 'undecided');
});

test('not a calib.io board: another dictionary, or a 5x5 grid calib.io does not sell', () => {
    const d4 = identifyCalibioBoard([observe({ rows: 11, cols: 8, square: 24, marker: 18.75, dictName: 'DICT_4X4_1000' })]);
    assert.equal(d4.status, 'no-match');
    assert.ok(/DICT_4X4/.test(d4.reason), d4.reason);
    const other = identifyCalibioBoard([observe({ rows: 7, cols: 10, square: 30, marker: 22 })]);
    assert.equal(other.status, 'no-match', other.reason);
    const big = identifyCalibioBoard([observe({ rows: 21, cols: 30, square: 10, marker: 7 })]);
    assert.equal(big.status, 'no-match', big.reason);
});

test('the dictionary with the most markers wins; a stray marker id does not rule the board out', () => {
    const good = fromPreset('CCT300200C');
    const stray = fromPreset('CCT300200C', { extra: [{ id: 900, corners: [100, 100, 130, 100, 130, 130, 100, 130] }], seed: 9 });
    const few4 = observe({ rows: 9, cols: 14, square: 20, marker: 15, dictName: 'DICT_4X4_1000', keep: (x, y, id) => id < 4 });
    const r = identifyCalibioBoard([good, stray, few4], { squareHint: 20 });
    assert.equal(r.status, 'match', r.reason);
    assert.equal(r.dictName, 'DICT_5X5_1000');
    assert.equal(r.maxId, 900);
});

test('scoreGridsOnImage: every grid is judged on the same image pairs', () => {
    const grids = presetGrids().map(g => ({ ...g, rho: 0.73 }));
    const s = scoreGridsOnImage(fromPreset('CCT800600C'), grids);
    assert.equal(s.length, grids.length);
    const ok = s[grids.findIndex(g => g.rows === 9 && g.cols === 12)];
    assert.equal(ok.outOfRange, 0);
    assert.ok(ok.agree / ok.pairs > 0.97);
    for (const x of s) assert.ok(x.pairs <= ok.pairs && x.n === 54);
});

run();
