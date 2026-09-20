# Onlybots patch queue

The maintained queue is `patches/onlybots`, a linear series over
`upstream/master` (`paperclipai/paperclip`). `origin` is `zannis/paperclip`.
`deploy/onlybots` remains the existing deployment branch. This workflow does not
change it, push anything, restart Paperclip, or touch its databases.

## Scope and initial reconstruction

The operator selected **patches already used by deploy/onlybots, plus completed
fixes**. The September 16, 2026 source snapshot is
`7817676bf9523188905b48fe679990f838bb7488`, based on upstream
`13368c518303e886a5c9445fbc69afcbdf0a9228`. The first update targets upstream
`4577d1002994690ccfba6f58e2142364f3bc5715`.

The deployed baseline `196f62809` combined 78 files. It was reconstructed as
13 topic commits, followed by the nine later deployed non-merge commits.
The reconstructed tree was compared with the source deployment commit and was
identical before rebasing. The two deployment merges introduced no additional
tree changes beyond the replayed commits. Original branch tips remain intact.

Local recovery references:

- `backup/onlybots-before-consolidation-20260916`: original deployment snapshot.
- `backup/onlybots-reconstructed-20260916`: equivalent tree with linear history.

## Retained patches

| Topic | Source / disposition |
| --- | --- |
| Fork review CI guard | Deployed baseline; keep upstream-owned automation scoped to upstream |
| RTK Docker integration | Deployed baseline; upstream PR #12349 closed without merge |
| Bundled git-install packaging | Deployed preparation of server/UI, catalogs and workspace dependencies |
| Claude SDK plugin loading | Deployed ACPX patches and their lockfile hashes |
| Codex MCP HTTP headers | Deployed baseline; upstream PR #12287 remains open |
| Runtime API probe and exit diagnostics | Deployed baseline; upstream PR #12886 remains open |
| Zombie-aware liveness | Deployed supervisor/restart changes plus later recovery/watchdog corrections |
| Infrastructure termination recovery | Deployed classification/backoff; upstream PR #12030 remains open |
| Suppressed workspace policy diagnostics | Deployed baseline; upstream PR #12028 closed without merge |
| Project inference | Deployed implementation; upstream PR #12575 closed without merge |
| No-active-run HTTP 204 | Deployed server and client behavior; upstream PR #12027 remains open |
| OpenAPI authorization annotations | Deployed baseline; upstream PR #12720 remains open |
| Serialized mock imports | Deployed test corrections; upstream PR #12522 remains open |
| Recovery fixtures and CI adaptations | Later deployment fixes retained in order |
| Watchdog recovery audit | Deployed `fe297dbbc`; preserve its tested authority boundaries. Its comment-only grant refused the run's own recovery once the restored owner checked the leaf out; `025a952b1` attributes that one transition and adds a deterministic comparator test |
| Internal operation surfaces | Fork PR #3 merged into deployment, including its test import fix |
| Remote MCP header policy | Fork PR #5 merged into deployment, plus reconnect deduplication |
| TypeSafe connection | Fork PR #7 replayed onto the queue (19 topic commits); upstream PR paperclipai/paperclip#13713 open |
| Transient upstream turn failures | Ported from onlybots `bin/patch-paperclip-529-recovery.sh` as source: acpx turn failures matching the 529/429/503 shape classify as `acpx_transient_upstream`, join the transient continuation set with a budget of 6, and read as the `transient_upstream` family. Not upstream |

## Completed fixes and exclusions

