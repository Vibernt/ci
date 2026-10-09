/**
 * vibernt/shard: split a job's test files across matrix legs (docs/ACTIONS.md).
 *
 * `mode: fixed` (default): this leg's test files, split by recorded duration with one plan per workflow run; every leg
 * and every re-run reads that plan, so each file runs in exactly one leg. When the API cannot be reached the leg
 * outputs every file (it runs the whole suite) instead of guessing, so no file is ever left out.
 *
 * `mode: plan` (fan-out, docs/TEST_INTELLIGENCE.md#fan-out): a plan job lists the test files and records the run's
 * fan-out plan; it outputs `matrix` (a JSON list of leg numbers) for the legs' `strategy.matrix`, because GitHub fixes a
 * matrix's size when the plan job finishes.
 *
 * `mode: pull`: a matrix leg pulls its work from the run's queue: it claims a batch of units, runs `run` once with the
 * batch's files (`{files}` in the command, and VIBERNT_FILES), attributes each JUnit case to the unit whose file it
 * names (package-relative paths mapped to repository paths), posts the batch's results in one call, heartbeats its
 * leases, and repeats until the queue is drained, so a slow or lost leg's work is taken over by the others. It reports
 * when its job started, so its setup counts in the plan's per-leg overhead. It fails when a unit it ran failed (and
 * won: a speculative copy that lost does not count).
 *
 * `mode: prepare` and `mode: restore` (build once, v045-b15, docs/ACTIONS.md#build-once-prepare-and-restore): the plan
 * job, after the job's own setup steps, packs the prepared workspace (actions/lib/workspace.mjs: no .git, credential
 * files, keys or caches; refused when a file holds a secret-looking variable's value) and uploads it through the sealed
 * copy path; each leg, after its checkout, restores it instead of repeating the setup, verified by size and digest.
 * Neither ever fails the job: without a copy (none, too large, stale, another trust level, any error) the step says
 * `restored: false` and the leg's own setup steps run (`if: steps.<id>.outputs.restored != 'true'`).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { input, booleanInput, setOutput, summary, info, warning, call, jobKey, listFiles, spaceList, main, jobStartedAt, queuePost, apiUrl } from '../lib/vibernt.mjs';
import { pack, validate, extract, lockfileHash, MAX_COPY_BYTES } from '../lib/workspace.mjs';
import { junitCases } from '../lib/junit.mjs';
import { attribute, packageRoots, resultPosts, norm, safeRelative } from '../lib/fanout.mjs';

const DEFAULT_PATTERN = ['**/*.test.{js,mjs,cjs,ts,mts,tsx,jsx}', '**/*.spec.{js,mjs,cjs,ts,mts,tsx,jsx}', '**/test_*.py', '**/*_test.py', '**/*_test.go'].join('\n');
const MODES = ['fixed', 'plan', 'pull', 'prepare', 'restore'];
/** A leg the queue keeps waiting (for a re-queued unit or a speculative copy) gives up after this long in all. */
const MAX_IDLE_MS = 5 * 60000;
const workspace = () => process.env.GITHUB_WORKSPACE || process.cwd();

/** `{a,b}` alternatives expanded, since the glob helper matches `*`, `**` and `?` only. */
function expand(patterns) {
    return patterns.split(/\n/).map(x => x.trim()).filter(Boolean).flatMap(p => {
        const m = /\{([^{}]+)\}/.exec(p);
        return m ? expand(m[1].split(',').map(alt => p.replace(m[0], alt)).join('\n')) : [p];
    });
}

function emit(files, extra = {}) {
    setOutput('files', spaceList(files));
    setOutput('files-json', JSON.stringify(files));
    setOutput('count', String(files.length));
    for (const [k, v] of Object.entries(extra))
        setOutput(k, String(v));
}

