#!/usr/bin/env bash
# CI publisher: requires a verified snapshot and a disposable runner checkout.
set -euo pipefail
: "${GITHUB_WORKSPACE:?}" "${RUNNER_TEMP:?}" "${RELEASE_TAG:?}"

git ls-remote --heads origin refs/heads/marketplace > "$RUNNER_TEMP/marketplace-ref"
previous=''
if test -s "$RUNNER_TEMP/marketplace-ref"; then
  git fetch --no-tags --depth=1 origin refs/heads/marketplace
  previous=$(git rev-parse FETCH_HEAD)
  git show "$previous:release.json" > "$RUNNER_TEMP/previous-release.json"
  relation=$(node scripts/release-policy.mjs dist/published-marketplace "$RELEASE_TAG" "$RUNNER_TEMP/previous-release.json")
else
  relation=$(node scripts/release-policy.mjs dist/published-marketplace "$RELEASE_TAG")
fi
export GIT_INDEX_FILE="$RUNNER_TEMP/marketplace.index"
git read-tree --empty
git --work-tree="$GITHUB_WORKSPACE/dist/published-marketplace" add -A -f -- .
tree=$(git write-tree)
if test -n "$previous"; then
  if test "$(git rev-parse "$previous^{tree}")" = "$tree"; then
    echo 'This marketplace snapshot is already published.'
    exit 0
  fi
  if test "$relation" = 'same-version'; then
    echo 'Refusing to publish a changed marketplace tree at the same version.' >&2
    exit 1
  fi
fi
set -- "$tree" -m "chore(release): publish $RELEASE_TAG"
if test -n "$previous"; then set -- "$@" -p "$previous"; fi
commit=$(git -c commit.gpgsign=false -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit-tree "$@")
git push origin "$commit:refs/heads/marketplace"
