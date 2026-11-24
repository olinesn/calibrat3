/**
 * tests/cli/test-cli-board.mjs — the command line's board choice (--board, board.toml's
 * `preset` key, Auto) and the report.json fields scripts read (`ok`, `exitCode`, `error`,
 * `board`, `cameras`), on the sample session (a DICT_4X4 board, not a calib.io one).
 *
 * Node only (spawns the CLI, which needs ffmpeg; skipped without it). Auto identifying a real
 * calib.io board needs a rendered session (scripts/make_synthetic_session.py, see README.md).
 */
import { test, run, assert } from '../harness.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffmpegVersion } from '../../cli/ffmpeg-video.mjs';
import { CALIBIO_PRESETS } from '../../calib/board-presets.js';

let haveFfmpeg = true;
try { ffmpegVersion(); } catch (_) { haveFfmpeg = false; }
const dir = mkdtempSync(path.join(tmpdir(), 'calibrat3-cli-board-'));
const SAMPLE = path.resolve('sample_session');
const VIEWS = ['back', 'mid', 'side', 'top'];

function cli(args, tag) {
    const out = path.join(dir, `${tag}.toml`), report = path.join(dir, `${tag}.json`);
    const p = spawnSync(process.execPath, ['cli/calibrate.mjs', ...args, '--out', out, '--report', report, '--workers', '2', '--calib-workers', '2', '-q'], { encoding: 'utf8' });
    return { code: p.status, stderr: p.stderr, out, report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null };
}

/** The sample session's videos with another board.toml. */
function sessionWithBoardToml(name, text) {
    const d = path.join(dir, name);
    mkdirSync(d);
    for (const v of VIEWS) symlinkSync(path.join(SAMPLE, `${v}.mp4`), path.join(d, `${v}.mp4`));
    writeFileSync(path.join(d, 'board.toml'), text);
    return d;
}

test('--list-boards prints every calib.io preset', () => {
    const p = spawnSync(process.execPath, ['cli/calibrate.mjs', '--list-boards'], { encoding: 'utf8' });
    assert.equal(p.status, 0);
    for (const x of CALIBIO_PRESETS) assert.ok(p.stdout.includes(x.id) && p.stdout.includes(x.sku), x.id);
});

test('unknown --board, or --board with the custom board flags: exit 2', () => {
    let r = cli([SAMPLE, '--board', 'CCT999'], 'unknown');
    assert.equal(r.code, 2);
    assert.ok(/not a calib\.io board preset/.test(r.stderr), r.stderr);
    r = cli([SAMPLE, '--board', 'CCT300200C', '--dict', 'DICT_5X5_1000'], 'mixed');
    assert.equal(r.code, 2);
    assert.ok(/sets the whole board/.test(r.stderr), r.stderr);
});

if (!haveFfmpeg) {
    test('ffmpeg not found: skipped', () => {});
} else {
    test('--board auto on a board that is not calib.io: exit 3, report says why, board.toml not used', () => {
        const r = cli([SAMPLE, '--board', 'auto'], 'auto-sample');
        assert.equal(r.code, 3, r.stderr);
        assert.ok(/no calib\.io board identified/.test(r.stderr), r.stderr);
        const j = r.report;
        assert.ok(j, 'report written on failure');
        assert.equal(j.ok, false); assert.equal(j.exitCode, 3); assert.ok(/DICT_4X4/.test(j.error), j.error);
        assert.equal(j.board.source, 'flag'); assert.equal(j.board.requested, 'auto'); assert.equal(j.board.method, 'auto');
        assert.equal(j.board.preset, null); assert.equal(j.board.boardTomlUsed, false); assert.equal(j.board.boardToml, 'board.toml');
        assert.ok(j.board.notes.some(n => /board\.toml not used/.test(n)), JSON.stringify(j.board.notes));
        assert.equal(j.board.auto.status, 'no-match'); assert.equal(j.board.auto.dictName, 'DICT_4X4_1000');
        assert.ok(j.board.auto.framesSearched.length >= 1 && j.board.auto.images >= 4);
        assert.deepEqual(j.cameras.map(c => c.name), VIEWS);
        for (const c of j.cameras) { assert.equal(c.inCalibration, false); assert.ok(c.reason); }
        assert.ok(!existsSync(r.out), 'no calibration.toml');
    });

    test('board.toml preset = "auto": Auto with square_length as the hint, same exit 3 here', () => {
        const d = sessionWithBoardToml('toml-auto', 'preset = "auto"\nsquare_length = 24\n');
        const r = cli([d], 'toml-auto');
        assert.equal(r.code, 3, r.stderr);
        const j = r.report;
        assert.equal(j.board.source, 'board.toml'); assert.equal(j.board.boardTomlUsed, true); assert.equal(j.board.requested, 'auto');
        assert.equal(j.board.auto.squareHint, 24); assert.equal(j.board.auto.squareHintFrom, 'board.toml');
    });

    test('board.toml with values: calibrates, report has the board and every camera', () => {
        const r = cli([SAMPLE], 'toml');
        assert.equal(r.code, 0, r.stderr);
        const j = r.report;
        assert.equal(j.ok, true); assert.equal(j.exitCode, 0); assert.equal(j.error, null);
        assert.equal(j.board.source, 'board.toml'); assert.equal(j.board.method, 'custom'); assert.equal(j.board.requested, 'custom');
        assert.equal(j.board.preset, null); assert.equal(j.board.auto, null);
        assert.deepEqual([j.board.boardX, j.board.boardY, j.board.squareLength, j.board.markerLength, j.board.dictName], [8, 11, 24, 18.75, 'DICT_4X4_1000']);
        assert.deepEqual(j.cameras.map(c => c.name), VIEWS);
        const toml = readFileSync(r.out, 'utf8');
        for (const c of j.cameras) {
            assert.equal(c.inCalibration, true, c.name); assert.equal(c.reason, null);
            assert.ok(c.framesWithBoard > 0 && c.framesWithBoard <= c.framesSampled && c.framesUsable <= c.framesWithBoard, `${c.name} frames`);
            assert.ok(c.reprojectionPx && c.reprojectionPx.median > 0 && c.reprojectionPx.p95 >= c.reprojectionPx.median && c.reprojectionPx.observations > 0, `${c.name} reprojection`);
            assert.ok(toml.includes(`name = "${c.name}"`), `${c.name} in calibration.toml`);
        }
    });
}

await run();
rmSync(dir, { recursive: true, force: true });
