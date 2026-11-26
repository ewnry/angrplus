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

### Replace an interface area and connect its actions

The theme script and inline plugins have `api.ui`. `api.ui.replace(selector, render)` keeps the original React element mounted but hidden and inserts the element returned by `render(original)` next to it. It watches for the native element being recreated and mounts the replacement again. Disabling or reapplying the theme removes the custom view and restores the original element. The method also returns a function that removes that replacement immediately.

```text
@plus 1
@script
api.ui.replace('[data-testid="model-selector-trigger"]', (original) => {
  const button = document.createElement('button');
  button.className = 'my-model-button';
  button.textContent = 'Choose model';
  button.onclick = () => original.click();
  return button;
});
@end
@css
.my-model-button { border-radius: 8px; padding: 8px 12px; }
```

`api.ui.find(selector)` finds an existing element; `api.ui.click(selector)` runs its click handler and returns whether it was available. `api.ui.setValue(selector, value)` updates an input, textarea or editable element and sends input/change events. Themes also have `api.models.get()`, `api.models.select(value)`, `api.models.effort()`, `api.models.setEffort(level)`, `api.models.subscribe(callback)`, `api.permissions.get()`, `api.permissions.open()` and `api.permissions.select(label)`. The older `api.getModels`, `api.selectModel` and `api.setEffort` aliases remain available. See [plugins.md](plugins.md) and `examples/plugins/model-controls` for the data shapes and a working picker. CSS styles the replacement; actions require the script block. These hooks work with the actual UI and may need new selectors when Google changes its DOM; hiding an element does not turn its internal React components into a stable public API.

### Switching Code and Gemini Web

`api.layout.get()` returns `code` or `cowork`. Use `api.layout.set("code")` or `api.layout.set("cowork")` to switch the actual view; the latter opens Gemini Web and requires the existing Gemini Web session. `api.layout.openSettings()` opens native Antigravity settings; `api.layout.openAccounts()` opens the Antigravity+ account pool when available and returns `false` otherwise. A theme that enables Cowork should switch back to Code and remove `agy-custom-cowork-enabled` in its cleanup.