const project = () => (input('project') ? { project: input('project') } : {});
/**
 * The job's test files: `files-from` (a checked-in file with one repository path per line, for lists longer than an
 * input can carry; files not in the checkout are left out with a warning), else the `pattern` globs.
 */
function testFiles() {
    const from = input('files-from');
    if (from) {
        const root = workspace();
        const wanted = [...new Set(readFileSync(join(root, from), 'utf8').split(/\n/).map(x => x.trim().replace(/^\.\//, '')).filter(x => x && !x.startsWith('#')))];
        const present = wanted.filter(f => safeRelative(f) && existsSync(join(root, f))).sort();
        if (present.length < wanted.length)
            warning(`${wanted.length - present.length} listed test file(s) are not in the checkout, for example ${wanted.find(f => !present.includes(f))}.`);
        return present;
    }
    return listFiles(expand(input('pattern', DEFAULT_PATTERN)).join('\n'));
}

async function fixed(job) {
    const index = Number(input('index', '')), total = Number(input('total', ''));
    if (!Number.isInteger(total) || total < 2 || total > 16 || !Number.isInteger(index) || index < 1 || index > total)
        throw new Error('index must be 1 to total, and total 2 to 16 (for example index: ${{ matrix.shard }}, total: 4).');
    const files = testFiles();
    if (!files.length)
        throw new Error('No test file matches the pattern.');
    let result;
    try {
        result = await call('/v1/actions/shard', { job, index, total, files, ...project() });
    }
    catch (problem) {
        if (booleanInput('fail-on-error', false))
            throw problem;
        warning(`Shard plan unavailable (${problem.message}); this leg runs every test file.`);
        return emit(files, { basis: 'unavailable' });
    }
    emit(result.files, { basis: result.basis, digest: result.digest });
    info(`Shard ${index} of ${total}: ${result.files.length} file(s), split ${result.basis}${result.balance ? `, balance ${result.balance}` : ''}.`);
    summary(`### Vibernt CI shard ${index} of ${total}\n\n${result.files.length} test files (${result.basis}). Plan ${result.digest}.`);
}

async function plan(job) {
    const files = testFiles();
    if (!files.length)
        throw new Error('No test file matches the pattern.');
    const max = input('max') ? Number(input('max')) : undefined;
    if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 50))
        throw new Error('max must be 1 to 50.');
    const costCap = input('cost-cap') ? Number(input('cost-cap')) : undefined;
    if (costCap !== undefined && !(costCap >= 1 && costCap <= 10))
        throw new Error('cost-cap must be a number from 1 to 10.');
    let result;
    try {
        result = await call('/v1/actions/shard', {
            job, mode: 'plan', files, ...(max ? { max } : {}), ...(input('target') ? { target: input('target') } : {}), ...(input('fail-fast') ? { failFast: input('fail-fast') } : {}),
            ...(input('timeout') ? { timeout: input('timeout') } : {}), ...(costCap !== undefined ? { costCap } : {}), ...project()
        });
    }
    catch (problem) {
        if (booleanInput('fail-on-error', false))
            throw problem;
        // One leg: it pulls nothing and runs every file (see pull below), so nothing is left out.
        warning(`Fan-out plan unavailable (${problem.message}); one leg runs every test file.`);
        setOutput('matrix', '[1]');
        setOutput('shards', '1');
        setOutput('basis', 'unavailable');
        return;
    }
    setOutput('matrix', JSON.stringify(result.matrix));
    setOutput('shards', String(result.shards));
    setOutput('basis', result.basis);
    setOutput('digest', result.digest);
    const s = ms => `${Math.round((ms || 0) / 1000)} s`;
    info(`Fan-out plan: ${result.shards} leg(s), ${files.length} test file(s), expected wall ${s(result.expected?.wallMs)} against ${s(result.expected?.singleWallMs)} on one leg, per-leg overhead ${s(result.overheadMs)} (setup included), cost ${result.cost?.ratio ?? '?'}x one leg.`);
    if (result.history?.estimate)
        info(result.history.estimate);
    summary(`### Vibernt CI fan-out plan\n\n${result.shards} legs for ${files.length} test files (${result.basis}). Expected wall ${s(result.expected?.wallMs)}, one leg ${s(result.expected?.singleWallMs)}; per-leg overhead ${s(result.overheadMs)}. Plan ${result.digest}.`);
}

/** Runs the leg's command for a batch's files: `{ code, timedOut, stopped }`. */
function runBatch(command, files, stop, timeoutMs) {
    const list = files.join(' ');
    return new Promise(resolve => {
        const child = spawn('bash', ['-eo', 'pipefail', '-c', command.replaceAll('{files}', list)], { stdio: 'inherit', env: { ...process.env, VIBERNT_FILES: list }, detached: true });
        let timedOut = false;
        const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { } };
        const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1000, timeoutMs));
        const watch = setInterval(() => { if (stop()) kill(); }, 250);
        child.on('close', code => { clearTimeout(timer); clearInterval(watch); resolve({ code, timedOut, stopped: !timedOut && stop() }); });
    });
}

