# AGENTS.md

MindSpark is an open-source mind-mapping app with zero runtime dependencies: a vanilla-JS client in `public/`, an optional Node 22 + SQLite server in `server.js`, and an optional Cloudflare Worker in `worker/` for OAuth, sharing and live collaboration. The same client ships in three shapes (local server, static Pages, Worker) and picks its storage backend at boot by probing `/healthz`.

This is the working guide for coding agents. `README.md` explains features and deployment, `CONTRIBUTING.md` explains contribution rules, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the deep reference: client subsystems, server routes and schema, worker contracts, test map. Read the deep reference before changing a subsystem you have not touched before.

## Commands

| What | Command |
|---|---|
| Run locally | `ADMIN_PASSWORD=change-me npm start` (or `node --disable-warning=ExperimentalWarning server.js`) |
| Dev with reload | `npm run dev` |
| All tests | `npm test` |
| One test file | `node --test test/<name>.test.mjs` |
| One test case | `node --test --test-name-pattern="..." test/<name>.test.mjs` |
| Syntax check | `node --check <file.js>` |
| Build executables | `npm run build:win`, `build:mac`, `build:linux` |
| Deploy static app | `npx wrangler deploy` |
| Deploy collab worker | `npx wrangler deploy --config worker/wrangler.toml` |

There is no install step, no bundler, no linter and no formatter. `npm install` only fetches dev tools (`pkg`, `wrangler`). The server creates `data/mindspark.db` on first boot.

## Ground rules

1. **Zero runtime dependencies.** The client is hand-written classic script, the server uses only Node built-ins (`node:http`, `node:sqlite`, `node:crypto`), and the worker uses the Cloudflare runtime. Dev-only dependencies are acceptable; a runtime one needs a strong argument.
2. **No em dash (U+2014) in any tracked source or doc file.** CI rejects it in code, Markdown, HTML, CSS, JSON, YAML and TOML.
3. **No build step and no client modules.** `public/*.js` are loaded with `defer` as classic scripts. `templates.js` must load before `app.js` because `TEMPLATES` and `TEMPLATE_CATEGORIES` are top-level `const`. No `import`, `export` or top-level `await` in `public/`.
4. **Match the surrounding style.** There is no formatter, and many tests slice source files by exact text. Do not reformat unrelated lines.
5. **Empty `catch(e){}` needs a reason.** Allowed for best-effort storage writes, DOM teardown and cosmetic work. Anything that can lose work, leave local and remote state disagreeing, or make a user click do nothing must `console.warn`, and usually `toast()` too. The policy is documented at the top of `public/app.js`.
6. **Undoable mutations call `pushHistory()` before touching `map`.** There is no automatic diffing.
7. **Saves go through `scheduleSave()` and `flushPendingSave()`.** `_runSave` is single-flight; calling `Store.save()` directly bypasses the queue and can interleave with autosave. A cloud conflict is reported, never auto-overwritten.
8. **Respect `READONLY`.** Public `#view=` pages are read-only; new mutation paths must check the gate.
9. **Layouts are data, never code.** A layout is a strategy name plus parameters and travels inside every `#view=` share link. Themes are CSS variables. Looks and map styles may add CSS and a registered painter (`LOOK_FX`, `CANVAS_FX`), but imported JSON never carries executable code.
10. **Every fetch target must be in all three CSP copies** (`public/index.html`, `public/_headers`, `server.js`). Worker origins are also listed in `WORKER_ONLY` in `test/csp.test.mjs`.
11. **Keep the two import builders identical.** `buildMapFromSpec` in `server.js` and `worker/import-core.js` must stay field-for-field equal; `test/server-http.test.mjs` checks parity.
12. **Worker relay allowlist.** Only `op`, `cur` and `ping` are relayed between peers. A `meta` op must never replace `nodes`. A socket never claims ownership; only the first authenticated `PUT` does. Without `AUTH_SECRET`, `/api/session` answers `501` and legacy capability links keep working.
13. **Two separate Worker deploys.** `npx wrangler deploy` ships `public/`; `npx wrangler deploy --config worker/wrangler.toml` ships the API/Durable Object worker. Secrets must be set with `--config worker/wrangler.toml` or they land on the wrong worker.

