# GitHub automation guide

This directory is still only partially standardized. Several historical workflows and helper locations do not yet follow one uniform shape. Do not copy old patterns blindly. For new work, bug fixes, and cleanup, use the `ci.yml` + `comment.atom.yml` + `autofix.atom.yml` + `.github/scripts/handoff.py` system as the reference topology unless a maintainer explicitly chooses a different boundary.

## Required reading

Before changing GitHub automation, read the current versions of:

- `.github/workflows/ci.yml`
- `.github/workflows/comment.atom.yml`
- `.github/workflows/autofix.atom.yml`
- `.github/scripts/handoff.py`
- `.github/config/runners.json`, `.github/config/scopes.json`, and `.github/config/convergence.json`
- `.github/scripts/runners.py`, `.github/scripts/scopes.py`, and `.github/scripts/convergence.py`
- `.github/workflows/convergence.atom.yml` and `.github/scripts/lib/r2.py` when changing reusable workload results
- `docs/ci/workload-products.md` when changing reusable workload product publication or restoration
- `specs/current/ci.md` when changing scope rules, confidence tiers, or planner invariants
- `scripts/approve-fork-pr-workflows.ts` when touching fork PR approval behavior

If the change affects cross-workflow behavior, update the relevant workflow/script self-checks instead of relying only on workflow YAML review.

## Architecture

GitHub automation uses two layers.

Business layer:

- Business workflows decide what happened and what should be requested next.
- `ci.yml` is the main low-privilege PR, merge-queue, and manual validation gate (application merge bar only).
- `ci.yml` should resolve runners, compose scope and convergence decisions in its Linux `plan` job, run validation, and produce typed handoff artifacts.
- Docker image checks are standalone and outside the merge gate. Do not re-attach `docker-image.yml` to `Validate workspace`.
- Business workflows should not perform trusted writes to PR comments or branches when a capability workflow can do it.

Atomic capability layer:

- Capability workflows perform reusable trusted operations from well-defined inputs.
- `comment.atom.yml` consumes `handoff-comment-*` artifacts and upserts pure text PR comments.
- `autofix.atom.yml` consumes `handoff-autofix-*` artifacts and applies same-repository patches.
- `rerun.atom.yml` watches completed `ci` runs and requests one `gh run rerun --failed` when leaf jobs died to runner/spot cancel. Decision logic lives in `.github/scripts/rerun_infra_cancel.py`; it must not rerun ordinary assertion failures or stale heads.
- `convergence.atom.yml` consumes successful `handoff-convergence-*` artifacts and is the sole trusted publisher of immutable reusable workload results.
- `.github/scripts/handoff.py` owns artifact names, directory layout, discovery, and contract validation for `comment`, `autofix`, and `convergence` handoffs.

Default rule: do not add a new domain-specific follow-on workflow such as `foo.comment.atom.yml` or `foo.autofix.atom.yml` until the flow has been tested against these existing atomic capabilities.

## Directory conventions

- `.github/workflows/` contains GitHub Actions workflow entrypoints.
- `.github/actions/` contains reusable composite actions for workflow setup steps.
- `.github/scripts/` contains workflow-owned scripts and contracts that are not general repo developer commands.
- `.github/templates/` contains non-executable `.md` and `.txt` delivery templates rendered by
  `.github/scripts/template.py`. Keep shell, expressions, conditionals, and structured JSON out of
  these templates; workflow or domain scripts must calculate every explicit parameter.
- `.github/scripts/release/` contains release workflow implementation helpers. Keep release-only helpers there and CI handoff helpers at `.github/scripts/`.
- Root `scripts/` remains for repo-level developer checks, product scripts, and guard/test logic. Do not move workflow-only handoff glue there just to make it look more general.

New workflow-owned helpers should usually live under `.github/scripts/`. Prefer TypeScript for project-owned scripts in general, but Python is acceptable for small GitHub runner glue when stdlib portability and low setup cost matter. Keep such exceptions narrow and covered by `pnpm guard` policy.

The planning control plane is deliberately Linux-only and stdlib-only. Runner classes,
scope rules, and workload convergence declarations live in `.github/config/`; their Python
entrypoints initialize metadata before workload runners start. A Windows job
must never invoke these scripts. Keep runner placement, changed-file relevance,
reusable-result convergence, and fine-grained commands inside a workload independent.

`convergence.py` computes workload identities from declared Git inputs, the
execution class, product mode, policy, and `schema.version`. Changes to hashing
or declaration interpretation require a schema version bump. The control file
set remains a trusted-writer admission boundary, not an implicit global cache
input; execution-affecting configuration must be declared by workloads. Public
result reads are credential-free. Only confirmed missing receipts select
execution; transient transport failures fail visibly after their bounded retry.
Only a successful gate may produce a `handoff/convergence` candidate; only trusted
`convergence.atom.yml` code may publish immutable results. `lib/r2.py` knows R2
transport only and must not interpret workload policy or handoff schemas.

Workloads prepared through workflow postinstall may declare `postinstallIntent`.
The shared stdlib Python resolver projects that intent and the selected Git tree
into one canonical Plan; the Plan digest, rather than setup-action implementation
details, enters the workload identity. The Plan describes delivered workspace
state only. Job IDs, concurrency, cache hits, cache formats, compression,
storage, retries, and timing are execution policy and stay outside its digest.
`postinstall.py` and `convergence.py` must use the same resolver, and receipts
must bind the executed or restored closure to the canonical Plan.

