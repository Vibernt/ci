/*
 * A copy of src/lib/junit.mjs for the actions, which have no dependencies: a pull leg parses a batch's JUnit reports
 * to attribute each case to its unit (docs/ACTIONS.md). tests/actions-js.test.mjs keeps everything below the marker
 * identical to src/lib/junit.mjs after its import line.
 */
class AppError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
function invariant(ok, code, message, status = 400) {
    if (!ok)
        throw new AppError(status, code, message);
}
// ---------- src/lib/junit.mjs ----------
/**
 * JUnit XML on the Worker (dependency-free), for results uploaded by the `vibernt/report` action (docs/ACTIONS.md).
 * It reads what runner/reports.py reads from a report inside a build: each `<testcase>` with its classname (or the
 * enclosing suite's name) as suite, its name, its file (the case's, the suite's, or the one file a report names),
 * time and outcome (`failure` or `error` fails it, `skipped` skips it). Document type declarations and entity
 * definitions are refused, like the runner refuses them; only the five predefined entities and character references
 * are decoded. Bounded: at most `maxCases` cases and `maxElements` elements per report.
 */
export const JUNIT_LIMITS = Object.freeze({ maxCases: 50000, maxElements: 400000, maxMessage: 1000, maxDepth: 64 });
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(text) {
    return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]+);/g, (whole, ref) => {
        if (ref[0] === '#') {
            const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        }
        return Object.hasOwn(ENTITIES, ref) ? ENTITIES[ref] : whole;
    });
}
const NAME = /^[A-Za-z_:][\w:.-]*/;
function attributes(text) {
    const out = {};
    const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(text)))
        out[m[1]] = decode(m[3] ?? m[4] ?? '');
    return out;
}
/** A minimal element tree: `{ tag, attrs, children, text }` (local names; namespaces dropped). */
export function parseXml(xml, { maxElements = JUNIT_LIMITS.maxElements, maxDepth = JUNIT_LIMITS.maxDepth } = {}) {
    invariant(typeof xml === 'string', 'JUNIT_XML', 'A report must be XML text.', 422);
    invariant(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'JUNIT_XML', 'Document type and entity declarations are not accepted in a report.', 422);
    const root = { tag: '#document', attrs: {}, children: [], text: '' };
    const stack = [root];
    let i = 0, elements = 0;
    const fail = message => { throw new AppError(422, 'JUNIT_XML', `The report is not well-formed XML: ${message}.`); };
    while (i < xml.length) {
        const lt = xml.indexOf('<', i);
        const top = stack.at(-1);
        if (lt < 0) {
            top.text += decode(xml.slice(i));
            break;
        }
        if (lt > i)
            top.text += decode(xml.slice(i, lt));
        if (xml.startsWith('<!--', lt)) {
            const end = xml.indexOf('-->', lt + 4);
            if (end < 0)
                fail('an unclosed comment');
            i = end + 3;
        }
        else if (xml.startsWith('<![CDATA[', lt)) {
            const end = xml.indexOf(']]>', lt + 9);
            if (end < 0)
                fail('an unclosed CDATA section');
            top.text += xml.slice(lt + 9, end);
            i = end + 3;
        }
        else if (xml.startsWith('<?', lt)) {
            const end = xml.indexOf('?>', lt + 2);
            if (end < 0)
                fail('an unclosed processing instruction');
            i = end + 2;
        }
        else if (xml[lt + 1] === '/') {
            const end = xml.indexOf('>', lt);
            if (end < 0)
                fail('an unclosed end tag');
            const name = xml.slice(lt + 2, end).trim().split(':').pop();
            if (stack.length < 2 || stack.at(-1).tag !== name)
                fail(`an unexpected </${name}>`);
            stack.pop();
            i = end + 1;
        }
        else {
            // A start tag; quoted attribute values may contain '>'.
            let j = lt + 1, quote = null;
            for (; j < xml.length; j++) {
                const ch = xml[j];
                if (quote) {
                    if (ch === quote)
                        quote = null;
                }
                else if (ch === '"' || ch === "'")
                    quote = ch;
                else if (ch === '>')
                    break;
            }
            if (j >= xml.length)
                fail('an unclosed start tag');
            const body = xml.slice(lt + 1, j);
            const selfClosing = body.endsWith('/');
            const inner = selfClosing ? body.slice(0, -1) : body;
            const name = NAME.exec(inner)?.[0];
            if (!name)
                fail('a tag without a name');
            if (++elements > maxElements)
                throw new AppError(413, 'JUNIT_SIZE', `A report may have at most ${maxElements} elements.`);
            const element = { tag: name.split(':').pop(), attrs: attributes(inner.slice(name.length)), children: [], text: '' };
            top.children.push(element);
            if (!selfClosing) {
                stack.push(element);
                if (stack.length > maxDepth + 1)
                    fail('elements nested too deeply');
            }
            i = j + 1;
        }
    }
    if (stack.length !== 1)
        fail(`<${stack.at(-1).tag}> is not closed`);
    const top = root.children.filter(c => c.tag);
    if (top.length !== 1)
        fail('a report needs exactly one root element');
    return top[0];
}
function* walk(element) {
    yield element;
    for (const child of element.children)
        yield* walk(child);
}
/** A classname that is a repository file path (scripts/node-junit-reporter.mjs, vitest): used as the file when none is given. */
const PATHLIKE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w@+.-]+(?:\/[\w@+.-]+)+\.[A-Za-z]{1,5}$/;
/**
 * The cases of one JUnit report: `{ suite, name, file, status, durationMs, message }`, as runner/reports.py
 * `junit_cases` reads them, plus the report's totals. Refuses a TRX or any other root.
 */
export function junitCases(xml, { maxCases = JUNIT_LIMITS.maxCases } = {}) {
    const root = parseXml(xml);
    invariant(root.tag === 'testsuites' || root.tag === 'testsuite', 'JUNIT_XML', 'A report must be JUnit XML (a <testsuites> or <testsuite> root).', 422);
    const suites = [...walk(root)].filter(e => e.tag === 'testsuite');
    const files = new Set(suites.map(s => s.attrs.file).filter(Boolean));
    const only = files.size === 1 ? [...files][0] : null;
    const containers = root.tag === 'testsuite' ? suites : [root, ...suites];
    const cases = [];
    let failed = 0, skipped = 0;
    for (const suite of containers)
        for (const c of suite.children.filter(x => x.tag === 'testcase')) {
            const problem = c.children.find(x => x.tag === 'failure') || c.children.find(x => x.tag === 'error');
            const status = problem ? 'failed' : c.children.some(x => x.tag === 'skipped') ? 'skipped' : 'passed';
            const seconds = Number(c.attrs.time);
            const suiteName = c.attrs.classname || suite.attrs.name || null;
            let file = c.attrs.file || suite.attrs.file || only || null;
            if (!file && suiteName && PATHLIKE.test(suiteName))
                file = suiteName;
            const message = problem ? String(problem.attrs.message || problem.text || '').trim().slice(0, JUNIT_LIMITS.maxMessage) || null : null;
            cases.push({ suite: suiteName, name: c.attrs.name || '', file, status, durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0, message });
            if (status === 'failed')
                failed++;
            if (status === 'skipped')
                skipped++;
            if (cases.length > maxCases)
                throw new AppError(413, 'JUNIT_SIZE', `A report may have at most ${maxCases} test cases.`);
        }
    return { cases, total: cases.length, failed, skipped };
}