/** The `batch` input: true (the queue's largest batch), false (one unit a claim) or a number of units. */
function batchSize(grant) {
    const raw = input('batch', 'true');
    if (/^(true|yes)$/i.test(raw))
        return Math.max(1, Math.min(256, Number(grant.batchMax) || 64));
    if (/^(false|no)$/i.test(raw))
        return 1;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 256)
        throw new Error('batch must be true, false or a number of units from 1 to 256.');
    return n;
}

async function pull(job) {
    const index = Number(input('index', ''));
    const command = input('run');
    const report = input('junit', 'junit.xml');
    if (!Number.isInteger(index) || index < 1 || index > 50)
        throw new Error('index must be 1 to 50 (for example index: ${{ matrix.shard }}).');
    if (!command)
        throw new Error('Pull mode needs `run`: the test command, with {files} where the batch\'s test files go (they are also in VIBERNT_FILES).');
    const root = norm(input('root', ''));
    if (root && !safeRelative(root))
        throw new Error('root must be a directory inside the repository, for example packages/core.');
    const startedAt = jobStartedAt();
    let grant;
    try {
        grant = await call('/v1/actions/shard', { job, mode: 'pull', index, ...(startedAt ? { startedAt } : {}), ...project() });
    }
    catch (problem) {
        if (booleanInput('fail-on-error', false) || index > 1)
            throw problem;
        // The plan was unavailable too: leg 1 runs the whole suite, so no test is left out.
        warning(`Fan-out queue unavailable (${problem.message}); this leg runs every test file.`);
        const files = testFiles();
        const { code } = await runBatch(command, files, () => false, 6 * 3600000);
        if (code !== 0)
            throw new Error(`The test command failed (exit ${code}).`);
        return;
    }
    const size = batchSize(grant);
    // The setup this leg repeated (every step before this one): part of the plan's per-leg overhead.
    const setupMs = startedAt ? Math.max(0, Date.now() - startedAt) : null;
    if (setupMs !== null)
        info(`Setup before this step: ${Math.round(setupMs / 1000)} s.`);
    const leases = new Set();
    const cancelled = new Set();
    let stopped = false;
    const beat = setInterval(() => {
        queuePost(grant, 'heartbeat', { leases: [...leases] }).then(answer => {
            for (const lease of answer.cancel || [])
                cancelled.add(lease);
            if (answer.stop)
                stopped = true;
        }).catch(() => { });
    }, Math.max(1000, grant.heartbeatMs || 10000));
    const cwd = relative(workspace(), process.cwd());
    let failed = 0, units = 0, won = 0, batches = 0, idleMs = 0, first = true;
    try {
        for (;;) {
            const answer = await queuePost(grant, 'claim', { ...(size > 1 ? { batch: size } : {}), ...(first && setupMs !== null ? { setupMs } : {}) });
            first = false;
            if (answer.stop || answer.done) {
                if (answer.reason === 'stopped-early')
                    info('The group stopped early after a confirmed failure: no more units for this leg.');
                break;
            }
            if (answer.wait) {
                // Out of work while units run elsewhere: the queue keeps one leg briefly for a re-queued unit or a
                // speculative copy; this bound only guards against waiting on a queue that never lets go.
                if (idleMs >= MAX_IDLE_MS)
                    break;
                const wait = Math.min(5000, answer.wait);
                idleMs += wait;
                await new Promise(resolve => setTimeout(resolve, wait));
                continue;
            }
            idleMs = 0;
            const batch = answer.units || [answer.unit];
            units += batch.length;
            batches++;
            for (const u of batch)
                leases.add(u.lease);
            for (const path of listFiles(report))
                rmSync(path, { force: true });
            const files = batch.flatMap(u => u.files);
            info(`Batch ${batches}: ${batch.length} unit(s), ${files.length} file(s)${batch.some(u => u.speculative) ? ' (speculative copy)' : ''}, estimated ${Math.round(batch.reduce((n, u) => n + (u.estMs || 0), 0) / 1000)} s.`);
            const started = Date.now();
            // The longest unit timeout of the batch, or three times its estimate when that is longer: one invocation
            // runs every unit, so the batch has the time its units would have had.
            const timeoutMs = Math.min(6 * 3600000, Math.max(...batch.map(u => u.timeoutMs || 1800000), 3 * batch.reduce((n, u) => n + (u.estMs || 0), 0)));
            const ran = await runBatch(command, files, () => stopped || batch.every(u => cancelled.has(u.lease)), timeoutMs);
            const wall = Date.now() - started;
            for (const u of batch)
                leases.delete(u.lease);
            let cases = [], unreadable = false, found = [];
            if (!ran.stopped && !ran.timedOut)
                for (const path of listFiles(report).slice(0, 20)) {
                    found.push(path);
                    try {
                        cases.push(...junitCases(readFileSync(join(workspace(), path), 'utf8')).cases);
                    }
                    catch (problem) {
                        unreadable = true;
                        warning(`Report ${path} could not be read (${problem.message}).`);
                    }
                }
            const byUnit = attribute(cases, batch, { roots: packageRoots({ root, cwd, reports: found }) });
            // A failed run that names no failing test (a crash, a missing or broken report) fails every unit of the batch.
            const unexplained = !ran.stopped && !ran.timedOut && (ran.code !== 0 || unreadable || !found.length) && !cases.some(c => c.status === 'failed');
            const results = batch.map(u => {
                const mine = byUnit.get(u.id) || [];
                const status = ran.stopped || cancelled.has(u.lease) ? 'cancelled' : ran.timedOut ? 'timeout' : unexplained || mine.some(c => c.status === 'failed') ? 'failed' : 'passed';
                const measured = mine.reduce((n, c) => n + (c.durationMs || 0), 0);
                return {
                    lease: u.lease, status, durationMs: ran.timedOut ? wall : measured > 0 ? measured : Math.round(wall / batch.length), exitCode: Number.isInteger(ran.code) ? ran.code : null,
                    cases: status === 'cancelled' ? [] : mine.slice(0, 5000).map(c => ({ suite: c.suite, name: c.name, file: c.file, status: c.status, durationMs: c.durationMs, message: c.message }))
                };
            });
            info(`Batch ${batches} ran in ${Math.round(wall / 1000)} s: exit ${ran.code}${ran.timedOut ? ' (timed out)' : ''}, ${cases.length} case(s), ${cases.filter(c => c.status === 'failed').length} failed${unexplained ? ' (a failure without a failing test: every unit fails)' : ''}.`);
            const posted = Date.now();
            for (const part of resultPosts(results)) {
                const answer = await queuePost(grant, 'result', { results: part });
                (answer.results || []).forEach((verdict, k) => {
                    const r = part[k];
                    if (verdict?.error)
                        warning(`The result of a unit was refused: ${verdict.error.code}.`);
                    // An immediate retry of another unit's failure (stop early, v045-a15): evidence, never this leg's outcome.
                    else if (verdict?.confirm !== undefined && verdict?.confirm !== null)
                        info(`Immediate retry of unit ${verdict.confirm}: ${verdict.reproduced ? 'reproduced' : 'not reproduced (recorded as flaky)'}.${verdict.stoppedEarly ? ' The failure is confirmed: no more units are handed out (stopped early).' : ''}`);
                    else if (verdict?.winner && r.status !== 'cancelled') {
                        won++;
                        if (r.status !== 'passed') {
                            failed++;
                            info(`A unit failed (${r.status}): ${r.cases.filter(c => c.status === 'failed').slice(0, 5).map(c => `${c.file} > ${c.name}`).join('; ') || 'no failing test named'}.`);
                        }
                    }
                });
            }
            info(`Batch ${batches}: ${results.length} result(s) posted in ${Date.now() - posted} ms.`);
        }
    }
    finally {
        clearInterval(beat);
    }
    setOutput('units', String(units));
    summary(`### Vibernt CI fan-out leg ${index}\n\n${units} unit(s) in ${batches} batch(es), ${won} result(s) kept, ${failed} failed.${setupMs !== null ? ` Setup ${Math.round(setupMs / 1000)} s.` : ''}${stopped ? ' The group was stopped (fail-fast).' : ''}`);
    if (failed || stopped)
        throw new Error(stopped ? 'A test failed on another leg and fail-fast stopped this group.' : `${failed} test unit(s) failed.`);
}

