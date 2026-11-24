/**
 * calib/board-presets.js — the ChArUco boards calib.io sells, as board configs.
 *
 * Pure data + lookups, no DOM, no OpenCV.
 *
 * Every value below is from calib.io's ChArUco product page
 * (https://calib.io/products/charuco-targets, read 2026-11-24): its "Fine" and "Coarse"
 * pattern tables (Plate Size, Checker Width [mm], Marker Width [mm], Rows x Columns) and its
 * variant list (size / pattern / material, SKU). What the page does NOT state, and how it is
 * filled in here:
 *   - Dictionary: the page says only "Our default selection of ChArUco targets use the
 *     DICT_5x5 dictionary", without a size. OpenCV's DICT_5X5_50/100/250/1000 are the first
 *     N codes of one list, so a board's ids 0..N-1 are the same markers in all of them; the
 *     largest board here needs 238 ids, so DICT_5X5_1000 (what the lab's 300 x 200 coarse
 *     board is calibrated with, and what PhotonVision tells calib.io owners to pick).
 *   - First marker id: not stated. calib.io's pattern generator has a "Start ID" field; the
 *     stock boards are taken to start at 0 (the lab's 300 x 200 coarse board is detected
 *     with ids from 0 by OpenCV and sleap-anipose). A board starting elsewhere is not a preset.
 *   - Rows x Columns -> squares X / Y: the page doesn't say. Columns = squares X (OpenCV's
 *     squaresX, the long side), rows = squares Y: the lab's 300 x 200 coarse board is
 *     board_x = 14, board_y = 9, and PhotonVision maps calib.io's "9x12" to width 12, height 9.
 *   - Layout: every stock board has an odd number of rows, and the page says such patterns
 *     "are unaffected" by OpenCV 4.6's change for even-row boards, so legacyPattern is false
 *     (both layouts are the same board).
 * Units: mm (calibrat3 uses whatever unit the square is given in; pick Custom for metres).
 */

import { normalizeBoard } from './board.js';

export const CALIBIO_SOURCE = 'https://calib.io/products/charuco-targets';
export const CALIBIO_DICT = 'DICT_5X5_1000';

function preset(sku, plate, pattern, material, rows, cols, squareLength, markerLength) {
    const [w, h] = plate;
    return Object.freeze({
        id: `calibio-${w}x${h}-${pattern}`,
        sku,
        vendor: 'calib.io',
        plate: Object.freeze(plate.slice()),       // [width, height, thickness] mm
        pattern,                                   // 'coarse' | 'fine'
        material,                                  // 'aluminium composite' | 'ceramic'
        rows, cols, squareLength, markerLength,
        dictName: CALIBIO_DICT,
        firstId: 0,
        legacyPattern: false,
        label: `calib.io ${w} × ${h} mm ${pattern}${material === 'ceramic' ? ' (ceramic)' : ''} — ${rows} × ${cols} squares of ${squareLength} mm`,
        source: CALIBIO_SOURCE,
    });
}

/** calib.io's stock ChArUco targets, coarse first, largest first. */
export const CALIBIO_PRESETS = Object.freeze([
    // Coarse, aluminium composite (https://calib.io/products/charuco-targets, "Coarse" table)
    preset('CCT800600C', [800, 600, 6], 'coarse', 'aluminium composite', 9, 12, 60, 45),   // https://calib.io/products/charuco-targets
    preset('CCT600400C', [600, 400, 6], 'coarse', 'aluminium composite', 9, 14, 40, 30),   // https://calib.io/products/charuco-targets
    preset('CCT400300C', [400, 300, 6], 'coarse', 'aluminium composite', 9, 12, 30, 22),   // https://calib.io/products/charuco-targets
    preset('CCT300200C', [300, 200, 6], 'coarse', 'aluminium composite', 9, 14, 20, 15),   // https://calib.io/products/charuco-targets
    preset('CCT200150C', [200, 150, 6], 'coarse', 'aluminium composite', 9, 12, 15, 11),   // https://calib.io/products/charuco-targets
    // Fine, aluminium composite (https://calib.io/products/charuco-targets, "Fine" table)
    preset('CCT800600F', [800, 600, 6], 'fine', 'aluminium composite', 17, 24, 30, 22),    // https://calib.io/products/charuco-targets
    preset('CCT600400F', [600, 400, 6], 'fine', 'aluminium composite', 17, 28, 20, 15),    // https://calib.io/products/charuco-targets
    preset('CCT400300F', [400, 300, 6], 'fine', 'aluminium composite', 17, 24, 15, 11),    // https://calib.io/products/charuco-targets
    preset('CCT300200F', [300, 200, 6], 'fine', 'aluminium composite', 17, 28, 10, 7),     // https://calib.io/products/charuco-targets
    preset('CCT200150F', [200, 150, 6], 'fine', 'aluminium composite', 17, 24, 7.5, 5.5),  // https://calib.io/products/charuco-targets
    // Fine, ceramic (https://calib.io/products/charuco-targets, "Fine" table, ceramic rows)
    preset('CCT150100F', [150, 100, 3], 'fine', 'ceramic', 15, 24, 5, 3.5),                // https://calib.io/products/charuco-targets
    preset('CCT100075F', [100, 75, 3], 'fine', 'ceramic', 15, 22, 4, 3),                   // https://calib.io/products/charuco-targets
    preset('CCT075050F', [75, 50, 3], 'fine', 'ceramic', 15, 24, 2.5, 1.8),                // https://calib.io/products/charuco-targets
]);

/** A preset by id ('calibio-300x200-coarse') or SKU ('CCT300200C'), case-insensitive; null if unknown. */
export function presetById(key) {
    if (key == null) return null;
    const k = String(key).trim().toLowerCase();
    return CALIBIO_PRESETS.find(p => p.id === k || p.sku.toLowerCase() === k) || null;
}

/** The board config (calib/board.js shape) of a preset. */
export function presetBoard(p) {
    return normalizeBoard({
        boardX: p.cols, boardY: p.rows,
        squareLength: p.squareLength, markerLength: p.markerLength,
        dictName: p.dictName, legacyPattern: p.legacyPattern,
    });
}

/**
 * The preset a board config is, value for value (squares X/Y, square, marker, dictionary,
 * pattern), or null. A board measured with calipers (20.02 mm) is not a preset.
 */
export function presetForBoard(board) {
    if (!board) return null;
    for (const p of CALIBIO_PRESETS) {
        if (board.boardX === p.cols && board.boardY === p.rows && board.squareLength === p.squareLength &&
            board.markerLength === p.markerLength && board.dictName === p.dictName && !board.legacyPattern) return p;
    }
    return null;
}

/** Markers on a rows x cols board (white squares). */
export function gridMarkerCount(rows, cols) { return Math.floor((rows * cols) / 2); }

/**
 * The distinct square grids among the presets, each with the presets that have it:
 * [{rows, cols, markers, presets:[...]}], in catalog order.
 */
export function presetGrids(presets = CALIBIO_PRESETS) {
    const grids = [];
    for (const p of presets) {
        let g = grids.find(x => x.rows === p.rows && x.cols === p.cols);
        if (!g) { g = { rows: p.rows, cols: p.cols, markers: gridMarkerCount(p.rows, p.cols), presets: [] }; grids.push(g); }
        g.presets.push(p);
    }
    return grids;
}
