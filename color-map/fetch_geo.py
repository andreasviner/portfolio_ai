"""
Pull the live survey DB *with coarse geo* for the color map.

Same authenticated `GET /color-polygraph/export` endpoint the retraining
pipeline uses (cloudflare/worker.py), but with `include_geo=1` so each row also
carries country / region / city / timezone_cf. That flag is off by default and
token-gated, so this only works with the EXPORT_TOKEN already in
`color-polygraph/.env` -- AND only after the worker carrying the include_geo
change has been deployed (`wrangler deploy` in color-polygraph/cloudflare/).

Reads CP_API_BASE + CP_EXPORT_TOKEN (or EXPORT_TOKEN) from
`color-polygraph/.env`, or pass --base / --token explicitly.

Usage:
    python fetch_geo.py                 # completed rows only, with geo
    python fetch_geo.py --all           # include not-yet-completed rows too

Output:
    color-map/data/geo_dump.json
        {"pulled_at","source","completed_only","include_geo","count","rows":[...]}
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "data", "geo_dump.json")

# The .env with the export token lives at the color-polygraph submodule root.
_CP_ROOT = os.path.normpath(os.path.join(HERE, "..", "color-polygraph"))

PAGE_LIMIT = 1000          # matches the worker default; capped at 5000 there
REQUEST_TIMEOUT = 60       # seconds per page request

# Cloudflare's Bot Fight Mode rejects the default "Python-urllib" UA at the edge
# (error 1010) before the request reaches the worker; look like a browser.
_BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
               "AppleWebKit/537.36 (KHTML, like Gecko) "
               "Chrome/124.0.0.0 Safari/537.36")


def _load_dotenv(path):
    """Minimal KEY=VALUE loader; does not override already-set env vars."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def _fetch_page(base, token, limit, offset, completed_only):
    qs = urllib.parse.urlencode({
        "limit": limit,
        "offset": offset,
        "completed_only": "1" if completed_only else "0",
        "include_geo": "1",
    })
    url = f"{base.rstrip('/')}/color-polygraph/export?{qs}"
    req = urllib.request.Request(url, headers={
        "x-export-token": token,
        "user-agent": _BROWSER_UA,
        "accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8")
        except Exception:
            pass
        raise SystemExit(
            f"export request failed: HTTP {exc.code} {exc.reason}\n"
            f"  url: {url}\n  body: {body}\n"
            "  (a 400/500 mentioning an unknown column means the include_geo "
            "worker change has not been deployed yet.)")
    except urllib.error.URLError as exc:
        raise SystemExit(f"could not reach {url}: {exc.reason}")


def pull_all(base, token, completed_only, out_path):
    rows, offset, total, t0 = [], 0, None, time.time()
    while True:
        page = _fetch_page(base, token, PAGE_LIMIT, offset, completed_only)
        # Old worker omits include_geo entirely (defaults to False here) -> fail
        # fast rather than silently writing geo-less rows.
        if page.get("include_geo", False) is not True:
            raise SystemExit(
                "worker did not confirm include_geo: the deployed worker does "
                "not support the geo flag yet. Deploy the updated worker.py "
                "(wrangler deploy in color-polygraph/cloudflare/) and retry.")
        batch = page.get("rows", [])
        rows.extend(batch)
        total = page.get("total", total)
        print(f"  page offset={offset}  got {len(batch)}  (running {len(rows)}/{total})")
        if not page.get("has_more") or not batch:
            break
        offset += len(batch)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    snapshot = {
        "pulled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": base,
        "completed_only": completed_only,
        "include_geo": True,
        "count": len(rows),
        "total_reported": total,
        "rows": rows,
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(snapshot, fh)
    print(f"\nWrote {len(rows)} rows to {out_path}  ({time.time() - t0:.1f}s)")
    return snapshot


def main():
    _load_dotenv(os.path.join(_CP_ROOT, ".env"))
    ap = argparse.ArgumentParser(description="Pull the live survey DB with geo for the color map.")
    ap.add_argument("--base", default=os.environ.get("CP_API_BASE"),
                    help="API base URL (or set CP_API_BASE in color-polygraph/.env)")
    ap.add_argument("--token",
                    default=os.environ.get("CP_EXPORT_TOKEN") or os.environ.get("EXPORT_TOKEN"),
                    help="export token (or set CP_EXPORT_TOKEN / EXPORT_TOKEN)")
    ap.add_argument("--all", action="store_true",
                    help="include rows that have not completed all three confirmations")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output dump path")
    args = ap.parse_args()

    if not args.base:
        sys.exit("no API base: pass --base or set CP_API_BASE in color-polygraph/.env")
    if not args.token:
        sys.exit("no export token: pass --token or set CP_EXPORT_TOKEN in color-polygraph/.env")

    print(f"Pulling from {args.base}  (completed_only={not args.all}, include_geo=1) ...")
    pull_all(args.base, args.token, completed_only=not args.all, out_path=args.out)


if __name__ == "__main__":
    main()
