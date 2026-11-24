import { test, run, assert } from './harness.mjs';
import { DEFAULT_BOARD, normalizeBoard, numMarkers, legacyPatternDiffers, tomlFromDictName, DICT_NAMES } from '../calib/board.js';
import { CALIBIO_PRESETS, CALIBIO_DICT, presetById, presetBoard, presetForBoard, presetGrids, gridMarkerCount } from '../calib/board-presets.js';
import { generateBoardToml, parseBoardToml } from '../import-export/toml.js';

test('the catalog: 13 calib.io boards, unique ids and SKUs, each with its source', () => {
    assert.equal(CALIBIO_PRESETS.length, 13);
    assert.equal(new Set(CALIBIO_PRESETS.map(p => p.id)).size, 13);
    assert.equal(new Set(CALIBIO_PRESETS.map(p => p.sku)).size, 13);
    for (const p of CALIBIO_PRESETS) {
        assert.ok(/^calibio-\d+x\d+-(coarse|fine)$/.test(p.id), p.id);
        assert.ok(/^CCT\d{6}[CF]$/.test(p.sku), p.sku);
        assert.equal(p.sku.endsWith('C') ? 'coarse' : 'fine', p.pattern, p.sku);
        assert.ok(p.source.startsWith('https://calib.io/'), p.id);
    }
});

test('every preset passes normalizeBoard, value for value', () => {
    for (const p of CALIBIO_PRESETS) {
        const b = presetBoard(p);
        assert.deepEqual(b, normalizeBoard({ boardX: p.cols, boardY: p.rows, squareLength: p.squareLength, markerLength: p.markerLength, dictName: p.dictName, legacyPattern: false }), p.id);
        assert.equal(b.boardX, p.cols, `${p.id} squares X = columns`);
        assert.equal(b.boardY, p.rows, `${p.id} squares Y = rows`);
    }
});

test('markers fit the dictionary, from id 0', () => {
    assert.ok(DICT_NAMES.includes(CALIBIO_DICT));
    for (const p of CALIBIO_PRESETS) {
        const n = numMarkers(presetBoard(p));
        assert.equal(n, gridMarkerCount(p.rows, p.cols));
        assert.equal(p.firstId, 0, p.id);
        assert.ok(p.firstId + n <= tomlFromDictName(p.dictName).dictSize, `${p.id}: ${n} markers`);
    }
    // the biggest grid (17 x 28 = 238 markers) is why DICT_5X5_50 / _100 would not do
    assert.equal(Math.max(...CALIBIO_PRESETS.map(p => gridMarkerCount(p.rows, p.cols))), 238);
});

test('every board fits on its plate, markers are 70-75 % of a square, rows are odd (no legacy layout)', () => {
    for (const p of CALIBIO_PRESETS) {
        assert.ok(p.cols * p.squareLength <= p.plate[0] && p.rows * p.squareLength <= p.plate[1], `${p.id} ${p.cols * p.squareLength} x ${p.rows * p.squareLength} mm`);
        const r = p.markerLength / p.squareLength;
        assert.ok(r >= 0.7 && r <= 0.75, `${p.id} ratio ${r}`);
        assert.equal(p.rows % 2, 1, p.id);
        assert.equal(legacyPatternDiffers(presetBoard(p)), false, p.id);
        assert.equal(p.legacyPattern, false);
    }
});

test('the lab board campy uses (14 x 9 squares of 20 mm, 15 mm markers, 5x5/1000) is calib.io 300 x 200 coarse', () => {
    const p = presetForBoard(normalizeBoard({ boardX: 14, boardY: 9, squareLength: 20, markerLength: 15, dictName: 'DICT_5X5_1000' }));
    assert.equal(p && p.sku, 'CCT300200C');
    assert.equal(p.id, 'calibio-300x200-coarse');
});

test('presetById takes ids and SKUs in any case; presetForBoard needs every value', () => {
    assert.equal(presetById('calibio-800x600-fine').sku, 'CCT800600F');
    assert.equal(presetById('cct075050f').id, 'calibio-75x50-fine');
    assert.equal(presetById(' CCT200150C ').id, 'calibio-200x150-coarse');
    assert.equal(presetById('auto'), null);
    assert.equal(presetById(null), null);
    for (const p of CALIBIO_PRESETS) assert.equal(presetForBoard(presetBoard(p)), p);
    const b = presetBoard(presetById('CCT300200C'));
    assert.equal(presetForBoard({ ...b, squareLength: 20.02 }), null, 'measured with calipers');
    assert.equal(presetForBoard({ ...b, dictName: 'DICT_5X5_250' }), null);
    assert.equal(presetForBoard({ ...b, legacyPattern: true }), null);
    assert.equal(presetForBoard({ ...b, boardX: 9, boardY: 14 }), null, 'rows and columns swapped is another board');
    assert.equal(presetForBoard(DEFAULT_BOARD), null, 'the default board is not a preset');
});

test('grids: six distinct, most sold in several sizes', () => {
    const grids = presetGrids();
    assert.deepEqual(grids.map(g => `${g.rows}x${g.cols}:${g.presets.length}`), ['9x12:3', '9x14:2', '17x24:3', '17x28:2', '15x24:2', '15x22:1']);
});

test('board.toml preset: a preset fills what the file leaves out, the file wins otherwise', () => {
    const { board } = parseBoardToml('preset = "calibio-300x200-coarse"\n');
    assert.deepEqual(board, { boardX: 14, boardY: 9, squareLength: 20, markerLength: 15, dictName: 'DICT_5X5_1000', legacyPattern: false, preset: 'calibio-300x200-coarse' });
    assert.deepEqual(normalizeBoard(board), presetBoard(presetById('CCT300200C')));
    const sku = parseBoardToml('PRESET = "CCT800600C"\n').board;
    assert.equal(sku.preset, 'calibio-800x600-coarse');
    assert.equal(sku.squareLength, 60);
    const measured = parseBoardToml('preset = "CCT300200C"\nsquare_length = 20.03\n').board;
    assert.equal(measured.squareLength, 20.03);
    assert.equal(measured.boardX, 14);
    assert.equal(presetForBoard(normalizeBoard(measured)), null);
    assert.throws(() => parseBoardToml('preset = "calibio-1x1-coarse"\n'));
});

test('board.toml preset = "auto": no values needed, the ones given are kept as a hint', () => {
    assert.deepEqual(parseBoardToml('preset = "auto"\n').board, { preset: 'auto', legacyPattern: false });
    const b = parseBoardToml('preset = "Auto"\nsquare_length = 20.0\n').board;
    assert.equal(b.preset, 'auto');
    assert.equal(b.squareLength, 20);
});

test('board.toml writer names the preset when the board is one, and reads back the same', () => {
    const b = presetBoard(presetById('CCT600400F'));
    const text = generateBoardToml(b);
    assert.ok(/^preset = "calibio-600x400-fine"/m.test(text), text);
    assert.ok(/board_x = 28/.test(text) && /board_y = 17/.test(text) && /dict_size = 1000/.test(text), text);
    const back = parseBoardToml(text).board;
    assert.equal(back.preset, 'calibio-600x400-fine');
    assert.deepEqual(normalizeBoard(back), b);
    assert.ok(!/preset/.test(generateBoardToml(DEFAULT_BOARD)), 'a custom board writes no preset');
});

run();
