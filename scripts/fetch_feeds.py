#!/usr/bin/env python3
"""Fetch built-in feeds and write a compact JSON cache. Stdlib only."""
import json, sys, re, html, time, concurrent.futures as cf, urllib.request, gzip, ssl
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone

UA = "Mozilla/5.0 (compatible; BreakingNewsBot/1.0; +https://ashridge-cpu.github.io/breaking-news/)"
MAX_ITEMS = 30

def strip(s, n=280):
    if not s: return ""
    s = re.sub(r"<[^>]+>", " ", s); s = html.unescape(s); s = re.sub(r"\s+", " ", s).strip()
    return (s[:n-1] + "…") if len(s) > n else s

def ts(s):
    if not s: return 0
    s = s.strip()
    try: return int(parsedate_to_datetime(s).timestamp() * 1000)
    except Exception: pass
    try: return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception: return 0

def local(tag): return tag.rsplit('}', 1)[-1].lower()

def child(el, *names):
    for c in el:
        if local(c.tag) in names: return c
    return None

def text(el, *names):
    c = child(el, *names)
    return (c.text or "").strip() if c is not None and c.text else ""

def parse(data):
    root = ET.fromstring(data)
    items = []
    for el in root.iter():
        t = local(el.tag)
        if t not in ("item", "entry"): continue
        title = strip(text(el, "title"), 300)
        link = ""
        if t == "entry":
            for c in el:
                if local(c.tag) == "link" and c.get("rel", "alternate") == "alternate" and c.get("href"):
                    link = c.get("href"); break
        if not link:
            link = text(el, "link")
            if not link:
                c = child(el, "link"); link = c.get("href", "") if c is not None else ""
            if not link:
                g = child(el, "guid"); link = (g.text or "").strip() if g is not None and g.text and g.text.startswith("http") else ""
        summ = strip(text(el, "description", "summary", "content", "encoded"))
        date = ts(text(el, "pubdate", "published", "updated", "date", "issued"))
        if title and link:
            items.append({"t": title, "l": link, "s": summ if summ != title else "", "d": date})
    return items

def get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        b = r.read()
        if r.headers.get("Content-Encoding") == "gzip": b = gzip.decompress(b)
        return b

def load(url):
    items = parse(get(url))
    if "news.google.com" in url:
        for i in items:
            i["t"] = re.sub(r"\s+-\s+[^-]{2,60}$", "", i["t"]); i["s"] = ""
    return items

def one(src):
    try:
        try:
            items = load(src["url"])
            if not items: raise ValueError("no items")
        except Exception:
            if not src.get("alt"): raise
            items = load(src["alt"])
        items.sort(key=lambda i: i["d"], reverse=True)
        if not items: return src["id"], {"ok": False, "err": "no items"}
        return src["id"], {"ok": True, "items": items[:MAX_ITEMS]}
    except Exception as e:
        return src["id"], {"ok": False, "err": type(e).__name__ + ": " + str(e)[:120]}

def main(srcfile, out):
    srcs = json.load(open(srcfile))
    res = {}
    with cf.ThreadPoolExecutor(12) as ex:
        for sid, r in ex.map(one, srcs): res[sid] = r
    json.dump({"generated": int(time.time() * 1000), "feeds": res}, open(out, "w"), ensure_ascii=False, separators=(",", ":"))
    bad = [k for k, v in res.items() if not v["ok"]]
    print(f"{len(srcs)-len(bad)}/{len(srcs)} ok; failed: {bad}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
