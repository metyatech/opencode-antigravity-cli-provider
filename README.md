# opencode-antigravity-cli-provider

## Overview

`opencode-antigravity-cli-provider` is a standalone OpenCode plugin and AI SDK custom provider for the official Antigravity `agy` CLI. It registers an OpenCode provider named `antigravity-cli` and delegates generation to `agy --model <exact display name> -p <prompt>` through a subprocess bridge.

This repository is intentionally narrow: it packages the provider as local plugin source for OpenCode and preserves the existing text-only `agy` CLI behavior. It does not implement an Antigravity backend client.

## npm status

This package is not published to npm yet. Use it as a local vendor plugin from this repository until a package publication workflow exists.

## Local vendor plugin usage

Build this repository first:

```bash
bun install
bun run build
```

Then add the built plugin to your OpenCode config from a local path. The plugin
auto-registers the `antigravity-cli` provider so it shows up under `/models`
(for example `antigravity-cli/default`) without you having to add it under
`provider["antigravity-cli"]` yourself:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///path/to/opencode-antigravity-cli-provider/dist/index.js"
  ]
}
```

On startup, the plugin runs the official read-only `agy models` command and
builds OpenCode model IDs from the displayed model names. It auto-injects the
`antigravity-cli` provider only if `provider["antigravity-cli"]` is absent and
discovery returns at least one model. It does NOT change your top-level default
`model` unless you explicitly pass the plugin `model` option with a discovered
slug.

For example, this `agy models` output:

```text
Gemini 3.5 Flash (Medium)
Claude Sonnet 4.6 (Thinking)
```

creates OpenCode model IDs:

```text
antigravity-cli/gemini-3-5-flash-medium
antigravity-cli/claude-sonnet-4-6-thinking
```

Those slug IDs are only OpenCode IDs. The provider passes the exact display
names back to `agy --model`, such as `Gemini 3.5 Flash (Medium)`. There is no
default model and no alias mapping.

The generated provider config has this shape:

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
          "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)"
        },
        "extraArgs": []
      },
      "models": {
        "gemini-3-5-flash-medium": {
          "name": "Gemini 3.5 Flash (Medium)"
        }
      }
    }
  }
}
```

If discovery fails or returns zero models, the plugin warns and skips provider
injection. It does not fall back to a hard-coded model.

To make Antigravity your OpenCode default model, opt in explicitly via the
plugin option `model` using one discovered slug while leaving your top-level
`config.model` unset:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///path/to/opencode-antigravity-cli-provider/dist/index.js",
      { "model": "gemini-3-5-flash-medium" }
    ]
  ]
}
```

An existing top-level `model` is always preserved; the plugin never overwrites
it. If the requested slug is not in the current discovery result, the plugin
warns and leaves `config.model` unchanged.

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

Models are discovered from `agy models` automatically. The plugin does not
support manual `models`, manual `modelMap`, aliases, a default/fallback model,
or a doctor command. If `agy models --json` is unsupported by your installed
CLI, that is expected; this plugin uses the plain-text `agy models` output.

Provider options:

- `enabled`: set to `false` to skip config injection.
- `command`: CLI command to spawn. Defaults to `agy`.
- `timeoutMs`: generation subprocess timeout. Defaults to `1800000` and must be between `1000` and `7200000`.
- `discoveryTimeoutMs`: `agy models` discovery timeout. Defaults to `10000`.
- `extraArgs`: extra CLI arguments passed before `--model` and `-p` for generation only.
- `model`: optional discovered slug to set as the top-level OpenCode default as `antigravity-cli/<slug>`. The plugin only sets it when `config.model` is currently unset and the slug exists in the discovery result.

Example with supported options:

```jsonc
{
  "plugin": [
    [
      "file:///path/to/opencode-antigravity-cli-provider/dist/index.js",
      {
        "command": "agy",
        "timeoutMs": 1800000,
        "discoveryTimeoutMs": 10000,
        "extraArgs": [],
        "model": "gemini-3-5-flash-medium"
      }
    ]
  ]
}
```

## Limitations

- Text generation only; no OpenCode-native tool-call or approval integration.
- No token usage reporting. Usage fields are `undefined`.
- No cache control, conversation resume, or shared `agy` conversation state.
- Streaming approximates stdout chunks as text deltas.
- stderr is diagnostic-only and is never returned as generated text.
- Each request is a fresh `agy --model <exact display name> -p` subprocess invocation.

## Safety model

This project only bridges to the official `agy` CLI. It does not introduce OAuth, keyring inspection, internal Antigravity APIs, sidecars, proxies, local OpenAI-compatible servers, account rotation, quota bypasses, credential managers, token fetchers, direct Google/Antigravity backend fetches, aliases, or a doctor command.

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
