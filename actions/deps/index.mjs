/**
 * vibernt/deps (optional, docs/NODE_MODULES.md#drop-in-jobs): installed node_modules by exact install identity for
 * GitHub Actions jobs, on drop-in runners or anywhere else. The composite action.yml wraps actions/cache: this script
 * computes the key and the paths (`plan`), then verifies a restored tree with the package manager's offline mode or
 * installs in full and decides whether the new tree may be saved (`install`). The same rules as native jobs
 * (runner/nodemodules.py): no prefix fallback, a restored tree that does not verify is replaced by a full install,
 * an install that changes anything outside node_modules and the declared outputs is never saved, and a fork's pull
 * request never saves. Node 24, no dependencies.
 *
 * The key depends on install inputs only: the lockfile, the dependency fields of the lockfile's importers' package.json
 * files, the project's install configuration (pnpm-workspace.yaml, .npmrc, pnpmfile, patches), the package manager's
 * version, Node's major version, the platform and the variables that change what an install writes. Build outputs (a
 * package.json under dist/, restored by build once) and tool variables (TURBO_*) are not install inputs.
 *
 * For pnpm projects with a supply-chain policy (minimumReleaseAge, trustPolicy), pnpm's metadata cache is saved and
 * restored with the tree: the offline verify reads it (without it pnpm stops with ERR_PNPM_NO_OFFLINE_META).
 *
 * Its only network calls are the dependency store's guard before a full install: when the job's registry is the Vibernt
 * dependency store, a sample of the lockfile's tarballs is fetched from the public registry and through the store, and
 * a store that is slower (or fails, or serves other bytes) is left out of the rest of the job.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setOutput, info, warning, summary, booleanInput, main } from '../lib/vibernt.mjs';

export const MANAGERS = {
    pnpm: { lockfile: 'pnpm-lock.yaml', install: ['pnpm', 'install', '--frozen-lockfile'], verify: ['pnpm', 'install', '--frozen-lockfile', '--offline'] },
    npm: { lockfile: 'package-lock.json', install: ['npm', 'ci', '--foreground-scripts', '--no-audit', '--no-fund'], verify: ['npm', 'install', '--offline', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund'] }
};
const INSTALL_FILES = new Set(['package.json', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', 'npm-shrinkwrap.json']);
/** The project directory's own install configuration (beside the lockfile). */
const ROOT_FILES = ['pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', 'npm-shrinkwrap.json'];
/** The fields of an importer's package.json that an install reads. */
const MANIFEST_FIELDS = ['name', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'dependenciesMeta', 'bundleDependencies', 'bundledDependencies', 'overrides', 'resolutions', 'pnpm', 'workspaces', 'packageManager', 'bin', 'directories', 'os', 'cpu', 'libc'];
/** An importer's own scripts that run during an install. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'];
/** Variables that change what an install writes: the package managers' own configuration, NODE_ENV, native builds. */
const ENV_PREFIXES = ['npm_config_', 'NPM_CONFIG_', 'pnpm_config_', 'PNPM_CONFIG_'];
const ENV_NAMES = new Set(['NODE_ENV', 'PYTHON', 'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'GYP_DEFINES']);
/** Package-manager configuration that does not change the tree (where to read the registry, logging, caches, tokens). */
const ENV_IGNORED = /^(?:npm|pnpm)_config_(?:userconfig|globalconfig|registry|cache|cache_dir|loglevel|progress|reporter|color|fund|audit|update_notifier|yes|_auth.*|.*token.*|.*password.*)$/i;
const HOME_CACHES = ['.npm', '.pnpm-store', '.cache/pnpm', '.local/share/pnpm', '.local/state/pnpm', '.cache/node/corepack', '.cache/node-gyp', '.node-gyp', '.cache/prisma', '.cache/checkpoint-nodejs', '.config/pnpm', '.npmrc'];
/** Directories of the GitHub Actions runner itself under the home: its logs and its work root (workspaces, temp, tools). */
const RUNNER_DIRS = new Set(['_diag', '_work']);
const SKIP = new Set(['node_modules', '.git']);
export const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';
const sha256 = data => createHash('sha256').update(data).digest('hex');

/** `directory`, `manager`, `outputs` and `metadata` inputs, validated: relative, no `..`, never inside node_modules or .git. */
export function spec(env = process.env) {
    const get = name => (env[`INPUT_${name.toUpperCase()}`] || '').trim();
    const plain = (path, what) => {
        const parts = path.split('/');
        if (!path || path.startsWith('/') || parts.some(p => ['', '.', '..', 'node_modules', '.git'].includes(p)))
            throw new Error(`${what} must be a plain relative path outside node_modules and .git: ${path}`);
        return path;
    };
    const directory = get('directory') && get('directory') !== '.' ? plain(get('directory').replace(/\/+$/, ''), 'directory') : '.';
    const manager = get('manager') || 'auto';
    if (!['auto', 'pnpm', 'npm'].includes(manager))
        throw new Error(`manager must be auto, pnpm or npm: ${manager}`);
    const metadata = get('metadata') || 'auto';
    if (!['auto', 'true', 'false'].includes(metadata))
        throw new Error(`metadata must be auto, true or false: ${metadata}`);
    const outputs = [...new Set(get('outputs').split('\n').map(x => x.trim()).filter(Boolean).map(x => plain(x.replace(/\/+$/, ''), 'outputs')))].sort();
    for (const output of outputs)
        if (INSTALL_FILES.has(output.split('/').pop()) || Object.values(MANAGERS).some(m => output.endsWith(m.lockfile)))
            throw new Error(`An install file cannot be an output: ${output}`);
    return { directory, manager, outputs, metadata };
}
function walk(root, visit, { skip = SKIP, under = '' } = {}) {
    let entries;
    try {
        entries = readdirSync(join(root, under), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const rel = under ? `${under}/${entry.name}` : entry.name;
        if (entry.isDirectory() && skip.has(entry.name))
            continue;
        if (visit(rel, entry) === false)
            continue;
        if (entry.isDirectory())
            walk(root, visit, { skip, under: rel });
    }
}
/** The lockfile's importers (project directories, relative to the lockfile's directory, '.' for the root). */
export function importersOf(dir, manager) {
    const importers = new Set(['.']);
    const text = readFileSync(join(dir, MANAGERS[manager].lockfile), 'utf8');
    if (manager === 'pnpm') {
        const block = /^importers:\n((?: {2}.*\n|\n)*)/m.exec(text);
        for (const m of (block?.[1] || '').matchAll(/^ {2}(['"]?)([^'"\n:][^'"\n]*?)\1:\s*$/gm))
            importers.add(m[2]);
    }
    else {
        for (const key of Object.keys(JSON.parse(text).packages || {}))
            if (key && !key.split('/').includes('node_modules'))
                importers.add(key);
    }
    return [...importers].filter(p => !p.split('/').some(x => x === '..' || x === 'node_modules')).sort();
}
/** The install-relevant part of a package.json: dependency fields and install scripts, or null when unreadable. */
function manifestInputs(path) {
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return existsSync(path) ? 'unreadable' : null;
    }
    const out = {};
    for (const field of MANIFEST_FIELDS)
        if (manifest[field] !== undefined)
            out[field] = manifest[field];
    const scripts = Object.fromEntries(INSTALL_SCRIPTS.filter(s => typeof manifest.scripts?.[s] === 'string').map(s => [s, manifest.scripts[s]]));
    if (Object.keys(scripts).length)
        out.scripts = scripts;
    return out;
}
/**
 * {path: sha256} of the install inputs under the project directory: the lockfile, the root install configuration, the
 * patches directory, and the dependency fields of every importer's package.json (and its .npmrc). Files that are not
 * install inputs (build outputs, a package.json under dist/) never change it.
 */
export function installFiles(dir, manager) {
    const found = {};
    const add = (rel, data) => { found[rel] = sha256(data); };
    add(MANAGERS[manager].lockfile, readFileSync(join(dir, MANAGERS[manager].lockfile)));
    for (const name of ROOT_FILES)
        if (existsSync(join(dir, name)) && lstatSync(join(dir, name)).isFile())
            add(name, readFileSync(join(dir, name)));
    walk(join(dir, 'patches'), (rel, entry) => {
        if (entry.isFile())
            add(`patches/${rel}`, readFileSync(join(dir, 'patches', rel)));
    });
    for (const importer of importersOf(dir, manager)) {
        const at = importer === '.' ? '' : `${importer}/`;
        const inputs = manifestInputs(join(dir, at, 'package.json'));
        if (inputs !== null)
            add(`${at}package.json`, JSON.stringify(inputs));
        if (at && existsSync(join(dir, at, '.npmrc')))
            add(`${at}.npmrc`, readFileSync(join(dir, at, '.npmrc')));
    }
    return found;
}
/** The variables of `env` that are install inputs, sorted. */
export function installEnv(env) {
    return Object.keys(env).filter(k => (ENV_NAMES.has(k) || ENV_PREFIXES.some(p => k.startsWith(p))) && !ENV_IGNORED.test(k)).sort().map(k => [k, env[k]]);
}
const version = (argv) => {
    const result = spawnSync(argv[0], argv.slice(1), { cwd: tmpdir(), encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: process.env.HOME || tmpdir(), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } });
    return ((result.stdout || result.stderr || '').trim().split('\n')[0] || `exit ${result.status}`).slice(0, 120);
};
/** A package manager's configuration value as the project sees it (its .npmrc, the user's, the environment), or null. */
function configValue(manager, name, dir, env) {
    const result = spawnSync(manager, ['config', 'get', name], { cwd: dir, encoding: 'utf8', timeout: 20000, env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } });
    const value = (result.stdout || '').trim().split('\n').pop()?.trim();
    return result.status === 0 && value && value !== 'undefined' && value !== 'null' ? value : null;
}
/** Whether a pnpm project sets a supply-chain policy (whose offline verify needs pnpm's metadata cache). */
export function supplyChainPolicy(dir) {
    const read = name => {
        try {
            return readFileSync(join(dir, name), 'utf8');
        }
        catch {
            return '';
        }
    };
    if (/^\s*(?:minimumReleaseAge|trustPolicy)\s*:/m.test(read('pnpm-workspace.yaml')) || /^\s*(?:minimum-release-age|trust-policy)\s*=/m.test(read('.npmrc')))
        return true;
    try {
        const pnpm = JSON.parse(read('package.json')).pnpm || {};
        return pnpm.minimumReleaseAge !== undefined || pnpm.trustPolicy !== undefined;
    }
    catch {
        return false;
    }
}
/** pnpm's cache directory (its metadata lives there): `pnpm config get cache-dir`, else pnpm's platform default. */
export function pnpmCacheDir(dir, env = process.env, platform = process.platform, lookup = configValue) {
    const configured = lookup('pnpm', 'cache-dir', dir, env);
    if (configured && isAbsolute(configured))
        return configured;
    const home = env.HOME || homedir();
    if (platform === 'darwin')
        return join(home, 'Library/Caches/pnpm');
    if (platform === 'win32')
        return join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'pnpm-cache');
    return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'pnpm');
}
/** The node_modules directories the lockfile's importers own (relative to the workspace), then the outputs. */
export function pathsOf(dir, manager, outputs, prefix) {
    const at = path => (prefix === '.' ? path : `${prefix}/${path}`);
    const trees = importersOf(dir, manager).map(p => at(p === '.' ? 'node_modules' : `${p}/node_modules`));
    return [...trees, ...outputs.map(at)];
}
export function identity(env = process.env, run = version, lookup = configValue) {
    const s = spec(env);
    const workspace = env.GITHUB_WORKSPACE || process.cwd();
    const dir = s.directory === '.' ? workspace : join(workspace, s.directory);
    const manager = s.manager !== 'auto' ? s.manager : existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(dir, 'package-lock.json')) ? 'npm' : null;
    if (!manager || !existsSync(join(dir, MANAGERS[manager].lockfile)))
        throw new Error(`No ${manager ? MANAGERS[manager].lockfile : 'pnpm-lock.yaml or package-lock.json'} in ${s.directory}.`);
    let packageManager = null;
    try {
        packageManager = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).packageManager || null;
    }
    catch { }
    const node = run(['node', '--version']);
    const major = /^v?(\d+)\./.exec(node)?.[1] || 'absent';
    const metadata = manager === 'pnpm' && (s.metadata === 'true' || (s.metadata === 'auto' && supplyChainPolicy(dir)));
    const parts = {
        format: 2, manager, managerVersion: run([manager, '--version']), packageManager, node: major,
        platform: { os: env.RUNNER_OS || process.platform, arch: env.RUNNER_ARCH || process.arch, libc: process.report?.getReport?.().header?.glibcVersionRuntime || 'none', image: `${env.ImageOS || ''}-${env.ImageVersion || ''}` },
        paths: { workspace, directory: s.directory, outputs: s.outputs, metadata },
        files: sha256(JSON.stringify(installFiles(dir, manager))),
        env: sha256(JSON.stringify(installEnv(env))),
        commands: { install: MANAGERS[manager].install, verify: MANAGERS[manager].verify }
    };
    const digest = sha256(JSON.stringify(parts));
    const paths = pathsOf(dir, manager, s.outputs, s.directory);
    // pnpm's metadata cache rides along (absolute, outside the workspace); its dlx cache does not.
    const cacheDir = metadata ? pnpmCacheDir(dir, env, process.platform, lookup) : null;
    if (cacheDir)
        paths.push(cacheDir, `!${join(cacheDir, 'dlx')}`);
    return { key: `vibernt-deps-v2-${parts.platform.os}-${parts.platform.arch}-${manager}-node${major}-${digest.slice(0, 40)}`, manager, dir, workspace, spec: s, paths, metadata: cacheDir, lockfile: sha256(readFileSync(join(dir, MANAGERS[manager].lockfile))) };
}
/** Absolute paths (inside `home`) of the runner's own directories: the workspace, its work root, temp and tool cache. */
export function runnerPaths(env = process.env, workspace = env.GITHUB_WORKSPACE) {
    const out = [workspace, env.RUNNER_WORKSPACE, env.RUNNER_TEMP, env.RUNNER_TEMP && resolve(env.RUNNER_TEMP, '..'), env.RUNNER_TOOL_CACHE, env.AGENT_TOOLSDIRECTORY];
    return [...new Set(out.filter(p => typeof p === 'string' && isAbsolute(p)).map(p => resolve(p)))];
}
/**
 * Type, size and mtime of every path outside node_modules (workspace, .git/objects left out) and of what an install can
 * write in the home: everything but the package-manager caches, the workspace and the runner's own directories (its
 * _diag logs, its _work root with every workspace, temp and tool cache), which a runner keeps under the home.
 */
