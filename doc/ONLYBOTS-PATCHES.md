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
| Codex MCP HTTP headers | Deployed baseline. Upstream now writes `http_headers` itself, so only the rtk half remains: `AGENTS.md` and `RTK.md` are copied into managed Codex homes and kept out of the sandbox sync allowlist |
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
| Lockfile sync | Retired October 3, 2026: upstream `ffe5e9e2a` ships a lockfile in sync with its overrides |
| Lane task primitives | Conditional issue PATCH (`expected` preconditions on revision, status, assignee and description hash; atomic status and comment; no self-wake on a conditional park) and a durable idempotency key registry (retain, void, delete tombstones) with board lookup and void routes. Migrations 0295–0296 (renumbered from 0284–0285). For flow's lane-task reuse. Fork-only, not proposed upstream |
| Grouped lane children | Create-only, board-only `groupedChild` issue flag (migration 0297, renumbered from 0286). A grouped child's completion never wakes its parent (`issue_children_completed`, including native completions), it never relays a stop comment, it is not counted as the parent's open child (including by recovery), and parent subtree holds (cancel, pause, restore) skip it and its descendants. For flow's lane tasks. Fork-only, not proposed upstream |
| Fork image publishing | `docker.yml` also triggers on pushes to `patches/onlybots`; only `zannis/paperclip` builds that ref, publishing the multi-arch (amd64, arm64) production image as `ghcr.io/zannis/paperclip:sha-<short>` with upstream's OCI and schema labels. The full-SHA tag and standard-image attestation stay upstream-master-only; upstream has retired the cloud image build. Fork-only, not proposed upstream |
| Anthropic SDK refresh | The claude-agent-acp `@anthropic-ai/claude-agent-sdk` override 0.3.280 → 0.3.283 (Claude Code 2.1.283), with the runner integrity pins, executable digests and Daytona image check moved together. The `@anthropic-ai/sdk` half retired once upstream moved claude-local to 0.129.0. Retire the rest when upstream bumps past 0.3.283 |
| Lockfile in queue PRs | `pr-trusted.yml`'s "Block manual lockfile edits" skips PRs into `patches/onlybots`: upstream's lockfile refresh runs on `master` only, so a queue PR that changes dependencies carries its own `pnpm-lock.yaml` instead of a direct sync commit after merge. `pr.yml` calls the fork's own `pr-trusted.yml`, not upstream's `master` copy, so this and every other queue change to the checks takes effect. |
| Claude ACP pin and npm overrides | `@agentclientprotocol/claude-agent-acp` 0.73.0 → 0.81.2 (its patch ported), keeping the `claude-agent-sdk` override at 0.3.283, with the runner's qualified command digest and dependency bindings. The published CLI package now carries every nested pnpm override as an npm `overrides` entry: the managed install is an npm install, so without them it resolved claude-agent-acp's own SDK declaration (0.3.257 under 0.73.0) and codex-acp's own Codex range. npm refuses an override keyed on a direct dependency unless it is pinned to the override's exact version, so codex-local pins codex-acp `1.6.2` and the generator refuses a mismatch. The git installer writes those overrides into the staged payload's own `package.json` before `npm install`, since npm honours overrides only from the root project. |
| Commit trailers left to repository conventions | The bundled `paperclip` skill no longer tells agents they MUST add `Co-Authored-By: Paperclip`; it defers to the repository's and operator's commit conventions. Deployments that forbid generated-by trailers refused every agent commit that obeyed it. The bullet is rewritten in place, not removed, so the capability inventory's line-numbered heading ids stay valid. The frozen `skills-releases/paperclip/*` snapshots are left as they are: they are seeded per company and checked against that snapshot at startup. Fork-only |

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

## Upstream update (September 24, 2026)

The queue moved from upstream `4577d1002` to `4b8ec588f` (117 upstream
commits). The old queue tip `735945c29` is anchored at
`refs/onlybots-backups/pre-rebase-20260923`. 37 of 48 patches replayed
unchanged. These resolutions need review:

- **Claude SDK plugin loading.** Upstream #13651 changed `patches/acpx@0.13.1.patch`.
  The patch was rebuilt from the pristine 0.13.1 package: upstream's hunks, then
  the plugin hunks. Both acpx patches apply to their pristine packages. Only the
  two acpx hashes changed in that commit's lockfile.
