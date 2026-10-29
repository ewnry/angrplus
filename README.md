# angrplus (Antigravity+)

Antigravity modification providing multi-account quota pooling, seamless hot-swapping between accounts, and custom UI controls.

## Features

- **Multi-Account Quota Pool:** Automatic switching when an account hits quota limits.
- **Independent Quotas:** Separate tracking for Claude and Gemini quotas.
- **Claude Hot-Swap:** Hot-swaps quota without interrupting thinking streams.
- **Custom UI:** Custom model selectors, effort toggles, and context popovers.

## Development & Building

### Prerequisites

- Node.js >= 22.12.0
- npm

### Installation

```bash
npm install
```

### Build Patch

```bash
npm run build
```

### Apply Patch Locally

To patch an existing Antigravity installation:

```bash
# Direct in-place patch
npm run patch

# Or build the full standalone installer (Windows)
npm run build:installer
```

### Restore Original

```bash
npm run patch:restore
```

## License

Apache-2.0
