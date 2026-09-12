# dsh-usage-monitor

English | [简体中文](README.md)

> A DeepSeek Harness (DSH) plugin that shows DeepSeek API **official pricing, session token usage/cost, cumulative cost, and account balance** directly inside DSH.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json)

![DSH usage panel](docs/screenshots/usage-view.png)

> Screenshots use demo data and do not represent any real account.

## Features

- **Account balance**: queries `GET https://api.deepseek.com/user/balance` and shows total, topped-up, and granted balance. Cached for 60 seconds by default with manual refresh.
- **Current session cost**: reads the DSH `tokenUsage` projection and estimates cost in real time across four token buckets: cache hit, cache miss, cache write, and output.
- **Cumulative cost**: a local ledger records usage across sessions, using incremental pricing so peak/off-peak changes are accounted for accurately.
- **Official pricing**: built-in `deepseek-flash` and `deepseek-v4-pro` prices with automatic peak/off-peak tier selection.
- **Two UI entry points**:
  - a full **Usage** tab in the conversation view;
  - an always-visible dock above the input box showing balance, current session cost, active model price, and price tier.
- **Privacy-friendly**: no public listener, no stored API key. See **Security & Privacy** below.

## Screenshots

### Full usage panel

![Usage panel](docs/screenshots/usage-panel.png)

### Input-box dock

![Usage dock](docs/screenshots/usage-dock.png)

## Installation

### Prerequisites

- DSH installed, for example `@deepseek-ai/dsh`;
- the `web` profile;
- a usable DeepSeek API key, already configured in `~/.dsh/.credentials.yaml` or supplied via the `DEEPSEEK_API_KEY` environment variable.

### 1. Install the plugin

```sh
dsh plugin --profile web add github:liyiersan/dsh-usage-monitor
```

You can also install from a local checkout:

```sh
dsh plugin --profile web add /path/to/dsh-usage-monitor
```

This repository declares `dsh.bundle.patch`. On DSH versions that support the manifest, the install command applies `cordis.patch.yml` automatically and inserts the plugin into the profile composition, so you normally do not need to edit the profile patch by hand.

### 2. Manual install / fallback

If your DSH version does not apply the bundle patch automatically, edit `$DSH_HOME/profiles/web/cordis.patch.yml` (default: `~/.dsh/profiles/web/cordis.patch.yml`) and add:

```yaml
- insert:
    - id: usage-monitor
      name: '@local/dsh-usage-monitor'
```

### 3. Make sure the API key is available

The plugin never stores the key itself. It resolves `DEEPSEEK_API_KEY` through the DSH credentials service, falling back to the process environment.

### 4. Restart DSH

```sh
dsh web
```

Open any conversation. You should see the **Usage** tab in the conversation view and the usage dock above the input box.

### Uninstall

```sh
dsh plugin --profile web remove @local/dsh-usage-monitor
```

If you added the `insert` entry manually, remove it from `cordis.patch.yml`; a bundle install is normally cleaned up by `dsh plugin remove`. Optionally delete the local ledger:

```sh
rm -rf "$DSH_HOME/usage-monitor"
```

## Pricing model

Unit: **CNY / million tokens**. Peak hours are Beijing time Monday-Friday `09:00-12:00` and `14:00-18:00`; off-peak prices are half of peak prices.

| Model | Tier | Cache hit | Cache miss | Output |
|---|---:|---:|---:|---:|
| DeepSeek-V4.1-Flash | Off-peak | 0.02 | 1 | 4 |
| DeepSeek-V4.1-Flash | Peak | 0.04 | 2 | 8 |
| DeepSeek-V4-Pro | Off-peak | 0.15 | 4.5 | 13.5 |
| DeepSeek-V4-Pro | Peak | 0.3 | 9 | 27 |

Billing rules:

- `cacheRead` (cache-hit input) uses the cache-hit price;
- `uncachedInput` (cache-miss input) uses the cache-miss price;
- `output` uses the output price;
- `cacheWrite` is not listed separately by the official docs, so this project conservatively charges it at the cache-miss price;
- model names containing `pro`, `chat`, or `reasoner` are normalized to V4-Pro; names containing `flash` are normalized to Flash; unknown models fall back to Flash and are marked as an estimate in the UI.

> Costs are estimated locally and should match the official billing model, though tiny rounding differences are possible. DeepSeek prices may change; when updating, keep `lib/pricing.js` and the inline pricing copy in `lib/client.js` in sync.

## How it works

```text
DSH Host (Node)
  lib/index.js ── GET /user/balance ──> api.deepseek.com
       │
       ├─ GET  /usage-monitor/data   ──> browser client
       └─ POST /usage-monitor/report <── browser client
                                      │
                                      ├─ conversation.view "Usage" tab
                                      └─ conversation.input.dock bar
```

- `lib/index.js`: host half. Resolves credentials, queries balance, maintains the local ledger, and exposes local HTTP endpoints.
- `lib/client.js`: browser bundle. Registers the `conversation.view` and `conversation.input.dock` slots and reads/reports data.
- `lib/pricing.js`: pure pricing engine used by the host and tests.
- The client carries an inline copy of the pricing table because browser modules cannot import server modules directly. Update both copies when prices change.

## Project layout

```text
dsh-usage-monitor/
├── lib/
│   ├── client.js      # browser bundle
│   ├── index.js       # host plugin
│   └── pricing.js     # pricing engine
├── scripts/
│   ├── client-check.mjs
│   ├── inspect-session.mjs
│   └── smoke.mjs
├── test/
│   └── pricing.test.mjs
├── docs/screenshots/
├── package.json
├── README.md
├── README.en.md
└── LICENSE
```

## Development & tests

```sh
npm test                 # pricing engine unit tests
npm run test:client      # offline client bundle checks
node scripts/smoke.mjs   # host smoke test (queries the real balance API)
```

`scripts/smoke.mjs` uses a temporary `DSH_HOME`, so it does not pollute your real ledger. It reads the key from the local DSH credentials file or the environment, but only prints the key length, never the key itself.

## Compatibility

This version was developed and verified against DSH `0.1.1-rc.2` with the `web` profile (September 2026). DSH client APIs may still evolve; if slots or model-resolution APIs change after a DSH upgrade, please open an issue or a PR.

## Security & Privacy

- No telemetry is collected or uploaded.
- The plugin does not store the API key; the key is provided only by the DSH credentials service or the process environment.
- Balance queries run on the host side and only target `https://api.deepseek.com/user/balance`.
- The local ledger lives at `$DSH_HOME/usage-monitor/ledger.json` and records only session IDs and token usage; it is not committed to this repository.
- The `/usage-monitor/*` endpoints are served by the DSH web server on loopback. `/usage-monitor/report` requires `Content-Type: application/json` to reduce CSRF risk.
- If you fork this project, do not commit your local ledger, credentials file, or logs containing personal paths.

## Contributing

Issues and PRs are welcome. Before opening a PR, please run:

```sh
npm test
npm run test:client
```

## License

[MIT](LICENSE)