export function snapshot(workspace, home, env = process.env) {
    const seen = new Map();
    const record = (label, root, skipRel = new Set()) => walk(root, (rel, entry) => {
        if (skipRel.has(rel) || rel === '.git/objects')
            return false;
        if (label === 'home' && entry.isDirectory() && RUNNER_DIRS.has(entry.name))
            return false;
        let info;
        try {
            info = lstatSync(join(root, rel));
        }
        catch {
            return false;
        }
        const kind = info.isSymbolicLink() ? 'l' : info.isDirectory() ? 'd' : 'f';
        if (kind === 'd' && label === 'home' && [...skipRel].some(c => c.startsWith(`${rel}/`)))
            return true;
        seen.set(`${label}:${rel}`, kind === 'd' ? 'd' : `${kind}:${info.size}:${info.mtimeMs}`);
        return true;
    });
    record('workspace', workspace);
    if (home && existsSync(home)) {
        const root = resolve(home);
        const runner = runnerPaths(env, workspace).map(p => relative(root, p)).filter(r => r && !r.startsWith('..') && !isAbsolute(r)).map(r => r.split(sep).join('/'));
        record('home', root, new Set([...HOME_CACHES, ...runner]));
    }
    return seen;
}
/** Changes outside node_modules: anything but a path under a declared output (created or rewritten by the install). */
export function sideEffects(before, after, outputs = []) {
    const changed = [];
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        if (before.get(key) === after.get(key))
            continue;
        const rel = key.startsWith('workspace:') ? key.slice(10) : null;
        if (rel !== null && outputs.some(o => rel === o || rel.startsWith(`${o}/`)))
            continue;
        changed.push(key);
    }
    return changed.slice(0, 5);
}
/** A pull request whose head is another repository (a fork) never saves. */
export function fromFork(env = process.env) {
    if (!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME))
        return false;
    try {
        const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
        return event.pull_request?.head?.repo?.full_name !== env.GITHUB_REPOSITORY;
    }
    catch {
        return true;
    }
}
/* ----- The dependency store's guard (docs/DEPENDENCY_STORE.md "The guard") ----- */
const STORE_MARK = '# Vibernt dependency store';
const SAMPLE = 16, CONCURRENCY = 8, ARM_TIMEOUT_MS = 30000;
/**
 * The dependency store the runner configured in the job user's npmrc: { file, registry, token, lines }, or null. Only a
 * file the runner wrote (its marker comment, a `registry=` ending in /npm/ and that URL's own token) counts.
 */
