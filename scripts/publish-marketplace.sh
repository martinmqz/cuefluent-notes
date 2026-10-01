#!/usr/bin/env bash
# Prepare a release-owned branch for review; never push directly to main.
set -euo pipefail
: "${GITHUB_WORKSPACE:?}" "${RUNNER_TEMP:?}" "${RELEASE_TAG:?}"
cd "$GITHUB_WORKSPACE"
snapshot="$GITHUB_WORKSPACE/dist/published-marketplace"
path_list=$(node scripts/release-policy.mjs paths)
paths=()
while IFS= read -r entry; do paths+=("$entry"); done <<< "$path_list"

# Reject unexpected snapshot files and verify package closure before staging.
node scripts/marketplace-content.mjs snapshot "$snapshot" "$RELEASE_TAG"
git fetch --no-tags --depth=1 origin refs/heads/main
previous=$(git rev-parse FETCH_HEAD)
if git cat-file -e "$previous:release.json" 2>/dev/null; then
  git show "$previous:release.json" > "$RUNNER_TEMP/previous-release.json"
  relation=$(node scripts/release-policy.mjs "$snapshot" "$RELEASE_TAG" "$RUNNER_TEMP/previous-release.json")
else
  relation=$(node scripts/release-policy.mjs "$snapshot" "$RELEASE_TAG")
fi
staging=$(mktemp -d "$RUNNER_TEMP/marketplace-index.XXXXXX")
trap 'rm -rf "$staging"' EXIT
export GIT_INDEX_FILE="$staging/index"
git read-tree "$previous"
git --work-tree="$snapshot" add -A -f -- "${paths[@]}"
tree=$(git write-tree)
# Validate the actual Git bytes too: attributes may transform staging inputs.
node scripts/marketplace-content.mjs tree "$tree" "$RELEASE_TAG"
if test "$(git rev-parse "$previous^{tree}")" = "$tree"; then
  echo 'This marketplace snapshot is already published on main.'
  if test -n "${GITHUB_OUTPUT:-}"; then printf 'changed=false\n' >> "$GITHUB_OUTPUT"; fi
  exit 0
fi
if test "$relation" = 'same-version'; then
  echo 'Refusing to publish a changed marketplace tree at the same version.' >&2
  exit 1
fi
branch="chore/publish-$RELEASE_TAG"
git ls-remote --heads origin "refs/heads/$branch" > "$staging/existing-ref"
if test -s "$staging/existing-ref"; then
  git fetch --no-tags --depth=1 origin "refs/heads/$branch"
  commit=$(git rev-parse FETCH_HEAD)
  if test "$(git rev-parse "$commit^{tree}")" != "$tree"; then
    echo 'Publication branch differs from the prepared update; review the existing PR instead of overwriting it.' >&2
    exit 1
  fi
else
  commit=$(git -c commit.gpgsign=false -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit-tree "$tree" -p "$previous" -m "chore(release): publish $RELEASE_TAG")
  git push origin "$commit:refs/heads/$branch"
fi
if test -n "${GITHUB_OUTPUT:-}"; then
  printf 'changed=true\nbranch=%s\ncommit=%s\n' "$branch" "$commit" >> "$GITHUB_OUTPUT"
fi
printf 'Prepared %s at %s for review. Main is unchanged.\n' "$branch" "$commit"
