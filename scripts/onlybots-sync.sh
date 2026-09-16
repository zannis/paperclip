#!/usr/bin/env bash
# Maintain the local patch queue without changing deployment or remote branches.
set -euo pipefail

die() { printf 'onlybots-sync: %s\n' "$*" >&2; exit 1; }
clean() { test -z "$(git status --porcelain)" || die 'Commit or stash changes in this worktree first.'; }
queue=refs/heads/patches/onlybots
command=${1:-help}
shift || true

case "$command" in
  prepare)
    test "$#" -eq 2 || die 'Usage: bash scripts/onlybots-sync.sh prepare WORKTREE sync/NAME'
    destination=$1
    candidate=$2
    case "$candidate" in sync/*) ;; *) die 'Candidate branch must start with sync/.';; esac
    git check-ref-format --branch "$candidate" >/dev/null
    test ! -e "$destination" || die 'Destination already exists; choose a new worktree path.'
    if git show-ref --verify --quiet "refs/heads/$candidate"; then die 'Candidate branch already exists.'; fi
    clean
    git fetch --no-tags upstream master
    git fetch --no-tags origin
    source=$(git rev-parse --verify "$queue^{commit}")
    remote_source=$(git rev-parse --verify refs/remotes/origin/patches/onlybots 2>/dev/null || true)
    if test -n "$remote_source" && test "$remote_source" != "$source"; then
      die 'Local and remote patches/onlybots differ. Reconcile them explicitly before preparing an update.'
    fi
    target=$(git rev-parse --verify upstream/master^{commit})
    old_base=$(git merge-base "$source" "$target")
    test "$(git rev-list --count --merges "$old_base..$source")" -eq 0 || die 'The patch queue must be linear; inspect its merge commits first.'
    if test "$old_base" = "$target"; then
      printf 'The queue already contains upstream %s; no candidate created.\n' "$target"
      exit 0
    fi
    metadata="refs/onlybots-sync/$candidate"
    git update-ref "$metadata/source" "$source" ''
    git update-ref "$metadata/old-base" "$old_base" ''
    git update-ref "$metadata/upstream" "$target" ''
    # This also anchors the previous queue against garbage collection.
    git update-ref "refs/onlybots-backups/$candidate" "$source" ''
    git worktree add -b "$candidate" "$destination" "$source"
    if ! git -C "$destination" -c rerere.enabled=true -c rerere.autoupdate=false \
      rebase --onto "$target" "$old_base"; then
      printf 'Candidate retained at %s. Resolve conflicts, stage the resolutions, then run git rebase --continue there.\n' "$destination" >&2
      exit 1
    fi
    printf 'Candidate ready at %s. Run report, review the patch differences, then verify.\n' "$destination"
    ;;
  report|verify|promote)
    test "$#" -eq 0 || die "Usage: bash scripts/onlybots-sync.sh $command"
    candidate=$(git symbolic-ref --quiet --short HEAD) || die 'Finish the rebase first.'
    case "$candidate" in sync/*) ;; *) die 'Run this command from a sync/ candidate worktree.';; esac
    metadata="refs/onlybots-sync/$candidate"
    source=$(git rev-parse --verify "$metadata/source^{commit}")
    old_base=$(git rev-parse --verify "$metadata/old-base^{commit}")
    target=$(git rev-parse --verify "$metadata/upstream^{commit}")
    candidate_sha=$(git rev-parse HEAD)
    git merge-base --is-ancestor "$target" HEAD || die 'Candidate does not contain the pinned upstream commit.'
    test "$(git rev-list --count --merges "$target..HEAD")" -eq 0 || die 'Candidate must remain linear.'
    if test "$command" = report; then
      git range-diff "$old_base..$source" "$target..HEAD"
      git diff --stat "$target...HEAD"
      exit 0
    fi
    clean
    if test "$command" = verify; then
      # A failed rerun must not leave an earlier success eligible for promotion.
      git update-ref -d "$metadata/verified"
      git diff --check "$target...HEAD"
      pnpm install --frozen-lockfile
      # Build first: workspace typechecks/tests consume generated package exports.
      pnpm build
      pnpm -r typecheck
      pnpm test:run
      clean
      test "$(git rev-parse HEAD)" = "$candidate_sha" || die 'HEAD changed during verification; rerun checks.'
      git update-ref "$metadata/verified" "$candidate_sha"
      printf 'Verified %s. Review the range-diff before running promote.\n' "$candidate_sha"
    else
      verified=$(git rev-parse --verify "$metadata/verified^{commit}" 2>/dev/null || true)
      test "$verified" = "$candidate_sha" || die 'This exact candidate has not passed verify.'
      # Updating a checked-out branch behind its worktree would corrupt the
      # relationship between its HEAD, index and files. Refuse that operation.
      if git worktree list --porcelain | grep -Fqx "branch $queue"; then
        die 'patches/onlybots is checked out in another worktree; switch that worktree to a different branch first.'
      fi
      git update-ref "$queue" "$candidate_sha" "$source"
      printf 'Promoted the local patch queue to %s. No remote branch or deployment was changed.\n' "$candidate_sha"
    fi
    ;;
  help|--help|-h)
    printf '%s\n' \
      'prepare WORKTREE sync/NAME  Fetch and rebase a new candidate from patches/onlybots.' \
      'report                     Compare the original and rebased patch series.' \
      'verify                     Install, build, typecheck and test the exact candidate.' \
      'promote                    Advance only the local queue after successful verification.'
    ;;
  *) die "Unknown command: $command";;
esac
