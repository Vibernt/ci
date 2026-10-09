/**
 * The prepared workspace of a drop-in fan-out job (v045-b15, docs/ACTIONS.md#build-once-prepare-and-restore): packed
 * once by `vibernt/shard` with `mode: prepare` after the job's own setup steps, restored by each leg with
 * `mode: restore` instead of repeating them. Node 24, no dependencies: a tar writer and a validating tar reader, zstd
 * (node:zlib) or gzip, SHA-256 of the archive as it is written.
 *
 * What is copied follows the native copy (runner/fanout.py `members`): directories, regular files (a hard link as a
 * regular file) and links whose target stays inside the workspace, lexically and on disk; sockets, devices and pipes
 * are left out. A drop-in job's setup ran with whatever the workflow gave it, so more is left out than natively:
 *   - `.git` anywhere (the leg checks out its own commit; checkout's token lives in .git/config),
 *   - credential files anywhere (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`,
 *     `.env` and `.env.*`, `.envrc`) and credential directories (`.ssh`, `.aws`, `.docker`, `.gnupg`, `.kube`, `.azure`),
 *   - key files outside dependency directories (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa`...),
 *   - caches (`.cache`, `.pnpm-store`, `.npm`, `.yarn-cache`, `.turbo`, `.nx`, `.gradle`, `__pycache__`, `.pytest_cache`,
 *     `.mypy_cache`, `.ruff_cache`), and the workflow's own `exclude` globs.
 * Every packed file is also scanned for the values of the job's secret-looking environment variables (names with
 * TOKEN, SECRET, PASSWORD, PRIVATE, CREDENTIAL, API_KEY, ACCESS_KEY or AUTH, and the Actions runtime's own tokens):
 * a file that contains one refuses the whole copy (`secret-in-workspace`), and the legs set up themselves.
 *
 * The reader refuses (`Unsafe`) anything that is not a directory, a regular file or a link, any path that is absolute,
 * climbs out of the workspace, names `.git` or carries a NUL, a link whose target lands outside, a malformed or
 * truncated header, and more than MAX_ENTRIES entries or MAX_EXTRACT_BYTES of content. Restoring validates the whole
 * archive before it writes anything, never writes through a link, and removes what it created when writing fails.
 */
import { closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeSync, chmodSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import zlib from 'node:zlib';

export const MAX_COPY_BYTES = 512 * 1024 * 1024;
export const MAX_ENTRIES = 500000;
export const MAX_EXTRACT_BYTES = 8 * 1024 * 1024 * 1024;
export const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'Pipfile.lock', 'bun.lockb', 'bun.lock'];
const LOCK_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'target', 'vendor', '__pycache__']);
export const CREDENTIAL_FILES = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.envrc', '.dockercfg']);
export const CREDENTIAL_DIRS = new Set(['.git', '.ssh', '.aws', '.docker', '.gnupg', '.kube', '.azure']);
export const CACHE_DIRS = new Set(['.cache', '.pnpm-store', '.npm', '.yarn-cache', '.turbo', '.nx', '.gradle', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const DEPENDENCY_DIRS = new Set(['node_modules', '.venv', 'venv', 'vendor', 'site-packages']);
const ENV_FILE = /^\.env(\..+)?$/;
const KEY_FILE = /\.(pem|key|p12|pfx|jks|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i;
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH/i;
/** Variables that look secret by name but are not (or are URLs whose secret part is elsewhere). */
const NOT_SECRET = new Set(['ACTIONS_ID_TOKEN_REQUEST_URL', 'GITHUB_TOKEN_URL']);

export class Unsafe extends Error {
    constructor(message) {
        super(message);
        this.code = 'UNSAFE';
    }
}

/** Why a path is left out of the copy (`credential`, `cache`, `key`, `git`, `excluded`), or null when it is copied. */
export function excludedReason(rel, isDir, extra = []) {
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    if (parts.includes('.git'))
        return 'git';
    if (isDir && CREDENTIAL_DIRS.has(name))
        return 'credential';
    if (isDir && CACHE_DIRS.has(name))
        return 'cache';
    if (!isDir && (CREDENTIAL_FILES.has(name) || ENV_FILE.test(name)))
        return 'credential';
    if (!isDir && KEY_FILE.test(name) && !parts.slice(0, -1).some(p => DEPENDENCY_DIRS.has(p)))
        return 'key';
    if (extra.some(re => re.test(rel) || (isDir && re.test(`${rel}/`))))
        return 'excluded';
    return null;
}

/** The values of the environment's secret-looking variables (at least 8 characters), the needles a copy is scanned for. */
export function secretValues(env = process.env) {
    const out = new Map();
    for (const [name, value] of Object.entries(env)) {
        if (NOT_SECRET.has(name) || typeof value !== 'string' || value.length < 8 || /^(true|false)$/i.test(value))
            continue;
        if (SECRET_NAME.test(name) || name === 'GITHUB_TOKEN' || name === 'ACTIONS_RUNTIME_TOKEN')
            out.set(value, name);
    }
    return [...out].map(([value, name]) => ({ name, bytes: Buffer.from(value) }));
}

/** A link is copied only when its target stays inside the workspace: lexically, and on disk (runner/fanout.py). */
function linkInside(root, parent, target) {
    if (!target || target.startsWith('/') || target.includes('\0'))
        return false;
    const landing = posix.normalize(posix.join(parent || '.', target));
    if (landing === '..' || landing.startsWith('../'))
        return false;
    try {
        const real = realpathSync(join(root, parent, target));
        const rel = relative(realpathSync(root), real);
        return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
    }
    catch {
        // A dangling link inside the workspace: lexically inside is enough (as GNU tar copies it).
        return true;
    }
}

/**
 * The workspace's entries to copy, each directory before its contents, sorted: `{ name, type: 'dir'|'file'|'link',
 * mode, size, mtime, link }`, and what was left out (`skipped`: counts by reason, and the first few paths).
 */
export function members(root, { exclude = [] } = {}) {
    const extra = exclude.map(globRe);
    const out = [], skipped = { counts: {}, examples: [] };
    const stack = [''];
    while (stack.length) {
        const folder = stack.pop();
        let names;
        try {
            names = readdirSync(folder ? join(root, folder) : root).sort();
        }
        catch {
            continue;
        }
        const below = [];
        for (const name of names) {
            const rel = folder ? `${folder}/${name}` : name;
            let st;
            try {
                st = lstatSync(join(root, rel));
            }
            catch {
                continue;
            }
            const isDir = st.isDirectory();
            const reason = excludedReason(rel, isDir, extra);
            if (reason) {
                skipped.counts[reason] = (skipped.counts[reason] || 0) + 1;
                if (skipped.examples.length < 10)
                    skipped.examples.push(rel);
                continue;
            }
            let entry;
            if (st.isSymbolicLink()) {
                const target = readlinkSync(join(root, rel));
                if (!linkInside(root, folder, target))
                    continue;
                entry = { name: rel, type: 'link', mode: 0o777, size: 0, mtime: st.mtimeMs, link: target };
            }
            else if (isDir) {
                entry = { name: rel, type: 'dir', mode: st.mode & 0o7777, size: 0, mtime: st.mtimeMs };
                below.push(rel);
            }
            else if (st.isFile())
                entry = { name: rel, type: 'file', mode: st.mode & 0o7777, size: st.size, mtime: st.mtimeMs };
            else
                continue;
            out.push(entry);
            if (out.length > MAX_ENTRIES)
                throw new Error(`The workspace has more than ${MAX_ENTRIES} entries to copy.`);
        }
        stack.push(...below.reverse());
    }
    return { entries: out, skipped };
}

/** A glob (`**`, `*`, `?`) as a regular expression over a repository-relative path. */
function globRe(glob) {
    let out = '';
    const g = String(glob).trim().replace(/^\.\//, '').replace(/\/$/, '/**');
    for (let i = 0; i < g.length; i++) {
        const ch = g[i];
        if (ch === '*' && g[i + 1] === '*') {
            const slash = g[i + 2] === '/';
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
    return new RegExp(`^${out}(?:/.*)?$`);
}

/**
 * The digest of every lockfile of the workspace outside dependency directories (runner/fanout.py `lockfile_hash`),
 * or null when it has none: part of the copy's address and the leg's staleness check.
 */
export function lockfileHash(root) {
    const found = [];
    const walk = folder => {
        let names;
        try {
            names = readdirSync(folder ? join(root, folder) : root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        }
        catch {
            return;
        }
        for (const d of names) {
            if (found.length > 200)
                return;
            const rel = folder ? `${folder}/${d.name}` : d.name;
            if (d.isDirectory() && !LOCK_SKIP.has(d.name))
                walk(rel);
            else if (d.isFile() && (LOCKFILES.includes(d.name) || (d.name.startsWith('requirements') && d.name.endsWith('.txt'))))
                found.push(rel);
        }
    };
    walk('');
    if (!found.length)
        return null;
    const digest = createHash('sha256');
    for (const rel of found.sort()) {
        digest.update(`${rel}\0`);
        digest.update(`${createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')}\n`);
    }
    return digest.digest('hex');
}

// ---------- tar ----------
const BLOCK = 512;
const octal = (value, width) => `${Math.floor(value).toString(8).padStart(width - 1, '0')}\0`;
const padding = size => (BLOCK - (size % BLOCK)) % BLOCK;
const TYPE = { file: '0', dir: '5', link: '2' };
const MAX_OCTAL_SIZE = 8 ** 11 - 1;

function paxRecord(key, value) {
    const body = ` ${key}=${value}\n`;
    let len = Buffer.byteLength(body) + 1;
    while (String(len).length + Buffer.byteLength(body) !== len)
        len = String(len).length + Buffer.byteLength(body);
    return `${len}${body}`;
}
function rawHeader(name, type, { mode = 0o644, size = 0, mtime = 0, link = '' } = {}) {
    const block = Buffer.alloc(BLOCK);
    block.write(name, 0, 100, 'utf8');
    block.write(octal(mode, 8), 100, 'ascii');
    block.write(octal(0, 8), 108, 'ascii');
    block.write(octal(0, 8), 116, 'ascii');
    block.write(octal(size, 12), 124, 'ascii');
    block.write(octal(Math.max(0, mtime / 1000), 12), 136, 'ascii');
    block.fill(0x20, 148, 156);
    block.write(type, 156, 'ascii');
    block.write(link, 157, 100, 'utf8');
    block.write('ustar\0', 257, 'ascii');
    block.write('00', 263, 'ascii');
    let sum = 0;
    for (const b of block)
        sum += b;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return block;
}
/** The header block(s) of one entry: a pax header first when a name or link is long or not ASCII, or the size is huge. */
export function tarHeader(entry) {
    const name = entry.type === 'dir' ? `${entry.name}/` : entry.name;
    const ascii = s => /^[\x20-\x7e]*$/.test(s);
    const records = [];
    if (Buffer.byteLength(name) > 100 || !ascii(name))
        records.push(paxRecord('path', name));
    if (entry.link && (Buffer.byteLength(entry.link) > 100 || !ascii(entry.link)))
        records.push(paxRecord('linkpath', entry.link));
    const size = entry.type === 'file' ? entry.size : 0;
    if (size > MAX_OCTAL_SIZE)
        records.push(paxRecord('size', String(size)));
    const own = rawHeader(records.length ? name.slice(0, 99).replace(/[^\x20-\x7e]/g, '_') : name, TYPE[entry.type], { mode: entry.mode, size: size > MAX_OCTAL_SIZE ? 0 : size, mtime: entry.mtime, link: records.some(r => r.includes(' linkpath=')) ? '' : entry.link || '' });
    if (!records.length)
        return [own];
    const data = Buffer.from(records.join(''));
    return [rawHeader('PaxHeader', 'x', { size: data.length }), data, Buffer.alloc(padding(data.length)), own];
}

/** The compressor of the copy: zstd (node:zlib, Node 22.15 and later) when available, else gzip -1. */
export function compressor(prefer = 'zstd') {
    if (prefer === 'zstd' && typeof zlib.createZstdCompress === 'function')
        return { format: 'zstd', stream: zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }) };
    return { format: 'gzip', stream: zlib.createGzip({ level: 1 }) };
}

/**
 * Packs the workspace into `output`: `{ bytes, sha256, format, entries, plainBytes, skipped }`, or throws
 * `{ code: 'too-large' }` past `limit` compressed bytes and `{ code: 'secret-in-workspace', file, variable }` when a
 * packed file contains the value of a secret-looking variable of `env`.
 */
export async function pack(root, output, { limit = MAX_COPY_BYTES, exclude = [], env = process.env, prefer = 'zstd' } = {}) {
    const { entries, skipped } = members(root, { exclude });
    const needles = secretValues(env);
    const overlap = Math.max(0, ...needles.map(n => n.bytes.length)) - 1;
    const { format, stream } = compressor(prefer);
    const file = createWriteStream(output);
    const hash = createHash('sha256');
    let bytes = 0, failure = null;
    stream.on('data', chunk => {
        bytes += chunk.length;
        hash.update(chunk);
        if (bytes > limit && !failure) {
            failure = Object.assign(new Error(`The workspace copy is larger than ${limit} bytes.`), { code: 'too-large' });
        }
        if (!file.write(chunk))
            stream.pause();
    });
    file.on('drain', () => stream.resume());
    const done = new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
        file.on('error', reject);
    });
    done.catch(() => { });
    let plainBytes = 0, pending = [], held = 0;
    // Small pieces (headers, small files) are joined into 1 MiB writes: one compressor call per piece made packing
    // 20,000 small files take seconds.
    const flush = async () => {
        if (!held)
            return;
        const joined = pending.length === 1 ? pending[0] : Buffer.concat(pending, held);
        pending = [];
        held = 0;
        if (!stream.write(joined))
            await once(stream, 'drain');
    };
    const write = async buf => {
        if (failure)
            throw failure;
        plainBytes += buf.length;
        pending.push(buf);
        held += buf.length;
        if (held >= 1024 * 1024)
            await flush();
    };
    const scan = (buf, rel) => {
        for (const n of needles)
            if (buf.indexOf(n.bytes) !== -1)
                throw Object.assign(new Error(`${rel} contains the value of ${n.name}; the workspace is not copied.`), { code: 'secret-in-workspace', file: rel, variable: n.name });
    };
    // One read buffer for every file (a fresh 4 MiB buffer per file made packing 20,000 small files take 10 s).
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
    try {
        for (const entry of entries) {
            if (entry.type !== 'file') {
                for (const part of tarHeader(entry))
                    await write(part);
                continue;
            }
            const path = join(root, entry.name);
            const fd = openSync(path, 'r');
            try {
                // The size is read again from the open file: a file that changed size since the listing is copied as it is now.
                const size = lstatSync(path).size;
                for (const part of tarHeader({ ...entry, size }))
                    await write(part);
                let tail = Buffer.alloc(0), left = size;
                while (left > 0) {
                    const n = readSync(fd, chunk, 0, Math.min(chunk.length, left), null);
                    if (n <= 0)
                        break;
                    const piece = Buffer.from(chunk.subarray(0, n));
                    if (needles.length) {
                        scan(tail.length ? Buffer.concat([tail, piece]) : piece, entry.name);
                        tail = overlap > 0 ? piece.subarray(Math.max(0, piece.length - overlap)) : Buffer.alloc(0);
                    }
                    await write(piece);
                    left -= n;
                }
                // A file that shrank is padded with zeros to its declared size, so the archive stays well formed.
                if (left > 0)
                    await write(Buffer.alloc(left));
                await write(Buffer.alloc(padding(size)));
            }
            finally {
                closeSync(fd);
            }
        }
        await write(Buffer.alloc(BLOCK * 2));
        await flush();
        if (failure)
            throw failure;
        stream.end();
        await done;
        await new Promise((resolve, reject) => file.end(error => (error ? reject(error) : resolve())));
    }
    catch (error) {
        stream.destroy();
        file.destroy();
        throw error;
    }
    if (failure)
        throw failure;
    return { bytes, sha256: hash.digest('hex'), format, entries: entries.length, plainBytes, skipped };
}

// ---------- reading ----------
/** The archive's format from its first bytes: `zstd`, `gzip`, or null. */
export function formatOf(head) {
    if (head.length >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd)
        return 'zstd';
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b)
        return 'gzip';
    return null;
}
function decompressed(path) {
    const fd = openSync(path, 'r');
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    closeSync(fd);
    const format = formatOf(head);
    if (!format)
        throw new Unsafe('The workspace copy is neither zstd nor gzip.');
    if (format === 'zstd' && typeof zlib.createZstdDecompress !== 'function')
        throw new Unsafe('This Node.js cannot decompress zstd.');
    const inflate = format === 'zstd' ? zlib.createZstdDecompress() : zlib.createGunzip();
    return createReadStream(path).pipe(inflate);
}
const text = field => {
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
};
function number(field) {
    const s = text(field).trim();
    if (s === '')
        return 0;
    if (!/^[0-7]+$/.test(s))
        throw new Unsafe('A malformed number in an archive header.');
    return parseInt(s, 8);
}
function checksumOk(block) {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++)
        sum += i >= 148 && i < 156 ? 0x20 : block[i];
    return number(block.subarray(148, 156)) === sum;
}
function pax(data) {
    const out = {};
    let at = 0;
    while (at < data.length) {
        const space = data.indexOf(0x20, at);
        if (space === -1)
            throw new Unsafe('A malformed pax header.');
        const len = Number(data.subarray(at, space).toString('ascii'));
        if (!Number.isInteger(len) || len <= 0 || at + len > data.length)
            throw new Unsafe('A malformed pax header.');
        const record = data.subarray(space + 1, at + len - 1).toString('utf8');
        const eq = record.indexOf('=');
        if (eq === -1)
            throw new Unsafe('A malformed pax header.');
        const key = record.slice(0, eq);
        if (!['path', 'linkpath', 'size', 'mtime', 'atime', 'ctime'].includes(key))
            throw new Unsafe(`An unsupported pax header key (${key.slice(0, 40)}).`);
        out[key] = record.slice(eq + 1);
        at += len;
    }
    return out;
}
/** Whether a member path is safe to write under the workspace (relative, inside, no `.git`, no NUL), normalised. */
export function safeMember(name) {
    const clean = String(name).replace(/\/+$/, '');
    if (!clean || clean.includes('\0') || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.includes('\\'))
        return null;
    const norm = posix.normalize(clean);
    if (norm === '.' || norm === '..' || norm.startsWith('../') || norm !== clean.replace(/^\.\//, ''))
        return null;
    if (norm.split('/').some(p => p === '.git' || p === '..' || p === '.'))
        return null;
    return norm;
}
/**
 * Reads the tar stream of the copy at `path`, calling `visit(entry)` for each member (`{ name, type, mode, size,
 * mtime, link }`); `visit` returns a function that receives the member's data, or nothing. Refuses (Unsafe) anything
 * outside the rules above.
 */
export async function readTar(path, visit) {
    const source = decompressed(path)[Symbol.asyncIterator]();
    let buf = Buffer.alloc(0), ended = false;
    const fill = async n => {
        while (buf.length < n && !ended) {
            const { value, done } = await source.next();
            if (done)
                ended = true;
            else
                buf = buf.length ? Buffer.concat([buf, value]) : value;
        }
        return buf.length >= n;
    };
    const take = async n => {
        if (!(await fill(n)))
            throw new Unsafe('The workspace copy is truncated.');
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        return out;
    };
    /** Streams `n` bytes to `sink` (or skips them) without holding them all. */
    const stream = async (n, sink) => {
        let left = n;
        while (left > 0) {
            if (!buf.length && !(await fill(1)))
                throw new Unsafe('The workspace copy is truncated.');
            const k = Math.min(left, buf.length);
            if (sink)
                await sink(buf.subarray(0, k));
            buf = buf.subarray(k);
            left -= k;
        }
    };
    let entries = 0, total = 0, extended = null;
    for (;;) {
        const block = await take(BLOCK);
        if (block.every(b => b === 0)) {
            // The end: a second zero block, then nothing but zero padding.
            const second = await take(BLOCK);
            if (!second.every(b => b === 0))
                throw new Unsafe('A malformed end of the archive.');
            while (await fill(1)) {
                if (!buf.every(b => b === 0))
                    throw new Unsafe('Data after the end of the archive.');
                buf = Buffer.alloc(0);
            }
            return { entries, bytes: total };
        }
        if (!checksumOk(block) || text(block.subarray(257, 263)) !== 'ustar')
            throw new Unsafe('A malformed archive header.');
        const type = String.fromCharCode(block[156] || 0x30);
        let size = number(block.subarray(124, 136));
        if (type === 'x' || type === 'L' || type === 'K') {
            if (size > 1024 * 1024)
                throw new Unsafe('An extended header is too large.');
            const data = await take(size);
            await take(padding(size));
            extended = extended || {};
            if (type === 'x')
                Object.assign(extended, pax(data));
            else
                extended[type === 'L' ? 'path' : 'linkpath'] = text(data);
            continue;
        }
        const raw = extended?.path ?? text(block.subarray(0, 100));
        const link = extended?.linkpath ?? text(block.subarray(157, 257));
        if (extended?.size !== undefined) {
            size = Number(extended.size);
            if (!Number.isSafeInteger(size) || size < 0)
                throw new Unsafe('A malformed size in an extended header.');
        }
        extended = null;
        const kind = type === '0' || type === '\0' ? 'file' : type === '5' ? 'dir' : type === '2' ? 'link' : null;
        if (!kind)
            throw new Unsafe(`An archive member of an unsupported type (${JSON.stringify(type)}).`);
        const name = safeMember(raw);
        if (!name)
            throw new Unsafe(`An archive member outside the workspace (${raw.slice(0, 120)}).`);
        if (kind === 'link') {
            const parent = posix.dirname(name);
            const landing = posix.normalize(posix.join(parent, link));
            if (!link || link.startsWith('/') || link.includes('\0') || landing === '..' || landing.startsWith('../') || landing.split('/').includes('.git'))
                throw new Unsafe(`A link that leaves the workspace (${name.slice(0, 120)}).`);
        }
        if (kind !== 'file' && size !== 0)
            throw new Unsafe('A directory or link with content.');
        if (++entries > MAX_ENTRIES)
            throw new Unsafe(`More than ${MAX_ENTRIES} entries.`);
        total += size;
        if (total > MAX_EXTRACT_BYTES)
            throw new Unsafe(`More than ${MAX_EXTRACT_BYTES} bytes of content.`);
        const sink = await visit({ name, type: kind, mode: number(block.subarray(100, 108)) & 0o7777, size, mtime: number(block.subarray(136, 148)) * 1000, link });
        await stream(size, sink);
        await stream(padding(size), null);
    }
}

/** Checks the whole archive (every header, every rule) without writing: `{ entries, bytes }`. */
export const validate = path => readTar(path, () => null);

/**
 * Restores the copy at `path` over the workspace `root` (the leg's checkout). Writes nothing through a link: every
 * parent of a member must be a real directory inside `root`. On any failure the top-level paths it created are removed
 * and the error is thrown. Returns `{ entries, bytes }`.
 */
export async function extract(path, root) {
    const created = new Set();
    const before = new Set(readdirSync(root));
    // Directories already checked (or made) in this restore: a member's parents are looked at once, not per member.
    const known = new Set();
    // Directories this restore made: nothing of the checkout can be inside them, so their members need no lstat.
    const fresh = new Set();
    const ensureDir = rel => {
        if (known.has(rel))
            return;
        let at = '';
        for (const part of rel.split('/')) {
            at = at ? `${at}/${part}` : part;
            if (known.has(at))
                continue;
            const full = join(root, at);
            let st = null;
            try {
                st = lstatSync(full);
            }
            catch { }
            if (!st) {
                mkdirSync(full);
                fresh.add(at);
                if (!before.has(at.split('/')[0]))
                    created.add(at.split('/')[0]);
            }
            else if (!st.isDirectory())
                throw new Unsafe(`${at.slice(0, 120)} is in the way of the copy (not a directory).`);
            known.add(at);
        }
    };
    const dirs = [];
    try {
        const result = await readTar(path, entry => {
            const full = join(root, entry.name);
            const parent = posix.dirname(entry.name);
            if (parent !== '.')
                ensureDir(parent);
            if (!before.has(entry.name.split('/')[0]))
                created.add(entry.name.split('/')[0]);
            let st = null;
            if (!fresh.has(parent))
                try {
                    st = lstatSync(full);
                }
                catch { }
            if (entry.type === 'dir') {
                if (st && !st.isDirectory())
                    throw new Unsafe(`${entry.name.slice(0, 120)} is in the way of the copy (not a directory).`);
                if (!st) {
                    mkdirSync(full);
                    fresh.add(entry.name);
                }
                known.add(entry.name);
                dirs.push(entry);
                return null;
            }
            if (st?.isDirectory())
                throw new Unsafe(`${entry.name.slice(0, 120)} is a directory in the checkout and not in the copy.`);
            if (st)
                unlinkSync(full);
            if (entry.type === 'link') {
                symlinkSync(entry.link, full);
                return null;
            }
            const fd = openSync(full, 'wx', entry.mode & 0o777 | 0o200);
            let left = entry.size;
            const finish = () => {
                closeSync(fd);
                // The mode it was opened with is right for the usual 0644 and 0755 (umask 022); anything else is set.
                const mode = entry.mode & 0o7777;
                if (mode !== ((mode & 0o755) | 0o200))
                    chmodSync(full, mode);
                if (entry.mtime > 0)
                    utimesSync(full, entry.mtime / 1000, entry.mtime / 1000);
            };
            if (!left) {
                finish();
                return null;
            }
            return chunk => {
                writeSync(fd, chunk);
                left -= chunk.length;
                if (left === 0)
                    finish();
            };
        });
        for (const d of dirs) {
            chmodSync(join(root, d.name), d.mode & 0o7777 | 0o700);
            if (d.mtime > 0)
                utimesSync(join(root, d.name), d.mtime / 1000, d.mtime / 1000);
        }
        return result;
    }
    catch (error) {
        for (const top of created)
            rmSync(join(root, top), { recursive: true, force: true });
        throw error;
    }
}

/** SHA-256 and size of a file. */
export async function fileDigest(path) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
        bytes += chunk.length;
    }
    return { sha256: hash.digest('hex'), bytes };
}

export const exists = existsSync;
