/**
 * tests/run-mjs-tests.mjs — run every tests/test-*.mjs in its own process.
 *
 *   node tests/run-mjs-tests.mjs            # all
 *   node tests/run-mjs-tests.mjs geometry   # only files whose name contains "geometry"
 *
 * tests/test-*.mjs are pure-logic tests (calib/, import-export/) — no DOM, no OpenCV —
 * that the browser runner (tests/test-runner.html) loads too. tests/cli/test-*.mjs are
 * Node-only tests of the command line (cli/: ffmpeg, worker_threads); they skip
 * themselves when ffmpeg is missing.
 * Browser-level behaviour (workers, WebCodecs) is covered by tests/e2e/.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const filters = process.argv.slice(2);
const list = (sub) => readdirSync(path.join(here, sub)).filter(f => f.startsWith('test-') && f.endsWith('.mjs')).sort().map(f => path.join(sub, f));
const files = [...list('.'), ...list('cli')]
    .filter(f => filters.length === 0 || filters.some(s => f.includes(s)));
if (files.length === 0) { console.error('no matching tests/test-*.mjs or tests/cli/test-*.mjs'); process.exit(1); }

let failed = 0;
for (const file of files) {
    console.log(`\n== ${file}`);
    const code = await new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join('tests', file)], { cwd: root, stdio: 'inherit' });
        p.on('close', resolve);
    });
    if (code !== 0) failed++;
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
