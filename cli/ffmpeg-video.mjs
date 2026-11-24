/**
 * cli/ffmpeg-video.mjs — video frames for the command line, decoded by ffmpeg.
 *
 * Frame numbering is the app's (loading/video.js): frame N is the N-th sample of the
 * first video track in PRESENTATION order (sorted by composition time), counting every
 * sample in the file (edit lists ignored, frames cut off at the end of a crashed file
 * dropped — loading/sample-table.js completeSamples). The frame table is read with the
 * app's own sample-table.js + the vendored mp4box.js, and ffmpeg is run so that it emits
 * exactly one picture per sample in presentation order:
 *
 *   -ignore_editlist 1        all samples, like mp4box (no edit-list trimming)
 *   -noautorotate             WebCodecs does not apply the container's rotation either
 *   -fps_mode passthrough     no frame duplication / dropping to a constant rate
 *                             (-vsync passthrough before ffmpeg 5.1)
 *   -pix_fmt gray -f rawvideo the luma plane, expanded to full range (see below)
 *
 * The number of frames ffmpeg emits is checked against the sample table; a mismatch would
 * shift every frame number, so it is an error.
 *
 * Pixels: the app draws each VideoFrame onto a canvas (YUV -> RGB by the browser) and
 * converts RGBA -> gray with OpenCV (0.299 R + 0.587 G + 0.114 B). ffmpeg's `gray` is the
 * Y plane scaled from video range (16-235) to full range (0-255), which is what that
 * RGB -> gray round trip gives up to rounding and chroma (a mean of ~1-2 grey levels
 * on 8-bit images); tests/e2e/cli-parity.mjs measures it against Chromium.
 */
import { spawn, execFileSync } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSampleTable, completeSamples, trackDurationSec, CHUNK_SIZE } from '../loading/sample-table.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP4_EXT = /\.(mp4|mov|m4v)$/i;

let MP4Box = null;
/** The vendored mp4box.js, evaluated in global scope as index.html loads it. */
async function loadMP4Box() {
    if (MP4Box) return MP4Box;
    if (!globalThis.MP4Box) (0, eval)(await readFile(path.join(ROOT, 'lib/mp4box/mp4box.all.min.js'), 'utf8'));
    globalThis.Log?.setLogLevel?.(globalThis.Log.error);
    MP4Box = globalThis.MP4Box;
    return MP4Box;
}

const ffmpegInfo = new Map();
/** `{version:[major, minor], fpsMode:string[]}` for an ffmpeg binary. */
export function ffmpegVersion(ffmpeg = 'ffmpeg') {
    if (ffmpegInfo.has(ffmpeg)) return ffmpegInfo.get(ffmpeg);
    let out;
    try { out = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }); }
    catch (e) { throw new Error(`cannot run ${ffmpeg} (${e.code || e.message}); install ffmpeg or pass --ffmpeg /path/to/ffmpeg (on Spock: module load ffmpeg/6.1)`); }
    const m = /ffmpeg version n?(\d+)\.(\d+)/.exec(out);
    const version = m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [99, 0];   // git builds: assume recent
    const modern = version[0] > 5 || (version[0] === 5 && version[1] >= 1);
    const info = { version, line: out.split('\n')[0], fpsMode: modern ? ['-fps_mode', 'passthrough'] : ['-vsync', 'passthrough'] };
    ffmpegInfo.set(ffmpeg, info);
    return info;
}

/** ffprobe next to the given ffmpeg (same directory), else on PATH. */
function ffprobeFor(ffmpeg) {
    if (ffmpeg.includes('/')) return path.join(path.dirname(ffmpeg), 'ffprobe');
    return 'ffprobe';
}

/**
 * The app's view of a video: size, frame count, fps, keyframes, B-frames — from the
 * MP4 sample table (same code as loading/video.js). Non-MP4 containers (which the app
 * cannot open) fall back to ffprobe's packet count.
 * @returns {Promise<{width, height, codec, totalFrames, fps, duration, keyframes, hasBFrames, fragmented, decodedWidth, decodedHeight, source}>}
 */
