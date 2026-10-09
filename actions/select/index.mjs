/**
 * vibernt/select: the test files a pull request can affect (Vibernt CI test impact analysis with a random holdout,
 * docs/ACTIONS.md). Outputs `mode` (quick or full) and, in quick mode, `files`. In full mode `files` is empty: run
 * everything. When the API cannot be reached the step does not fail: it outputs full mode, so a job never runs fewer
 * tests because of this action.
 */
import { input, booleanInput, setOutput, summary, info, warning, call, jobKey, spaceList, main } from '../lib/vibernt.mjs';

/** Units as runner arguments: `go` turns a package directory into a ./dir pattern (the root package is "."). */
function unitArgs(units, format) {
    return units.map(u => (format === 'go' ? (u === '.' || u === '' ? '.' : u.startsWith('./') ? u : `./${u}`) : u));
}
function full(reason) {
    setOutput('mode', 'full');
    setOutput('args', input('full-args'));
    setOutput('files', '');
    setOutput('files-json', '[]');
    setOutput('holdout-json', '[]');
    setOutput('count', '0');
    setOutput('reasons', reason);
}

main(async () => {
    const job = jobKey();
    let result;
    try {
        result = await call('/v1/actions/select', { job, ...(input('project') ? { project: input('project') } : {}) });
    }
    catch (problem) {
        if (booleanInput('fail-on-error', false))
            throw problem;
        warning(`Test selection is unavailable (${problem.message}); running everything.`);
        return full('unavailable');
    }
    const reasons = (result.reasons || []).map(r => r.code).join(',');
    if (result.mode !== 'quick') {
        info(`Full run: ${reasons || 'not a pull request'}.`);
        summary(`### Vibernt CI test selection: full run\n\n${(result.reasons || []).map(r => `- ${r.code}: ${r.message || ''}`).join('\n')}`);
        return full(reasons);
    }
    const files = result.files || [];
    setOutput('mode', 'quick');
    // No unit at all would make a runner run its default (for go test, only the current directory): run everything.
    setOutput('args', files.length ? spaceList(unitArgs(files, input('format', 'files'))) : input('full-args'));
    setOutput('files', spaceList(files));
    setOutput('files-json', JSON.stringify(files));
    setOutput('holdout-json', JSON.stringify(result.holdout || []));
    setOutput('count', String(files.length));
    setOutput('reasons', reasons);
    const counts = result.counts || {};
    info(`Quick run: ${files.length} of ${counts.units ?? '?'} test units (${(result.holdout || []).length} held out to measure misses).`);
    summary(`### Vibernt CI test selection: ${files.length} of ${counts.units ?? '?'} test units\n\nSkip risk: ${result.skipRisk?.status || 'unknown'}${result.skipRisk?.value != null ? ` (${(result.skipRisk.value * 100).toFixed(1)}%)` : ''}.`);
});
