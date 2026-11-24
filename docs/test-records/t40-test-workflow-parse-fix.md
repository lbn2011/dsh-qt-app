# t40 test record — `.github/workflows/test.yml` parse failure (job `name` used `env`)

Task: t40 (owner host-architect). Isolated worktree `/data/qt-phase3/app/wt/ci-parse-fix`,
branch `phase3/ci-parse-fix`, base `f44cd0fda0fffa876fc73c203ce5c66466430ac2`
(= reviewed t36 SHA). In-scope paths: `.github/workflows/test.yml`, `docs/test-records/`.
The t38 worktree (`/data/qt-phase3/app/wt/integration`) and `/data/EAC-Desktop` were not
touched; nothing was pushed.

## 1. Symptom

GitHub Actions run `45419599811` for `test.yml` was created with **zero jobs** — the run
exists but no job is instantiated. That is the signature of a workflow file that GitHub
rejects at *parse* time (a schema/expression error in the file itself, before matrix
expansion), not of a failing step.

## 2. Root cause

`jobs.webui-real-host.name` (line 198 at the base commit) read the `env` context:

```yaml
  webui-real-host:
    name: webui real host (dsh ${{ env.DSH_HOST_VERSION }})
```

`jobs.<job_id>.name` is one of the fields whose expression evaluation happens **before**
any job runs, and the `env` context is not available there. Per the GitHub Actions
context-availability table, that field may only read `github`, `inputs`, `matrix`,
`needs`, `strategy`, `vars`. Using `env` there invalidates the entire workflow file, so
every job — including the ones that do not reference the expression — disappears from the
run.

## 3. Baseline evidence (before the fix)

Tool: `actionlint` 1.7.7 (linux/amd64, downloaded from its GitHub release page into `/tmp/al/`
— not vendored into the repo, no dependency added to the project). Run against the
**unmodified** file at the base commit:

```
$ /tmp/al/actionlint -oneline .github/workflows/test.yml
.github/workflows/test.yml:198:36: context "env" is not allowed here. available contexts are "github", "inputs", "matrix", "needs", "strategy", "vars". see https://docs.github.com/en/actions/learn-github-actions/contexts#context-availability for more details [expression]
exit=1
```

Column 36 is the start of `env.DSH_HOST_VERSION` inside the expression, which matches the
reported diagnosis exactly.

## 4. Fix

Display name replaced by a fixed literal; a comment records why the expression cannot come
back:

```yaml
  webui-real-host:
    # A fixed display name on purpose: `jobs.<job_id>.name` can only read the
    # github/inputs/matrix/needs/strategy/vars contexts, so an `env` expression
    # here makes GitHub reject the whole workflow file before any job is
    # created. The pinned host version stays in the single `env` block below,
    # which is where the job's steps read it from.
    name: webui real host (pinned dsh host)
```

Deliberately unchanged:

- `env.DSH_HOST_VERSION: 0.2.2-rc.1` stays the **single** version lock for the job; the
  install step still consumes it through the shell (`"@deepseek-ai/dsh@$DSH_HOST_VERSION"`),
  so there is no duplicated version literal and no unused variable.
- The forced-real-host gate is intact: `env.DSH_REQUIRE_REAL_HOST: "1"`, the
  `Real host WebUI tests` step, and the `Fail if a host test was skipped` step
  (`grep -q '^ℹ skipped 0$' webui-real-host.log`) are byte-identical.
- Job id `webui-real-host`, `runs-on`, `timeout-minutes`, and every step are unchanged.

Job set before vs after (id sets identical, `push:` is the `on:` trigger, not a job):

```
baseline: napi, typescript, webui-real-host, napi-integration, qml-lint, qml-tests, qt-webengine, packaging
fixed:    napi, typescript, webui-real-host, napi-integration, qml-lint, qml-tests, qt-webengine, packaging
```

File line count 621 → 626 (net +5: five comment lines; the `name:` line is a 1:1
replacement).

## 5. Post-fix evidence

```
$ /tmp/al/actionlint -oneline .github/workflows/test.yml
(no output)
exit=0

$ /tmp/al/actionlint -oneline            # repo-wide, all workflows in .github/workflows
(no output)
exit=0
```

So the specific error is gone and the file is clean under the same checker that reported it.

## 6. Verification scope — what this does and does not prove

Proven locally:

- The expression-context violation at `test.yml:198` is real and reproducible on the base
  commit, and absent after the fix.
- No other file under `.github/workflows/` has the same or any other `actionlint` finding
  at this commit (baseline run over all `*.yml` reported exactly this one error; the fixed
  tree reports none).
- The workflow still declares the same eight jobs with the same ids, the same matrix
  values, and an unchanged forced-real-host gate.

Not proven / explicitly out of reach here:

- **No remote run was made.** The fix is not yet confirmed green on a GitHub-hosted
  runner; nothing in this record should be read as "remote CI passes".
- `actionlint` validates syntax, schema, expression contexts and (with shellcheck enabled,
  not used here) shell bodies. It does not execute jobs, so runtime behaviour of the
  `webui-real-host` job is unchanged-and-unverified by this task.
- The check ran on Linux only; the workflow targets `ubuntu-22.04` for this job, but
  Windows/macOS runner behaviour was not exercised.
- The baseline repo-wide run had to be done with explicit file arguments on a copy in
  `/tmp`, because `actionlint` in directory mode requires a Git project root (it reported
  `no project was found in any parent directories`). The file contents were taken verbatim
  from `git show f44cd0f:.github/workflows/test.yml`, so the result is equivalent to a
  repo-wide run at the base commit.

## 7. Other diagnostics (reported, not changed)

- `jobs.<job_id>.name` is the only field in this file that had an illegal `env` reference.
  `env` used in step-level fields (`node-version: ${{ env.NODE_VERSION }}` at lines 74,
  169, 208, 254, 468, 565) is legal and was left alone.
- `.github/workflows/build.yml` parses cleanly and needs no change.
- `git diff --check` passes (no whitespace errors introduced).