GitHub PR states were checked September 16, 2026. Upstream PRs #12137 (tini),
#12596 (provider-exit polling) and #12646 (indeterminate runner results) are
merged and arrive through upstream; they are not replayed as duplicate patches.
Both merged fork PRs targeting deployment (#3 and #5) are already retained.

`fix/mcp-remote-headers` has a patch-equivalent deployed commit and is not added
again. A different SHA alone is not evidence of missing functionality.

The separate watchdog takeover branch (fork PR #4, still open), protected-agent
permission feature branch, unmerged experiments, historical backups, and extra
open-PR revisions not already deployed are excluded from this first queue.
An open PR is not evidence that a fix is incomplete, but neither is a branch
name evidence that it is complete: admit additional revisions after reviewing
their diff, dependencies and passing checks. This is not a claim that every
open branch has been semantically audited or superseded.

The first rebase preserves upstream's default-isolated-workspace helper alongside
the fork's suppressed-policy diagnostic helper. The test suite's new upstream
module-graph hoisting supersedes the old mock-import location in
`issue-agent-mutation-ownership-routes.test.ts`; a follow-up compatibility commit
serializes the imports at their new location, preserving the deployed safety
guard. Both workspace helper imports
are retained in heartbeat. ACPX lockfile changes replay over upstream's refreshed
lockfile; do not replace it with the old deployed file wholesale.

## Initial validation status (September 16, 2026)

This is a **local review candidate, not a verified deployment release**. No
remote branch or running deployment was changed. The initial queue bootstrap
is not a successful `verify`/`promote` cycle.

- Before rebasing, the reconstructed deployment tree matched the source exactly.
- Frozen offline dependency installation passed (lifecycle scripts disabled).
- Five sync-helper fixture tests and Bash syntax validation passed.
- The first 13-file focused run passed 729 of 730 tests. Its mock-import safety
  failure was fixed in the new hoisted setup; both affected files then passed
  all 128 tests. Thus every test in that original selection has a passing result
  across those runs; this is not a claim of a single green full-suite run.
- An additional eight-file selection covering recovery, zombie liveness,
  workspace policy and project inference passed all 391 tests.
- The direct server TypeScript check and UI build passed.
- Full `pnpm build` and `pnpm -r typecheck` were attempted and stopped because
  `cargo` was not on the build PATH. Filtering out the runner is not enough: the server
  build invokes it transitively.
- `pnpm test:run` was started, then explicitly stopped before completion once
  the build prerequisite blocker was established. No full-suite pass is claimed.

Make the required Rust toolchain available on PATH and rerun the full build, recursive
typechecks and test runner before treating this first queue as deployable.

On this host, the matching Rust/Cargo 1.97.1 toolchain is already installed.
For build commands, use:

```sh
export PATH="/home/zannis/.rustup/toolchains/1.97.1-aarch64-unknown-linux-gnu/bin:$PATH"
```

## Validation status (September 20, 2026)

Two serialized server suites failed on the published queue and on `fe297dbbc`
alone: `issue-watchdogs-routes` (12 tests, a race the warm test process loses)
and `permissions-upgrade-boundary-routes` (a mock missing an export the retained
patch imports). Both pass after `025a952b1`. On this queue tip: `pnpm -r
typecheck` and `pnpm build` pass; the patch's seven watchdog, issue and
interaction suites pass (491 tests); the full runner is left to fork CI.

## Routine upstream update

Start with a clean worktree and a local `patches/onlybots` matching the published
remote queue, if that remote branch exists. New fixes should be separate topic
commits with their tests and a source PR reference. Avoid merging upstream into
the queue; rebase the entire queue in an isolated candidate instead.

Use the repository's supported Node/pnpm versions and install the Rust toolchain
pinned in `packages/paperclip-runner/rust-toolchain.toml`. Full verification builds the native
runner as well as the JavaScript packages.

```sh
bash scripts/onlybots-sync.sh prepare /path/to/new-worktree sync/onlybots-20260917
cd /path/to/new-worktree
bash scripts/onlybots-sync.sh report
bash scripts/onlybots-sync.sh verify
bash scripts/onlybots-sync.sh promote
```

Before `promote`, ensure `patches/onlybots` is not checked out in another
worktree. In that other clean worktree, `git switch --detach` releases the branch
without changing its tip or files. Run `promote` from the candidate worktree.

`prepare` pins source, old base and new upstream SHAs under
`refs/onlybots-sync/<candidate>/`, and anchors the old queue under
`refs/onlybots-backups/<candidate>`. It stops on divergent local/remote queues,
existing destinations or non-linear patch history. It enables Git rerere for
the rebase without automatically staging remembered resolutions.

If rebase conflicts occur, inspect each one, preserve the patch's behavior and
upstream's new behavior, stage only resolved files, then use:

```sh
git -c rerere.enabled=true -c rerere.autoupdate=false rebase --continue
```

After each update, review `report`. Retire a patch only when upstream has its
behavior and regression coverage. Git's patch-ID matching cannot reliably
recognize a rewritten or squashed upstream implementation. Keep dependencies in
order and update this inventory when a patch is admitted, replaced or retired.

`verify` runs a frozen install, the full build, recursive typechecks and the
repository test runner. It records the exact successful commit, requires a clean
tree and refuses success if HEAD changes while checking. `promote` only advances
the local queue, checks that the queue has not changed since preparation, and
refuses to update a queue branch checked out in another worktree. Edits or
commits after verification require another verification run.

## Publishing and deployment

Review the candidate and its check results before publishing. For the first
publication, use `git push -u origin patches/onlybots`. For later rebases, record
the reviewed remote SHA and use an explicit lease:

```sh
git push --force-with-lease=refs/heads/patches/onlybots:OLD_REMOTE_SHA origin patches/onlybots
```

Replace `OLD_REMOTE_SHA` with the full SHA you reviewed. A rejected lease means
another writer updated the queue; fetch and reconcile, never overwrite it with
an unconditional force push. Feature branches remain independent for upstream
PRs; agents should not base long-lived work on the rewritable queue.

Deploy an immutable tested tag or image digest. Preserve the previous deployed
artifact for rollback. The sync helper intentionally has no deployment command.
Changing the deployed application may apply database migrations; reverting an
application tag is not a database rollback procedure.

Automation may run `prepare` and `verify` periodically and report the candidate
and conflicts. Promotion, remote publication and deployment remain explicit
steps. Unchanged upstream should not trigger another build/deploy cycle.