export function storeConfig(env = process.env) {
    const file = env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig || join(env.HOME || homedir(), '.npmrc');
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch {
        return null;
    }
    if (!text.includes(STORE_MARK))
        return null;
    const lines = text.split('\n');
    const registry = lines.map(l => /^registry=(https?:\/\/\S+\/npm\/)\s*$/.exec(l)?.[1]).find(Boolean);
    if (!registry)
        return null;
    const nerf = registry.replace(/^https?:/, '');
    const tokenLine = lines.find(l => l.startsWith(`${nerf}:_authToken=`));
    return tokenLine ? { file, registry, token: tokenLine.slice(nerf.length + 12).trim(), lines } : null;
}
/** [{name, version, sha512 hex}] from the lockfile, registry packages with a sha512 integrity, spread evenly. */
export function lockfileSample(dir, manager, limit = SAMPLE) {
    const entries = [];
    const text = readFileSync(join(dir, MANAGERS[manager].lockfile), 'utf8');
    if (manager === 'pnpm') {
        let section = null, key = null;
        for (const line of text.split('\n')) {
            if (line && !line.startsWith(' ')) {
                section = line.replace(/:\s*$/, '').trim();
                continue;
            }
            if (section !== 'packages')
                continue;
            const named = /^ {2}['"]?\/?((?:@[^/@\s'"]+\/)?[^/@\s'"(]+)[@/]([0-9][^(:'"\s]*)(?:\([^:]*\))?['"]?:\s*$/.exec(line);
            if (named) {
                key = [named[1], named[2]];
                continue;
            }
            const resolution = /^ {4}resolution:\s*\{(.*)\}\s*$/.exec(line);
            if (resolution && key) {
                const integrity = /integrity:\s*(sha512-[A-Za-z0-9+/]{86}==)/.exec(resolution[1]);
                if (integrity && !/tarball:|directory:/.test(resolution[1]))
                    entries.push([key[0], key[1], integrity[1]]);
                key = null;
            }
        }
    }
    else {
        for (const [path, spec] of Object.entries(JSON.parse(text).packages || {})) {
            if (!spec || !path.includes('node_modules/') || spec.link)
                continue;
            if (String(spec.resolved || '').startsWith(PUBLIC_REGISTRY) && String(spec.integrity || '').startsWith('sha512-'))
                entries.push([path.split('node_modules/').pop(), String(spec.version || ''), String(spec.integrity).split(/\s+/)[0]]);
        }
    }
    const unique = [...new Map(entries.map(e => [e.join('\u0000'), e])).values()].sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1));
    const step = unique.length / limit;
    const spread = unique.length <= limit ? unique : Array.from({ length: limit }, (_, i) => unique[Math.floor(i * step)]);
    return spread.map(([name, v, integrity]) => ({ name, version: v, hex: Buffer.from(integrity.slice(7), 'base64').toString('hex') })).filter(x => x.version && x.hex.length === 128);
}
export const tarballUrl = (registry, name, v) => `${registry.replace(/\/+$/, '')}/${name}/-/${encodeURIComponent(name.split('/').pop())}-${encodeURIComponent(v)}.tgz`;
/** Fetches every sampled tarball from `registry`, CONCURRENCY at a time, hashing each: wall time, bytes, failures. */
export async function measure(registry, sample, headers = {}, timeoutMs = ARM_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    const queue = [...sample];
    let ok = 0, bytes = 0, mismatched = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
            const item = queue.shift();
            try {
                const response = await fetch(tarballUrl(registry, item.name, item.version), { headers: { 'user-agent': 'vibernt-deps-store-guard/1', ...headers }, signal: controller.signal });
                if (!response.ok) {
                    await response.body?.cancel().catch(() => { });
                    continue;
                }
                const data = Buffer.from(await response.arrayBuffer());
                if (createHash('sha512').update(data).digest('hex') === item.hex) {
                    ok++;
                    bytes += data.length;
                }
                else
                    mismatched++;
            }
            catch { }
        }
    }));
    clearTimeout(timer);
    const seconds = (performance.now() - started) / 1000;
    return { seconds: Number(seconds.toFixed(3)), tarballs: ok, bytes, failed: sample.length - ok, mismatched, bytesPerSecond: seconds > 0 ? Math.round(bytes / seconds) : 0 };
}
/** Whether to install through the store: { use, reason, sample, store?, direct? } (as runner/store_probe.py). */
export async function storeDecision(store, sample, direct = PUBLIC_REGISTRY, measureFn = measure) {
    if (!sample.length)
        return { use: true, reason: 'no-sample', sample: 0 };
    const first = await measureFn(direct, sample, {});
    if (first.tarballs === 0)
        return { use: true, reason: 'registry-unavailable', sample: sample.length, direct: first };
    const through = await measureFn(store.registry, sample, { authorization: `Bearer ${store.token}` });
    const out = { sample: sample.length, store: through, direct: first };
    if (through.mismatched)
        return { use: false, reason: 'integrity', ...out };
    if (through.failed > first.failed)
        return { use: false, reason: 'errors', ...out };
    if (through.seconds > first.seconds)
        return { use: false, reason: 'slower', ...out };
    return { use: true, reason: 'as-fast', ...out };
}
/**
 * Before a full install: the guard, when the job's registry is the dependency store. Returns the variables the install
 * runs with ({} to keep the store, or NPM_CONFIG_USERCONFIG pointing at a copy of the user's npmrc without the store,
 * which the rest of the job gets too through GITHUB_ENV; a project's own .npmrc still wins over either).
 */
