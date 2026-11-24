/**
 * calib/board-identify.js — which calib.io board is in the video, from the ArUco markers seen.
 *
 * Pure JS, no DOM, no OpenCV: the input is what `detectMarkers` returns per image (dictionary,
 * marker ids, each marker's 4 corners in its own order: top-left, top-right, bottom-right,
 * bottom-left as printed).
 *
 * How a grid is recognised. A marker id says where the marker sits on a board of a given
 * size (row-major over the white squares, OpenCV's layout), and each marker's own 4 corners
 * say which way the board's rows and columns run around it and how big a square is there.
 * For every pair of markers that are near each other in the image, each candidate grid
 * predicts where the second marker should be from the first one's corners and the two ids;
 * the board's real grid predicts it within a fraction of a marker, a grid with another
 * number of columns misplaces every pair that spans two rows by one square or more.
 * Comparing whole-board fits (a homography) does not work: on a patch of the board a grid
 * with the wrong column count is just a sheared copy of the right one, which a homography
 * absorbs; the markers' own squares are not sheared.
 *
 * Limits. Boards that differ only in physical size (calib.io sells most grids in two or
 * three sizes) look the same in an image without the camera's focal length, so the size
 * comes from `squareHint` (the Square field, or board.toml's square_length) or not at all.
 * A board with the same columns and fewer rows (calib.io's 15 x 24 vs 17 x 24) is told apart
 * only once a marker id past the smaller board's last one is seen; until then both stay
 * candidates. Markers that all sit in one board row carry no evidence.
 */

import { CALIBIO_PRESETS, presetGrids } from './board-presets.js';

export const IDENTIFY_DEFAULTS = Object.freeze({
    minMarkers: 4,          // an image with fewer markers of a dictionary is ignored
    neighbourRadius: 2.3,   // pair markers whose centres are within this many squares in the image
    agreeTol: 0.35,         // a pair agrees with a grid when predicted within this many marker sides
    fitFraction: 0.85,      // a grid fits when at least this share of the pairs agree
    margin: 0.15,           // ...and beats every grid with another column count by this much
    minPairs: 12,           // pairs needed before deciding anything
    maxOutOfRange: 0.1,     // share of marker ids past a grid's last one that rules the grid out
});

/** 'DICT_5X5_1000' -> 'DICT_5X5'. */
export function dictFamily(dictName) {
    const m = /^(DICT_\d+X\d+)/.exec(dictName || '');
    return m ? m[1] : String(dictName);
}

/**
 * Marker positions on a rows x cols board: index = marker id (from 0), value = [col, row] of
 * its square (row 0 at the top). OpenCV >= 4.6 layout (top-left square black), or for even
 * rows the legacy one (top-left square a marker: calib/board.js detectorLayout's convention).
 */
export function markerSquares(rows, cols, legacy = false) {
    const out = [];
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const black = (legacy && rows % 2 === 0) ? ((y + 1) % 2 === x % 2) : (y % 2 === x % 2);
            if (!black) out.push([x, y]);
        }
    }
    return out;
}

/** Centre, side and local board axes (image px per square) of every marker of one image. */
function markerFrames(corners, n, rho) {
    const h = rho / 2;
    const frames = new Array(n);
    for (let i = 0; i < n; i++) {
        const o = i * 8;
        const p = [[corners[o], corners[o + 1]], [corners[o + 2], corners[o + 3]], [corners[o + 4], corners[o + 5]], [corners[o + 6], corners[o + 7]]];
        const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
        let side = 0;
        for (let k = 0; k < 4; k++) side += Math.hypot(p[(k + 1) % 4][0] - p[k][0], p[(k + 1) % 4][1] - p[k][1]);
        side /= 4;
        // Least-squares affine map from the marker's square (corners at (+-h, +-h) square units,
        // in the detector's order TL, TR, BR, BL) to the image: closed form for these 4 points.
        const au = [(p[1][0] + p[2][0] - p[0][0] - p[3][0]) / (4 * h), (p[1][1] + p[2][1] - p[0][1] - p[3][1]) / (4 * h)];
        const av = [(p[2][0] + p[3][0] - p[0][0] - p[1][0]) / (4 * h), (p[2][1] + p[3][1] - p[0][1] - p[1][1]) / (4 * h)];
        frames[i] = { cx, cy, side, au, av };
    }
    return frames;
}

/**
 * Score candidate grids on one image's markers.
 * @param {{ids:ArrayLike<number>, corners:ArrayLike<number>}} obs  corners: 8 numbers per marker
 * @param {Array<{rows, cols, rho, squares?}>} grids
 * @returns {Array<{agree, pairs, outOfRange, n}>} one per grid
 */