- **Remote MCP header policy.** Upstream #13758 retired the Composio broker.
  Discovery and execution keep the shared `buildRemoteHeaders` policy without
  the Composio session and retry branches.
- **TypeSafe connection.** The health check and install early return no longer
  reference Composio. The install early return keys on TypeSafe alone.
- **Chat-run connector restriction.** Upstream #13828 limits the restricted
  chat-run block to `agentmail_` tools so Slack-origin runs can use governed
  connector tools. The TypeSafe commit had widened the block to every connector.
  Upstream's line is kept, so a restricted chat run can call TypeSafe under tool
  governance.
- **Watchdog recovery audit, internal operation surfaces.** Both sides were
  kept: the Slack conversation resume and the `afterInsert` hook, and the idle
  Slack condition inside `surfaceIssueCondition`.

On the rebased tip, with Node 26 and pnpm 9.15.4: the frozen install, `pnpm -r
typecheck` and `pnpm build` (including the Rust runner) pass. The 79 test files
that the queue touches pass: 77 files and 2670 tests, with 2 files and 12 tests
skipped. The serialized server suite was not run.

## Upstream update (October 3, 2026)

The queue moved from upstream `4b8ec588f` to `ffe5e9e2a` (210 upstream
commits). The old queue tip `faf1c8216` is anchored at
`refs/onlybots-backups/sync/onlybots-20261003`. 42 of 72 patches replayed
unchanged; one was retired. These resolutions need review:

- **Migration renumbering.** Upstream added 0284–0294. The lane task primitives
  and grouped children migrations moved from 0284–0286 to 0295–0297. Their SQL
  is byte-identical: the migrator identifies applied migrations by content hash,
  so a database that already ran the old numbers treats them as applied, and
  upstream's new migrations still run. Each snapshot is upstream's latest
  snapshot plus the original patch's snapshot delta. Upstream's new migrations
  touch none of these columns.
- **Lockfile sync** is retired: upstream's lockfile now matches its overrides.
- **Codex MCP HTTP headers.** Upstream writes `http_headers` and asserts it. The
  patch keeps only the rtk `AGENTS.md`/`RTK.md` seeding and its tests, and its
  commit is renamed accordingly.
- **Anthropic SDK refresh.** Upstream moved `@anthropic-ai/sdk` to 0.129.0, past
  the patch's 0.128.0; that half is dropped. The `claude-agent-sdk` 0.3.283
  override, pins and digests remain, and the commit is renamed.
- **Claude SDK plugin loading.** Upstream changed `patches/acpx@0.13.1.patch`
  again. It was rebuilt from the pristine package: upstream's hunks, then the
  plugin hunks. Both acpx patches apply to their pristine packages; only the
  two acpx hashes changed in the lockfile.
- **Project inference.** Upstream resolves the create assignment project with
  `resolveCreateAssignmentProjectId`. The inferred project is passed into it
  (inference runs only when no project, parent or workspace is given).
- **Reconnect credential dedupe.** Upstream moved the reconnect loop into a
  transaction and matches refs by config path only, which still duplicates the
  Authorization header. The header-key match is reapplied there.
- **Idempotency key registry.** Upstream's new `assertCanReuseIssue` guard runs
  on the registry path before a retain update.
- **Conditional updates.** The atomic conditional comment passes upstream's
  `mirrorToSlack` for board users, like upstream's other comment paths.
- **Grouped children.** Upstream removed delegation mention forwarding, so the
  grouped-child guard there and its test scenarios are gone.
- **Fork image publishing.** Upstream retired the cloud image job; its skip
  condition is gone.
- **TypeSafe connection.** Upstream's catalog generator requires a permission
  review for every tool method; `tool-method-permission-reviews.json` gains a
  TypeSafe entry (no key-permission helper text). Store counts move to 60.

On the rebased tip, with Node 26.5.0 and pnpm 9.15.4: `git diff --check`, the
frozen install, `pnpm build` (including the Rust runner) and `pnpm -r
typecheck` pass. `pnpm test:run`: 15267 passed, 61 failed, 101 skipped. All 61
failures are in `workspace-runtime` and `execution-workspaces-service` and are
local to the build machine: its global git config signs commits without a
reachable gpg, and its global ignore file ignores `.worktrees/`. With both
neutralised, those files pass except two that compare `/private/var` with
`/var` (macOS). The serialized server suite was not run.

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
