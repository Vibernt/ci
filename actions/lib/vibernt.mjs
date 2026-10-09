/**
 * Shared helpers of the vibernt/report, vibernt/select and vibernt/shard actions (docs/ACTIONS.md). Node 24, no
 * dependencies: inputs and outputs follow the GitHub Actions runner protocol (INPUT_* variables, the GITHUB_OUTPUT and
 * GITHUB_STEP_SUMMARY files), the job's OIDC token comes from the Actions runtime (ACTIONS_ID_TOKEN_REQUEST_URL, which
 * needs `permissions: id-token: write`), and the only other network call is to the Vibernt CI API.
 */
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** An input as the runner passes it (`with: { api-url: ... }` becomes INPUT_API-URL). */
export function input(name, fallback = '') {
    const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
    return value === undefined || value.trim() === '' ? fallback : value.trim();
}
export function booleanInput(name, fallback = false) {
    const value = input(name, '');
    if (!value)
        return fallback;
    if (/^(true|yes|1)$/i.test(value))
        return true;
    if (/^(false|no|0)$/i.test(value))
        return false;
    throw new Error(`Input ${name} must be true or false.`);
}
/** Writes a step output (multi-line safe: a random delimiter the value cannot contain). */
export function setOutput(name, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const file = process.env.GITHUB_OUTPUT;
    if (!file) {
        process.stdout.write(`${name}=${text}\n`);
        return;
    }
    let delimiter = `vibernt_${randomUUID()}`;
    while (text.includes(delimiter))
        delimiter = `vibernt_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}
export function summary(markdown) {
    if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
const escapeCommand = text => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
export const info = message => process.stdout.write(`${message}\n`);
export const warning = message => process.stdout.write(`::warning::${escapeCommand(message)}\n`);
export const error = message => process.stdout.write(`::error::${escapeCommand(message)}\n`);
export function fail(message) {
    error(message);
    process.exitCode = 1;
}
/**
 * The API base URL. HTTPS only, because the OIDC token travels with every request; plain HTTP is accepted for a
 * loopback address alone (a local development server).
 */
export function apiUrl() {
    const url = new URL(input('api-url', 'https://ci.vibernt.ai'));
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        throw new Error('api-url must be an https:// URL.');
    if (url.username || url.password)
        throw new Error('api-url must not contain credentials.');
    return url.origin;
}
/** The audience the API expects: its host, unless the workflow says otherwise. */
export const audience = base => input('audience', new URL(base).host);
/** The job's GitHub Actions OIDC token for `aud` (one per call: the API accepts each token once). */
export async function idToken(aud) {
    const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer)
        throw new Error('No OIDC token is available: give the job `permissions: id-token: write`.');
    const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}audience=${encodeURIComponent(aud)}`, { headers: { authorization: `bearer ${bearer}`, accept: 'application/json' } });
    if (!response.ok)
        throw new Error(`The Actions runtime refused an OIDC token (HTTP ${response.status}).`);
    const body = await response.json();
    if (typeof body?.value !== 'string')
        throw new Error('The Actions runtime returned no OIDC token.');
    return body.value;
}
/** POSTs to the API with a fresh OIDC token; retries a network failure or a 5xx twice, each time with a new token. */
export async function call(path, body) {
    const base = apiUrl(), aud = audience(base);
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt)
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        try {
            const token = await idToken(aud);
            const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
            const text = await response.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : null;
            }
            catch {
                data = null;
            }
            if (response.ok)
                return data;
            const problem = new Error(`${data?.error?.code || 'HTTP_' + response.status}: ${data?.error?.message || text.slice(0, 300)}`);
            problem.status = response.status;
            problem.code = data?.error?.code;
            if (response.status < 500)
                throw problem;
            last = problem;
        }
        catch (problem) {
            if (problem.status && problem.status < 500)
                throw problem;
            last = problem;
        }
    }
    throw last;
}
/** The job key every action of one job must share: the `job` input, or the job's id in the workflow. */
export function jobKey() {
    const job = input('job', process.env.GITHUB_JOB || '');
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(job))
        throw new Error('Input job must be 1 to 80 letters, digits, dots, dashes or underscores (for a matrix, add the matrix values).');
    return job;
}
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'vendor', 'target', 'dist', 'build', '.next', 'coverage']);
/** A glob as a regular expression over a repository-relative path: `**` crosses directories, `*` and `?` do not. */
export function globRegExp(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*' && glob[i + 1] === '*') {
            const slash = glob[i + 2] === '/';
            out += slash ? '(?:.*/)?' : '.*';
            i += slash ? 2 : 1;
        }
        else if (ch === '*')
            out += '[^/]*';
        else if (ch === '?')
            out += '[^/]';
        else
            out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
}
/**
 * Repository-relative files under `root` matching any of `globs` (newline- or comma-separated), sorted. Skips
 * dependency and build directories; at most `max` files.
 */
