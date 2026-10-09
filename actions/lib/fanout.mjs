/**
 * What a fan-out pull leg of vibernt/shard does with a batch's results (docs/ACTIONS.md, runner/fanout.py does the
 * same for native shards): each JUnit case to the unit whose file it names, with package-relative and absolute paths
 * mapped to repository paths, and the results split into requests of a bounded size. No dependencies.
 */
import { existsSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
/** A batch's results go to the queue in requests of at most this many units and about this many bytes. */
export const RESULTS_PER_POST = 64;
export const RESULT_POST_BYTES = 3 * 1024 * 1024;
export const safeRelative = f => !isAbsolute(f) && !String(f).split('/').includes('..');
export const norm = path => String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
/**
 * The directories a report's package-relative paths may be relative to, nearest first: the `root` input (the
 * package the command runs in), the action's working directory, each report's directory and its parents.
 */
export function packageRoots({ root = '', cwd = '', reports = [] } = {}) {
    const out = [];
    const add = dir => {
        const d = norm(dir);
        if (d && d !== '.' && safeRelative(d) && !out.includes(d))
            out.push(d);
    };
    add(root);
    add(cwd);
    for (const report of reports)
        for (let d = dirname(norm(report)); d && d !== '.' && d !== '/'; d = dirname(d))
            add(d);
    return out;
}
/**
 * Each case of a batch's reports to the unit whose file it names, with `file` set to that file's repository path
 * (runner/fanout.py `attribute`): the case's file, else its suite or classname, as a repository path, an absolute path
 * in the workspace, a path relative to one of `roots` (a package that ran its own test runner: Better Auth, Mastra),
 * or a path suffix only one of the batch's files has. A case no file names goes to the batch's first unit, so every
 * test is reported once; its file is mapped the same way when the mapped file exists in the checkout.
 * `Map(unit id -> cases)`.
 */
export function attribute(cases, batch, { roots = [], root = process.env.GITHUB_WORKSPACE || process.cwd(), exists = f => existsSync(join(root, f)) } = {}) {
    const owner = new Map();
    for (const unit of batch)
        for (const f of unit.files)
            owner.set(norm(f), unit.id);
    const files = [...owner.keys()];
    const base = norm(root);
    const mapped = name => {
        let n = norm(name);
        if (!n)
            return null;
        if (isAbsolute(n) || /^[A-Za-z]:\//.test(n)) {
            if (base && n.startsWith(`${base}/`))
                n = n.slice(base.length + 1);
            else
                return files.find(f => n.endsWith(`/${f}`)) || null;
        }
        if (owner.has(n))
            return n;
        for (const r of roots)
            if (owner.has(`${r}/${n}`))
                return `${r}/${n}`;
        const suffix = files.filter(f => f.endsWith(`/${n}`));
        if (suffix.length === 1)
            return suffix[0];
        return null;
    };
    const out = new Map(batch.map(u => [u.id, []]));
    for (const c of cases) {
        const file = mapped(c.file) || mapped(c.suite);
        if (file) {
            out.get(owner.get(file)).push({ ...c, file });
            continue;
        }
        // Not a file of this batch: kept with its repository path when one of the roots makes it a real file.
        const name = norm(c.file);
        const repo = name && !isAbsolute(name) ? [name, ...roots.map(r => `${r}/${name}`)].find(f => safeRelative(f) && exists(f)) : null;
        out.get(batch[0].id).push({ ...c, file: repo || c.file });
    }
    return out;
}

/** Splits a batch's results into requests of at most RESULTS_PER_POST units and about RESULT_POST_BYTES. */
export function resultPosts(results) {
    const posts = [];
    let current = [], bytes = 0;
    for (const r of results) {
        const size = JSON.stringify(r).length;
        if (current.length && (current.length >= RESULTS_PER_POST || bytes + size > RESULT_POST_BYTES)) {
            posts.push(current);
            current = [];
            bytes = 0;
        }
        current.push(r);
        bytes += size;
    }
    if (current.length)
        posts.push(current);
    return posts;
}