Product workloads may declare `batches` in their workflow configuration. Each
entry binds one workload, one business execution request, and one product name.
Python projects build/restore requests and verified artifact references;
executors do not parse pending Plan state or construct workload identities.
Requests affect identity, while batch and transport artifact names do not.
Cross-job projections carry product keys and SHA-256 values rather than public
origins or complete URLs. Missing publication output must not fall back to an
incomplete cold Plan.

## Handoff contract

Use `.github/scripts/handoff.py` for all CI follow-on artifact names and paths. The canonical layout is:

- `handoff/comment/<id>/metadata.json` plus `body.md`
- `handoff/autofix/<id>/metadata.json` plus `patch.diff`
- `handoff/convergence/<id>/metadata.json` plus `candidate.json`

Artifact names must come from `handoff.py artifact-name <kind> <id>`, and download patterns must come from `handoff.py artifact-pattern <kind>`.

PR-targeting handoffs identify the target PR, head SHA, base SHA, CI run id, kind, and id. Convergence handoffs instead bind repository, workflow policy, event, run attempt, source SHAs, and the candidate. Capability-specific fields must be validated by `handoff.py`.

Do not hand-roll artifact name prefixes, alternate directory layouts, or one-off metadata parsers in workflows. Extend `handoff.py` first, then use the new contract from producers and consumers.

## Capability rules

### `comment.atom.yml`

Use `comment.atom.yml` for pure text PR comments only.

- Input is an already-final `body.md`.
- The body must contain a stable marker.
- The workflow validates PR state, draft state, head SHA, and base SHA before upsert.
- It writes the GitHub API payload through `jq -n --rawfile body ...` and `gh api --input`.
- It must not install dependencies, access R2, execute scripts, or checkout PR code.

### `autofix.atom.yml`

Use `autofix.atom.yml` for same-repository patch application.

- Input is `patch.diff` plus metadata including `allowed_paths` and `commit_message`.
- Fork PRs must skip, not fail.
- Closed, draft, stale head, and stale base cases must skip, not fail.
- Apply patches only after validating the live PR state.
- Verify the resulting changed files exactly match `allowed_paths`.
- Prefer the configured bot app token for pushes so follow-up CI is triggered as expected.
- Do not use this workflow for arbitrary commands, generated scripts, or PR-head code execution.

## Fork PR approval

`fork-pr-workflow-approval.yml` and `scripts/approve-fork-pr-workflows.ts` are a separate security boundary. They may approve low-risk fork PR `pull_request` runs, but must not approve trusted `workflow_run` capability workflows.

Keep `.github/workflows/ci.yml` as the only approved workflow path unless a maintainer explicitly expands the allowlist. `comment.atom.yml`, `autofix.atom.yml`, release workflows, deployment workflows, and any workflow with trusted secrets or write permissions must stay outside fork auto-approval.

## Common iteration flow

1. Classify the change.
   - Validation or business decision: start in `ci.yml`.
   - Pure text PR comment: produce `handoff/comment` and let `comment.atom.yml` consume it.
   - Same-repo patch: produce `handoff/autofix` and let `autofix.atom.yml` consume it.
   - New naming, paths, or metadata: update `.github/scripts/handoff.py`.
2. Update scope routing in `.github/config/scopes.json`, then run `python3 .github/scripts/scopes.py validate`.
3. Declare workload input closure, execution class, product contract, and explicit reuse opt-in in `.github/config/convergence.json`; use `"*"` until a narrower set has high-confidence evidence.
4. Run the focused checks:
   - `python3 .github/scripts/handoff.py self-check`
   - `actionlint -color`
5. Run repo-level checks before handing off:
   - `pnpm guard`
   - `pnpm typecheck`

Use `git diff --check` before finishing workflow edits.

## FAQ

### Should I add a new `*.comment.atom.yml` workflow?

Usually no. If the body is already final markdown, produce `handoff/comment` and use `comment.atom.yml`. Comment bodies that need trusted materialization (dependency install, R2 access, artifact processing) would require a new capability workflow with an explicit trust boundary — add one only after a maintainer decision, never by copying historical patterns.

### Why does `autofix.atom.yml` skip fork PRs?

Fork PR branches are not writable by the base repository in the same trust model, and pushing generated changes to forks would require a different permission and ownership design. Skip fork PRs and use comments for contributor guidance.

### Can trusted `workflow_run` workflows checkout PR code?

No, not by default. They may download PR artifacts as data, but must not execute PR-provided code or scripts. Checkout trusted base/default code before running repository scripts.

### Why centralize handoff names in `handoff.py`?

GitHub artifact behavior is easy to drift: artifact names must be unique per upload, and consumers need stable patterns. Centralizing names, paths, and validation keeps producers and consumers aligned and makes topology tests meaningful.

### Where should tests live?

This repository no longer carries a test layer. Cross-workflow topology coverage now lives in each helper's `self-check` (for example `python3 .github/scripts/handoff.py self-check`) and workflow-level assertions. Do not add one-off `*.test.ts` files just because a workflow helper exists; prefer helper self-checks when that is enough.
