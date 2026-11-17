/**
 * cli/web-worker.mjs — the browser `Worker` API on top of node:worker_threads, so the
 * app's own pool clients (loading/detect-pool.js DetectorPool, loading/calib-client.js
 * CalibWorker) and worker scripts run unchanged in Node:
 *
 *   installWebWorker();                       // globalThis.Worker = NodeWebWorker
 *   const pool = new DetectorPool({size: 8}); // spawns loading/detect-worker.js in worker_threads
 *
 * Messages arrive as MessageEvent{data}; worker failures as an 'error' Event with .message
 * (CALIBRAT3_DEBUG=1 also prints the worker's stack trace).
 */
import { Worker as ThreadWorker } from 'node:worker_threads';

const HOST = new URL('./worker-host.mjs', import.meta.url);

export class NodeWebWorker extends EventTarget {
    /** @param {string|URL} url file: URL of a classic worker script */
    constructor(url) {
        super();
        const href = url instanceof URL ? url.href : String(url);
        this._thread = new ThreadWorker(HOST, { workerData: { url: href } });
        this._thread.on('message', (data) => this.dispatchEvent(new MessageEvent('message', { data })));
        this._thread.on('error', (err) => {
            const ev = new Event('error');
            ev.message = err && err.message ? err.message : String(err);
            if (process.env.CALIBRAT3_DEBUG) console.error(err);
            ev.error = err;
            this.dispatchEvent(ev);
        });
    }

    postMessage(msg, transfer) {
        // Only ArrayBuffers (and MessagePorts) are transferable between threads.
        const list = Array.isArray(transfer) ? transfer.filter(t => t instanceof ArrayBuffer) : undefined;
        this._thread.postMessage(msg, list && list.length ? list : undefined);
    }

    terminate() { return this._thread.terminate(); }
}

/** Make `new Worker(url)` create a NodeWebWorker (what DetectorPool / CalibWorker call). */
export function installWebWorker() {
    globalThis.Worker = NodeWebWorker;
}
