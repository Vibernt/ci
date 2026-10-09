# Vibernt CI GitHub Actions

Actions that connect GitHub Actions workflows to [Vibernt CI](https://ci.vibernt.ai). They run on any runner and do
the most on Vibernt's drop-in runners (`runs-on: vibernt-ubuntu-24.04`).

| Action | What it does |
|---|---|
| `vibernt/ci/actions/select@v1` | Test selection: lists the tests a pull request can affect (with a holdout), so the job runs only those |
| `vibernt/ci/actions/report@v1` | Sends the job's JUnit results to Vibernt (test history, flake quarantine, selection calibration) |
| `vibernt/ci/actions/shard@v1` | Fan-out: `plan` a run's shards, `prepare` the workspace once, `restore` it on each leg, `pull` work from the shared queue |
| `vibernt/ci/actions/deps@v1` | Restores installed `node_modules` by lockfile identity and verifies offline; installs and saves on a miss |

Each action authenticates with the job's GitHub OIDC token (`permissions: id-token: write`); no Vibernt token or
secret is stored in the workflow. Documentation: https://ci.vibernt.ai/docs/ (Actions, Drop-in runners, Test
intelligence, Installed node_modules).

`v1` follows the latest compatible release; pin a full commit SHA for reproducible workflows.

Licensed under the Apache License 2.0 (see `LICENSE`).
