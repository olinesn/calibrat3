/**
 * cli/worker-host.mjs — runs one of the app's classic Web Worker scripts
 * (loading/detect-worker.js, loading/calib-worker.js) unchanged inside a Node
 * worker_thread, by providing the few worker globals they use:
 *
 *   self, location, postMessage(msg, transfer), onmessage, close(),
 *   importScripts(url)  — evaluates a classic script (opencv.js) in the global scope,
 *                          exactly as a browser worker would,
 *   fetch(file:...)     — sba-solver-wasm loads its .wasm with fetch(new URL(..., import.meta.url)).
 *
 * The worker script itself is then import()ed: package.json says "type": "module", so it
 * runs as an ES module (strict mode) and its dynamic import('../calib/...') resolve
 * relative to its own URL, as in the browser.
 *
 * workerData: {url} — file: URL of the worker script.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const scriptUrl = workerData.url;

globalThis.self = globalThis;
globalThis.location = new URL(scriptUrl);   // WorkerLocation (Emscripten reads self.location.href)
globalThis.onmessage = null;
globalThis.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer && transfer.length ? transfer : undefined);
globalThis.close = () => parentPort.close();
globalThis.importScripts = (...urls) => {
    for (const u of urls) {
        const file = fileURLToPath(new URL(u, scriptUrl));
        // Classic-script semantics: top-level `this` and var declarations land on globalThis.
        // No `module` / `define` in scope, so a UMD bundle (opencv.js) takes its
        // worker/global branch and sets `self.cv` — what the browser worker sees.
        // Emscripten's runtime also calls require('fs') when it sees Node (opencv.js does, for
        // its unused NODEFS), and a classic script in a browser has no `require`: give it one.
        if (typeof globalThis.require !== 'function') globalThis.require = createRequire(file);
        vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file });
    }
};
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
    if (href.startsWith('file:')) {
        const type = href.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
        return new Response(readFileSync(fileURLToPath(href)), { headers: { 'content-type': type } });
    }
    return nodeFetch(input, init);
};

parentPort.on('message', (data) => {
    if (typeof globalThis.onmessage === 'function') globalThis.onmessage({ data });
});

await import(scriptUrl);