## Repo map

| Path | What it is |
|---|---|
| `public/app.js` | The whole client: storage, canvas, layout, Markdown mode, undo, themes, prompts, collab. Plain script, roughly 19k lines. |
| `public/templates.js` | Template data (`TEMPLATES`, `TEMPLATE_CATEGORIES`), loaded before `app.js`. |
| `public/image-store.js`, `public/node-image.js` | `window.MSImageStore` (server-only uploads) and `window.MSNodeImage` (node badges). |
| `public/styles.css` | All styling, themes, looks and UI layouts. |
| `public/sw.js` | Service worker (offline shell cache). |
| `server.js` | Zero-dependency HTTP + SQLite API, auth, publishing, static serving, CSP header. |
| `uploads.js` | Image upload, magic-byte sniffing, serving, owner-scoped delete. |
| `launcher.js` | Packaged-executable entry: browser open, pkg path overrides. |
| `worker/` | Optional Cloudflare Worker: OAuth, identity JWTs, shared rooms, Durable Object relay, GPT import. |
| `test/` | 93 `node:test` files, 2 helpers, 2 golden fixtures. No framework, no dependencies. |
| `themes/`, `layouts/` | Reference JSON palettes and layout presets, documented in their own READMEs. |
| `.github/workflows/` | CI, static Pages deploy, release container build. |

## Boot in one screen

1. `public/index.html` loads `templates.js`, `image-store.js`, `node-image.js`, `app.js`, all deferred, in that order.
2. `initStore()` probes `healthz`:
   - `{"mode":"collab"}`: the same origin is the collaboration backend.
   - Any other 2xx: `ServerStore` over the self-hosted SQLite API.
   - No answer: `CloudStore`, which stores maps in the user's own git forge repo behind a token.
3. `window.MINDSPARK_HOST` forces server mode, supplies the store and disables the service worker.
4. `proceedBoot()` loads or creates a map, applies theme, look, style and UI layout, renders, then binds shortcuts and preferences.
5. Autosave is debounced, single-flight and flushed on unload. Cloud saves write a local backup first and merge the index.

The document is `map = { id, title, color, rootId, nodes }`. Node ids are strings; `parent` links form the tree; `x`, `y` and `side` are derived by layout.

## Where to change what

| Task | Touch |
|---|---|
| New theme | `THEMES` and `THEME_CONFIG_DEFAULTS` in `app.js`, `:root[data-theme="..."]` in `styles.css`, optional `themes/<id>.json`. Tests: `theme-css-json-parity`, `theme-library`, `color-contrast`. |
| New look | `LOOKS`, `LOOK_CONFIG_DEFAULTS`, `LOOK_FX`, `:root[data-look="..."]` CSS. Tests: `looks-registry`, `look-config`. |
| New map style | `MAP_STYLES`, `STYLE_CONFIG_DEFAULTS`, `CANVAS_FX`. Tests: `style-config`, `organic-style`. |
| New layout strategy | `LAYOUT_PARAMS`, `ENGINE_PARAMS`, `BUILTIN_LAYOUTS`, dispatch in `layoutRunForMap`, at least one `layouts/*.json`. Also the hardcoded `ENGINES` map in `test/layout-library.test.mjs`. |
| New UI layout | `UI_LAYOUTS`, `applyUiLayout`, `body.ui-*` CSS, `LAYOUT_CLASSES` in `test/shell-grid-placement.test.mjs`. |
| New template | `TEMPLATES` and `TEMPLATE_CATEGORIES` in `public/templates.js`. Test: `templates-thinking`. |
| New preference | `PREFS` plus its apply handler. Test: `prefs-registry` (every `mindspark:` key needs a row). |
| New shortcut | `shortcuts` in `app.js`. |
| New LLM provider or fetch host | The prompt region in `app.js` plus all three CSP copies. Test: `csp`. |
| New export format | The export region in `app.js`; add a test when the output is text or structure. |
| New forge | One full descriptor in `FORGES`, pane markup and `SELF_HOSTED_PANES`, the forge origin in all three CSP copies, and `test/forge-adapters.test.mjs`. |
| New server route | The `if` chain in `server.js`, the API table in `README.md`, and `test/server-http.test.mjs`. |
| New worker route | `worker/oauth-worker.js`, the contract in `README.md`, and a worker test. Keep `auth-core.js` and `collab-http.js` free of `cloudflare:*` imports. |
| New client script | A `<script defer>` in `index.html` in load order, plus `CLIENT_FILES` in `test/helpers/load-app-fns.mjs` if tests need to lift from it. |

