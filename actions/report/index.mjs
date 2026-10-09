/**
 * vibernt/report: upload a job's JUnit XML to Vibernt CI test history (docs/ACTIONS.md). Flake detection, the flake
 * budget, holdout scoring and quarantine apply to what it uploads. With `fail-on-blocking` (the default) the step
 * fails when a failing test is not quarantined, so `continue-on-error: true` on the test step plus this action makes
 * quarantined failures stop blocking the job.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { input, booleanInput, setOutput, summary, info, warning, fail, call, jobKey, listFiles, main } from '../lib/vibernt.mjs';

const MAX_REPORTS = 20, MAX_REPORT_BYTES = 8 * 1024 * 1024, MAX_TOTAL_BYTES = 9 * 1024 * 1024;

main(async () => {
    const job = jobKey();
    const root = process.env.GITHUB_WORKSPACE || process.cwd();
    const files = listFiles(input('path', '**/junit*.xml'), { root, max: 1000 });
    if (!files.length) {
        const message = `No JUnit report matches "${input('path', '**/junit*.xml')}".`;
        if (booleanInput('fail-if-no-reports', true))
            return fail(message);
        return warning(message);
    }
    if (files.length > MAX_REPORTS)
        return fail(`${files.length} reports match; at most ${MAX_REPORTS} can be uploaded at once (merge them or narrow the path).`);
    let total = 0;
    const reports = files.map(path => {
        const size = statSync(join(root, path)).size;
        if (size > MAX_REPORT_BYTES)
            throw new Error(`${path} is larger than 8 MiB.`);
        total += size;
        return { path, xml: readFileSync(join(root, path), 'utf8') };
    });
    if (total > MAX_TOTAL_BYTES)
        return fail(`The reports add up to more than 9 MiB; upload them from separate steps with distinct job values.`);
    const index = input('shard-index'), count = input('shard-total');
    const body = {
        job,
        reports,
        ...(input('project') ? { project: input('project') } : {}),
        ...(index && count ? { shard: { index: Number(index), total: Number(count) } } : {})
    };
    const result = await call('/v1/actions/report', body);
    for (const [name, value] of [['verdict', result.verdict], ['tests', result.tests], ['failed', result.failed], ['blocking-failures', result.blockingFailures], ['quarantined-failures', result.quarantinedFailures], ['run-id', result.runId]])
        setOutput(name, String(value ?? ''));
    info(`Uploaded ${result.tests} test results from ${files.length} report(s): ${result.failed} failed, ${result.quarantinedFailures} of them quarantined.`);
    const lines = (result.failures || []).map(f => `| ${f.name} | ${f.file || ''} | ${f.quarantined ? `quarantined until ${new Date(f.expiresAt).toISOString().slice(0, 10)}` : f.knownFlaky ? 'known flaky' : 'blocking'} |`);
    summary([`### Vibernt CI test results: ${result.verdict}`, '', `${result.tests} tests, ${result.failed} failed (${result.quarantinedFailures} quarantined, ${result.blockingFailures} blocking).`, ...(lines.length ? ['', '| Test | File | Status |', '| --- | --- | --- |', ...lines] : [])].join('\n'));
    if (result.blockingFailures > 0 && booleanInput('fail-on-blocking', true))
        fail(`${result.blockingFailures} failing test(s) are not quarantined.`);
});
