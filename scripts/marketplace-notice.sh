#!/usr/bin/env bash
# A final README notice for old registrations; never alter their package bytes.
set -euo pipefail
: "${GITHUB_WORKSPACE:?}" "${RUNNER_TEMP:?}"
cd "$GITHUB_WORKSPACE"
staging=$(mktemp -d "$RUNNER_TEMP/marketplace-notice.XXXXXX")
trap 'rm -rf "$staging"' EXIT
git ls-remote --heads origin refs/heads/marketplace > "$staging/ref"
if ! test -s "$staging/ref"; then exit 0; fi
git fetch --no-tags --depth=1 origin refs/heads/marketplace
previous=$(git rev-parse FETCH_HEAD)
blob=$(git hash-object -w -- packaging/marketplace-moved.md)
if test "$(git rev-parse "$previous:README.md")" = "$blob"; then exit 0; fi
export GIT_INDEX_FILE="$staging/index"
git read-tree "$previous"
git update-index --add --cacheinfo "100644,$blob,README.md"
tree=$(git write-tree)
commit=$(git -c commit.gpgsign=false -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit-tree "$tree" -p "$previous" -m 'docs(distribution): announce marketplace migration to main')
git push origin "$commit:refs/heads/marketplace"
