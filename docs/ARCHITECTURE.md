# Architecture

Deep reference for coding agents. `AGENTS.md` has the rules and the task-to-file table; this file explains how the pieces actually fit. `README.md` remains the source of truth for features, deployment modes and environment variables.

Line numbers are deliberately sparse: `public/app.js` is about 19k lines and moves constantly. Grep the symbol names below.

## Runtime shapes

One client, three deployments:

| Shape | How it runs | Storage | Collab |
|---|---|---|---|
| Local | `node server.js` (or a packaged executable) | SQLite on disk, built-in accounts | No |
| Static | `public/` on any static host, typically `*.github.io` | The user's own private git forge repo, behind a token | No |
| Worker | `public/` as Cloudflare assets plus `worker/` | Forge repo plus worker rooms | Yes |

The client chooses at boot, not at build time.

## Client boot and mode selection

`public/index.html` loads four classic scripts with `defer`, in this order:

1. `templates.js` (defines top-level `TEMPLATES`, `TEMPLATE_CATEGORIES`)
2. `image-store.js` (defines `window.MSImageStore`)
3. `node-image.js` (defines `window.MSNodeImage`)
4. `app.js`

`app.js` then runs `initStore()`:

- `probeHealth()` fetches `healthz` relative to `document.baseURI`.
- `200` with `{"mode":"collab"}`: this origin is the collaboration backend, and `COLLAB.url` is set to the origin.
- Any other `2xx`: `MODE = 'server'`, `ServerStore` talks to the SQLite API.
- Network failure or non-2xx: cloud mode, `CloudStore.tryInit()`, login overlay for a forge token.

If `window.MINDSPARK_HOST` exists, it wins: `MODE = 'server'`, the host supplies `store`, `user`, `ready()`, `onError()`, `logout()` and optional `shareBase`, and the service worker is not registered. This is the documented embedding contract in `CONTRIBUTING.md`.

`proceedBoot()` / `_proceedBoot()` load or create a map, apply theme, look, style and UI layout, render once, then bind shortcuts and preferences. `showLoginOverlay()` reuses markup already present in `index.html`.

`READONLY` is the global write gate. Public `#view=` views and host-driven read-only states set it.

## Client subsystems (`public/app.js`)

| Subsystem | Key symbols |
|---|---|
| Full repaint | `render()`, `_nodeSignature`, `_nodeEls`, `_nodeSig`, `drawEdges()` |
| Viewport | `view = {x,y,k}`, `_stageSize`, `_stagePoint`, `positionPopup` |
| Tree index | `withChildIndex`, `childrenOf`, `_ci` |
| Layout dispatch | `layoutRunForMap`, `autoLayout` |
| Layout strategies | `layoutTree`, `layoutChain`, `layoutRadial`, `layoutGrid`, `layoutMatrix`, `layoutTreeTable` |
| Layout registries | `LAYOUT_PARAMS`, `ENGINE_PARAMS`, `BUILTIN_LAYOUTS`, `LAYOUT_CONFIG_DEFAULTS`, `CHAIN_LAYOUTS`, `TREE_LAYOUTS` |
| Node editing | selection (`sel`, `multiSel`), node CRUD, reparent, node toolbar |
| Undo | `pushHistory`, `restore`, `undo`, `redo`, `history`, `hpos` |
| Markdown mode | `toggleMdMode`, `syncTextFromMap`, `applyMdToMap`, `carryMarkdownIds`, `parseMarkdownOutline`, `buildMarkdown`, `mdToHtml` |
| Persistence | `scheduleSave`, `_runSave`, `flushPendingSave`, `hasUnsavedWork`, `_doCloudSave`, `cloudDiff`, `adoptCloudMerged` |
| Import / export | Markdown and Mermaid builders, `exportPNG`, `printOnly` |
| Prompts and LLM | prompt builder, token estimate, provider calls (Anthropic, OpenAI, OpenRouter, Groq) |
| Citations | Crossref lookup and reference rollup |
| Collaboration | `Collab`, `Session`, share links, access API, live ops |
| Presentation | `_pres`, `_deck` |
| Formulas | formula engine and autocomplete |
| Templates | `createMapFromTemplate`, consuming `TEMPLATES` |
| Themes / looks / styles / UI layouts | `THEMES`, `LOOKS`, `MAP_STYLES`, `UI_LAYOUTS` and their defaults |
| Preferences / shortcuts | `PREFS`, `shortcuts` |

