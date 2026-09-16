# Browser search

AIO provides two Pi-compatible tools:

- `web_search` uses the SearXNG or Exa backend selected in Pi settings.
- `fetch_content` validates each initial URL, tries Camofox Readability or an
  accessibility snapshot, and escalates blocked or empty pages to CloakBrowser.

`web_search` is opt-in: AIO does not register it until a provider is selected.
`fetch_content` remains available independently. Results are returned inline and
bounded by the configured output cap. There is deliberately no curator UI,
response-id store, or `get_search_content` tool.

## Select a search provider

Configure `aio.browserSearch` in global `~/.pi/agent/settings.json` or trusted
project `.pi/settings.json`. Project values override global values.

Use Exa with an API key from the environment:

```json
{
  "aio": {
    "browserSearch": {
      "provider": "exa",
      "exa": {
        "apiKeyEnv": "EXA_API_KEY",
        "searchType": "auto"
      }
    }
  }
}
```

Set `EXA_API_KEY` in Pi's environment. `apiKeyEnv` defaults to `EXA_API_KEY` and
can name a different environment variable. Optional Exa settings are `baseUrl`
and `searchType` (`auto`, `keyword`, `neural`, `hybrid`, `fast`, `instant`,
`deep-lite`, `deep`, or `deep-reasoning`). AIO calls Exa's REST API directly so requests retain Pi's
cancellation behavior without another runtime SDK dependency.

Use a self-hosted SearXNG instance instead:

```json
{
  "aio": {
    "browserSearch": {
      "provider": "searxng",
      "searxng": {
        "baseUrl": "http://localhost:8080"
      }
    }
  }
}
```

The tool's `provider` argument is retained for pi-web-access call compatibility;
it does not override the backend selected in settings. Remove `provider` from
`aio.browserSearch` to disable `web_search`, then restart Pi or run `/reload`.

## Optional self-hosted browsing stack

SearXNG requires its own service. Camofox is used only when `includeContent` or
`fetch_content` browses a result. Start the included local-only Compose stack
from the repository root when those services are wanted:

```bash
cp .env.example .env # optional: customize images, ports, or secrets
docker compose up --build -d
docker compose ps
```

Both ports bind to `127.0.0.1`. Verify the services with:

```bash
curl 'http://localhost:8080/search?format=json&q=health'
curl 'http://localhost:9377/health'
```

Stop them with `docker compose down`; add `-v` to also delete browser profiles
and the SearXNG cache.

`cloakbrowser` and `playwright-core` are optional npm dependencies. AIO imports
them only when Camofox cannot extract a page. CloakBrowser downloads its
Chromium binary on first use.

## Environment configuration

- `EXA_API_KEY` — default Exa credential environment variable.
- `BROWSER_SEARCH_EXA_BASE` (`https://api.exa.ai`) — Exa base URL fallback.
- `BROWSER_SEARCH_SEARXNG_BASE` (`http://localhost:8080`) — SearXNG base URL
  fallback when settings do not specify one.
- `BROWSER_SEARCH_CAMOFOX_BASE` (`http://localhost:9377`) — Camofox REST base.
- `CAMOFOX_API_KEY` (empty) — Camofox API bearer token.
- `CAMOFOX_USER_ID` (`pi-bot`) — Camofox session identity.
- `BROWSER_SEARCH_CAMOFOX_AUTO_RESTART` (disabled) — set to `1`, `true`, or
  `yes` to permit `docker restart camofox-browser` after a recovering 503.
- `BROWSER_SEARCH_EXA_TIMEOUT_MS` (`20000`) — Exa request timeout.
- `BROWSER_SEARCH_SEARXNG_TIMEOUT_MS` (`20000`) — SearXNG request timeout.
- `BROWSER_SEARCH_CAMOFOX_TIMEOUT_MS` (`30000`) — Camofox request timeout.
- `BROWSER_SEARCH_MAX_INLINE_CONTENT` (`40000`) — model-facing result cap.
- `BROWSER_SEARCH_CLOAK_MAX_CHARS` (`100000`) — CloakBrowser extraction cap.

The SSRF guard rejects unsafe initial URLs and private DNS results before either
browser tier starts navigation. As with any remote browser service, deploy
Camofox with its own network policy if redirects to internal destinations must
also be prevented.

## Coexisting with pi-web-access

Both packages can register `web_search` and `fetch_content`, and Pi keeps the
first registration for each name. Do not load both extensions simultaneously.
To keep pi-web-access skills while letting AIO own the tools, use a package
filter in Pi settings:

```json
{
  "source": "npm:pi-web-access",
  "extensions": []
}
```

Omitting the `skills` key keeps that package's skills enabled. Alternatively,
remove pi-web-access entirely.