// ---------- build once: prepare and restore (v045-b15) ----------
const mib = n => `${(n / 1048576).toFixed(1)} MiB`;
const secs = ms => `${(ms / 1000).toFixed(1)} s`;
const scratch = () => mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'vibernt-workspace-'));
/** `max-size`: bytes, or a number with k, m or g; never more than the copy's limit (512 MiB). */
function maxSize() {
    const raw = input('max-size', '');
    if (!raw)
        return MAX_COPY_BYTES;
    const m = /^([0-9]+(?:\.[0-9]+)?)\s*([kmg]?)i?b?$/i.exec(raw);
    if (!m)
        throw new Error('max-size is a size such as 300m or 1g.');
    const n = Number(m[1]) * { '': 1, k: 1024, m: 1048576, g: 1073741824 }[m[2].toLowerCase()];
    return Math.min(MAX_COPY_BYTES, Math.floor(n));
}
/**
 * A request to the copy's own URL (its grant is the authority, never the OIDC token), relative to the API origin and
 * refused on any other; a network error or a 5xx is retried.
 */
async function grantFetch(path, init, attempts = 3) {
    const url = new URL(path, apiUrl());
    if (url.origin !== apiUrl())
        throw new Error('The API answered a copy URL on another origin.');
    let last;
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt)
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        try {
            const response = await fetch(url, init);
            if (response.ok || response.status < 500)
                return response;
            last = new Error(`HTTP ${response.status}`);
            await response.body?.cancel();
        }
        catch (problem) {
            last = problem;
        }
    }
    throw last;
}
const refusal = async response => {
    const data = await response.json().catch(() => null);
    return new Error(`${data?.error?.code || 'HTTP_' + response.status}: ${data?.error?.message || ''}`);
};
/**
 * `mode: prepare`: packs the workspace as the job's setup steps left it and uploads it in parts. Never fails the job
 * (unless `fail-on-error`): without a copy the legs run their own setup steps, and the reason is recorded.
 */
