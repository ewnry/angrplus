# Feature comparison and integration boundaries

This comparison covers the desktop addon, provider proxy, web dashboard, and
remote provider connection. It compares source behavior at the revisions below,
not features inferred from repository names or screenshots. Mobile clients,
hosted cloud agents, and a remote computer-control daemon are separate products.

## Audited revisions and licensing

| Reference | Pinned revision | Source license | Integration approach |
| --- | --- | --- | --- |
| [12errh/antigravity-proxy](https://github.com/12errh/antigravity-proxy/tree/457d0490ffdca79cce99b4c0acfb059aa83426b9) | `457d0490ffdca79cce99b4c0acfb059aa83426b9` | MIT | Adapt routing, provider, dashboard, history, context, and utility components into the optional gateway; retain [upstream notices](../gateway/UPSTREAM.md). |
| [Aminetwiti/antigravity-patch-proxy-remote](https://github.com/Aminetwiti/antigravity-patch-proxy-remote/tree/662e5a4a48f02ba541e324b3d35b286ce1e9823e) | `662e5a4a48f02ba541e324b3d35b286ce1e9823e` | Apache-2.0 | Read model/proxy/Doctor/OAuth source to identify desktop features; implement them through this project's existing addon rather than replacing its installed runtime. |

Relevant remote-reference source includes `src/proxy/modelLoader.ts`,
`src/proxy.ts`, `src/services/googleAuth.ts`,
`ag-doctor-ui/src/services/googleOAuthServer.ts`, and its account-discovery
services. These show that OAuth, quota, and account pooling are desktop proxy
features independent of the repository's Go remote daemon. The Go `/v2`
workspace/session/terminal APIs and mobile clients are a separate runtime.

## Desktop model and request features

| Feature found in the references | Integrated behavior | Implementation / boundary |
| --- | --- | --- |
| Multiple providers and models | Available | Shared [provider catalog](../src/providers.ts), model store, Settings editor. |
| Provider groups and enable/disable | Available | Models group by provider and endpoint; group and individual enable actions preserve saved credentials. Storage remains a flat model list. |
| Provider-level shared defaults | Import and discovery supported | Provider-group imports inherit defaults; discovered models copy settings. Later model edits are independent; this is not a live shared provider-credential object. |
| Edit, duplicate, rename, delete | Available | Main-process updates preserve masked credentials; duplicate uses the source model's saved secret. |
| Provider model discovery | Available | Live model catalogs with search, filtered bulk selection, available capability/limit metadata, and provider-specific pagination. See [provider setup](providers.md). |
| Local server discovery | Available on request | Common ports for Ollama, LM Studio, llama.cpp, vLLM, LocalAI, TabbyAPI, Text Generation WebUI, LiteLLM, and Aphrodite. No background network scan. |
| JSON/base64 import and export | Available | Flat arrays, `models`, and provider-group inputs; export removes API keys, custom headers, and Google tokens/client secrets. Import validates before writing. |
| OpenAI, Anthropic, Gemini protocols | Available | Explicit `apiFormat` selects translation independently from preset branding; old entries retain their historical format when no override exists. |
| Provider presets including local and custom services | Available | Catalog covers the desktop presets; actual model availability is discovered or configured, not promised by static examples. |
| Raw endpoint, custom headers, extra JSON fields | Available | Advanced settings expose `rawUrl`, `customHeaders`, `extraBody`; headers are encrypted and removed from export. `extraBody` is ordinary configuration and should not contain secrets. |
| Reasoning/thinking, output/context limits, vision | Available | Explicit model overrides; support depends on protocol/model. Context limits cannot enlarge the provider's actual context window. |
| Retries, fallback chain, circuit breaker | Available | One request owner applies retry/fallback rules, respects cancellation, and does not retry after output is delivered. Disabled and duplicate fallback entries are skipped. |
| Streaming/tool compatibility and empty/idle protection | Available | Request-scoped translator state, fragmented SSE handling, empty-stream checks, idle timeout, and tool argument validation. |
| Health/usage diagnostics | Available across two components | Desktop loopback `/health` and aggregate `/metrics`; gateway dashboard provides request history, usage and cost estimates. Counters are not a billing ledger. |
| Modern Settings reinjection | Available | Works with the Models & Usage content container and legacy Models/MCP anchor; handles pane replacement without a URL change. Vendor preload APIs are preserved. |
| Doctor diagnostics and repair | Available as CLI | Read-only `npm run doctor`, installer preflight, transactional `doctor:repair` / `patch:restore`. The reference's separate Doctor Electron application is not bundled. |

See [customPreload.ts](../src/customPreload.ts),
[modelManagement.ts](../src/modelManagement.ts),
[modelStore.ts](../src/modelStore.ts), and
[customRequest.ts](../src/proxy/customRequest.ts).

## Google account management

| Reference feature | Integrated behavior | Difference or requirement |
| --- | --- | --- |
| Browser OAuth sign-in | Available on explicit action | User supplies their own Google Desktop OAuth client. No OAuth client ID/secret copied from the reference is bundled. PKCE, state, temporary random loopback port, cancellation, and timeout are implemented. |
| Account JSON import / editing | Available | Import your own `authorized_user` JSON or account arrays. No automatic extraction of browser, IDE, or gcloud credentials. |
| Secure persistence and masked UI | Available | OAuth results remain in main-process memory until model save; unsaved pending entries expire after 10 minutes. Saved credentials use OS `safeStorage` or local AES-256-GCM. |
| Access-token refresh | Available | Refreshes as needed; concurrent refreshes share the same pending operation; updated credentials can persist encrypted. |
| Multiple account selection | Available | Round robin, least loaded, or latest remaining quota; eligible-account conversation affinity, concurrency limits, failure cooldown, and authentication state. The reference's latency/P2C scoring is not duplicated exactly. |
| Quota retrieval / display | Available on request | **Test account** retrieves a quota snapshot, and **Pool status** displays it. The reference's periodic three-minute quota polling is not enabled; quota is refreshed explicitly. |
| Service/project eligibility | Provider-controlled | OAuth success alone does not grant Cloud Code access or quota. Supply an eligible account/project where required; region and entitlement failures remain visible. |

See [googleOAuth.ts](../src/googleOAuth.ts),
[googleAccounts.ts](../src/googleAccounts.ts), and the
[Google account workflow](configuration.md#google-cloud-code-account-pools).

## Optional gateway and web dashboard

The gateway is an independently started Node process. It receives native Gemini
JSON or SSE requests from the desktop addon, translates/routes them upstream, and
stores its own history. It requires Node.js 22.13 or newer for built-in SQLite.

| Feature from `12errh/antigravity-proxy` | Integration |
| --- | --- |
| Provider priorities and model/provider fallback mapping | Retained in the dashboard and routing configuration. |
| Custom provider endpoints and live model discovery | Retained; keys and endpoints belong to the gateway's local profile. |
| OpenAI chat, Anthropic messages, Gemini, OpenCode Zen/Go protocols | Retained provider adapters; OpenCode Responses routing is available in the gateway. |
| Local model service discovery | Retained, explicitly initiated. |
| Reasoning settings and model context windows | Retained and editable. |
| Context strip/lite modes and LLM compaction | Retained, opt-in. Compaction performs an additional provider request; context passes through unchanged by default. |
| Request history, search, replay, sessions | Retained using SQLite; prompts, responses, and tool arguments are stored. Delete requests/sessions from the dashboard when appropriate. |
| Usage, charts, pricing overrides | Retained; charts are bundled for offline use. Token/cost totals are estimates, and bundled price/model tables can become stale. |
| Blocklists, rate limits, failover webhooks | Retained; configure them explicitly in the dashboard. |
| Dashboard configuration reload | Retained after saving; listener address/port changes require restart. |
| Setup, status, logs, start/stop lifecycle | Added a scoped CLI for the optional gateway; it manages its own process only. |
| OS TLS interception / custom certificate / hosts edits | Not used. The desktop's existing addon sends directly to the gateway HTTP interface. No global certificate or DNS change is required. |
| Launching or force-stopping Antigravity | Not used. Gateway lifecycle does not control the vendor application. |

The gateway requires an access token for models/generation and separate dashboard
login. Both listeners bind to loopback by default. A tunnel or explicitly enabled
network listener provides remote provider access; HTTP network listeners need a
trusted encrypted transport when traffic leaves a trusted local network.
See [gateway/README.md](../gateway/README.md) for exact commands, endpoints, and
configuration, and [gateway/UPSTREAM.md](../gateway/UPSTREAM.md) for attribution.

## Remote and platform boundaries

| Capability | Status |
| --- | --- |
| Connect desktop custom models to a remote gateway | Available: save URL/token/dashboard URL, authenticate, import aliases, open dashboard. |
| Use gateway from another HTTP client | Available through authenticated native Gemini generation/model APIs. |
| Web request-history sessions | Available in the gateway; these represent provider requests. |
| Go remote daemon workspaces, terminal, filesystem, live agent sessions / MCP relay | Outside this integration; those `/v2` APIs are not implemented by the gateway. |
| Mobile/Flutter clients and hosted cloud-agent scheduling | Outside this desktop/proxy/web/remote-provider scope. |
| Existing standalone app WSL bridge | Preserved from the installed vendor runtime. Custom-model routing still applies only to local desktop sessions; it does not reroute the vendor's WSL language server. |
| Separate VS Code-based Antigravity IDE | Unsupported layout; detected before deployment. This patch targets the standalone Electron desktop agent. |
| Recovery after supported desktop updates | Version-specific preflight, backups, validated hooks, and rollback; unfamiliar runtime layouts fail before replacement. |

The transport choice is deliberate: preserving the installed desktop runtime
avoids replacing newer WSL, certificate, updater, and host-bridge behavior with
older source snapshots. See [compatibility and recovery](compatibility.md).

## Verification

```sh
npm run build
npm run gateway:install
npm run gateway:build
npm test
npm run gateway:test
npm run test:integration
```

DOM fixtures verify grouping, edit/duplicate/enable flows, masked secrets,
discovery, export/import, gateway actions, account controls, OAuth cancellation,
and reinjection. OAuth tests drive the loopback callback with an injected token
exchange to check PKCE/state, rejection, timeout, and cleanup. Provider/gateway
tests use local HTTP fixtures for streaming, retries, fallback, authentication,
history, and lifecycle. Installer tests use copied fixtures rather than changing
the live installation.

These tests do not establish paid-provider access, real Google account
entitlement, or compatibility with every future desktop release. Such checks
require the intended user credentials and installed runtime. Static catalog
entries are configurable defaults, not a statement that a provider/model is
currently available.
