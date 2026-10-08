#!/usr/bin/env bash
# TornScope release tag creation — the ONLY sanctioned way to tag a release.
#
# v2.6.1 release-safety hardening:
#   - Tags are IMMUTABLE: this script refuses to create, move or force-push
#     an existing tag. A post-release fix ships as a NEW patch version.
#   - Hard-fails when the target tag already exists locally or on origin.
#
# Usage:
#   scripts/release-tag.sh            # tag v$(package.json version) at HEAD
#   scripts/release-tag.sh <sha>      # tag a specific commit
set -euo pipefail
cd "$(dirname "$0")/.."

for arg in "$@"; do
  case "$arg" in
    -f|--force|-d|--delete)
      echo "FAIL: '$arg' is not permitted — release tags are immutable (fix after release => new patch version)" >&2
      exit 1
      ;;
  esac
done

version=$(node -p "require('./package.json').version")
tag="v${version}"
target="${1:-HEAD}"

[[ -z "$(git status --porcelain)" ]] || { echo "FAIL: working tree dirty" >&2; exit 1; }

git fetch origin --tags --quiet

if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null 2>&1; then
  echo "FAIL: tag ${tag} already exists locally ($(git rev-parse --short "${tag}")) — tags are immutable; bump the version and tag that" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
  echo "FAIL: tag ${tag} already exists on origin — tags are immutable; bump the version and tag that" >&2
  exit 1
fi

git tag -a "${tag}" -m "TornScope ${tag} (${target})" "${target}"
git push origin "refs/tags/${tag}"
echo "Tagged ${tag} -> $(git rev-parse --short "${target}") and pushed (immutable; fixes ship as a new patch version)"