export function scoreGridsOnImage(obs, grids, opts = {}) {
    const o = { ...IDENTIFY_DEFAULTS, ...opts };
    const n = obs.ids.length;
    const rho = grids.length ? grids.reduce((a, g) => a + g.rho, 0) / grids.length : 0.73;
    const fr = markerFrames(obs.corners, n, rho);
    // Pairs chosen from the image alone, so every grid is judged on the same pairs.
    const pairs = [];
    for (let i = 0; i < n; i++) {
        const sq = fr[i].side / rho;
        if (!(sq > 0)) continue;
        for (let j = 0; j < n; j++) {
            if (j === i || obs.ids[j] === obs.ids[i]) continue;
            if (Math.hypot(fr[j].cx - fr[i].cx, fr[j].cy - fr[i].cy) <= o.neighbourRadius * sq) pairs.push(i, j);
        }
    }
    return grids.map((g) => {
        const squares = g.squares || markerSquares(g.rows, g.cols);
        let outOfRange = 0;
        for (let i = 0; i < n; i++) if (!(obs.ids[i] >= 0 && obs.ids[i] < squares.length)) outOfRange++;
        let agree = 0, count = 0;
        for (let k = 0; k < pairs.length; k += 2) {
            const i = pairs[k], j = pairs[k + 1];
            const si = squares[obs.ids[i]], sj = squares[obs.ids[j]];
            if (!si || !sj) continue;
            const du = sj[0] - si[0], dv = sj[1] - si[1];
            const f = fr[i];
            const px = f.cx + f.au[0] * du + f.av[0] * dv, py = f.cy + f.au[1] * du + f.av[1] * dv;
            const err = Math.hypot(px - fr[j].cx, py - fr[j].cy) / f.side;
            count++;
            if (err < o.agreeTol) agree++;
        }
        return { agree, pairs: count, outOfRange, n };
    });
}

const fmtGrid = (g) => `${g.rows} × ${g.cols}`;
const plural = (n, s) => `${n.toLocaleString('en-US')} ${s}${n === 1 ? '' : 's'}`;

/**
 * Identify the calib.io board from marker detections.
 * @param {Array<{dictName:string, ids:ArrayLike<number>, corners:ArrayLike<number>}>} observations
 *        one entry per image and dictionary searched
 * @param {{squareHint?:number|null, presets?:object[]}} [options] plus IDENTIFY_DEFAULTS overrides
 * @returns {{status:'match'|'size-ambiguous'|'undecided'|'no-match', preset:object|null,
 *            candidates:object[], grid:{rows,cols}|null, dictName:string|null, scores:object[],
 *            markersSeen:number, maxId:number, reason:string}}
 */
