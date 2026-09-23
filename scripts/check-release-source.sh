#!/usr/bin/env bash
# A release runner starts with only the source tag checked out at depth one.
set -euo pipefail
: "${RELEASE_TAG:?}"

# Fetch only the main ancestry needed for this check, not generated snapshots
# or other branches/tags. The source tag itself can remain a shallow boundary.
git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
git merge-base --is-ancestor HEAD origin/main
node scripts/release-policy.mjs check-tag package.json "$RELEASE_TAG"
