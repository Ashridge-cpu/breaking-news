# Breaking News

Live headlines from the sources you choose – checked every 5 minutes, new items shown at the top.

**App:** https://ashridge-cpu.github.io/breaking-news/

## How it works
- `sources.json` – the built-in feed list (every URL verified to return current items).
- `.github/workflows/feeds.yml` – every ~5 minutes GitHub Actions fetches the built-in feeds server-side
  (`scripts/fetch_feeds.py`, Python stdlib only) and force-pushes a single `feeds.json` to the `data` branch.
  The app reads it from `raw.githubusercontent.com`, which allows cross-site requests, so no CORS proxy is needed for built-ins.
- If that cache is missing or older than 15 minutes, or for sources you add yourself, the app fetches the feed
  in the browser: directly first, then via free public CORS proxies (allorigins, codetabs, everyorigin, rss2json).
- Settings (toggles, your own sources, alerts) are stored in the browser's localStorage. No accounts, no API keys.