export function identifyCalibioBoard(observations, options = {}) {
    const { squareHint = null, presets = CALIBIO_PRESETS, ...rest } = options;
    const o = { ...IDENTIFY_DEFAULTS, ...rest };
    const families = new Set(presets.map(p => dictFamily(p.dictName)));
    const result = (status, reason, extra = {}) => ({ status, reason, preset: null, candidates: [], grid: null, dictName: null, scores: [], markersSeen: 0, maxId: -1, ...extra });

    // 1. Which dictionary: the one with the most markers over all images.
    const perDict = new Map();
    for (const ob of observations) {
        if (!ob || !ob.ids || ob.ids.length < o.minMarkers) continue;
        const e = perDict.get(ob.dictName) || { markers: 0, images: 0 };
        e.markers += ob.ids.length; e.images++;
        perDict.set(ob.dictName, e);
    }
    if (perDict.size === 0) return result('undecided', `no image with ${o.minMarkers}+ ArUco markers yet`);
    const ranked = [...perDict.entries()].sort((a, b) => b[1].markers - a[1].markers);
    const [bestDict, bestCount] = ranked[0];
    if (!families.has(dictFamily(bestDict))) {
        return result('no-match', `the markers are ${dictFamily(bestDict)} (${plural(bestCount.markers, 'marker')} in ${plural(bestCount.images, 'image')}); calib.io's stock ChArUco boards are ${[...families].join(' / ')}`, { dictName: bestDict, markersSeen: bestCount.markers });
    }
    const obs = observations.filter(ob => ob && ob.ids && ob.ids.length >= o.minMarkers && ob.dictName === bestDict);
    let markersSeen = 0, maxId = -1;
    for (const ob of obs) { markersSeen += ob.ids.length; for (const id of ob.ids) if (id > maxId) maxId = id; }

    // 2. Score every grid calib.io sells in this dictionary family.
    const grids = presetGrids(presets.filter(p => dictFamily(p.dictName) === dictFamily(bestDict))).map(g => ({
        ...g, rho: g.presets.reduce((a, p) => a + p.markerLength / p.squareLength, 0) / g.presets.length,
        squares: markerSquares(g.rows, g.cols),
    }));
    const scores = grids.map(g => ({ rows: g.rows, cols: g.cols, markers: g.markers, agree: 0, pairs: 0, outOfRange: 0, n: 0, fraction: 0 }));
    for (const ob of obs) {
        const s = scoreGridsOnImage(ob, grids, o);
        s.forEach((r, k) => { scores[k].agree += r.agree; scores[k].pairs += r.pairs; scores[k].outOfRange += r.outOfRange; scores[k].n += r.n; });
    }
    // A grid is ruled out by ids past its last marker: two different ones that a bigger calib.io
    // grid has (a real 17 x 24 board's bottom rows rule out 15 x 24), or many of any kind. One
    // stray id (a misread marker) rules out nothing.
    const allIds = new Set();
    for (const ob of obs) for (const id of ob.ids) allIds.add(id);
    const biggest = Math.max(...grids.map(g => g.markers));
    for (const s of scores) {
        s.fraction = s.pairs ? s.agree / s.pairs : 0;
        let past = 0;
        for (const id of allIds) if (id >= s.markers && id < biggest) past++;
        s.ruledOut = past >= 2 || (s.outOfRange >= 2 && s.outOfRange > o.maxOutOfRange * s.n);
    }
    const base = { dictName: bestDict, scores, markersSeen, maxId };
    const seen = `${dictFamily(bestDict)} markers (${plural(markersSeen, 'detection')} in ${plural(obs.length, 'image')}, ids up to ${maxId})`;
    const maxPairs = Math.max(0, ...scores.filter(s => !s.ruledOut).map(s => s.pairs));
    const live = scores.map((s, k) => ({ s, g: grids[k] })).filter(x => !x.s.ruledOut);
    if (live.length === 0) {
        return result('no-match', `${seen}: ids past the last marker of every calib.io ${dictFamily(bestDict)} board`, base);
    }
    if (maxPairs < o.minPairs) {
        return result('undecided', `${seen}: only ${plural(maxPairs, 'neighbouring marker pair')} so far (${o.minPairs} needed): a frame showing more of the board, over two rows or more, decides`, base);
    }
    live.sort((a, b) => b.s.fraction - a.s.fraction);
    const best = live[0];
    const describe = (x) => `${fmtGrid(x.g)} ${x.s.agree}/${x.s.pairs}`;
    if (best.s.fraction < o.fitFraction) {
        return result('no-match', `${seen}: they don't line up as any calib.io board (best ${describe(best)} neighbouring pairs agree, ${Math.round(o.fitFraction * 100)} % needed)`, base);
    }
    const rival = live.find(x => x.g.cols !== best.g.cols);
    if (rival && rival.s.fraction > best.s.fraction - o.margin) {
        return result('undecided', `${seen}: ${describe(best)} and ${describe(rival)} neighbouring pairs agree: the markers seen so far don't tell these grids apart`, base);
    }
    // Same column count, different rows (15 x 24 vs 17 x 24): equal on every id both have.
    const same = live.filter(x => x.g.cols === best.g.cols && x.s.fraction >= o.fitFraction);
    const candidates = same.flatMap(x => x.g.presets);
    const gridText = same.length === 1 ? `${fmtGrid(best.g)} grid` :
        `${same.map(x => x.g.rows).join(' or ')} × ${best.g.cols} grid (ids up to ${maxId} seen; an id from ${Math.min(...same.map(x => x.g.markers))} on would mean ${Math.max(...same.map(x => x.g.rows))} rows)`;
    const why = `${seen}; ${gridText}: ${describe(best)} neighbouring pairs agree${rival ? ` (next, ${describe(rival)})` : ''}`;
    const grid = { rows: Math.max(...same.map(x => x.g.rows)), cols: best.g.cols };
    if (candidates.length === 1) {
        return { ...result('match', `${why}; calib.io sells it in one size`, base), preset: candidates[0], candidates, grid: { rows: candidates[0].rows, cols: candidates[0].cols } };
    }
    const hint = Number(squareHint);
    if (squareHint != null && Number.isFinite(hint)) {
        const byHint = candidates.filter(p => Math.abs(p.squareLength - hint) < 1e-9);
        if (byHint.length === 1) {
            return { ...result('match', `${why}; ${plural(candidates.length, 'size')} on sale, the square size given (${hint} mm) picks this one`, base), preset: byHint[0], candidates, grid: { rows: byHint[0].rows, cols: byHint[0].cols } };
        }
    }
    return { ...result('size-ambiguous', `${why}; calib.io sells it in ${plural(candidates.length, 'size')} (${candidates.map(p => `${p.plate[0]} × ${p.plate[1]} mm, ${p.squareLength} mm squares`).join('; ')}), which an image can't tell apart`, base), candidates, grid };
}
