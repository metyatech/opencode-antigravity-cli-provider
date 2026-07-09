# opencode-antigravity-cli-provider

## Overview

`opencode-antigravity-cli-provider` is a standalone OpenCode plugin and AI SDK custom provider for the official Antigravity `agy` CLI. It registers an OpenCode provider named `antigravity-cli` and delegates generation to the official CLI through a `node-pty` pseudoterminal.

This repository is intentionally narrow: it packages the provider as local plugin source for OpenCode and preserves the existing text-only `agy` CLI behavior. It does not implement an Antigravity backend client.

## npm status

This package is not published to npm yet. Use it as a local vendor plugin from this repository until a package publication workflow exists.

## Local vendor plugin usage

Build this repository first:

```bash
bun install
bun run build
```

Then add the built plugin to your OpenCode config from the local vendor path. The plugin auto-registers the `antigravity-cli` provider so it shows up under `/models` with each discovered slug (for example `antigravity-cli/gemini-3-5-flash-medium` and `antigravity-cli/claude-opus-4-6-thinking`) without you having to add it under `provider["antigravity-cli"]` yourself:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./vendor/opencode-antigravity-cli-provider"
  ]
}
```

On startup, the plugin runs the official read-only `agy models` command through
a pseudoterminal (`node-pty`) and builds OpenCode model IDs from the displayed
model names. Discovery uses a PTY because pipe-based execution can hang or never
emit the model list for this CLI. Generation also uses `node-pty` and avoids
putting the full rendered prompt on the command line: the provider writes the
prompt to an OS-temp UTF-8 `prompt.txt`, passes that temp directory with the
official `--add-dir`, and sends only a short wrapper prompt with `-p` that
names the exact generated `prompt.txt` path instead of embedding the prompt
body. This mitigates Windows error 206 (`The filename or extension is too
long`) for long OpenCode prompts. It auto-injects the `antigravity-cli`
provider only if `provider["antigravity-cli"]` is absent and discovery returns
at least one model.
It does NOT change your top-level default `model` unless you explicitly pass the
plugin `model` option with a discovered slug.

For example, this `agy models` output:

```text
Gemini 3.5 Flash (Medium)
Claude Opus 4.6 Thinking
Claude Sonnet 4.6 (Thinking)
```

creates OpenCode model IDs:

```text
antigravity-cli/gemini-3-5-flash-medium
antigravity-cli/claude-opus-4-6-thinking
antigravity-cli/claude-sonnet-4-6-thinking
```

Those slug IDs are only OpenCode IDs. The provider passes the exact display
names back to `agy --model`, such as `Gemini 3.5 Flash (Medium)` or
`Claude Opus 4.6 Thinking`. There is no default model and no alias mapping.

The generated provider config has this shape:

```jsonc
{
  "provider": {
    "antigravity-cli": {
      "npm": "./vendor/opencode-antigravity-cli-provider/dist/provider.js",
      "name": "Antigravity CLI",
      "options": {
        "command": "agy",
        "timeoutMs": 1800000,
        "modelMap": {
          "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)",
          "claude-opus-4-6-thinking": "Claude Opus 4.6 Thinking"
        },
        "extraArgs": []
      },
      "models": {
        "gemini-3-5-flash-medium": {
          "name": "Gemini 3.5 Flash (Medium)"
        },
        "claude-opus-4-6-thinking": {
          "name": "Claude Opus 4.6 Thinking"
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
`config.model` unset. The example below selects Claude Opus 4.6 Thinking as
the default for new sessions:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "./vendor/opencode-antigravity-cli-provider",
      { "model": "antigravity-cli/claude-opus-4-6-thinking" }
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
      "./vendor/opencode-antigravity-cli-provider",
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
3. OpenCode can load the local vendor plugin path after this repository is built.
4. Bun is available for local development commands.
5. The native `node-pty` dependency can install for your OS/runtime; it is used
   for both `agy models` discovery and text generation.

## Models and options

Models are discovered from `agy models` automatically through `node-pty`. The
plugin does not support manual `models`, manual `modelMap`, aliases, a
default/fallback model, or a doctor command. If `agy models --json` is
unsupported by your installed CLI, that is expected; this plugin uses the
plain-text `agy models` output.

Provider options:

- `enabled`: set to `false` to skip config injection.
- `command`: CLI command to spawn. Defaults to `agy`.
- `timeoutMs`: generation PTY timeout. Defaults to `1800000` and must be between `1000` and `7200000`.
- `discoveryTimeoutMs`: `agy models` discovery timeout. Defaults to `60000`.
- `extraArgs`: extra CLI arguments passed before `--model` and `-p` for generation only.
- `model`: optional discovered model ID such as `antigravity-cli/<slug>` to set as the top-level OpenCode default. The plugin only sets it when `config.model` is currently unset and the slug exists in the discovery result.

Example with supported options:

```jsonc
{
  "plugin": [
    [
      "./vendor/opencode-antigravity-cli-provider",
      {
        "command": "agy",
        "timeoutMs": 1800000,
        "discoveryTimeoutMs": 60000,
        "extraArgs": [],
        "model": "antigravity-cli/claude-opus-4-6-thinking"
      }
    ]
  ]
}
```

## Limitations

- Text generation only; no OpenCode-native tool-call or approval integration.
- No token usage reporting. Usage fields are `undefined`.
- No cache control, conversation resume, or shared `agy` conversation state.
- Streaming emits the final sanitized generation text as a text delta.
- PTY terminal control sequences from generation output are sanitized before the
  text is returned.
- Each generation request is a fresh PTY invocation that passes the exact model
  display name, adds a temp prompt directory with `--add-dir`, and uses `-p`
  only for the short wrapper prompt that points to the exact generated
  `prompt.txt`. Temp prompt directories and files are removed on a best-effort
  basis after success, failure, timeout, or abort.
- Stream cancellation waits for the underlying CLI cancellation cleanup when the
  caller awaits `ReadableStream` cancellation.

## Safety model

This project only bridges to the official `agy` CLI. It does not introduce OAuth, keyring inspection, internal Antigravity APIs, sidecars, proxies, local OpenAI-compatible servers, account rotation, quota bypasses, credential managers, token fetchers, direct Google/Antigravity backend fetches, aliases, or a doctor command.

`extraArgs` are intended for generation helper arguments only; they cannot be used to override `--model` or the managed prompt workspace because model selection and prompt transport are determined exclusively by the OpenCode selected slug, the discovery-derived `modelMap`, and the provider-created temp `prompt.txt`. The provider also rejects dangerous authentication, account-routing, model, and prompt-workspace arguments in `extraArgs`: `--api-key`, `--token`, `--auth`, `--credential`, `--credentials`, `--project`, `--account`, `--login`, `--logout`, `--model`, and `--add-dir`. Discovery and generation both spawn `agy` through `node-pty` without a shell. This repository does not use `child_process.exec`.

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