`render()` is the single funnel for visual output: it measures once, then draws edges, positions the node bar, updates the minimap, breadcrumb and outline. New visuals hook into `render()` rather than starting an independent repaint loop.

Layout strategies are pure: they take the map plus parameters and return positions, with no DOM access. They are the best unit-test seam.

### State and naming

- `map` is the document; `view` is the viewport; `ui` is transient UI state.
- `_foo` means module-private global; it is not an API.
- `_nodeEls`, `_nodeSig`, `_ci` are render caches; do not read them outside rendering.
- `$` and `$$` are `querySelector` / `querySelectorAll`. `escapeHtml` must run before any user or model text reaches `innerHTML`.
- DOM ids live in `index.html`; renaming one means grepping both files.

### Registries

`THEMES`, `LOOKS`, `MAP_STYLES`, `UI_LAYOUTS`, `BUILTIN_LAYOUTS`, `PREFS`, `LAYOUT_PARAMS` and `ENGINE_PARAMS` are `const` registries. A capability is added by appending an entry and wiring the matching defaults object and CSS block. Registries are not mutated at runtime.

### Persistence rules

- `scheduleSave()` debounces; `_runSave()` is single-flight and coalesces concurrent saves.
- `flushPendingSave()` runs on unload and before switching maps.
- `CloudStore.save` writes a local backup first, merges `_index.json`, and guards the map path.
- A save conflict sets `ce.conflict` with "changed elsewhere" and is surfaced through `cloudDiff` / `adoptCloudMerged`. It is never auto-overwritten.
- `ServerStore` treats `401` as an expired session and calls `onUnauthorized`.

### Theme, look, style and layout data

`themes/README.md` and `layouts/README.md` are the schemas. In short:

- A theme is 20 CSS variables, validated by `validateCustomTheme()`.
- A layout is a strategy name plus parameters. It cannot carry code because it travels inside `#view=` links.
- A look or map style adds a CSS block and, when it draws, an entry in `LOOK_FX` or `CANVAS_FX`.

## Self-hosted server

`server.js` is a single `http.createServer` handler with a linear `if` chain over exact paths plus a few regexes. There is no router, middleware or framework.

The server is written for the origin root. A reverse proxy can strip a prefix for the normal app because client URLs are relative, but published `/public/<guid>` pages inject `<base href="/">` and assume the root. Static hosting has no such constraint.

### Request pipeline

1. Security headers on every response: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, CSP.
2. API branches (`/api/...`).
3. `uploads.handle(...)` for `/api/files` and `/files/`.
4. `/healthz` returns `{ok:true}`.
5. `/` and `GET /public/<guid>` serve `index.html`, with `<base href="/">` injected for the published page.
6. Static files from `PUBLIC`, with path-traversal protection, an mtime-keyed cache, weak ETags and gzip for compressible types over 1 KB.
7. Everything else is a JSON 404. There is no SPA catch-all; the client uses hash routing.

### Authentication

- Cookie `ms_session`, `HttpOnly`, `SameSite=Lax`, `Secure` only when `x-forwarded-proto` is `https`.
- Passwords are salted scrypt (`scrypt$<salt>$<hash>`) and compared in constant time.
- `ADMIN_USER` / `ADMIN_PASSWORD` create the bootstrap administrator on first boot. Later boots leave the live password alone unless `ADMIN_PASSWORD_RESET=1`.
- `SESSION_TTL_DAYS` defaults to 30.
- `requireAuth` returns `401`; `requireAdmin` returns `403` for a signed-in non-admin.
- Another user's map is a `404`, not a `403`, because map ids are owner-scoped. `DELETE /api/maps/:id` always returns `204`.
- `POST /api/import` accepts `IMPORT_TOKEN` bearer or a session cookie; token imports are owned by the bootstrap admin.

### SQLite schema

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, unique `username` (NOCASE), `password_hash`, `role`, `disabled` | |
| `sessions` | `token`, `user_id`, `expires` | Indexed by user |
| `maps` | `(owner_id, id)` primary key, `title`, `color`, `data`, `updated` | `data` is the full map JSON |
| `map_versions` | `(owner_id, id, ts)` primary key, `data` | Newest 100 listed, newest 50 kept |
| `publications` | `guid` primary key, `owner_id`, `map_id` | Read-only `/public/<guid>` |
| `uploads` | `name`, `owner_id`, `mime`, `size`, `sha256` | Files live in `data/uploads/` |

