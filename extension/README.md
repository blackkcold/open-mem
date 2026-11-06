# OpenMem Console for OpenChamber

An OpenChamber extension that puts the OpenMem review console where you already
work: a rail panel, a full page, and a one-line Work Status section. The existing
OpenMem HTTP server and the OpenCode plugin are unchanged; the extension is a
thin UI plus a local proxy.

## What you get

- **Rail panel** — queue count, health score, shadow/live state, and the top three
  candidates with approve/promote/draft/deny actions appropriate to the candidate.
- **Full page** — the complete console: queue, suggestions, memory map, audit,
  skill review, health, and settings.
- **Work Status section** — a compact queue/health readout next to the chat.
- **No token in the UI** — the local service injects the OpenMem Bearer token.
- **Host theme** — light/dark follow OpenChamber's `--oc-*` tokens.

## Requirements

- OpenChamber **2.6.0+** on web or desktop. Mobile and VS Code do not load
  extensions.
- OpenCode with the OpenMem plugin loaded, on the **same machine** as
  OpenChamber. The extension proxies to `127.0.0.1:47821`.
- The OpenMem console server must be enabled (`console: true`, the default) and
  the data directory must contain `console-token` (or a `token` in
  `config.json`).

## Build

```bash
npm --prefix console install
npm run build:extension
```

This writes:

```
extension/page/main.js
extension/panel/main.js
extension/status/main.js
extension/service/main.js
```

The HTML entries are committed; the JS files must exist before installing.
Generated `*/main.js` bundles are ignored by Git; rebuild them from source before
folder installation or packaging. `npm run verify` includes the bundle build and
service proxy tests. CI uses the same command, without live credentials or models.
The build is an IIFE for the three UI surfaces and a Node ESM bundle for the
service, because OpenChamber extension iframes cannot load ES modules.

Packaged builds derive the extension version from `console/package.json` and append
`+build.<UTC timestamp>`. The OpenChamber extension card and the console footer show
the same build, so two builds of the same semantic version are distinguishable.

## Install

### Option A — install the zip (recommended for a normal deployment)

```bash
npm run package:extension
# dist/openmem-console-extension-0.1.0.zip
```

In OpenChamber, open **Settings → Extensions → Install from file/zip**, choose
the zip, then approve the **service** capability. The host copies it to
`~/.config/openchamber/extensions/openmem`, so it survives restarts. This is the
path to use if you want a normal installed extension rather than a folder
mounted from the repository.

### Option B — install the folder (development)

1. In OpenChamber, open **Settings → Extensions**.
2. Add the extension folder by absolute path:

   ```
   /Users/11169285/Documents/Opencode project/open-mem/extension
   ```

   Use the folder/path install action, not a Git URL. A path install reads the
   folder in place and watches it for rebuilds.
3. Approve the **service** capability. The service is a separate local Node
   process with your user rights; it only proxies the OpenMem API.
4. Open the console from the sidebar header actions → **扩展页面** →
   **OpenMem 控制台**.
5. Optional: the rail panel **OpenMem** and the chat Work Status section
   **OpenMem** appear after the extension is enabled.

If the extension does not appear, disable and re-enable it in
**Settings → Extensions**, or restart OpenChamber. Path installs do not
auto-update.

## Empty queue and demo data

A fresh install reads the real OpenMem data directory
(`~/.config/opencode/memory/autopilot`). If that directory has no pending
candidates, the panel and page correctly show **0 待审批 / 100 健康 / 队列为空**.
That is the real state, not a failed extension. Candidates appear after an
OpenCode session runs through the plugin and the queue receives items.

To exercise the UI with sample candidates **without touching real memory**, point
the extension service at the demo data directory:

```bash
# terminal 1 — demo backend on 47822 (writes tmp/harness-data)
plugin/node_modules/.bin/tsx plugin/src/cli.ts demo \
  --data tmp/harness-data --port 47822

# terminal 2 — give the service the demo port/token
node -e "const fs=require('fs');const d='tmp/harness-data';const t=fs.readFileSync(d+'/console-token','utf8').trim();fs.writeFileSync(d+'/config.json',JSON.stringify({port:47822,token:t},null,2)+'\n')"
```

