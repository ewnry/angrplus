# Antigravity+ custom CSS and plugins

Open Settings → General+ → Custom themes & plugins. Edits are saved locally and applied when you press Save and apply. CSS and each plugin have separate enable switches. Changes apply immediately and are restored at startup.

## CSS

Write ordinary CSS in the editor. The stylesheet is appended after the application's styles. Example:

```css
body.agy-theme-claude { --background: #171923; }
body.agy-theme-claude [role="navigation"][aria-label="Sidebar"] { background: #171923 !important; }
```

Inspect elements with developer tools to discover selectors. Target stable attributes such as `data-testid` where possible; internal UI elements can change between Antigravity versions. CSS can be disabled without deleting it.

## Plugins

Add a plugin, enter its JavaScript and enable it, then save. The code runs in the Antigravity+ preload's isolated renderer context with `document`, `window` and `api`. `api.id` is the plugin ID; `api.log(...)` writes to developer tools. Plugins can edit the app DOM. Return a cleanup function to undo modifications when settings are reapplied:

```js
const badge = document.createElement('span');
badge.textContent = 'Hello';
badge.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999';
document.body.append(badge);
return () => badge.remove();
```

Only enable code you trust: plugins can read and modify content visible in the app. This is a renderer DOM extension API; Node.js and Electron APIs are not provided as plugin parameters. Plugins should avoid depending on private class names. A plugin failure is logged and does not prevent other plugins from loading.

## For agents

Users can ask an agent to edit CSS or JavaScript here. The configuration lives at `~/.gemini/antigravity/plus-customizations.json`, with shape:

```json
{"css":"/* CSS */","cssEnabled":false,"plugins":[{"id":"example","name":"Example","code":"api.log('ready');","enabled":false}]}
```

Use unique IDs with lowercase ASCII letters, digits, `_` or `-` (1–64 characters). Preserve other fields and plugins when editing. New plugins should start disabled until the user chooses to enable them. Reload the app or use Save and apply in General+ after editing the file. Never include secrets in plugin code or transmit chat content without the user's instruction.

CSS files can be placed in `~/.gemini/antigravity/themes/`. In General+, use **Open themes folder**, **Refresh**, select a `.css` file and press **Load**. This copies its content into the editor; enable Custom CSS and press **Save and apply**. Later edits to the file require loading it again.

## .plus themes

Put `.plus` files in `~/.gemini/antigravity/themes/`, select one in General+, press Load, enable Custom theme and Save and apply. A .plus theme is one UTF-8 file. Directives go before `@css`; everything after `@css` is ordinary CSS.

```text
@plus 1
@add body | div | my-badge | Hello Antigravity
@script
api.log('Theme loaded');
return () => api.log('Theme removed');
@end
@css
.my-badge { position: fixed; right: 16px; bottom: 16px; color: coral; }
```

`@add selector | tag | class | text` appends an element to the first matching parent and automatically removes it when the theme is reapplied or disabled. Optional `@script` runs JavaScript with `document`, `window`, and `api`; return a cleanup function. `@layout claude` enables the built-in Claude layout hooks; it is used in the provided `claude-desktop.plus`. Directives are parsed before CSS, and the theme must start with `@plus 1` and contain `@css`. Enable only trusted themes: scripts can read and modify the app interface.