## Testing

- `npm test` runs every `test/*.test.mjs`. Start with the affected file, then run the full suite for cross-cutting changes.
- `test/helpers/load-app-fns.mjs` lifts **top-level** `function` and `async function` declarations and top-level `const` values from `public/templates.js` and `public/app.js`, then evaluates them in a `new Function` factory. Write new pure helpers as top-level declarations, not arrow functions or object methods. Renaming or deleting a lifted function fails at import time by design; update the test name instead of working around the harness.
- The suite has no dependencies and no DOM emulator. DOM, fetch, timers and `vm` stubs are local to each test. Do not add jsdom, Playwright or any test dependency.
- Layout output is pinned by golden fixtures: `test/fixtures/tree-layout-golden.json` and `chain-layout-golden.json`. Nothing regenerates them; change them only for an intentional geometry change, with justification.
- Real-browser behavior (grid layout, drag, canvas pixels, animation, OAuth popups, IME) is not covered. State the manual check in the PR instead of faking coverage.
- CI runs `npm test`, `node --check` on every tracked `.js` and `.mjs`, the no-em-dash check, YAML validation under `.github/`, and a smoke boot that asserts `/`, `/app.js`, `/styles.css` and `/api/maps` return 200.

## Traps

- **Line numbers rot.** Comments and docs contain `app.js:1234` hints; grep the symbol first, then read around it.
- **`worker/README.md` is stale.** It documents OAuth and `/api/import` only. The "Companion backend" section of the root `README.md` is authoritative for collaboration.
- **`/api/session` ignores `forge` and `instance`.** The shipped worker always verifies against `api.github.com`. A companion backend must verify against the forge it was given.
- **`MS_PUBLIC`, not `PUBLIC`.** Windows sets `PUBLIC=C:\Users\Public` for every process. The server honours legacy `PUBLIC` only when it is not that path; packaged builds set `MS_PUBLIC`.
- **Sub-path hosting is only partly supported.** Routes are exact and the published page injects `<base href="/">`. A reverse proxy can strip a `/mindspark/` prefix for the normal app, but published `/public/<guid>` links assume the origin root. Static hosting has no such constraint because every client URL is relative. Test both if you mount the Node server under a prefix.
- **Two kinds of share link.** `#view=` carries the whole gzipped map in the URL and is read-only. `#shared=` points at a live room and supports editing, collaboration and access control.
- **Service worker policy.** It never caches `/api/`, `/files/`, `healthz` or cross-origin requests. Bump `CACHE` in `public/sw.js` when shell assets change, or stale `app.js` is served.
- **Runtime data is ignored.** `data/` (SQLite plus `uploads/`) is created at boot and gitignored.
- **Source-slice tests.** Some tests locate code by exact strings such as `const FORGES = {`, `const CloudStore = {`, `let Store;` or a CSS block. Changing those anchors or reformatting the block fails tests.

## Before you call it done

- [ ] `npm test` passes, or the affected files pass and any pre-existing failure is named.
- [ ] `node --check` passes on every changed `.js` / `.mjs` file.
- [ ] No U+2014 anywhere in the diff.
- [ ] If a registry grew (theme, look, layout, pref, forge, provider, script), the matching test list and CSP copies were updated.
- [ ] If server routes or startup changed, the server boots with a temp `DB_PATH` and `/`, `/app.js`, `/styles.css`, `/api/maps` answer 200.
- [ ] If the change needs a real browser, the manual check is written down.
- [ ] Nothing was committed unless the user asked.
