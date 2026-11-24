/**
 * tests/cli/barcode-video.mjs — synthetic videos whose every frame carries its own
 * frame number as a barcode, for checking frame numbering through a decoder.
 *
 * Frame i is a W x H gray image of 16 px blocks: blocks 0..11 hold the bits of i
 * (white = 1), blocks 12..23 their complement (a decode check). Lossy codecs keep
 * 16 px black/white blocks intact at high quality, so readBarcode() recovers i exactly.
 * Node only (spawns ffmpeg).
 */
import { spawn } from 'node:child_process';

export const W = 96, H = 64, BLOCK = 16, BITS = 12;
const COLS = W / BLOCK;

export function barcodeFrame(i) {
    const img = new Uint8Array(W * H).fill(0);
    for (let b = 0; b < 2 * BITS; b++) {
        const bit = b < BITS ? (i >> b) & 1 : 1 - ((i >> (b - BITS)) & 1);
        if (!bit) continue;
        const bx = (b % COLS) * BLOCK, by = Math.floor(b / COLS) * BLOCK;
        for (let y = by; y < by + BLOCK; y++) img.fill(255, y * W + bx, y * W + bx + BLOCK);
    }
    return img;
}

/** Frame number encoded in a decoded gray frame, or -1 if the barcode does not check out. */
export function readBarcode(gray, width = W) {
    const bit = (b) => {
        const bx = (b % COLS) * BLOCK + 4, by = Math.floor(b / COLS) * BLOCK + 4;
        let s = 0;
        for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) s += gray[y * width + x];
        return s / 64 > 128 ? 1 : 0;
    };
    let v = 0;
    for (let b = 0; b < BITS; b++) {
        const a = bit(b), c = bit(b + BITS);
        if (a === c) return -1;
        v |= a << b;
    }
    return v;
}

/**
 * Encode `n` barcode frames with ffmpeg.
 * @param {string} out  output .mp4
 * @param {{n:number, codec?:'h264'|'hevc', fragmented?:boolean, ffmpeg?:string}} o
 */
export function makeBarcodeVideo(out, { n, codec = 'h264', fragmented = false, ffmpeg = 'ffmpeg' }) {
    const enc = codec === 'hevc'
        ? ['-c:v', 'libx265', '-preset', 'fast', '-x265-params', 'bframes=4:keyint=24:min-keyint=24:scenecut=0:b-adapt=0:log-level=error', '-crf', '10', '-tag:v', 'hvc1']
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-x264-params', 'bframes=3:b-pyramid=normal:b-adapt=0:keyint=24:scenecut=0', '-crf', '10'];
    const mov = fragmented ? ['-movflags', '+frag_keyframe+empty_moov+default_base_moof'] : [];
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', '30', '-i', 'pipe:0',
        ...enc, '-pix_fmt', 'yuv420p', ...mov, out];
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', reject);
        p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`ffmpeg encode failed (${code}): ${err}`)));
        (async () => {
            for (let i = 0; i < n; i++) if (!p.stdin.write(barcodeFrame(i))) await new Promise(r => p.stdin.once('drain', r));
            p.stdin.end();
        })();
    });
}

/** Whether this ffmpeg has an encoder (libx264 / libx265). */
export function hasEncoder(name, ffmpeg = 'ffmpeg') {
    return new Promise((resolve) => {
        const p = spawn(ffmpeg, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('error', () => resolve(false));
        p.on('close', () => resolve(new RegExp(`\\s${name}\\s`).test(out)));
    });
}