export function listFiles(globs, { root = process.env.GITHUB_WORKSPACE || process.cwd(), max = 20000 } = {}) {
    const patterns = String(globs).split(/[\n,]/).map(x => x.trim()).filter(Boolean).map(globRegExp);
    const found = [];
    const walk = dir => {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names.sort()) {
            if (SKIP.has(name))
                continue;
            const path = join(dir, name);
            let stat;
            try {
                stat = statSync(path);
            }
            catch {
                continue;
            }
            if (stat.isDirectory())
                walk(path);
            else if (stat.isFile()) {
                const rel = relative(root, path).split(sep).join('/');
                if (patterns.some(re => re.test(rel))) {
                    if (found.length >= max)
                        throw new Error(`More than ${max} files match; narrow the pattern.`);
                    found.push(rel);
                }
            }
        }
    };
    walk(root);
    return found.sort();
}
/** Space-separated, shell-safe enough for `node --test ${{ steps.x.outputs.files }}`: paths with spaces are refused. */
export function spaceList(files) {
    const odd = files.find(f => /\s/.test(f));
    if (odd)
        warning(`"${odd}" contains whitespace; use the files-json output for it.`);
    return files.filter(f => !/\s/.test(f)).join(' ');
}
/**
 * When this job started (epoch ms), so a fan-out leg's setup (every step before it) counts in its measured overhead:
 * VIBERNT_JOB_STARTED_AT when a step set it (`date +%s%3N` into GITHUB_ENV as the job's first step), else the start
 * of the action's parent process, the runner's worker, which GitHub's runner starts for each job (Linux, from /proc:
 * its start in clock ticks after boot, USER_HZ 100), else null. A value in the future or over 6 hours old is not
 * believed.
 */
export function jobStartedAt(now = Date.now(), { env = process.env, ppid = process.ppid, read = path => readFileSync(path, 'utf8') } = {}) {
    const believable = at => Number.isFinite(at) && at > 0 && at <= now + 60000 && now - at <= 6 * 3600000 ? Math.min(Math.round(at), now) : null;
    const given = believable(Number(env.VIBERNT_JOB_STARTED_AT));
    if (given !== null)
        return given;
    try {
        const stat = read(`/proc/${ppid}/stat`);
        // Fields after the command name, which is in parentheses and may contain spaces: starttime is field 22.
        const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
        const boot = Number(/^btime (\d+)$/m.exec(read('/proc/stat'))?.[1]);
        return believable(boot * 1000 + ticks * 10);
    }
    catch {
        return null;
    }
}
/**
 * POSTs to a fan-out queue endpoint with the leg's token: a network error or a 5xx is retried (4 attempts, 1, 2 and
 * 3 s apart), as the native runner's queue client does; a refusal (4xx) is thrown at once.
 */
export async function queuePost(grant, op, body, { attempts = 4, delayMs = 1000 } = {}) {
    let last;
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt)
            await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
        let response;
        try {
            response = await fetch(`${grant.queueUrl}/${op}`, { method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        }
        catch (problem) {
            last = problem;
            continue;
        }
        const data = await response.json().catch(() => ({}));
        if (response.ok)
            return data;
        last = Object.assign(new Error(`${data?.error?.code || 'HTTP_' + response.status}: ${data?.error?.message || ''}`), { status: response.status });
        if (response.status < 500)
            throw last;
    }
    throw last;
}
export async function main(run) {
    try {
        await run();
    }
    catch (problem) {
        fail(problem?.message || String(problem));
    }
}