`upsert(m, ownerId)` updates or inserts, then records a version only when the serialized map changed. Versions inside a 60-second window are refined in place instead of creating one per autosave. Deleting a map removes its versions and publication.

To swap SQLite for another database, replace the `Q` prepared statements, `upsert()` and the schema blocks. The row shape is `(owner_id, id, title, color, data, updated)`.

### API surface

| Method | Path | Auth |
|---|---|---|
| `GET` | `/healthz` | public |
| `POST` | `/api/auth/login` | public |
| `POST` | `/api/auth/logout` | cookie |
| `GET` | `/api/auth/me` | cookie |
| `GET`, `POST` | `/api/admin/users` | admin |
| `GET`, `POST` | `/api/maps` | cookie |
| `GET`, `PUT`, `DELETE` | `/api/maps/:id` | cookie, owner |
| `GET` | `/api/maps/:id/versions`, `/versions/:ts` | cookie, owner |
| `GET`, `POST`, `DELETE` | `/api/maps/:id/publish` | cookie, owner |
| `GET` | `/api/public/:guid` | public |
| `POST` | `/api/import` | `IMPORT_TOKEN` or cookie |
| `POST` | `/api/files` | cookie |
| `GET` | `/files/:name` | public |
| `DELETE` | `/api/files/:name` | cookie, owner |

Uploads are capped at 8 MB, sniffed by magic bytes, and rejected when the declared `Content-Type` disagrees with the bytes.

### CSP copies

The policy exists in three places and `test/csp.test.mjs` compares them directive by directive:

1. `<meta>` in `public/index.html`
2. `public/_headers`
3. The header in `server.js`

The meta and `_headers` copies include the two Worker origins (`https://` and `wss://`); the server copy omits them because server mode never talks to the Worker. `frame-ancestors 'none'` exists in `_headers` and `server.js` but not in the meta, where the spec ignores it.

`EXTRA_CONNECT_SRC` appends validated origins to `connect-src` at runtime for self-hosted forges. It rewrites both the header and the served HTML meta.

### Packaging

`launcher.js` is the `bin` entry for `pkg`. When packaged it sets `MS_PUBLIC` inside the snapshot and `DB_PATH` next to the executable, waits for the server's `listening` event, then opens the browser unless `NO_BROWSER=1`. It handles `SIGINT` / `SIGTERM` with `process.exit(0)`.

`BUILD.md` is slightly stale where it says `PUBLIC`; the code uses `MS_PUBLIC`.

## Collaboration worker

The worker is optional and API-only. It serves no static assets.

| File | Role | Importable in tests |
|---|---|---|
| `worker/oauth-worker.js` | Worker entry: routing, OAuth callback, `/api/session`, `/api/import`, collab forwarding | No |
| `worker/collab-do.js` | `CollabRoom` Durable Object: WebSocket relay, presence, opaque snapshot storage | No (tests read its source as text) |
| `worker/collab-http.js` | Shared-room HTTP contract, ACL routing, PATCH ops, visitor log, socket auth helpers | Yes |
| `worker/auth-core.js` | HS256 JWT mint/verify and pure `authorizeRequest()` ACL decisions | Yes |
| `worker/import-core.js` | Map spec to gzip/base64url `#view=` link | Yes |

`auth-core.js` and `collab-http.js` must stay free of `cloudflare:*` imports so a companion backend can run them unmodified.

### Routing

- `/api/collab/*` forwards the whole request to one Durable Object per room (`idFromName(room)`). The DO applies CORS and authorization.
- `POST /api/session` verifies a GitHub token and mints a 12-hour HS256 JWT `{sub, login}`. Without `AUTH_SECRET` it answers `501`, and the client falls back to legacy capability links.
- `POST /api/import` turns a GPT map spec into a share link.
- `/callback` exchanges the GitHub OAuth code and posts the token to the opener.
- Anything else is a plain-text 404.

### Identity and ACL

An ACL is:

```js
{
  ownerId, ownerLogin,
  members: { "<subject>": { role: "editor" | "viewer", login } },
  linkAccess: "none" | "view" | "edit" | "view-auth" | "edit-auth"
}
```

`authorizeRequest()` maps `need` (`read`, `write`, `admin`) plus identity and `X-Edit-Token` to an allow/deny result. Rank is owner 3, editor 2, viewer 1. The important cases:

