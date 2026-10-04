#!/usr/bin/env bash
#
# release.sh — build the simbox-agent binary, package the release tarball,
# compute its sha256, re-render action.yml from action.yml.template, and print
# the `gh release` commands to publish.
#
# Usage:
#   ./release.sh <version>            # e.g. ./release.sh 0.2.0  (tag v0.2.0)
#
# Pin bumps: edit packages/agent/src/pins.ts and packages/agent/package.json
# version BEFORE running this script — the rendered action + tarball embed
# whatever is checked in.
#
# Must be run on a machine with bun installed (the binary is cross-compiled to
# darwin-arm64 and linux-x64, so this works from Linux too).
set -euo pipefail

VERSION="${1:?usage: $0 <semver, e.g. 0.2.0>}"
TAG="v${VERSION#v}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_DIR="$REPO_ROOT/packages/agent"
OUT_DIR="$REPO_ROOT/dist-release"
TARBALL_NAME="simbox-agent-darwin-arm64.tar.gz"
TARBALL="$OUT_DIR/$TARBALL_NAME"
BIN_NAME="simbox-agent"   # name inside the tarball — action.yml untars + runs ./simbox-agent

echo "==> Building @simbox/agent ($TAG)"
bun run --cwd "$AGENT_DIR" build   # → packages/agent/dist/simbox-agent-darwin-arm64

echo "==> Packaging $TARBALL_NAME"
mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$AGENT_DIR/dist/simbox-agent-darwin-arm64" "$STAGE/$BIN_NAME"
chmod +x "$STAGE/$BIN_NAME"
tar -czf "$TARBALL" -C "$STAGE" "$BIN_NAME"

echo "==> Computing sha256"
if command -v shasum >/dev/null 2>&1; then
  SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
else
  SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
fi
echo "    sha256: $SHA"

LINUX_TARBALL="$OUT_DIR/simbox-agent-linux-amd64.tar.gz"
cp "$AGENT_DIR/dist/simbox-agent-linux-amd64" "$STAGE/$BIN_NAME"
chmod +x "$STAGE/$BIN_NAME"
tar -czf "$LINUX_TARBALL" -C "$STAGE" "$BIN_NAME"
if command -v shasum >/dev/null 2>&1; then
  LINUX_SHA="$(shasum -a 256 "$LINUX_TARBALL" | awk '{print $1}')"
else
  LINUX_SHA="$(sha256sum "$LINUX_TARBALL" | awk '{print $1}')"
fi

echo "==> Rendering action.yml"
sed \
  -e "s/{{SHA256}}/$SHA/g" \
  -e "s/{{SHA256_LINUX}}/$LINUX_SHA/g" \
  -e '/^# GENERATED FILE/d' \
  "$SCRIPT_DIR/action.yml.template" \
  > "$SCRIPT_DIR/action.yml.tmp"

# Prepend generated-file header (sed -e can't insert before line 1 portably).
{
  echo "# GENERATED FILE — rendered from action.yml.template by release.sh (tag $TAG)."
  echo "# sha256 embedded below is the digest of $TARBALL_NAME attached to that release."
  cat "$SCRIPT_DIR/action.yml.tmp"
} > "$SCRIPT_DIR/action.yml"
rm "$SCRIPT_DIR/action.yml.tmp"

echo ""
echo "Done. Next steps:"
echo "  1. Publish this directory to the TouchTechClub/runner repo and tag it:"
echo "       rsync -a --delete $SCRIPT_DIR/ /path/to/runner/"
echo "       cd /path/to/runner && git add -A && git commit -m 'simbox $TAG'"
echo "       git tag -f v1 && git tag $TAG && git push --tags -f origin v1 $TAG"
echo "  2. Create the release in TouchTechClub/simbox and upload the tarball:"
echo "       gh release create $TAG $TARBALL $LINUX_TARBALL \\"
echo "         --repo TouchTechClub/simbox \\"
echo "         --title 'simbox-agent $TAG' \\"
echo "         --notes 'simbox-agent darwin-arm64 · sha256 $SHA'"
echo "     (or upload to an existing release:)"
echo "       gh release upload $TAG $TARBALL $LINUX_TARBALL --repo TouchTechClub/simbox --clobber"
echo ""
echo "Verify: $SHA  $TARBALL"