export async function probeVideo(file, { ffmpeg = 'ffmpeg' } = {}) {
    const stream = probeStream(file, ffprobeFor(ffmpeg));
    if (!MP4_EXT.test(file)) {
        const n = parseInt(stream.nb_read_packets || stream.nb_frames, 10);
        const [a, b] = String(stream.avg_frame_rate || '30/1').split('/').map(Number);
        return {
            width: stream.width, height: stream.height, codec: stream.codec_name, totalFrames: n, fps: b ? a / b : 30,
            duration: b ? n * b / a : 0, keyframes: NaN, hasBFrames: !!stream.has_b_frames, fragmented: false,
            decodedWidth: stream.width, decodedHeight: stream.height, source: 'ffprobe',
        };
    }
    const M = await loadMP4Box();
    const fh = await open(file, 'r');
    try {
        const { size } = await fh.stat();
        const readBytes = async (offset, len) => {
            const end = Math.min(offset + len, size);
            const buf = Buffer.allocUnsafe(end - offset);
            await fh.read(buf, 0, buf.length, offset);
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
        };
        const { mp4, info, fragmented } = await readSampleTable(M, readBytes, size, { chunkSize: CHUNK_SIZE });
        if (!info.videoTracks || !info.videoTracks.length) throw new Error(`${file}: no video track`);
        const track = info.videoTracks[0];
        const samples = completeSamples(mp4.getTrackSamplesInfo(track.id), size);
        if (!samples.length) throw new Error(`${file}: no samples in the video track`);
        // Presentation order and B-frames exactly as loading/video.js _extractSamples
        const order = samples.map((_, i) => i).sort((a, b) => samples[a].cts - samples[b].cts || a - b);
        const hasBFrames = order.some((d, f) => d !== f);
        let keyframes = samples.filter(s => s.is_sync).length;
        if (!samples[0].is_sync) keyframes++;
        const duration = trackDurationSec(track, samples);
        return {
            width: track.video.width, height: track.video.height, codec: track.codec,
            totalFrames: samples.length, fps: duration > 0 ? samples.length / duration : 30, duration,
            keyframes, hasBFrames, fragmented,
            decodedWidth: stream.width, decodedHeight: stream.height, source: 'mp4box',
        };
    } finally {
        await fh.close();
    }
}

function probeStream(file, ffprobe) {
    let out;
    try {
        out = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
            'stream=codec_name,width,height,avg_frame_rate,nb_frames,has_b_frames', '-of', 'json', file], { encoding: 'utf8' });
    } catch (e) {
        throw new Error(`ffprobe failed on ${file}: ${(e.stderr || e.message || '').toString().trim()}`);
    }
    const s = JSON.parse(out).streams?.[0];
    if (!s) throw new Error(`${file}: no video stream`);
    return s;
}

/**
 * Decode every frame of `file` with ffmpeg and yield the wanted ones as 8-bit gray images
 * in frame order. Unwanted frames are skipped without copying. Back-pressured: ffmpeg is
 * blocked on its pipe while the consumer has not asked for the next frame.
 *
 * @param {string} file
 * @param {object} o
 * @param {number} o.width   output size (the app's: the track's width/height)
 * @param {number} o.height
 * @param {number} o.totalFrames  frames in the sample table (checked)
 * @param {Iterable<number>|null} [o.wanted]  frame numbers to yield (null = all)
 * @param {string} [o.ffmpeg]
 * @param {number} [o.threads]  ffmpeg decoder threads (0 = ffmpeg's choice)
 * @param {{decoded:number}} [o.stats]  filled in as frames come out
 * @yields {{frame:number, gray:Uint8Array}}
 */
