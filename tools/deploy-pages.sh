#!/usr/bin/env bash
#
# Publish the committed game to GitHub Pages.
#
#   bash tools/deploy-pages.sh
#
# Why a script and not a workflow: the site is served from the gh-pages branch of
# the public repo, and the only token this project has carries `repo` scope but
# not `workflow`, so .github/workflows/*.yml cannot be pushed. Every publish is
# therefore this command, run by hand. Nothing updates the site by itself when
# `main` moves.
#
# What makes the build special (proved by the deploy that first worked):
#   1. the site is served from /zombie-game/, so Vite's base must be set, and
#   2. `vite build --base` rewrites index.html only. The game's own absolute
#      /assets/... paths are string literals inside the bundle; left alone they
#      are requested from https://hendri1202.github.io/assets/... which 404s, so
#      the game has no models, no audio and a blank menu. vite.config.pages.ts
#      prefixes them and this script refuses to publish a bundle that still
#      contains a bare /assets/ literal.
#
# The build runs from `git archive HEAD` in a scratch directory, so it publishes
# exactly what is committed (never a half-edited working tree), never touches
# dist/, and never stages anything from the working tree.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${PAGES_REMOTE:-origin}"
PAGES_BRANCH="${PAGES_BRANCH:-gh-pages}"
SITE_URL="${PAGES_URL:-https://hendri1202.github.io/zombie-game/}"
SITE_ORIGIN="${PAGES_ORIGIN:-https://hendri1202.github.io}"
BASE_PATH="${PAGES_BASE_PATH:-/zombie-game/}"

# How many /assets/ literals a healthy bundle carries, counted as
# `grep -oE '["'"'"'\`]BASE/assets/' | wc -l`. It is a fingerprint of the asset
# tables in src/app/*Config.ts, src/level/CityLevel.ts and the two path builders:
# if a change adds or removes an asset path on purpose, update this number after
# re-checking the counts by hand. A mismatch is a stop sign, not a rounding error.
EXPECTED_ASSET_LITERALS="${PAGES_EXPECTED_LITERALS:-26}"

# GitHub Pages serves a new branch commit behind a CDN that may hold the old
# index.html for a while; the verification loop asks with a cache-busting query
# and gives the CDN up to ~5 minutes before giving up loudly.
VERIFY_ATTEMPTS="${PAGES_VERIFY_ATTEMPTS:-60}"
VERIFY_SLEEP="${PAGES_VERIFY_SLEEP:-5}"

SCRATCH="${PAGES_SCRATCH:-${TMPDIR:-/tmp}/zombie-pages-deploy}"
SRC_DIR="$SCRATCH/src"
OUT_DIR="$SCRATCH/site"

