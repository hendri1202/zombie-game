#!/usr/bin/env python3
"""List a public Google Drive folder (no API key) by parsing the _DRIVE_ivd blob."""
import json
import subprocess
import sys

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def fetch(folder_id):
    url = "https://drive.google.com/drive/folders/" + folder_id
    out = subprocess.run(["curl", "-sSL", "--max-time", "60", "-A", UA, url],
                         capture_output=True)
    return out.stdout.decode("utf-8", "replace")


def listing(folder_id):
    html = fetch(folder_id)
    marker = "window['_DRIVE_ivd']"
    i = html.find(marker)
    if i < 0:
        return []
    i = html.find("'", i + len(marker))
    j = html.find("';</script>", i)
    raw = html[i + 1:j]
    raw = raw.replace("\\'", "'").replace('\\"', '"')
    text = bytes(raw, "utf-8").decode("unicode_escape", errors="replace")
    data, _ = json.JSONDecoder().raw_decode(text.lstrip())
    rows = data[0] if data and isinstance(data[0], list) else []
    items = []
    for r in rows:
        try:
            items.append({
                "id": r[0],
                "parent": r[1][0] if isinstance(r[1], list) else None,
                "name": r[2],
                "mime": r[3],
                "size": r[13] if len(r) > 13 else None,
            })
        except Exception:
            pass
    return items


if __name__ == "__main__":
    fid = sys.argv[1]
    items = listing(fid)
    print(f"{len(items)} items in {fid}")
    for it in items:
        kind = "DIR " if it["mime"].endswith(".folder") else "FILE"
        print(f'{kind} {it["id"]}  {it["size"]}  {it["name"]}')