- No ACL plus an authenticated first `PUT` claims ownership. A signed-in stranger cannot claim a legacy token room without the token.
- `linkAccess: "edit"` allows anonymous writes; `"edit-auth"` requires an identity.
- `GET` and `PATCH` never claim; a socket never claims.
- `401` means no identity, `403` means a signed-in caller without access.
- Removing a member takes effect on the next request or message because the ACL is re-read; issued JWTs stay valid until expiry.

### Room HTTP contract

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/collab/<room>` | Read snapshot, record a signed-in visitor |
| `PUT` | `/api/collab/<room>` | Replace the snapshot; may claim ownership |
| `PATCH` | `/api/collab/<room>` | Apply `{ops:[...]}`; never claims |
| `GET`, `POST` | `/api/collab/<room>/acl` | Owner-only access list; add a member |
| `DELETE` | `/api/collab/<room>/acl/<id>` | Owner-only member removal |
| `POST` | `/api/collab/<room>/link` | Owner-only link mode |

Headers are `Authorization: Bearer <jwt>` and `X-Edit-Token: <token>`. `PUT` is last-write-wins. `PATCH` supports node upsert, node delete and meta writes; a meta write to `nodes` is ignored, and `__proto__`, `constructor` and `prototype` are rejected. The server stores node payloads opaquely; the client sanitizes them.

### WebSocket protocol

Identity rides as `?token=<jwt>` because a browser socket cannot set headers. The DO checks `read` at join and re-checks `write` per `snapshot` or `op`.

Client to server: `snapshot`, `name`, `op`, `cur`, `ping`. Server to client: `welcome`, `join`, `name`, `leave`, plus relayed `op`, `cur`, `ping`. Only those three types are relayed; `welcome`, `join` and `leave` are room-only, so a peer cannot forge them. A peer with write access can persist a `snapshot` over the socket; there is no size cap or acknowledgement.

### Import encoding

`buildMapFromSpec()` validates ids, uniqueness, root, parent links, cycles, markers and citation fields, then builds:

```js
{ v: 1, title, color, style, layout, rootId, nodes, links, vars: {} }
```

The token is `'g' + gzip + base64url`. It must stay byte-identical to the client's `_gzip` / `_b64urlFromBytes`, and the same builder exists in `server.js` for self-hosted `/api/import`. If `ALLOWED_ORIGIN` is unset, the returned URL has an empty origin.

### Companion backend contract

A backend can replace the worker if it serves the app same-origin and answers `GET /healthz` with `{"mode":"collab"}`. It must implement:

- `POST /api/session`: verify `{token, forge, instance}` against that forge and answer `{token, exp, id, login}`, or `501` to run without identities.
- `GET` / `PUT` / `PATCH /api/collab/<room>`: snapshot read, publish, merge; `X-Edit-Token` carries a capability token.
- Owner-only ACL routes and link mode.
- The WebSocket upgrade with the same message types, identity on `?token=`, `read` at join and `write` per snapshot or op.

Maps never reach the backend; the browser reads and writes the user's forge directly. The backend holds room state only. Discovery is same-origin on purpose, so a fork cannot be pointed at someone else's backend.

### Deploy

The app and the worker are two deploys:

```bash
npx wrangler deploy
npx wrangler deploy --config worker/wrangler.toml
npx wrangler secret put AUTH_SECRET --config worker/wrangler.toml
```

`wrangler.jsonc` serves `public/`. `worker/wrangler.toml` declares the `COLLAB` Durable Object binding and the `v1` SQLite migration. Secrets set without `--config` go to the app worker.

## Test suite

`npm test` runs 93 `node:test` files in separate processes. There is no framework and no dependency.

### Harness

`test/helpers/load-app-fns.mjs`:

- Reads `public/templates.js` and then `public/app.js` (the `CLIENT_FILES` list).
- `extractFunction(name)` finds a top-level `function` or `async function` and balances braces by trying candidate endings until the slice compiles.
- `extractConst(name)` does the same for a top-level `const`.
- `loadFns(names, deps)` evaluates the slices in one `new Function` factory, so the functions can call each other and receive stubbed globals.

It cannot lift arrow functions, function expressions, object or class methods, nested functions, generators, or files outside `CLIENT_FILES`. A missing name fails at module load. This is why renaming a tested function breaks tests immediately, and why tests exercise shipped code rather than a copy.

`test/helpers/css-audit.mjs` parses the real stylesheet, computes specificity, resolves variables and `color-mix`, and scores contrast. It is used by the theme, look and shell tests. It does not run a browser.

### Themes of tests

| Theme | Representative files |
|---|---|
| Layout engines and schema | `tree-layout`, `chain-layout`, `treetable`, `layout-strategy`, `layout-presets`, `layout-library`, `timeline-layout` |
| Shell, geometry and UI placement | `shell-grid-placement`, `zen-topbar`, `topbar-overflow`, `minimal-menu-placement`, `outline-render`, `split-resize` |
| Markdown and input | `markdown-roundtrip`, `markdown-identity`, `markdown-meta-reattach`, `md-preview-scrub`, `ime-composition` |
| Themes, looks and CSS invariants | `color-contrast`, `theme-css-json-parity`, `theme-library`, `looks-registry`, `css-vars-defined` |
| Security and untrusted input | `csp`, `xss-sinks`, `map-ingress`, `tree-integrity`, `import-core`, `auth-core` |
| Server, uploads and storage | `server-http`, `uploads`, `hosted-store`, `image-store`, `sw-cache-policy` |
| Forges, auth and collaboration | `forge-adapters`, `cloudstore-requests`, `collab-backend-discovery`, `collab-socket-identity`, `oauth-pkce` |
| Import, export and portability | `freemind-import`, `markers`, `demo-export`, `print-map` |
| UI regressions and data loss | `data-loss-guards`, `save-conflict-ui`, `undo-settings`, `visible-fixes`, `image-drop` |
| Registries and LLM | `prefs-registry`, `task-presets`, `templates-thinking`, `llm-providers` |
| Pure utilities | `app-pure`, `color-picker`, `link-favicons` |

`server-http` and `uploads` spawn the real server with a temporary `DB_PATH` and a random port. `cloudstore-requests`, `image-store`, `sw-cache-policy` and `hosted-store` use `vm` contexts with stubbed fetch, storage and DOM.

### Golden fixtures

`test/fixtures/tree-layout-golden.json` and `chain-layout-golden.json` pin exact coordinates for several shapes. Nothing regenerates them. Any coordinate change is a failure unless the geometry change is intentional and justified.

### Not covered

Real browser layout, drag and drop, canvas pixels, animation, OAuth popups, WebSocket runtime, IME, accessibility and cross-browser behavior are not covered. Tests state this in their header comments, and `CONTRIBUTING.md` asks contributors to say so in the PR rather than fake coverage.

## Known drift and sharp edges

- `worker/README.md` predates collaboration: it covers OAuth and `/api/import` only. The root README's companion-backend section is authoritative.
- Root README says the collab surface is documented in `worker/README.md`; it is not.
- `/api/session` accepts `forge` and `instance` from the client but ignores them and always verifies GitHub.
- The shipped worker mints bare GitHub ids (`sub: "583231"`); companion backends may namespace subjects (`gitlab:host:7`). ACLs are keyed by the minted string, so switching backends can orphan ACLs.
- `auth-core.js` comments say a claimed token room defaults to `linkAccess: "edit"`, but the code sets `"edit-auth"`, so old links require sign-in after a claim.
- Once an ACL exists, `X-Edit-Token` no longer grants anything; only owner/member rank and link mode count.
- `PATCH` cannot create the first snapshot on an empty room; the first write must be `PUT`.
- An anonymous `PUT` without a token leaves no capability behind, so a later anonymous `PATCH` is denied.
- `DELETE /api/collab/<room>/acl/<id>` does not guard `decodeURIComponent`, so a malformed escape becomes a 500.
- JWT verification checks HMAC and `exp` only: no `iss`, `aud`, `nbf` or header-alg check, and a payload can override `exp`.
- There is no JWT revocation list. Rotating `AUTH_SECRET` invalidates every issued token.
- CORS defaults to `*` when `ALLOWED_ORIGIN` is unset, including the OAuth `postMessage` target.
- The Durable Object checks `Upgrade` case-sensitively (`websocket`), so `WebSocket` is treated as a plain HTTP request.
- Socket `snapshot` payloads are stored opaquely with no validation, size cap or acknowledgement.
- `BUILD.md` still describes `PUBLIC`; the launcher and server use `MS_PUBLIC`.
