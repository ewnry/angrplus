# Model configuration

Use **Settings → Models & Usage → Custom Models** in the standalone desktop app.
Older versions call this page **Models**. The editor and Import action validate
configuration and encrypt credentials before saving.

## Model files and import

Desktop models live at `~/.gemini/antigravity/custom_models.json`. Import accepts
a `models` object, a model array, or provider groups with inherited defaults, as
JSON or base64-encoded JSON. Existing internal names are updated; new names are
added. Provider-group defaults become independent model entries after import.

This secret-free example targets a local OpenAI-compatible server. Replace
`YOUR_LOCAL_MODEL_ID` with an ID returned by **Discover local** or your server:

```json
{
  "models": [
    {
      "name": "models/local-example",
      "displayName": "Local example",
      "provider": "lmstudio",
      "apiFormat": "openai",
      "apiUrl": "http://127.0.0.1:1234/v1",
      "apiKey": "",
      "externalModelName": "YOUR_LOCAL_MODEL_ID",
      "enabled": true,
      "contextWindow": 32768,
      "maxOutputTokens": 4096,
      "timeout": 120000,
      "maxRetries": 2
    }
  ]
}
```

Choose limits supported by your actual model. The example does not install a
server or download a model. A local server that requires authentication still
needs its own API key.

## Discover and select models

Select a provider, enter its key and endpoint, then choose **Fetch provider models**.
Search the returned catalog by model name or ID. **Select filtered** selects the
current matches; selections remain checked when you change the search. **Add
selected** saves all checked models, including selections outside the current filter.

When available, discovery imports each model's context/output limits and image
and reasoning metadata. Explicit values in **Advanced settings** take priority.
An output limit at least as large as the context is reduced to leave input room.
Missing metadata keeps the normal defaults; review limits and capabilities for
your chosen model. Discovery does not generate a completion or verify tool use.
See [providers and model catalogs](providers.md) for endpoints and service-specific details.

## Fields and advanced settings

Most fields are exposed under **Advanced settings**. Fields marked JSON/import
are supported in configuration but do not have a separate editor control.

| Field | Meaning |
| --- | --- |
| `name` | Unique saved identifier, normally `models/<name>`; used by fallback references. |
| `displayName`, `description` | Display label and optional description. |
| `provider` | Preset ID from [providers.ts](../src/providers.ts), including `custom` and `google-cloudcode`. |
| `apiFormat` | `openai`, `anthropic`, or `google`; determines wire format independently of the preset name. Cloud Code requires `google`. |
| `apiUrl`, `externalModelName` | HTTP(S) endpoint and exact upstream model ID. Do not embed credentials in URLs. |
| `apiKey` | Provider key; empty for a local endpoint without authentication. Saved values are masked. |
| `enabled` | Defaults to enabled; disabled models stay saved but leave the custom picker and fallback chain. |
| `reasoningEffort` | Optional `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`; sent for the OpenAI format when configured. Model support varies. |
| `thinkingBudget` | Nonnegative token budget for supported Google/Anthropic requests. For Anthropic, `0` disables thinking; otherwise use at least `1024` and less than the output limit. |
| `maxOutputTokens`, `contextWindow` | Positive token limits. If both exist, output must be smaller than context. Limits cannot enlarge the upstream model's capacity. |
| `timeout` | Per-attempt timeout in milliseconds; default `120000`. |
| `idleTimeout`, `retryBudgetMs` | JSON/import: idle timeout (default `30000`) and overall retry/fallback time budget. Without an override, the latter is at least `120000` or the configured timeout, whichever is larger. |
| `maxRetries` | Integer `0`–`5`, default `3`. Time budgets can stop attempts earlier. |
| `fallbackModels` | Ordered array of up to 20 saved internal names. The editor accepts a comma-separated list. |
| `circuitBreaker` | `enabled`, `failureThreshold`, `cooldownMs`; default threshold `3`, cooldown `30000` ms. |
| `customHeaders` | Object of string header values. Reserved transport headers and line breaks are rejected. |
| `extraBody` | Additional JSON request fields; cannot replace model/messages/contents/system/tools/stream routing fields. Ordinary exported configuration, not secret storage. |
| `rawUrl` | Use the exact request URL instead of protocol path normalization. |
| `supportsVision`, `supportsThinking` | Advertised capability overrides. Thinking capability is JSON/import; these flags do not add upstream capabilities. |
| `allowUnauthorized` | Disable certificate verification for this model only; leave false for normal endpoints. |
| `gateway` | JSON/import: marks an imported gateway route and forwards conversation identity for gateway sessions. Set automatically by **Import model aliases**. |
| `googleAccounts`, `googleProject`, `googlePool` | Cloud Code accounts, optional default project, and account-selection settings; see below. |