export async function* grayFrames(file, o) {
    const { width, height, totalFrames } = o;
    const ffmpeg = o.ffmpeg || 'ffmpeg';
    const { fpsMode } = ffmpegVersion(ffmpeg);
    const wanted = o.wanted ? new Set(o.wanted) : null;
    let lastWanted = totalFrames - 1;
    if (wanted) { lastWanted = -1; for (const f of wanted) if (f > lastWanted) lastWanted = f; }
    const stats = o.stats || {};
    stats.decoded = 0;
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ignore_editlist', '1', '-noautorotate',
        '-threads', String(o.threads ?? 0), '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn', ...fpsMode];
    // Same pixel grid as the app: it draws the frame at the track's width x height.
    if (o.decodedWidth && o.decodedHeight && (o.decodedWidth !== width || o.decodedHeight !== height)) args.push('-vf', `scale=${width}:${height}`);
    args.push('-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1');
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d; });
    const exited = new Promise((resolve) => proc.on('close', (code, signal) => resolve({ code, signal })));
    const spawnError = new Promise((_, reject) => proc.on('error', reject));
    spawnError.catch(() => {});

    const frameSize = width * height;
    let frame = 0, pos = 0;
    let buf = null;            // current wanted frame's buffer (null: skipping)
    let finished = false;
    try {
        for await (const chunk of proc.stdout) {
            let off = 0;
            while (off < chunk.length) {
                if (frame > lastWanted) { finished = true; break; }   // nothing more to yield: stop decoding
                if (pos === 0 && (!wanted || wanted.has(frame))) buf = new Uint8Array(frameSize);
                const n = Math.min(frameSize - pos, chunk.length - off);
                if (buf) buf.set(chunk.subarray(off, off + n), pos);
                pos += n; off += n;
                if (pos === frameSize) {
                    const f = frame;
                    const out = buf;
                    frame++; pos = 0; buf = null;
                    stats.decoded = frame;
                    if (out) yield { frame: f, gray: out };
                }
            }
            if (finished) break;
        }
        if (finished) return;
        const { code, signal } = await Promise.race([exited, spawnError]);
        if (code !== 0) throw new Error(`ffmpeg failed on ${path.basename(file)} (exit ${code}${signal ? `, ${signal}` : ''}): ${stderr.trim().split('\n').slice(-5).join(' | ')}`);
        if (pos !== 0) throw new Error(`${path.basename(file)}: ffmpeg output ends with a partial frame (${pos} of ${frameSize} bytes) — the decoded size is not ${width}x${height}`);
        if (frame < totalFrames) {
            throw new Error(`${path.basename(file)}: ffmpeg decoded ${frame} frames but the file has ${totalFrames} samples — frame numbers would not match the app's; ` +
                `the video may be damaged or start with undecodable frames${stderr ? ` (ffmpeg: ${stderr.trim().split('\n').slice(-3).join(' | ')})` : ''}`);
        }
        // More pictures than samples cannot happen with -fps_mode passthrough; frames past
        // totalFrames (a damaged last sample the app drops) are ignored.
    } finally {
        if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
    }
}

/**
 * One gray frame near `seconds` (fast seek; for probing the board pattern only — the
 * frame number is not exact).
 */
export async function grayFrameAt(file, seconds, { width, height, ffmpeg = 'ffmpeg', decodedWidth, decodedHeight }) {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-noautorotate', '-ss', seconds.toFixed(3), '-i', file, '-map', '0:v:0', '-frames:v', '1'];
    if (decodedWidth && decodedHeight && (decodedWidth !== width || decodedHeight !== height)) args.push('-vf', `scale=${width}:${height}`);
    args.push('-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1');
    return new Promise((resolve, reject) => {
        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = []; let err = '';
        proc.stdout.on('data', (d) => chunks.push(d));
        proc.stderr.on('data', (d) => { err += d; });
        proc.on('error', reject);
        proc.on('close', (code) => {
            const b = Buffer.concat(chunks);
            if (code !== 0 || b.length !== width * height) { resolve(null); return; }
            resolve(new Uint8Array(b.buffer, b.byteOffset, b.length).slice());
        });
    });
}
