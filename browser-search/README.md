# Self-hosted browser search

AIO registers two Pi tools backed by the architecture from
[`Johell1NS/browser-search`](https://github.com/Johell1NS/browser-search):

- `web_search` queries a local SearXNG JSON endpoint.
- `fetch_content` validates each initial URL, tries Camofox Readability or an
  accessibility snapshot, and escalates blocked or empty pages to CloakBrowser.

The port is native TypeScript; it does not shell out to the upstream `.mjs`
scripts. Results are returned inline and bounded by the configured output cap.
There is deliberately no curator UI, response-id store, or
`get_search_content` tool.

## Runtime setup

SearXNG and Camofox are external services and are not started by AIO. Follow the
upstream [Docker setup](https://github.com/Johell1NS/browser-search/blob/master/docker/setup.md),
then verify:

```bash
curl 'http://localhost:8080/search?format=json&q=health'
curl 'http://localhost:9377/health'
```

`cloakbrowser` and `playwright-core` are optional npm dependencies. AIO installs
them when the platform supports them, but imports them only when Camofox cannot
extract a page. CloakBrowser downloads its Chromium binary on first use.

## Configuration

- `BROWSER_SEARCH_SEARXNG_BASE` (`http://localhost:8080`) — SearXNG base URL.
- `BROWSER_SEARCH_CAMOFOX_BASE` (`http://localhost:9377`) — Camofox REST
  base URL.
- `CAMOFOX_API_KEY` (empty) — Camofox API bearer token.
- `CAMOFOX_USER_ID` (`pi-bot`) — Camofox session identity.
- `BROWSER_SEARCH_CAMOFOX_AUTO_RESTART` (disabled) — set to `1`, `true`, or
  `yes` to permit `docker restart camofox-browser` after a recovering 503.
- `BROWSER_SEARCH_SEARXNG_TIMEOUT_MS` (`20000`) — SearXNG request timeout.
- `BROWSER_SEARCH_CAMOFOX_TIMEOUT_MS` (`30000`) — Camofox request timeout.
- `BROWSER_SEARCH_MAX_INLINE_CONTENT` (`40000`) — model-facing result cap.
- `BROWSER_SEARCH_CLOAK_MAX_CHARS` (`100000`) — CloakBrowser extraction cap.

The SSRF guard rejects unsafe initial URLs and private DNS results before either
browser tier starts navigation. As with any remote browser service, deploy
Camofox with its own network policy if redirects to internal destinations must
also be prevented.

## Coexisting with pi-web-access

Both packages register `web_search` and `fetch_content`, and Pi keeps the first
registration for each name. Do not load both extensions simultaneously. To keep
pi-web-access skills while letting AIO own the tools, use a package filter in
Pi settings:

```json
{
  "source": "npm:pi-web-access",
  "extensions": []
}
```

Omitting the `skills` key keeps that package's skills enabled. Alternatively,
remove pi-web-access entirely.