Timeout/budget fields accept `1`–`3600000` milliseconds. Context limiting uses a
conservative token estimate and removes whole oldest turns while preserving
supported tool exchanges. The proxy refuses a latest turn that still cannot fit.
Retries and fallback stop after output starts; they do not duplicate an already
streamed answer. Renaming/deleting a model updates its saved fallback references.

Old DeepSeek, Kimi, Fireworks, LM Studio, and llama.cpp entries without
`apiFormat` retain their historical Anthropic format. Select the intended format
explicitly when migrating a configuration.

## Gateway routes

Configure **Remote gateway** with the gateway URL, token, and dashboard URL.
**Test gateway** checks authenticated model listing; **Import model aliases**
adds routes using `provider: "google"`, `apiFormat: "google"`, and `gateway: true`.
Imported routes retain advertised context/output limits and image/thinking
capabilities. The default imported context window is `128000`; unspecified
image/thinking capabilities default to false. Re-import to refresh alias metadata.

The saved connection is `~/.gemini/antigravity/gateway_connection.json`. Changing
the gateway origin requires entering its token again. See the [gateway guide](../gateway/README.md)
for setup, network listeners, tunnels, and the gateway's separate configuration.

## Google Cloud Code account pools

Choose **Google Cloud Code account pool** and enter an available model ID. Add
an account before using **Fetch provider models**; discovery uses an enabled
account. The pool is separate from the application's vendor-managed sign-in.

1. Create your own Google OAuth client with application type **Desktop app** and configure consent/test users for your project. Enter its client ID and optional client secret under **Sign in with your OAuth client**.
2. Click **Sign in with Google**. This explicitly opens the browser using Google's [installed-app OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app), with PKCE, state validation, and a temporary loopback callback. The requested scope is `cloud-platform`. You can cancel; the login attempt times out after two minutes.
3. Save the model within **10 minutes**. Pending credentials remain in main-process memory until saved; the renderer receives masked fields. Repeat sign-in if an unsaved entry expires.
4. Alternatively, use **Import account credentials** for your own `authorized_user` JSON, an account object, or an array. Import itself makes no network requests. Save the model to retain the credentials encrypted.
5. Use **Test account** to check authorization and retrieve a quota snapshot. **Pool status** shows current state. Quota refresh is explicit, not periodic.

Each account has a unique stable `id`, optional `label`, `enabled`, `project`,
`clientId`, `clientSecret`, `refreshToken`, `accessToken`, and `expiresAt` (Unix
milliseconds). Up to 50 accounts are supported. Keep the ID unchanged when
editing masked credentials. Account `project` overrides `googleProject` when set.

`googlePool.strategy` accepts `round-robin`, `least-loaded`, or `quota`.
Remaining-quota selection uses the latest retrieved snapshot. Conversation
affinity can retain an eligible account. `maxConcurrency` is per account
(`1`–`100`, default `2`); `cooldownMs` defaults to `60000` and accepts
`1`–`3600000`. Access tokens refresh as needed; failed authorization and
cooldown/concurrency state can temporarily make an account unavailable.

No third-party OAuth client credentials are bundled, and no browser/IDE/gcloud
credentials are automatically extracted. Successful OAuth does not grant Cloud
Code entitlement, model access, or quota. Supply an eligible account/project;
Google's location and service-access decisions remain in effect.

## Credentials and data

Desktop API keys, custom-header values, saved gateway tokens, and Google
access/refresh tokens and client secrets are encrypted before persistence.
Electron `safeStorage` is preferred; otherwise AES-256-GCM uses a generated local
key at `~/.gemini/antigravity/.model-credentials-key`. Keep the key with private
backups. Machine-encrypted secrets are not portable configuration; enter fresh
credentials when moving to another machine or when decryption fails.

Saved secrets appear as `********`; leaving them unchanged preserves them on
the main-process side. Changing a provider or server origin requires fresh
credentials. **Export** removes API keys, all custom headers, and Google
access/refresh tokens and client secrets. It retains ordinary settings, account
labels/IDs, client IDs, and project names. Do not put secrets in `extraBody`, URLs,
descriptions, or other ordinary fields, and review exported metadata before sharing.

The optional gateway has a separate profile at `~/.gemini/antigravity/gateway`.
Its credential configuration does not use Electron `safeStorage`; its SQLite
history stores prompts, responses, tools, and replay snapshots. Consult
[gateway data handling](../gateway/README.md#lifecycle-and-data) before sharing
that profile. Desktop model Export does not export the gateway's database.
