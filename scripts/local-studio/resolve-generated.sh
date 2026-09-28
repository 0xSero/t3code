#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ -x node_modules/.bin/vp ]; then
  vp=(node_modules/.bin/vp)
elif command -v vp >/dev/null 2>&1; then
  vp=(vp)
else
  vp=(pnpm exec vp)
fi

regenerate() {
  case "$1" in
    pnpm-lock.yaml)
      "${vp[@]}" install --lockfile-only --ignore-scripts
      ;;
    apps/web/src/routeTree.gen.ts)
      node scripts/local-studio/route-tree.ts
      ;;
    *)
      echo "resolve-generated: no generator for $1" >&2
      return 1
      ;;
  esac
}

mode="conflicted"
if [ "${1:-}" = "--all" ]; then
  mode="all"
fi

generated=()
while IFS=$'\t' read -r path budget _id _purpose; do
  if [ "$budget" = "-" ]; then
    generated+=("$path")
  fi
done < .local-studio/hooks.txt

conflicted="$(git diff --name-only --diff-filter=U)"
resolved=0

blocking=()
while IFS= read -r path; do
  [ -z "$path" ] && continue
  is_generated=0
  for candidate in "${generated[@]}"; do
    if [ "$candidate" = "$path" ]; then
      is_generated=1
    fi
  done
  if [ "$is_generated" = 0 ]; then
    blocking+=("$path")
  fi
done <<< "$conflicted"

if [ "${#blocking[@]}" -gt 0 ]; then
  echo "resolve-generated: conflicts outside generated files need a human:" >&2
  printf '  %s\n' "${blocking[@]}" >&2
  exit 1
fi

for path in "${generated[@]}"; do
  if printf '%s\n' "$conflicted" | grep -qxF "$path"; then
    echo "resolve-generated: $path conflicted, taking upstream and regenerating"
    git checkout --theirs -- "$path"
    regenerate "$path"
    git add -- "$path"
    resolved=$((resolved + 1))
  elif [ "$mode" = "all" ]; then
    echo "resolve-generated: regenerating $path"
    regenerate "$path"
    if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
      git add -- "$path"
    fi
  fi
done

remaining="$(git diff --name-only --diff-filter=U)"
if [ -n "$remaining" ]; then
  echo "resolve-generated: resolved $resolved generated file(s); conflicts remain:" >&2
  printf '%s\n' "$remaining" | sed 's/^/  /' >&2
  exit 1
fi

echo "resolve-generated: resolved $resolved generated file(s); no conflicts remain"