Then create `data-dir.txt` **next to the installed `service/` folder** with the
absolute demo path. For a zip install that is
`~/.config/openchamber/extensions/openmem/data-dir.txt`; for a folder install it
is `<repo>/extension/data-dir.txt`. It contains one line:

```
/Users/11169285/Documents/Opencode project/open-mem/tmp/harness-data
```

Disable and re-enable the extension (or restart OpenChamber) so the service
restarts and reads the override. Delete `data-dir.txt` and disable/enable once
more to return to real data. The override is ignored when
`OPENMEM_DATA_DIR` is set.

## How it works

```
panel / page / status iframe
        │  serviceRequest (postMessage)
        ▼
OpenChamber host
        │  loopback HTTP
        ▼
extension/service/main.js  ──  Bearer token ──▶  127.0.0.1:47821
                                               (OpenMem plugin server)
```

- The plugin remains the **only** writer and the only HTTP server. The extension
  service never touches `items.jsonl`, `queue.json`, or the store.
- The service reads the token from
  `~/.config/opencode/memory/autopilot/console-token` (or `config.json`) and
  never sends it to the panel.
- The host limits every `serviceRequest` to **20 seconds**. `POST
  /api/queue/:id/suggest` and non-dry-run `POST /api/queue/batch` are therefore
  turned into service-side jobs: the service returns `202 {job}` immediately and
  the panel polls `/jobs/:id`. Jobs are deduplicated for 60 seconds, kept for
  5 minutes, and capped at 32.
- SSE is not available through the host proxy. The console polls: 5 seconds for
  queue/skills/audit/health, 20 seconds for map/settings and the header, and it
  stops while the frame is not visible.
- The service listens on `127.0.0.1` only and self-stops after 5 minutes without
  requests or pending jobs.

## Security notes

- The service runs with the user's full rights (OpenChamber services are not
  OS-sandboxed). Only install this folder if you trust its code.
- The panel never sees the OpenMem token; all API calls go through the host
  proxy and the service adds the Bearer header.
- The service only forwards `/api/*` to a fixed loopback origin. It does not
  accept arbitrary hosts, paths with `..`, or SSE.
- The extension does not change the console's network exposure. The OpenMem
  server still binds `127.0.0.1`; LAN/phone access is a separate feature and is
  not enabled by this extension.

## Known limits

- Web/desktop only; the phone app and VS Code do not load extensions.
- The proxy assumes OpenCode and OpenChamber run on the same host. A remote
  OpenChamber/VPS setup would proxy the server's `127.0.0.1`, not your laptop's.
- If another process holds port `47821`, the OpenMem plugin server cannot start;
  the extension shows a clear offline message instead of a blank console.
- Job results live in the service process. If it restarts, a panel can lose an
  in-flight suggestion; a refresh re-reads the queue and the underlying write
  still completes.
- The extension cannot open the full page from the rail panel; OpenChamber's
  sidebar **扩展页面** menu is the only page opener. This is a host SDK rule.

## Update and rollback

- **Update**: edit `console/` or `extension/src/`, run `npm run build:extension`.
  Path installs watch the folder and reload the frames; the service restarts on
  the next request. If the change does not show, disable/enable or restart.
- **Rollback**: **Settings → Extensions** → disable or remove **OpenMem**. The
  plugin, the standalone console, and the OpenMem data are untouched. Removing
  the extension folder is safe once it is uninstalled.

## Dev/test

```bash
node extension/test/service.test.mjs       # proxy, auth, job, offline
npm --prefix console run typecheck
npm run build:extension
```

A browser harness for the three surfaces lives in `extension/test/`:

```bash
# terminal 1: demo backend (writes tmp/harness-data)
plugin/node_modules/.bin/tsx plugin/src/cli.ts demo \
  --data tmp/harness-data --port 47822

# terminal 2: harness
node extension/test/host.mjs
# open http://127.0.0.1:47900/?surface=page&theme=light
```

Use `surface=panel|page|status`, `theme=light|dark`, and `chrome=0` for clean
screenshots. The harness is a test tool; it is not needed at runtime.
