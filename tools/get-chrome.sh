#!/usr/bin/env bash
# Downloads a Chrome for Testing build into tools/chrome/ (no root needed).
# Used for headless smoke tests and asset verification on machines without a browser.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/tools/chrome"
mkdir -p "$DEST"

META_URL="https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
META="$(curl -sSL --max-time 60 "$META_URL")"

python3 - "$META" <<'PY' > "$DEST/urls.txt"
import json, sys
meta = json.loads(sys.argv[1])
stable = meta["channels"]["Stable"]
print(stable["version"])
for key in ("chrome-headless-shell", "chrome"):
    for item in stable["downloads"].get(key, []):
        if item["platform"] == "linux64":
            print(item["url"])
PY

cat "$DEST/urls.txt"
VERSION="$(head -n1 "$DEST/urls.txt")"
echo "Chrome for Testing version: $VERSION"

tail -n +2 "$DEST/urls.txt" | while read -r url; do
  name="$(basename "$url" .zip)"
  echo "== downloading $name"
  curl -sSL --max-time 600 "$url" -o "$DEST/$name.zip"
  rm -rf "$DEST/$name"
  python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$DEST/$name.zip" "$DEST"
  rm -f "$DEST/$name.zip"
done

# zip extraction drops the exec bit; crashpad without it aborts Chrome at startup.
find "$DEST" -type f \( -name "chrome" -o -name "chrome_crashpad_handler" -o -name "chrome_sandbox" -o -name "chrome-headless-shell" \) -exec chmod +x {} \;
echo "Done. Binaries:"
find "$DEST" -maxdepth 2 -type f -name "chrome*" -perm -u+x