log()  { printf '[deploy] %s\n' "$*"; }
die()  { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

cd "$REPO_DIR"
git rev-parse --git-dir >/dev/null 2>&1 || die "$REPO_DIR is not a git repository"

SHORT_SHA="$(git rev-parse --short HEAD)"
FULL_SHA="$(git rev-parse HEAD)"
SUBJECT="$(git log -1 --format=%s HEAD)"
REMOTE_URL="$(git remote get-url "$REMOTE")" || die "no git remote named '$REMOTE'"

# ---------------------------------------------------------------------------
# 1. Build from the committed tree in a scratch directory
# ---------------------------------------------------------------------------
log "publishing $SHORT_SHA — $SUBJECT"
rm -rf "$SCRATCH"
mkdir -p "$SRC_DIR" "$OUT_DIR"

log "exporting git archive HEAD ($SHORT_SHA) to $SRC_DIR"
git archive --format=tar HEAD | tar -x -C "$SRC_DIR"

# The archive holds sources only; the toolchain comes from the repo's install.
# A symlink keeps the scratch build reproducible with whatever is installed here
# and avoids a second copy of node_modules.
[ -d "$REPO_DIR/node_modules" ] || die "node_modules missing in $REPO_DIR — run npm install first"
ln -s "$REPO_DIR/node_modules" "$SRC_DIR/node_modules"

[ -f "$SRC_DIR/vite.config.pages.ts" ] || die "vite.config.pages.ts is not committed at HEAD; commit it before deploying"
[ -f "$SRC_DIR/tools/deploy-pages.sh" ] || log "note: tools/deploy-pages.sh is not committed at HEAD (deploying an in-repo edit of this script)"

log "building with vite.config.pages.ts (base $BASE_PATH) into $OUT_DIR"
( cd "$SRC_DIR" && PAGES_OUT_DIR="$OUT_DIR" ./node_modules/.bin/vite build --config vite.config.pages.ts )

# Jekyll must stay out of the way: without this, GitHub Pages ignores files and
# directories starting with an underscore (three.js ships some) and can 404 the
# bundle.
: > "$OUT_DIR/.nojekyll"
log "wrote $OUT_DIR/.nojekyll"

# ---------------------------------------------------------------------------
# 2. Refuse to publish a bundle that would render blank
# ---------------------------------------------------------------------------
shopt -s nullglob
JS_FILES=( "$OUT_DIR"/assets/*.js )
shopt -u nullglob
[ "${#JS_FILES[@]}" -gt 0 ] || die "no JS bundle in $OUT_DIR/assets — build produced nothing to publish"

# grep -o counts occurrences (the minified bundle is a handful of very long
# lines, so plain `grep -c` would count lines), and -q-style exit codes are
# avoided because a zero match is a failure of `grep`, not of this script.
count_matches() { grep -oE "$1" "$2" 2>/dev/null | wc -l | tr -d ' ' || true; }

BARE_ANY=0; BARE_DOUBLE=0; PREFIXED=0
for f in "${JS_FILES[@]}"; do
  BARE_ANY=$(( BARE_ANY + $(count_matches "[\"'\`]/assets/" "$f") ))
  BARE_DOUBLE=$(( BARE_DOUBLE + $(count_matches "\"/assets/" "$f") ))
  PREFIXED=$(( PREFIXED + $(count_matches "[\"'\`]${BASE_PATH}assets/" "$f") ))
done

log "literal check on ${#JS_FILES[@]} bundle file(s):"
log "  bare /assets/ literals (any quote): $BARE_ANY  (must be 0)"
log "  bare /assets/ literals (double quote, the historical grep): $BARE_DOUBLE  (must be 0)"
log "  literals prefixed with $BASE_PATH: $PREFIXED  (must be $EXPECTED_ASSET_LITERALS)"

[ "$BARE_ANY" -eq 0 ] || die "$BARE_ANY /assets/ literal(s) left bare in the bundle; the site would request them from $SITE_ORIGIN/assets/ and 404 blank. Check vite.config.pages.ts."
[ "$BARE_DOUBLE" -eq 0 ] || die "$BARE_DOUBLE bare double-quoted /assets/ literal(s) in the bundle. Check vite.config.pages.ts."
[ "$PREFIXED" -eq "$EXPECTED_ASSET_LITERALS" ] || die "expected $EXPECTED_ASSET_LITERALS prefixed asset literals, found $PREFIXED. If asset paths changed on purpose, re-verify and set PAGES_EXPECTED_LITERALS; otherwise the transform or the sources regressed."

# index.html points at the prefixed bundle or the page is blank too.
INDEX_HTML="$OUT_DIR/index.html"
[ -f "$INDEX_HTML" ] || die "no index.html in $OUT_DIR"
grep -q "src=\"${BASE_PATH}assets/" "$INDEX_HTML" || die "index.html does not reference ${BASE_PATH}assets/ — base is wrong in vite.config.pages.ts"
if grep -qE '(src|href)="/assets/' "$INDEX_HTML"; then
  die "index.html still references a bare /assets/ path"
fi
SERVED_BUNDLE_PATH="$(grep -oE "src=\"[^\"]*\.js\"" "$INDEX_HTML" | head -1 | sed -E 's/^src="//; s/"$//')"
LOCAL_BUNDLE="$OUT_DIR${SERVED_BUNDLE_PATH}"
[ -f "$LOCAL_BUNDLE" ] || die "index.html references $SERVED_BUNDLE_PATH but no such file was built"
SERVED_SCRIPT_PATH="$SERVED_BUNDLE_PATH"
log "index.html -> $SERVED_SCRIPT_PATH"

# ---------------------------------------------------------------------------
# 3. Commit the built site and force-push it to gh-pages
# ---------------------------------------------------------------------------
cd "$OUT_DIR"
git init -q .
git add -A
TREE="$(git write-tree)"

PARENT_ARGS=()
if git fetch --no-tags --quiet "$REMOTE_URL" "refs/heads/$PAGES_BRANCH" 2>/dev/null; then
  PREV="$(git rev-parse --verify -q FETCH_HEAD || true)"
  if [ -n "$PREV" ]; then
    PARENT_ARGS=( -p "$PREV" )
    log "keeping $PAGES_BRANCH history: new commit descends from ${PREV:0:7}"
  fi
fi

AUTHOR_NAME="$(git -C "$REPO_DIR" config user.name || true)"
AUTHOR_EMAIL="$(git -C "$REPO_DIR" config user.email || true)"
AUTHOR_NAME="${AUTHOR_NAME:-dead-district deploy}"
AUTHOR_EMAIL="${AUTHOR_EMAIL:-deploy@users.noreply.github.com}"

MSG_FILE="$SCRATCH/commit-message.txt"
cat > "$MSG_FILE" <<EOF
Deploy Dead District to GitHub Pages from main $SHORT_SHA

$SUBJECT

Built from \`git archive HEAD\` ($FULL_SHA) with vite.config.pages.ts:
base $BASE_PATH plus the transform that prefixes the game's absolute
/assets/ paths, which \`vite build --base\` alone leaves untouched (they would
be requested from $SITE_ORIGIN/assets/ and 404, leaving the site blank).

Pre-push check on the bundle: $BARE_ANY bare /assets/ literals,
$PREFIXED literals prefixed with $BASE_PATH. \`.nojekyll\` present.

Reproduce with tools/deploy-pages.sh.
EOF

COMMIT="$(git -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" \
  commit-tree "$TREE" "${PARENT_ARGS[@]}" -F "$MSG_FILE")"
log "site commit $COMMIT (tree $TREE, $(git ls-tree -r --name-only "$TREE" | wc -l | tr -d ' ') files)"

# Prefer the gh CLI as the credential helper for this one push, but only when no
# helper is configured: the deploy machine may already have working credentials.
CRED_ARGS=()
if [ -z "$(git config --get-all credential.helper || true)" ] \
   && [ -z "$(git config --get-all credential.https://github.com.helper || true)" ] \
   && command -v gh >/dev/null 2>&1; then
  CRED_ARGS=( -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' )
fi

log "force-pushing $COMMIT to $REMOTE/$PAGES_BRANCH"
git "${CRED_ARGS[@]}" push --force "$REMOTE_URL" "$COMMIT:refs/heads/$PAGES_BRANCH"

# ---------------------------------------------------------------------------
# 4. Verify the live site: page 200, referenced bundle 200, and it is our build
# ---------------------------------------------------------------------------
SERVED_INDEX="$SCRATCH/served-index.html"
SERVED_BUNDLE="$SCRATCH/served-bundle.js"
http_code() { curl -sS -o "$1" -w '%{http_code}' --max-time 30 -H 'Cache-Control: no-cache' "$2" 2>/dev/null || echo 000; }

CACHE_BUST="deploy=$SHORT_SHA"
CODE=000
for attempt in $(seq 1 "$VERIFY_ATTEMPTS"); do
  CODE="$(http_code "$SERVED_INDEX" "$SITE_URL?$CACHE_BUST")"
  if [ "$CODE" = "200" ] && grep -q "src=\"${BASE_PATH}assets/" "$SERVED_INDEX"; then
    break
  fi
  if [ "$attempt" = "$VERIFY_ATTEMPTS" ]; then
    die "live site did not serve the new build: $SITE_URL returned $CODE (attempt $attempt/$VERIFY_ATTEMPTS). Pages may still be building; re-run this script or check https://github.com/hendri1202/zombie-game/deployments"
  fi
  [ "$attempt" = 1 ] && log "waiting for the CDN to serve the new build (got $CODE so far)..."
  sleep "$VERIFY_SLEEP"
done

log "live index.html: $CODE from $SITE_URL"
LIVE_SCRIPT="$(grep -oE "src=\"[^\"]*\.js\"" "$SERVED_INDEX" | head -1 | sed -E 's/^src="//; s/"$//')"
[ -n "$LIVE_SCRIPT" ] || die "live index.html has no module script tag"
case "$LIVE_SCRIPT" in
  "${BASE_PATH}assets/"*) : ;;
  *) die "live index.html references '$LIVE_SCRIPT', which is not under ${BASE_PATH}assets/ — the published page would request assets outside the repository path" ;;
esac
[ "$LIVE_SCRIPT" = "$SERVED_SCRIPT_PATH" ] || die "live index.html points at $LIVE_SCRIPT but this deploy built $SERVED_SCRIPT_PATH — the CDN is still serving an older build, retry later"

BUNDLE_URL="$SITE_ORIGIN$LIVE_SCRIPT?$CACHE_BUST"
BUNDLE_CODE="$(http_code "$SERVED_BUNDLE" "$BUNDLE_URL")"
log "live bundle: $BUNDLE_CODE from $BUNDLE_URL"
[ "$BUNDLE_CODE" = "200" ] || die "the bundle referenced by the live page returned $BUNDLE_CODE — the game would not boot"

# The site could serve our HTML and someone else's bundle; compare bytes.
LOCAL_HASH="$(sha256sum "$LOCAL_BUNDLE" | cut -d' ' -f1)"
LIVE_HASH="$(sha256sum "$SERVED_BUNDLE" | cut -d' ' -f1)"
[ "$LOCAL_HASH" = "$LIVE_HASH" ] || die "the live bundle differs from the one just built (built $LOCAL_HASH, served $LIVE_HASH); the CDN is serving something else"

LIVE_BARE="$(count_matches "[\"'\`]/assets/" "$SERVED_BUNDLE")"
LIVE_PREFIXED="$(count_matches "[\"'\`]${BASE_PATH}assets/" "$SERVED_BUNDLE")"
[ "$LIVE_BARE" -eq 0 ] || die "the live bundle contains $LIVE_BARE bare /assets/ literal(s)"
[ "$LIVE_PREFIXED" -eq "$EXPECTED_ASSET_LITERALS" ] || die "the live bundle has $LIVE_PREFIXED prefixed literals, expected $EXPECTED_ASSET_LITERALS"
log "live bundle literal check: bare $LIVE_BARE, prefixed $LIVE_PREFIXED (sha256 $LOCAL_HASH)"

# And one real asset file, since missing assets are what blanked the site before.
ASSET_PATH="${ASSET_PROBE_PATH:-${BASE_PATH}assets/weapons/Pistol.gltf}"
ASSET_CODE="$(http_code "$SCRATCH/served-asset.bin" "$SITE_ORIGIN$ASSET_PATH?$CACHE_BUST")"
log "live asset: $ASSET_CODE from $SITE_ORIGIN$ASSET_PATH"
[ "$ASSET_CODE" = "200" ] || die "live asset $ASSET_PATH returned $ASSET_CODE — models/audio would fail to load"

log "published and verified: $SITE_URL (commit $COMMIT, main $SHORT_SHA)"
log "note: nothing re-runs this automatically — the site stays at $SHORT_SHA until the next bash tools/deploy-pages.sh"
