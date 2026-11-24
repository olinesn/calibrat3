/**
 * tests/cli/test-ffmpeg-frames.mjs — the command line's frame numbering (cli/ffmpeg-video.mjs)
 * on videos with B-frames: frame N from ffmpeg must be the app's frame N, i.e. the N-th
 * sample in presentation order of the MP4 sample table (loading/video.js). Every frame
 * carries its own number as a barcode (tests/cli/barcode-video.mjs).
 *
 * Node only (spawns ffmpeg; skipped without it). The browser side of the same check —
 * WebCodecs frames vs ffmpeg frames — is tests/e2e/cli-parity.mjs.
 */
import { test, run, assert } from '../harness.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeVideo, grayFrames, ffmpegVersion } from '../../cli/ffmpeg-video.mjs';
import { makeBarcodeVideo, readBarcode, hasEncoder, W, H } from './barcode-video.mjs';

let haveFfmpeg = true;
try { ffmpegVersion(); } catch (_) { haveFfmpeg = false; }
const dir = mkdtempSync(path.join(tmpdir(), 'calibrat3-frames-'));
const N = 100;

async function decodeAll(file, info, wanted = null) {
    const out = [];
    for await (const { frame, gray } of grayFrames(file, { width: info.width, height: info.height, totalFrames: info.totalFrames, wanted })) {
        out.push({ frame, code: readBarcode(gray) });
    }
    return out;
}

async function checkVideo(file, label) {
    const info = await probeVideo(file);
    assert.equal(info.totalFrames, N, `${label}: frames in the sample table`);
    assert.equal(info.width, W, `${label}: width`); assert.equal(info.height, H, `${label}: height`);
    assert.ok(info.hasBFrames, `${label}: decode order differs from presentation order (B-frames)`);
    const all = await decodeAll(file, info);
    assert.equal(all.length, N, `${label}: frames out of ffmpeg`);
    for (const { frame, code } of all) assert.equal(code, frame, `${label}: frame ${frame} shows`);
    const wanted = [0, 1, 7, 23, 24, 25, 50, 98, 99];
    const some = await decodeAll(file, info, wanted);
    assert.deepEqual(some.map(x => x.frame), wanted, `${label}: wanted frames, in order`);
    for (const { frame, code } of some) assert.equal(code, frame, `${label}: wanted frame ${frame} shows`);
}

if (!haveFfmpeg) {
    test('ffmpeg not found: skipped', () => {});
} else {
    test('H.264 with B-frames (b-pyramid): ffmpeg frame N is presentation frame N', async () => {
        const f = await makeBarcodeVideo(path.join(dir, 'h264.mp4'), { n: N, codec: 'h264' });
        await checkVideo(f, 'h264');
    });
    test('H.264 with B-frames, fragmented MP4: same numbering', async () => {
        const f = await makeBarcodeVideo(path.join(dir, 'h264-frag.mp4'), { n: N, codec: 'h264', fragmented: true });
        const info = await probeVideo(f);
        assert.ok(info.fragmented, 'fragmented');
        await checkVideo(f, 'h264 fragmented');
    });
    test('HEVC with B-frames, fragmented MP4 (as campy writes): same numbering', async () => {
        if (!(await hasEncoder('libx265'))) { console.log('    (no libx265 encoder: skipped)'); return; }
        const f = await makeBarcodeVideo(path.join(dir, 'hevc-frag.mp4'), { n: N, codec: 'hevc', fragmented: true });
        await checkVideo(f, 'hevc fragmented');
    });
    test('stopping early (only early frames wanted) ends ffmpeg cleanly', async () => {
        const f = path.join(dir, 'h264.mp4');
        const info = await probeVideo(f);
        const got = await decodeAll(f, info, [2, 3]);
        assert.deepEqual(got.map(x => x.code), [2, 3]);
    });
}

await run();
rmSync(dir, { recursive: true, force: true });
