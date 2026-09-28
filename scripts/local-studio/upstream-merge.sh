#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: upstream-merge.sh --target <ref> --upstream <ref> --branch <name> [--report-dir <dir>]" >&2
  exit 2
}

target=""
upstream=""
branch=""
report_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    --upstream) upstream="$2"; shift 2 ;;
    --branch) branch="$2"; shift 2 ;;
    --report-dir) report_dir="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$target" ] && [ -n "$upstream" ] && [ -n "$branch" ] || usage

root="$(git rev-parse --show-toplevel)"
cd "$root"
report_dir="${report_dir:-$(mktemp -d)}"
mkdir -p "$report_dir"

emit() {
  printf '%s=%s\n' "$1" "$2" >> "$report_dir/outputs"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
}

: > "$report_dir/outputs"
: > "$report_dir/conflicts.txt"

upstream_sha="$(git rev-parse "$upstream^{commit}")"
target_sha="$(git rev-parse "$target^{commit}")"
emit upstream_sha "$upstream_sha"
emit target_sha "$target_sha"

if git merge-base --is-ancestor "$upstream_sha" "$target_sha"; then
  echo "upstream-merge: $target already contains $upstream ($upstream_sha)"
  emit status up-to-date
  emit merged_sha "$target_sha"
  exit 0
fi

git config rerere.enabled true
git config rerere.autoupdate true
git checkout --quiet -B "$branch" "$target_sha"

behind="$(git rev-list --count "$target_sha..$upstream_sha")"
message="Merge upstream pingdotgg/t3code main ($(git rev-parse --short "$upstream_sha"), $behind commits)"

if git merge --no-ff --no-edit -m "$message" "$upstream_sha"; then
  echo "upstream-merge: clean merge of $behind upstream commits"
else
  echo "upstream-merge: merge stopped with conflicts; resolving generated files"
  if ! bash scripts/local-studio/resolve-generated.sh; then
    git diff --name-only --diff-filter=U > "$report_dir/conflicts.txt"
    git merge --abort
    git checkout --quiet -B "$branch" "$upstream_sha"
    emit status conflict
    emit merged_sha "$upstream_sha"
    echo "upstream-merge: unresolved conflicts:"
    sed 's/^/  /' "$report_dir/conflicts.txt"
    exit 0
  fi
  git commit --no-edit -m "$message"
fi

emit status merged
emit merged_sha "$(git rev-parse HEAD)"
echo "upstream-merge: $branch at $(git rev-parse --short HEAD)"