export async function guardStore(state, env = process.env, { direct = env.VIBERNT_DEPS_PUBLIC_REGISTRY || PUBLIC_REGISTRY, measureFn = measure, lookup = configValue } = {}) {
    if (!booleanInput('store_guard', true))
        return {};
    const store = storeConfig(env);
    if (!store)
        return {};
    const effective = lookup(state.manager, 'registry', state.dir, env);
    if (!effective || effective.replace(/\/*$/, '/') !== store.registry) {
        info('vibernt/deps: the project names its own registry; the dependency store is not used.');
        return {};
    }
    let decision;
    try {
        decision = await storeDecision(store, lockfileSample(state.dir, state.manager), direct, measureFn);
    }
    catch {
        decision = { use: true, reason: 'probe-error', sample: 0 };
    }
    setOutput('store-guard', JSON.stringify(decision));
    const host = new URL(direct).host;
    const numbers = decision.store ? `${decision.sample} lockfile tarballs: store ${decision.store.seconds.toFixed(2)} s (${decision.store.failed} failed), ${host} ${decision.direct.seconds.toFixed(2)} s (${decision.direct.failed} failed)` : decision.reason;
    if (decision.use) {
        setOutput('registry', 'store');
        info(`vibernt/deps: dependency store kept (${decision.reason}; ${numbers}).`);
        return {};
    }
    const file = join(env.RUNNER_TEMP || tmpdir(), 'vibernt-deps-npmrc');
    const nerf = store.registry.replace(/^https?:/, '');
    const kept = store.lines.filter(l => l.trim() !== `registry=${store.registry}` && !l.startsWith(`${nerf}:_authToken=`) && !l.startsWith(STORE_MARK));
    writeFileSync(file, `# vibernt/deps: the dependency store was left out for this job (${decision.reason}).\n${kept.join('\n')}`, { mode: 0o600 });
    if (env.GITHUB_ENV)
        appendFileSync(env.GITHUB_ENV, `NPM_CONFIG_USERCONFIG=${file}\n`);
    setOutput('registry', 'public');
    warning(`vibernt/deps: the dependency store was left out for this job (${decision.reason}; ${numbers}); installs use the public registry.`);
    summary(`**vibernt/deps**: the dependency store was left out for this job (${decision.reason}; ${numbers}).`);
    return { NPM_CONFIG_USERCONFIG: file };
}
function execute(argv, cwd, extraEnv = {}) {
    return new Promise(resolveRun => {
        const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
        let kept = '';
        const tee = stream => chunk => {
            stream.write(chunk);
            if (kept.length < 4 * 1024 * 1024)
                kept += chunk.toString();
        };
        child.stdout.on('data', tee(process.stdout));
        child.stderr.on('data', tee(process.stderr));
        child.on('error', () => resolveRun({ code: 127, output: kept }));
        child.on('close', code => resolveRun({ code: code ?? 1, output: kept }));
    });
}
const statePath = env => join(env.RUNNER_TEMP || tmpdir(), 'vibernt-deps.json');
export async function plan(env = process.env) {
    const id = identity(env);
    writeFileSync(statePath(env), JSON.stringify({ key: id.key, manager: id.manager, dir: id.dir, workspace: id.workspace, paths: id.paths, outputs: id.spec.outputs.map(o => (id.spec.directory === '.' ? o : `${id.spec.directory}/${o}`)), lockfile: id.lockfile }));
    setOutput('key', id.key);
    setOutput('paths', id.paths.join('\n'));
    info(`vibernt/deps: ${id.key} (${id.paths.length} paths${id.metadata ? `, pnpm's metadata cache ${id.metadata} for its supply-chain policy` : ''})`);
}
export async function install(env = process.env) {
    const state = JSON.parse(readFileSync(statePath(env), 'utf8'));
    const commands = MANAGERS[state.manager];
    const lockfile = join(state.dir, commands.lockfile);
    let mode = 'install';
    if (env.VIBERNT_DEPS_HIT === 'true') {
        const verified = await execute(commands.verify, state.dir);
        if (verified.code === 0 && sha256(readFileSync(lockfile)) === state.lockfile) {
            setOutput('cache-hit', 'true');
            setOutput('mode', 'restored');
            setOutput('save', 'false');
            return;
        }
        warning(`The restored node_modules did not verify (exit ${verified.code}); installing in full.`);
        // The trees and outputs are replaced; pnpm's metadata cache (absolute) is a cache and stays.
        for (const path of state.paths.filter(p => !isAbsolute(p) && !p.startsWith('!')))
            rmSync(join(state.workspace, path), { recursive: true, force: true });
        mode = 'fallback';
    }
    const extraEnv = await guardStore(state, env);
    const home = env.HOME;
    const before = snapshot(state.workspace, home, env);
    const result = await execute(commands.install, state.dir, extraEnv);
    setOutput('cache-hit', 'false');
    setOutput('mode', mode);
    if (result.code !== 0) {
        setOutput('save', 'false');
        throw new Error(`${commands.install.join(' ')} failed (exit ${result.code}).`);
    }
    const effects = sideEffects(before, snapshot(state.workspace, home, env), state.outputs);
    const save = mode === 'install' && effects.length === 0 && booleanInput('save', true) && !fromFork(env);
    if (effects.length)
        warning(`The install changed files outside node_modules (${effects.join(', ')}); the tree is not saved. Declare generated paths in outputs.`);
    else if (fromFork(env))
        info('A pull request from a fork: the tree is not saved.');
    setOutput('save', save ? 'true' : 'false');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
    main(() => (process.argv[2] === 'plan' ? plan() : process.argv[2] === 'install' ? install() : Promise.reject(new Error('Usage: index.mjs plan|install'))));