async function prepare(job) {
    const root = workspace();
    const startedAt = jobStartedAt();
    const setupMs = startedAt ? Math.max(0, Date.now() - startedAt) : null;
    const exclude = input('exclude', '').split(/\n/).map(x => x.trim()).filter(Boolean);
    const limit = maxSize();
    const dir = scratch();
    const archive = join(dir, 'workspace.tar');
    const skip = async (reason, message) => {
        warning(`${message} The legs run their own setup steps.`);
        setOutput('saved', 'false');
        setOutput('reason', reason);
        await call('/v1/actions/shard', { job, mode: 'prepare', skipped: reason, ...(setupMs !== null ? { setupMs } : {}), ...project() }).catch(() => { });
        if (booleanInput('fail-on-error', false))
            throw new Error(message);
    };
    try {
        const packStarted = Date.now();
        const lock = lockfileHash(root);
        let packed;
        try {
            packed = await pack(root, archive, { limit, exclude, env: process.env });
        }
        catch (problem) {
            const reason = ['too-large', 'secret-in-workspace'].includes(problem.code) ? problem.code : 'pack-failed';
            return await skip(reason, `The workspace was not copied: ${problem.message}`);
        }
        const left = Object.entries(packed.skipped.counts).map(([k, v]) => `${v} ${k}`).join(', ');
        info(`Packed ${packed.entries} entries (${mib(packed.plainBytes)}) into ${mib(packed.bytes)} of ${packed.format} in ${secs(Date.now() - packStarted)}${left ? `; left out: ${left}` : ''}.`);
        let answer;
        try {
            answer = await call('/v1/actions/shard', { job, mode: 'prepare', bytes: packed.bytes, sha256: packed.sha256, lockfileHash: lock || 'none', ...(setupMs !== null ? { setupMs } : {}), ...project() });
        }
        catch (problem) {
            if (booleanInput('fail-on-error', false))
                throw problem;
            warning(`The prepared workspace was not uploaded (${problem.message}); the legs run their own setup steps.`);
            setOutput('saved', 'false');
            setOutput('reason', problem.code === 'FANOUT_COPY_SIZE' ? 'too-large' : 'unavailable');
            return;
        }
        if (!answer.upload) {
            setOutput('saved', answer.stored ? 'true' : 'false');
            setOutput('reason', answer.reason || '');
            info(answer.stored ? 'This run\'s prepared workspace is already stored.' : `No upload (${answer.reason}).`);
            return;
        }
        const uploadStarted = Date.now();
        const { url, partBytes, parts } = answer.upload;
        const fd = openSync(archive, 'r');
        try {
            let next = 0;
            // Four parts in flight; each carries its SHA-256, checked by the Worker before it is sealed and stored.
            const worker = async () => {
                while (next < parts) {
                    const n = next++;
                    const size = Math.min(partBytes, packed.bytes - n * partBytes);
                    const body = Buffer.allocUnsafe(size);
                    readSync(fd, body, 0, size, n * partBytes);
                    const digest = createHash('sha256').update(body).digest('hex');
                    const response = await grantFetch(`${url}&part=${n}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-vibernt-sha256': digest }, body });
                    if (!response.ok)
                        throw await refusal(response);
                    await response.body?.cancel();
                }
            };
            await Promise.all(Array.from({ length: Math.min(4, parts) }, worker));
        }
        finally {
            closeSync(fd);
        }
        const done = await grantFetch(url, { method: 'POST' });
        if (!done.ok)
            throw await refusal(done);
        info(`Uploaded the prepared workspace in ${parts} part(s) in ${secs(Date.now() - uploadStarted)}; the legs restore it instead of repeating the setup${setupMs !== null ? ` (${secs(setupMs)} before this step)` : ''}.`);
        setOutput('saved', 'true');
        setOutput('reason', '');
        setOutput('bytes', String(packed.bytes));
        setOutput('digest', packed.sha256);
        summary(`### Vibernt CI prepared workspace\n\n${packed.entries} entries, ${mib(packed.bytes)} (${packed.format}), uploaded for the legs of \`${job}\`.${left ? ` Left out: ${left}.` : ''}`);
    }
    catch (problem) {
        if (booleanInput('fail-on-error', false))
            throw problem;
        warning(`The prepared workspace was not stored (${problem.message}); the legs run their own setup steps.`);
        setOutput('saved', 'false');
        setOutput('reason', 'upload-failed');
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/**
 * `mode: restore`: the run's prepared workspace over this leg's checkout, verified by size and digest and checked
 * whole before anything is written. Without one (none, skipped, stale, another trust level, any error) it outputs
 * `restored: false` and the leg's own setup steps run.
 */
async function restore(job) {
    const root = workspace();
    const started = Date.now();
    const dir = scratch();
    const archive = join(dir, 'workspace.tar');
    const fallback = reason => {
        warning(`No prepared workspace restored (${reason}): this leg runs its own setup steps.`);
        setOutput('restored', 'false');
        setOutput('reason', reason);
        if (booleanInput('fail-on-error', false))
            throw new Error(`No prepared workspace restored (${reason}).`);
    };
    try {
        const lock = lockfileHash(root);
        let answer;
        try {
            answer = await call('/v1/actions/shard', { job, mode: 'restore', lockfileHash: lock || 'none', ...project() });
        }
        catch (problem) {
            return fallback(`unavailable: ${problem.message}`);
        }
        if (!answer.restore)
            return fallback(answer.reason || 'missing');
        const expected = answer.restore;
        let response;
        try {
            response = await grantFetch(expected.url, { method: 'GET' });
        }
        catch (problem) {
            return fallback(`download failed: ${problem.message}`);
        }
        if (!response.ok)
            return fallback(`download refused: ${(await refusal(response)).message}`);
        const hash = createHash('sha256');
        let bytes = 0;
        const file = createWriteStream(archive);
        try {
            for await (const chunk of response.body) {
                bytes += chunk.length;
                if (bytes > expected.bytes)
                    throw new Error('the download is longer than the prepared workspace');
                hash.update(chunk);
                if (!file.write(chunk))
                    await new Promise(resolve => file.once('drain', resolve));
            }
            await new Promise((resolve, reject) => file.end(error => (error ? reject(error) : resolve())));
        }
        catch (problem) {
            file.destroy();
            return fallback(`download failed: ${problem.message}`);
        }
        const digest = hash.digest('hex');
        if (bytes !== expected.bytes || digest !== expected.sha256)
            return fallback(`the download does not match the prepared workspace (${bytes} bytes, sha256 ${digest.slice(0, 12)})`);
        const downloaded = Date.now();
        let result;
        try {
            // The whole archive is checked before anything is written; a failure while writing removes what was created.
            await validate(archive);
            result = await extract(archive, root);
        }
        catch (problem) {
            return fallback(`the copy was refused: ${problem.message}`);
        }
        info(`Restored the prepared workspace: ${result.entries} entries, ${mib(bytes)} downloaded in ${secs(downloaded - started)}, written in ${secs(Date.now() - downloaded)}.`);
        setOutput('restored', 'true');
        setOutput('reason', '');
        setOutput('bytes', String(bytes));
        setOutput('restore-ms', String(Date.now() - started));
        summary(`### Vibernt CI restored workspace\n\nRestored ${mib(bytes)} in ${secs(Date.now() - started)} instead of repeating the setup.`);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

main(async () => {
    const job = jobKey();
    const mode = input('mode', 'fixed');
    if (!MODES.includes(mode))
        throw new Error('mode must be fixed, plan, pull, prepare or restore.');
    if (mode === 'prepare')
        return prepare(job);
    if (mode === 'restore')
        return restore(job);
    if (mode === 'plan')
        return plan(job);
    if (mode === 'pull')
        return pull(job);
    return fixed(job);
});
