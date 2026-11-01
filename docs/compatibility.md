# Compatibility and recovery

## Desktop agent and VS Code-based IDE are different applications

This patch targets the standalone Electron desktop agent: `Resources/app.asar`
with a `dist/main.js` entry point and `dist/preload.js`. The installer preserves
the installed application's runtime and adds custom-model modules under
`dist/modelPatch`. It validates three integration hooks before changing files:
desktop startup, language-server endpoint arguments, and the preload addon.
An unfamiliar runtime fails preflight with `UNSUPPORTED_RUNTIME`.

The separate Antigravity IDE uses an unpacked `Resources/app/out` tree (or an
archive with an `out/main.js` entry point), a VS Code workbench, and a different
language-server integration. Copying this project's `dist` directory into it
does not load the proxy or add a settings dashboard. The installer detects that
layout and exits with `NOT_SUPPORTED` before modifying application files.
[Issue #2](https://github.com/vahapogut/antigravity-add-model/issues/2) remains the
tracking issue for an actual IDE adapter. macOS IDE 2.1.1 support has not been
implemented or validated.

| Installation | Current behavior |
| --- | --- |
| Standalone Electron `app.asar`, entry `dist/main.js` | Validated runtime hooks; vendor APIs, certificate handling, updater and window code are retained |
| Standalone Windows app connected to WSL | Vendor WSL behavior is retained; custom-model proxy routing applies only to local sessions |
| Unpacked IDE `app/out`, including macOS `Antigravity IDE.app` | Refused without changing the application |
| Archived IDE with an `out/main.js` entry point | Refused without changing the application |
| Missing or unrecognized application layout | Explicit error; no success message |

A matching layout and version number are not a guarantee of compatibility with
every future Antigravity release. CI uses controlled Electron mocks and synthetic
ASAR packages; it does not log in to Google. CI includes macOS for filesystem
behavior, not proof of macOS IDE model generation, signing, or UI support.

## Black screen after an update

[Issue #1](https://github.com/vahapogut/antigravity-add-model/issues/1) reports
startup failures on newer desktop builds, including a recurrence in
[2.17.0](https://github.com/vahapogut/antigravity-add-model/issues/1#issuecomment-5874214374).
The old installer replaced the complete desktop runtime with this repository's
older copy. The official 2.17.0 package adds a `wsl` renderer bridge and changes
local language-server certificate handling. Replacing its preload/main/server
files loses those changes and can prevent the UI from starting. In an isolated
Windows test using the official 2.17.0 executable and language server, the old
overlay reproduced `ERR_CERT_AUTHORITY_INVALID` / main-frame load error `-202`;
both the pristine vendor runtime and the new additive patch loaded the local UI
successfully under the same conditions. The patched run started its proxy without
certificate, main-frame load, or preload errors. The test used an isolated profile,
blocked external traffic, and disabled update installation, protocol registration,
and external browser opening in its harness. It did not sign in to Google or
verify authenticated model listing/generation. The official Linux 2.17.0 archive
also passed runtime-hook validation; Linux/macOS GUI launches were not tested.

Deployment now retains the vendor preload (including every exposed bridge), IPC
handlers, WSL and host-bridge integration, certificate policy, updater, and window
settings. The custom UI is appended in its own scope without re-exposing vendor
globals; proxy startup and endpoint changes are inserted only at validated hooks.
The local proxy is bypassed in WSL sessions, where Windows loopback is not a
reliable route to the host from the Linux server. Custom-model generation in WSL
is not supported by this patch.

The earlier
[contribution #3](https://github.com/vahapogut/antigravity-add-model/pull/3), by
Beshoy-Sorial, identifies a missing `electronUpdater.getState()` call in 2.12.2.
Those legacy compatibility sources remain in the repository, but the installer
now uses the APIs shipped with the installed application instead of replacing them.

The model-response wrappers leave protocol-framed/non-JSON responses unchanged
and preserve XHR event ordering. These wrappers run in an Electron preload; they
are not evidence that the separate VS Code workbench is supported.

Older deploy scripts reused `app.asar.backup` indefinitely, even after an upstream
update. That could reinstall an old archive alongside newer external resources
and language-server binaries. Deployment now starts from the current archive,
preserves vendor files, builds and verifies a candidate before replacement,
and restores the previous files if a replacement fails. Legacy `.backup` and
`.bak` files are not automatically restored.

## Install, check, and restore

Use Node.js **22.12.0 or newer** (required by the pinned ASAR tool), then:

```sh
npm ci --ignore-scripts
npm run build
node scripts/deploy.mjs --check
```

Quit the standalone app and its language server before deployment. The installer
does not terminate processes, launch applications, or disable automatic updates.
All platform wrappers accept the same arguments:

```powershell
# Windows
.\deploy.ps1 --check --patch-language-server
.\deploy.ps1 --patch-language-server
```

```sh
# macOS standalone desktop agent
bash deploy.sh --check --resources "/Applications/Antigravity.app"
bash deploy.sh --resources "/Applications/Antigravity.app"

# Linux
bash deploy_linux.sh --check --resources /opt/antigravity/resources
bash deploy_linux.sh --resources /opt/antigravity/resources
```

`--resources` accepts a Resources directory, an installation root, or a macOS
`.app` directory. `--check` performs preflight only. Reopen the application
manually after a successful deployment.

The installer keeps version/fingerprint-specific restore data in
`Resources/.antigravity-model-patch`. To undo its last deployment:

```sh
node scripts/deploy.mjs --restore --resources "/path/to/Resources"
```

Restore refuses to overwrite application files that changed after deployment,
including an upstream update. It does not restore an arbitrary old release over
the new one. Keep the restore data until you have verified the patched app.
If a previous installer already mixed incompatible versions, reinstall a clean
vendor build first; this installer cannot infer which old backup was pristine.
When upgrading from the transactional overlay installer, a matching manifest and
SHA-256-verified original backup let this installer recover the correct vendor
runtime automatically. Repeat installation always starts from that same verified
original, so hooks do not accumulate. An old overlay without a valid restore point
requires a clean vendor reinstall; arbitrary `.backup` files are never guessed.

After an upstream update, run `--check` again and rebuild before redeploying.
Report a new failure with the desktop/IDE distinction, app version, OS, installer
output, and first application error. Do not include API keys or auth headers.

## Optional Windows language-server endpoint patch

Some standalone Windows builds bypass the configurable API server for model-list
requests. Their existing fixed-length endpoint replacement is available explicitly:

```powershell
.\deploy.ps1 --check --patch-language-server
.\deploy.ps1 --patch-language-server
```

This option is restricted to the recognized `resources/bin/language_server.exe`
endpoint and participates in backup/rollback. Unknown binary contents cause an
error instead of a guessed offset. It is not a macOS or IDE binary patch.
The modified binary requires port **50999**. An archive marker makes the proxy
fail clearly if that port is occupied instead of silently choosing a different
port that the binary cannot use. Normal unpatched operation retains dynamic-port
fallback. Language-server restarts reuse the existing proxy listener; concurrent
starts and shutdowns are coordinated so a restart does not collide with its own port.

## Provider 403/404 errors are a separate problem

The `UNSUPPORTED_LOCATION` response in issue #1 is a Google account/service
eligibility decision. Replacing a preload or repeatedly reinstalling the patch
does not change it. Check the provider's supported locations and account access.
A 404 needs the configured API URL and model/route availability checked.

The connection-test button requests the provider's model list with the saved
credentials and custom headers. It reports 401, 403, 404, 405, 429 and server
failures as unsuccessful, and checks whether the selected model is advertised.
An endpoint without a model-list API may still support generation; configure it
manually if necessary. A successful listing does not prove that model generation
will work or that the account has sufficient quota. For Google Cloud Code, the
account editor also offers an explicit authorization/quota check.
