/**
 * vibernt/deps (optional, docs/NODE_MODULES.md#drop-in-jobs): installed node_modules by exact install identity for
 * GitHub Actions jobs, on drop-in runners or anywhere else. The composite action.yml wraps actions/cache: this script
 * computes the key and the paths (`plan`), then verifies a restored tree with the package manager's offline mode or
 * installs in full and decides whether the new tree may be saved (`install`). The same rules as native jobs
 * (runner/nodemodules.py): no prefix fallback, a restored tree that does not verify is replaced by a full install,
 * an install that changes anything outside node_modules and the declared outputs is never saved, and a fork's pull
 * request never saves. Node 24, no dependencies, no network call of its own.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { input, booleanInput, setOutput, info, warning, main } from '../lib/vibernt.mjs';

export const MANAGERS = {
    pnpm: { lockfile: 'pnpm-lock.yaml', install: ['pnpm', 'install', '--frozen-lockfile'], verify: ['pnpm', 'install', '--frozen-lockfile', '--offline'] },
    npm: { lockfile: 'package-lock.json', install: ['npm', 'ci', '--foreground-scripts', '--no-audit', '--no-fund'], verify: ['npm', 'install', '--offline', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund'] }
};
const INSTALL_FILES = new Set(['package.json', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', 'npm-shrinkwrap.json']);
const ENV_PREFIXES = ['npm_config_', 'NPM_CONFIG_', 'pnpm_config_', 'PNPM_', 'COREPACK_', 'YARN_', 'NODE_', 'PRISMA_', 'PUPPETEER_', 'PLAYWRIGHT_', 'CYPRESS_', 'ELECTRON_', 'SHARP_', 'ESBUILD_', 'SWC_', 'NEXT_', 'TURBO_'];
const ENV_NAMES = new Set(['NODE_ENV', 'NODE_OPTIONS', 'PYTHON', 'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'GYP_DEFINES', 'HUSKY', 'LEFTHOOK', 'ADBLOCK', 'DISABLE_OPENCOLLECTIVE']);
const HOME_CACHES = ['.npm', '.pnpm-store', '.cache/pnpm', '.local/share/pnpm', '.local/state/pnpm', '.cache/node/corepack', '.cache/node-gyp', '.node-gyp', '.cache/prisma', '.cache/checkpoint-nodejs', '.config/pnpm', '.npmrc'];
const SKIP = new Set(['node_modules', '.git']);
const sha256 = data => createHash('sha256').update(data).digest('hex');

/** `directory` and `outputs` inputs, validated: relative, no `..`, never inside node_modules or .git. */
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
    const outputs = [...new Set(get('outputs').split('\n').map(x => x.trim()).filter(Boolean).map(x => plain(x.replace(/\/+$/, ''), 'outputs')))].sort();
    for (const output of outputs)
        if (INSTALL_FILES.has(output.split('/').pop()) || Object.values(MANAGERS).some(m => output.endsWith(m.lockfile)))
            throw new Error(`An install file cannot be an output: ${output}`);
    return { directory, manager, outputs };
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
/** {path: sha256} of the install-affecting files under the project directory (as runner/nodemodules.py). */
export function installFiles(dir) {
    const found = {};
    const locks = new Set(Object.values(MANAGERS).map(m => m.lockfile));
    walk(dir, (rel, entry) => {
        if (entry.isSymbolicLink() || !entry.isFile())
            return;
        const name = entry.name, top = !rel.includes('/');
        if (INSTALL_FILES.has(name) || (top && locks.has(name)) || rel.startsWith('patches/'))
            found[rel] = sha256(readFileSync(join(dir, rel)));
    });
    return found;
}
const version = (argv) => {
    const result = spawnSync(argv[0], argv.slice(1), { cwd: tmpdir(), encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: process.env.HOME || tmpdir(), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } });
    return ((result.stdout || result.stderr || '').trim().split('\n')[0] || `exit ${result.status}`).slice(0, 120);
};
/** The node_modules directories the lockfile's importers own (relative to the workspace), then the outputs. */
export function pathsOf(dir, manager, outputs, prefix) {
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
    const at = path => (prefix === '.' ? path : `${prefix}/${path}`);
    const trees = [...importers].filter(p => !p.split('/').some(x => x === '..' || x === 'node_modules')).sort().map(p => at(p === '.' ? 'node_modules' : `${p}/node_modules`));
    return [...trees, ...outputs.map(at)];
}
export function identity(env = process.env, run = version) {
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
    const names = Object.keys(env).filter(k => ENV_NAMES.has(k) || ENV_PREFIXES.some(p => k.startsWith(p))).sort();
    const node = run(['node', '--version']);
    const major = /^v?(\d+)\./.exec(node)?.[1] || 'absent';
    const parts = {
        format: 1, manager, managerVersion: run([manager, '--version']), packageManager, node: major,
        platform: { os: env.RUNNER_OS || process.platform, arch: env.RUNNER_ARCH || process.arch, libc: process.report?.getReport?.().header?.glibcVersionRuntime || 'none', image: `${env.ImageOS || ''}-${env.ImageVersion || ''}` },
        paths: { workspace, directory: s.directory, outputs: s.outputs },
        files: sha256(JSON.stringify(installFiles(dir))),
        env: sha256(JSON.stringify(names.map(k => [k, env[k]]))),
        commands: { install: MANAGERS[manager].install, verify: MANAGERS[manager].verify }
    };
    const digest = sha256(JSON.stringify(parts));
    return { key: `vibernt-deps-v1-${parts.platform.os}-${parts.platform.arch}-${manager}-node${major}-${digest.slice(0, 40)}`, manager, dir, workspace, spec: s, paths: pathsOf(dir, manager, s.outputs, s.directory), lockfile: sha256(readFileSync(join(dir, MANAGERS[manager].lockfile))) };
}
/** Type, size and mtime of every path outside node_modules (workspace, .git/objects left out) and of the home outside caches. */
export function snapshot(workspace, home) {
    const seen = new Map();
    const record = (label, root, skipRel = new Set()) => walk(root, (rel, entry) => {
        if (skipRel.has(rel) || rel === '.git/objects')
            return false;
        let info;
        try {
            info = lstatSync(join(root, rel));
        }
        catch {
            return false;
        }
        const kind = info.isSymbolicLink() ? 'l' : info.isDirectory() ? 'd' : 'f';
        if (kind === 'd' && label === 'home' && HOME_CACHES.some(c => c.startsWith(`${rel}/`)))
            return true;
        seen.set(`${label}:${rel}`, kind === 'd' ? 'd' : `${kind}:${info.size}:${info.mtimeMs}`);
        return true;
    });
    record('workspace', workspace);
    if (home && existsSync(home))
        record('home', home, new Set(HOME_CACHES));
    return seen;
}
export function sideEffects(before, after, outputs = []) {
    const changed = [];
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        if (before.get(key) === after.get(key))
            continue;
        const rel = key.startsWith('workspace:') ? key.slice(10) : null;
        if (rel !== null && !before.has(key) && outputs.some(o => rel === o || rel.startsWith(`${o}/`)))
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
function execute(argv, cwd) {
    return new Promise(resolve => {
        const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let kept = '';
        const tee = stream => chunk => {
            stream.write(chunk);
            if (kept.length < 4 * 1024 * 1024)
                kept += chunk.toString();
        };
        child.stdout.on('data', tee(process.stdout));
        child.stderr.on('data', tee(process.stderr));
        child.on('error', () => resolve({ code: 127, output: kept }));
        child.on('close', code => resolve({ code: code ?? 1, output: kept }));
    });
}
const statePath = env => join(env.RUNNER_TEMP || tmpdir(), 'vibernt-deps.json');
export async function plan(env = process.env) {
    const id = identity(env);
    writeFileSync(statePath(env), JSON.stringify({ key: id.key, manager: id.manager, dir: id.dir, workspace: id.workspace, paths: id.paths, outputs: id.spec.outputs.map(o => (id.spec.directory === '.' ? o : `${id.spec.directory}/${o}`)), lockfile: id.lockfile }));
    setOutput('key', id.key);
    setOutput('paths', id.paths.join('\n'));
    info(`vibernt/deps: ${id.key} (${id.paths.length} paths)`);
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
        for (const path of state.paths)
            rmSync(join(state.workspace, path), { recursive: true, force: true });
        mode = 'fallback';
    }
    const home = env.HOME;
    const before = snapshot(state.workspace, home);
    const result = await execute(commands.install, state.dir);
    setOutput('cache-hit', 'false');
    setOutput('mode', mode);
    if (result.code !== 0) {
        setOutput('save', 'false');
        throw new Error(`${commands.install.join(' ')} failed (exit ${result.code}).`);
    }
    const effects = sideEffects(before, snapshot(state.workspace, home), state.outputs);
    const save = mode === 'install' && effects.length === 0 && booleanInput('save', true) && !fromFork(env);
    if (effects.length)
        warning(`The install changed files outside node_modules (${effects.join(', ')}); the tree is not saved. Declare generated paths in outputs.`);
    else if (fromFork(env))
        info('A pull request from a fork: the tree is not saved.');
    setOutput('save', save ? 'true' : 'false');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
    main(() => (process.argv[2] === 'plan' ? plan() : process.argv[2] === 'install' ? install() : Promise.reject(new Error('Usage: index.mjs plan|install'))));
