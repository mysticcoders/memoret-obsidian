#!/usr/bin/env bash
# Fetches the shared conformance corpus into fixtures/ (gitignored).
#
# Pinned to a tag rather than main, so a new expectation lands when this
# receiver chooses to adopt it rather than the next time CI happens to run.
set -euo pipefail

TAG="${MEMORET_FIXTURES_TAG:-v1}"
REPO="https://github.com/mysticcoders/memoret-contract-fixtures.git"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fixtures"

rm -rf "$DEST"
git clone --depth 1 --branch "$TAG" --quiet "$REPO" "$DEST"
rm -rf "$DEST/.git"
echo "fetched conformance corpus $TAG into $DEST"
