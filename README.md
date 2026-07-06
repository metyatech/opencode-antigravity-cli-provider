# opencode-antigravity-cli-provider

## Overview

`opencode-antigravity-cli-provider` is a standalone OpenCode plugin and AI SDK custom provider for the official Antigravity `agy` CLI. It registers an OpenCode provider named `antigravity-cli` and delegates generation to `agy -p <prompt>` through a subprocess bridge.

This repository is intentionally narrow: it packages the provider as local plugin source for OpenCode and preserves the existing text-only `agy` CLI behavior. It does not implement an Antigravity backend client.

## npm status

This package is not published to npm yet. Use it as a local vendor plugin from this repository until a package publication workflow exists.

## Local vendor plugin usage

Build this repository first:

```bash
bun install
bun run build
```

Then add the built plugin to your OpenCode config from a local path:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///path/to/opencode-antigravity-cli-provider/dist/index.js"
  ],
  "model": "antigravity-cli/default"
}
```

The plugin injects this provider only if `provider["antigravity-cli"]` is absent:

```jsonc
{
  "provider": {
    "antigravity-cli": {
      "npm": "file:///path/to/opencode-antigravity-cli-provider/dist/provider.js",
      "name": "Antigravity CLI",
      "options": {
        "command": "agy",
        "timeoutMs": 1800000,
        "modelMap": {
          "default": null
        },
        "extraArgs": []
      },
      "models": {
        "default": {
          "name": "Antigravity CLI Default"
        }
      }
    }
  },
  "model": "antigravity-cli/default"
}
```

Disable plugin injection with plugin options:

```jsonc
{
  "plugin": [
    [
      "file:///path/to/opencode-antigravity-cli-provider/dist/index.js",
      {
        "enabled": false
      }
    ]
  ]
}
```

## Prerequisites

1. `agy` is installed and available in `PATH`.
2. `agy` has been run interactively to complete login, terms acceptance, theme setup, and workspace trust.
3. OpenCode can load local plugin files from the built `dist/index.js` path.
4. Bun is available for local development commands.

## Models and options

`default` deliberately omits `--model`. Additional OpenCode model IDs must be explicitly mapped to exact `agy --model` values:

```jsonc
{
  "plugin": [
    [
      "file:///path/to/opencode-antigravity-cli-provider/dist/index.js",
      {
        "command": "agy",
        "timeoutMs": 1800000,
        "modelMap": {
          "default": null,
          "workspace-pro": "Workspace Pro"
        },
        "extraArgs": [],
        "model": "antigravity-cli/workspace-pro",
        "models": {
          "workspace-pro": {
            "name": "Workspace Pro"
          }
        }
      }
    ]
  ]
}
```

Provider options:

- `enabled`: set to `false` to skip config injection.
- `command`: CLI command to spawn. Defaults to `agy`.
- `timeoutMs`: subprocess timeout. Defaults to `1800000` and must be between `1000` and `7200000`.
- `modelMap`: OpenCode model ID to exact `agy --model` value. `null` means omit `--model`.
- `extraArgs`: extra CLI arguments passed before `--model` and `-p`.
- `model`: default OpenCode model string injected when `config.model` is absent.
- `models`: OpenCode model metadata injected under `provider["antigravity-cli"].models`.

## Limitations

- Text generation only; no OpenCode-native tool-call or approval integration.
- No token usage reporting. Usage fields are `undefined`.
- No cache control, conversation resume, or shared `agy` conversation state.
- Streaming approximates stdout chunks as text deltas.
- stderr is diagnostic-only and is never returned as generated text.
- Each request is a fresh `agy -p` subprocess invocation.

## Safety model

This project only bridges to the official `agy` CLI. It does not introduce OAuth, internal Antigravity APIs, sidecars, proxies, local OpenAI-compatible servers, account rotation, quota bypasses, credential managers, token fetchers, or direct calls to Google or Antigravity backend services.

The provider also rejects dangerous authentication or account-routing arguments in `extraArgs`: `--api-key`, `--token`, `--auth`, `--credential`, `--credentials`, `--project`, `--account`, `--login`, and `--logout`. Subprocesses are spawned with `shell: false`; this repository does not use `child_process.exec`.

Run `agy` directly for interactive setup. If stdout or stderr looks like a login, permission, browser authorization, terms, theme, or workspace-trust prompt, the provider kills the child process and asks you to complete setup in `agy` directly.

## Development

```bash
bun install
bun run test
bun run typecheck
bun run build
git diff --check
```

Real `agy` smoke tests are intentionally not part of repository verification because they can trigger login, permission, and quota side effects.
