# Antigravity CLI Streaming Local Evidence

## 1. Investigation Scope

This report records local primary evidence collected on 2026-07-12 from the investigation worktree for `opencode-antigravity-cli-provider` streaming behavior. The worktree path validated before collection was `D:\ghws\opencode-antigravity-cli-provider-agy-streaming-evidence`, branch `investigate/agy-streaming-evidence-20260712`, HEAD `416ef340c93d8234889c4f8c1691883a408e9115`.

Scope boundaries observed during collection:

- No changes were made under `src/**`, tests, package manifests, lockfiles, OpenCode config, agent dotfiles, timeout config, or dependencies.
- Temporary logs and scripts were written only under `.omo/evidence/agy-streaming-investigation`.
- The only tracked report path is `docs/investigations/agy-streaming-local-evidence.md`.
- Direct PTY execution was attempted only through the temporary evidence script and was blocked by missing existing `node-pty` installation; no substitute non-PTY run was used for PTY evidence.

Raw evidence root: `.omo/evidence/agy-streaming-investigation`.

## 2. Repository and Environment

Initial repository validation facts:

- Original worktree `D:\ghws\opencode-antigravity-cli-provider` was inspected read-only.
- Original HEAD: `416ef340c93d8234889c4f8c1691883a408e9115`.
- Original branch: `main`.
- Worktree list showed the investigation branch checked out only at `D:/ghws/opencode-antigravity-cli-provider-agy-streaming-evidence`.
- Local branch `refs/heads/investigate/agy-streaming-evidence-20260712` exists at `416ef340c93d8234889c4f8c1691883a408e9115`.
- `git ls-remote --heads origin investigate/agy-streaming-evidence-20260712` returned no remote branch output at validation time.

Investigation worktree validation facts:

- Branch: `investigate/agy-streaming-evidence-20260712`.
- HEAD: `416ef340c93d8234889c4f8c1691883a408e9115`.
- Top-level path: `D:/ghws/opencode-antigravity-cli-provider-agy-streaming-evidence`.
- Remote: `origin https://github.com/metyatech/opencode-antigravity-cli-provider.git`.
- No tracked diffs were present before evidence collection.
- `.omo/` and `.omo/evidence/agy-streaming-investigation/test-placeholder.txt` were ignored by `.gitignore:7:.omo/` without creating the placeholder.

Environment facts from `environment.txt`:

- Collection timestamp: `2026-07-12T19:14:45.6035053+09:00`.
- OS: `Microsoft Windows NT 10.0.26200.0`.
- PowerShell: `7.6.3`.
- Bun: `1.3.14`.
- Node: `v24.12.0`.
- OpenCode: `1.15.11-dev.13660+sha.49a84a9.dirty`.
- agy: `1.1.1`.

Evidence files:

- `.omo/evidence/agy-streaming-investigation/environment.txt`
- `.omo/evidence/agy-streaming-investigation/agy-command-resolution.txt`

## 3. agy Command Resolution and Version

`agy` resolved to a native executable:

- `Get-Command agy` path/source: `%USERPROFILE%\AppData\Local\agy\bin\agy.exe`.
- `where.exe agy`: `%USERPROFILE%\AppData\Local\agy\bin\agy.exe`.
- `agy --version`: `1.1.1` with exit code `0`.
- No `.cmd` or `.ps1` shim was used for `agy`; therefore no shim target rewrite was needed.
- No `package.json` was found in the resolved executable parent directories.
- Source readability classification for installed `agy`: `SourceReadable=False or native-only by parent package.json probe`.

Evidence files:

- `.omo/evidence/agy-streaming-investigation/agy-command-resolution.txt`
- `.omo/evidence/agy-streaming-investigation/environment.txt`

## 4. Available CLI Output Modes

Help commands were captured independently with command, start/end time, duration, exit code, stdout, stderr, and timed-out state:

- `agy --help`: exit `0`, not timed out.
- `agy help`: exit `0`, not timed out.
- `agy models`: exit `0`, not timed out, duration `3211ms`.
- `agy models --help`: captured in `help/agy-models-help.txt`.
- `agy run --help`: captured in `help/agy-run-help.txt`.
- `agy prompt --help`: captured in `help/agy-prompt-help.txt`.
- `agy chat --help`: captured in `help/agy-chat-help.txt`.

Observed help-mode facts:

- `agy --help` listed `--print` / `-p` as: `Run a single prompt non-interactively and print the response`.
- `agy --help` listed `--print-timeout` with default `5m0s`.
- Exact searched terms `--json`, `--jsonl`, `--ndjson`, `--output-format`, `stream-json`, `event-stream`, `events`, `stream`, `headless`, `verbose`, `debug`, `reasoning`, and `thought` were not found in the captured help term occurrence summary.
- `non-interactive` occurred once in each top-level/prompt/run/chat help output where `--print` was described.
- `print` occurred six times in each top-level/prompt/run/chat help output.
- The word `thinking` occurred in `agy models` only because model display names included `Claude Sonnet 4.6 (Thinking)` and `Claude Opus 4.6 (Thinking)`.

Captured help does not show a documented structured streaming output mode. Captured help does show plain non-interactive print mode.

Evidence files:

- `.omo/evidence/agy-streaming-investigation/help/agy-help.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-help-command.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-models.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-models-help.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-run-help.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-prompt-help.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-chat-help.txt`
- `.omo/evidence/agy-streaming-investigation/help/help-term-occurrences.tsv`

## 5. Installed CLI Source Findings

Installed `agy` source search status:

- `agy` resolved directly to `%USERPROFILE%\AppData\Local\agy\bin\agy.exe`.
- No package root was discovered from resolved executable parent directories.
- The allowed source search scopes (`package.json`, `bin/**`, `src/**`, `dist/**`, `lib/**`, `build/**`, `cli/**`) could not be applied because no readable package root was found.
- `.omo/evidence/agy-streaming-investigation/agy-source-capability-search.txt` records the source-search non-applicability.

No local installed-CLI source evidence was available for structured output, TTY handling, spinner/redraw handling, delta handling, final-answer-only behavior, or event names.

## 6. Current Provider Buffering Behavior

Read-only provider facts verified from the current investigation worktree:

- `src/agy-command.ts:155` initializes `let output = ""`.
- `src/agy-command.ts:262-271` registers `child.onData`; each PTY data chunk is appended to `output`; the handler checks interactive setup prompts and does not call `request.onStdout`.
- `src/agy-command.ts:273-298` registers `child.onExit`; it sanitizes the whole accumulated output at line `285`, then calls `request.onStdout?.(sanitizedOutput)` at line `296` before resolving.
- `src/stream.ts:32-48` passes an `onStdout` callback into `runAgyCommand`; that callback emits `text-start` once and maps each received stdout chunk to a `text-delta` at line `46`.
- `src/stream.test.ts:157-181` expects one final `text-delta` with `delta` equal to `OK` for the PTY fixture.
- `src/types.ts:107-113` defines stream parts as `stream-start`, `text-start`, `text-delta`, `text-end`, `finish`, and `error`; no reasoning/thinking stream part type is present.
- `src/options.ts:4-11` sets default provider `timeoutMs` to `1_800_000`.
- `README.md:188-189` states: `Streaming emits the final sanitized generation text as a text delta.`

Evidence file:

- `.omo/evidence/agy-streaming-investigation/provider-implementation-facts.txt`

## 7. Discovered Model Mapping

`agy models` returned these display names:

1. `Gemini 3.5 Flash (Medium)`
2. `Gemini 3.5 Flash (High)`
3. `Gemini 3.5 Flash (Low)`
4. `Gemini 3.1 Pro (Low)`
5. `Gemini 3.1 Pro (High)`
6. `Claude Sonnet 4.6 (Thinking)`
7. `Claude Opus 4.6 (Thinking)`
8. `GPT-OSS 120B (Medium)`

Required slug mappings present in this local `agy models` output:

- `antigravity-cli/gemini-3-5-flash-medium` -> `Gemini 3.5 Flash (Medium)`.
- `antigravity-cli/gemini-3-1-pro-high` -> `Gemini 3.1 Pro (High)`.

Evidence files:

- `.omo/evidence/agy-streaming-investigation/help/agy-models.txt`
- `.omo/evidence/agy-streaming-investigation/model-mapping.txt`

## 8. Direct PTY Capture: Quick Case

Mandated quick case:

- Model slug: `antigravity-cli/gemini-3-5-flash-medium`.
- Display name exists: `Gemini 3.5 Flash (Medium)`.
- Prompt: `Return exactly one line and nothing else:\n\nAGY_STREAM_QUICK_OK`.

Execution result:

- Classification: `E insufficient`.
- The direct PTY capture could not run because existing `node-pty` was not resolvable in this worktree.
- `package.json` declares `node-pty` at `^1.1.0`, but no `node_modules/node-pty*` files were present in the worktree.
- The attempted script failed with: `Cannot find package 'node-pty' from 'D:\ghws\opencode-antigravity-cli-provider-agy-streaming-evidence\package.json'`.
- Dependency installation was not performed because dependency changes and `npm install`/`bun add`/updates were out of scope.
- No substitute non-PTY execution was used for this PTY case.

PTY metrics were not observed for quick case: no first chunk, first printable, last chunk, total chunks, byte count, max gap, 90s activity, final-10s concentration, overwrite behavior, spinner behavior, cursor movement, erase control, CR, ANSI color, or OSC counts are available.

Evidence files:

- `.omo/evidence/agy-streaming-investigation/tools/capture-agy-pty.ts`
- `.omo/evidence/agy-streaming-investigation/node-pty-resolution.txt`
- `.omo/evidence/agy-streaming-investigation/runs/quick/blocked.json`

## 9. Direct PTY Capture: Long Case

Mandated long case:

- Model slug: `antigravity-cli/gemini-3-1-pro-high`.
- Display name exists: `Gemini 3.1 Pro (High)`.
- Prompt requested a Japanese technical analysis of at least 1200 Japanese words and prohibited file modification.

Execution result:

- Classification: `E insufficient`.
- The direct PTY capture could not run for the same reason as the quick case: existing `node-pty` was not resolvable in this worktree.
- No substitute non-PTY execution was used for this PTY case.
- Git status checks around the attempted PTY script runs reported exit code `0` and no tracked status output.

PTY metrics were not observed for long case: no first chunk, first printable, last chunk, total chunks, byte count, max gap, 90s activity, final-10s concentration, overwrite behavior, spinner behavior, cursor movement, erase control, CR, ANSI color, or OSC counts are available.

Evidence files:

- `.omo/evidence/agy-streaming-investigation/tools/capture-agy-pty.ts`
- `.omo/evidence/agy-streaming-investigation/node-pty-resolution.txt`
- `.omo/evidence/agy-streaming-investigation/runs/long/blocked.json`

## 10. PTY Control Sequence Findings

Direct PTY raw chunks were not available from this evidence collection because `node-pty` was not installed/resolvable in the worktree.

Repository fixture and sanitizer evidence still show known PTY control-sequence handling in existing provider code/tests:

- `src/agy-command.test.ts:95-200` includes a generation fixture containing CSI, OSC title, BEL, cursor visibility, screen clear, cursor home, and CRLF, and expects sanitization to return `OK`.
- `src/model-discovery.test.ts:87-154` includes model-list PTY fixtures with CSI screen/cursor controls, OSC title, BEL, bare `\r` spinner redraws, and color escape sequences.
- `src/model-discovery.ts:196-236` defines sanitizer patterns for CSI, OSC, control residue, cursor-home frame separation, screen-clear frame separation, and bare-CR normalization for model-list output.

Observed from direct local PTY run: not measured.

## 11. OpenCode JSON Event Timeline

Mandated command shape captured by the temporary standard-API process script:

- `opencode run --format json --thinking --model antigravity-cli/gemini-3-1-pro-high --dir D:\ghws\opencode-antigravity-cli-provider-agy-streaming-evidence "<long prompt>"`.
- The script resolved the Windows `opencode.cmd` shim to the underlying `opencode.exe` before spawning because direct `spawn("opencode")` returned `ENOENT` on Windows.

Captured process metrics:

- Duration: `12264ms`.
- Exit code: `0`.
- Timed out: `false`.
- stdout line count: `1`.
- stderr line count: `0`.

Captured stdout event timeline:

- At `11718ms`, one JSON line was emitted with `type: "error"`.
- Error name: `APIError`.
- Error message: `Too Many Requests: quota exceeded`.
- Status code: `429`.
- Retryable: `true`.
- Metadata URL: `https://api.githubcopilot.com/chat/completions`.

Requested event names in this run:

- First JSON event: `error`.
- `message.updated`: not observed.
- `step-start`: not observed.
- `text-start`: not observed.
- `text-delta`: not observed.
- `reasoning-start`: not observed.
- `reasoning-delta`: not observed.
- `session.error`: not observed as a `type` value; the single event had `type: "error"`.
- `session.status idle`: not observed.
- `first_event`: `error` at `11718ms`.
- `stream_idle`: not observed in this run.
- Exact timeout message: none observed.
- Provider ID/model ID/phase: no antigravity provider event fields were present in the single captured error line.
- 90s provider-normalized events: none; the process ended before 90s.
- Retry, agy restart, fallback: none observed in captured stdout/stderr.

Evidence files:

- `.omo/evidence/agy-streaming-investigation/opencode-run/command.json`
- `.omo/evidence/agy-streaming-investigation/opencode-run/stdout-timed.ndjson`
- `.omo/evidence/agy-streaming-investigation/opencode-run/stderr-timed.ndjson`
- `.omo/evidence/agy-streaming-investigation/opencode-run/exit.json`

## 12. Existing 90000ms Error Evidence

Read-only log search scope:

- `%USERPROFILE%\AppData\Local\opencode`
- `%USERPROFILE%\AppData\Roaming\opencode`
- `%USERPROFILE%\.local\share\opencode`
- `%USERPROFILE%\.local\state\opencode`
- `%USERPROFILE%\.config\opencode`

Search cutoff: past 7 days from `2026-07-12T19:15:39.2248310+09:00`.

Terms searched:

- `Provider antigravity-cli/`
- `did not emit any event within 90000ms`
- `stream was idle for more than 90000ms`
- `ProviderRequestTimeoutError`
- `gemini-3-1-pro`

Result:

- No matching log excerpts were found in searched bases within the past 7 days.
- Secret-like values were redacted by the search script, but no matching excerpts were emitted.

Evidence file:

- `.omo/evidence/agy-streaming-investigation/existing-opencode-timeout-log-excerpts.txt`

## 13. Confirmed Facts

Confirmed local facts:

- The validated investigation worktree was on branch `investigate/agy-streaming-evidence-20260712` at HEAD `416ef340c93d8234889c4f8c1691883a408e9115` before collection.
- `agy` version was `1.1.1`.
- `agy` resolved to `%USERPROFILE%\AppData\Local\agy\bin\agy.exe`.
- Installed `agy` did not expose a readable JS package root through the resolved executable parent directories.
- Captured `agy` help showed `--print` / `-p` non-interactive print mode and did not show captured `--json`, `--jsonl`, `--ndjson`, `--output-format`, `stream-json`, `event-stream`, or `events` support.
- `agy models` included both required display names: `Gemini 3.5 Flash (Medium)` and `Gemini 3.1 Pro (High)`.
- Current provider code buffers PTY output in `src/agy-command.ts` until `child.onExit`, then emits one sanitized output through `request.onStdout`.
- Current stream adapter maps each provider `onStdout` call to a `text-delta`.
- Current provider stream type definitions do not include reasoning/thinking events.
- Current provider default generation timeout is `1800000ms`, which differs from a `90000ms` OpenCode idle/watchdog threshold referenced by the investigation objective.
- Direct local PTY quick/long captures were not obtained because existing `node-pty` was not resolvable and dependency installation was out of scope.
- The captured `opencode run --format json --thinking` process emitted one `error` event for GitHub Copilot quota (`429`) and no antigravity text/reasoning/session-status events.
- No existing local OpenCode 90000ms timeout excerpts matching the requested terms were found in the searched paths for the past 7 days.

## 14. Unresolved Questions

Unresolved from this evidence collection:

- Direct PTY chunk timing and control-sequence metrics for real `agy` generation remain unmeasured because `node-pty` was not installed/resolvable in this worktree.
- Whether real `agy` generation emits final-answer text incrementally or only near exit remains unknown from direct PTY evidence.
- Whether real `agy` generation emits progress/status output distinguishable from final-answer output remains unknown from direct PTY evidence.
- The exact OpenCode `90000ms` timeout message, phase, and antigravity provider event sequence were not reproduced in this run.
- The captured OpenCode run reached a GitHub Copilot quota error event, so it did not provide antigravity provider text/reasoning event evidence.
- Installed `agy` source-level event names, structured output handling, spinner/redraw implementation, and delta handling could not be inspected because the local CLI resolved to a native executable without a readable package root.

## 15. Evidence File Index

Evidence directory:

- `.omo/evidence/agy-streaming-investigation/`

Files:

- `.omo/evidence/agy-streaming-investigation/environment.txt`
- `.omo/evidence/agy-streaming-investigation/agy-command-resolution.txt`
- `.omo/evidence/agy-streaming-investigation/agy-source-capability-search.txt`
- `.omo/evidence/agy-streaming-investigation/model-mapping.txt`
- `.omo/evidence/agy-streaming-investigation/provider-implementation-facts.txt`
- `.omo/evidence/agy-streaming-investigation/node-pty-resolution.txt`
- `.omo/evidence/agy-streaming-investigation/existing-opencode-timeout-log-excerpts.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-help.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-help-command.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy--help.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-models.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-models-help.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-run-help.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-prompt-help.txt`
- `.omo/evidence/agy-streaming-investigation/help/agy-chat-help.txt`
- `.omo/evidence/agy-streaming-investigation/help/help-term-occurrences.tsv`
- `.omo/evidence/agy-streaming-investigation/tools/capture-agy-pty.ts`
- `.omo/evidence/agy-streaming-investigation/tools/capture-opencode-process.ts`
- `.omo/evidence/agy-streaming-investigation/runs/quick/blocked.json`
- `.omo/evidence/agy-streaming-investigation/runs/long/blocked.json`
- `.omo/evidence/agy-streaming-investigation/opencode-run/command.json`
- `.omo/evidence/agy-streaming-investigation/opencode-run/stdout-timed.ndjson`
- `.omo/evidence/agy-streaming-investigation/opencode-run/stderr-timed.ndjson`
- `.omo/evidence/agy-streaming-investigation/opencode-run/exit.json`

Evidence zip:

- `.omo/evidence/agy-streaming-investigation.zip`

## Attempt 2: Direct PTY Capture

### node-pty preparation result

- `bun install --frozen-lockfile` completed with exit `0`.
- `package.json` SHA256 was unchanged: `25341b1aecccbca6888382f7f8ddc593c97a84000eb827b4d95d3c0a73f5db6f`.
- `bun.lock` SHA256 was unchanged: `b80af1281058bef633d36fa8b273d2d480d9b7f127cd263cb62c86dd8a584b4b`.
- `require.resolve("node-pty")` resolved to `D:\ghws\opencode-antigravity-cli-provider-agy-streaming-evidence\node_modules\node-pty\lib\index.js`.
- `require("node-pty").spawn` type was `function`.
- Resolved `node-pty` package version: `1.1.0`.

Classification key used for this attempt:

- `A control-only`: PTY setup/control sequence chunk without answer body.
- `B progress/status-text`: human-readable CLI progress or status text that is not the requested final answer body.
- `C final-answer-body`: requested answer text or its continuation.
- `D terminal-newline/control-cleanup`: trailing terminal newline or cleanup-only output.
- `E insufficient`: no direct PTY answer evidence or errored/blocked capture.

### Quick metrics and classification

- Model slug/display: `gemini-3-5-flash-medium` / `Gemini 3.5 Flash (Medium)`.
- Run-level classification: `C final-answer-body observed`, with requested answer body in chunk `3` at `6864ms`; the quick final answer body was not split across multiple chunks.
- Metrics: `durationMs=7898`, `exitCode=0`, `timedOut=false`, `chunkCount=3`, `totalUtf8Bytes=182`, `firstPtyDataAtMs=37`, `lastPtyDataAtMs=6864`, `maxInterChunkGapMs=4824`, `chunksBefore90000Ms=3`, `promptCleanupSucceeded=true`.
- PTY output before 90s: yes; all 3 chunks arrived before `90000ms`.
- Final answer incremental or batched at direct PTY layer: batched for the answer body in this run; `AGY_STREAM_QUICK_OK` arrived in one chunk after a separate progress/status chunk.
- Control-sequence presence in raw PTY: CR=yes, CSI=yes, OSC=yes, screen clear=yes, line erase=no, cursor movement=yes.

Representative quick chunks:

| Slice | Chunk | elapsedMs | Classification | Escaped data |
| --- | ---: | ---: | --- | --- |
| first/middle/last | 1 | 37 | `A control-only` | `"\u001b[?9001h\u001b[?1004h"` |
| first/middle/last | 2 | 4861 | `B progress/status-text` | `"\u001b[?25l\u001b[2J\u001b[m\u001b[HI am viewing the contents of the prompt file to understand the request.\r\n\u001b]0;C:\\Users\\Origin\\AppData\\Local\\agy\\bin\\agy.exe\u0007\u001b[?25h"` |
| first/middle/last | 3 | 6864 | `C final-answer-body` | `"AGY_STREAM_QUICK_OK\r\n"` |

Relative quick evidence paths:

- `.omo/evidence/agy-streaming-minimal/tools/capture-agy-pty.ts`
- `.omo/evidence/agy-streaming-minimal/runs/quick/command.json`
- `.omo/evidence/agy-streaming-minimal/runs/quick/raw-pty.ndjson`
- `.omo/evidence/agy-streaming-minimal/runs/quick/final-raw-reconstructed.txt`
- `.omo/evidence/agy-streaming-minimal/runs/quick/final-sanitized-output.txt`
- `.omo/evidence/agy-streaming-minimal/runs/quick/exit.json`

### Long metrics and classification

- Model slug/display: `gemini-3-1-pro-high` / `Gemini 3.1 Pro (High)`.
- Run-level classification: `C final-answer-body observed`, with final answer body starting at chunk `3` (`228880ms`) and continuing through chunk `113` (`243107ms`).
- Metrics: `durationMs=244158`, `exitCode=0`, `timedOut=false`, `chunkCount=113`, `totalUtf8Bytes=14025`, `firstPtyDataAtMs=37`, `lastPtyDataAtMs=243107`, `maxInterChunkGapMs=143707`, `chunksBefore90000Ms=1`, `promptCleanupSucceeded=true`.
- PTY output before 90s: yes, but only chunk `1` was observed before `90000ms`; it was `A control-only`. The first human-readable status text arrived at chunk `2` (`143744ms`), after 90s.
- Final answer incremental or batched at direct PTY layer: incremental for the long run; final answer body was split across chunks `3-113`.
- Control-sequence presence in raw PTY: CR=yes, CSI=yes, OSC=yes, screen clear=yes, line erase=no, cursor movement=yes.

Representative long chunks:

| Slice | Chunk | elapsedMs | Classification | Escaped data |
| --- | ---: | ---: | --- | --- |
| first 5 | 1 | 37 | `A control-only` | `"\u001b[?9001h\u001b[?1004h"` |
| first 5 | 2 | 143744 | `B progress/status-text` | `"\u001b[?25l\u001b[2J\u001b[m\u001b[HI am searching for the source files you referenced so I can read them and provide the analysis. Once the search completes, I will proceed to read the files.\r\n\u001b]0;C:\\Users\\Origin\\AppData\\Local\\agy\\bin\\agy.exe\u0007\u001b[?25h"` |
| first 5 | 3 | 228880 | `C final-answer-body` | `"【1. PTY出力が現在どのようにして最終的なAI SDKのtext-deltaに到"` |
| first 5 | 4 | 229080 | `C final-answer-body` | `"達するか】\r\n本プラグインのアーキテクチャにおいて最も注目すべき点は、AI SDKに対"` |
| first 5 | 5 | 229280 | `C final-answer-body` | `"して「ストリーミング」としてのインターフェース（`stream.ts` における `createAgyTextStream`）を提供しつつも、内部的には出力をリアル"` |
| middle 5 | 55 | 236296 | `C final-answer-body` | `"リケーションに送信すると、テキストの文字化け、UIの"` |
| middle 5 | 56 | 236296 | `C final-answer-body` | `"\r\n\u001b[29;119Hの崩れ、予期せぬスクロール動作など、レンダリング機能に対して壊滅"` |
| middle 5 | 57 | 236497 | `C final-answer-body` | `"的な悪影響を及ぼす非常に「安全でない（unsafe）」状態を引き\r\n\u001b[29;119Hき起こします。"` |
| middle 5 | 58 | 236497 | `C final-answer-body` | `"\r\n`agy-command.ts` の `sanitizeAgyGenerationPtyOutput` 関数で定"` |
| middle 5 | 59 | 236697 | `C final-answer-body` | `"義されている正規表現のパターンを見ることで、具体的にどのよ "` |
| last 5 | 109 | 242506 | `C final-answer-body` | `"ては上書きされる運命にある大量の古いテキストの残骸と、消去コマンド、そしてキャリッジリタ"` |
| last 5 | 110 | 242706 | `C final-answer-body` | `"ーンが複雑\r\n\u001b[29;119H雑に絡み合ったノイズの塊となっています。\r\n\n**最終的な回答（Final answer）**"` |
| last 5 | 111 | 242707 | `C final-answer-body` | `"\r\n一方"` |
| last 5 | 112 | 242908 | `C final-answer-body` | `"で最終的な回答は、LLMによるテキスト生成が完了し、ユーザーが純粋に必要としている意"` |
| last 5 | 113 | 243107 | `C final-answer-body` | `"味のあるテキストデータそのものです \r\n\u001b[29;120H 。このデータは通常、余計な装飾、動的なカーソル制御、画面消去などのエスケープシーケンスを伴わない、静的でクリーンなテキス\r\n\u001b[29;119Hスト（Markdown形式のコードブロックや文章など）として印字されます。\r\n\nPTY環境の性質上、アプリケーション（この場合は `agy`）から出力されるこれらのプログレス出力と最終回答は、完全に同じ標準出 \r\n\u001b[29;120H 力（…"` |

Relative long evidence paths:

- `.omo/evidence/agy-streaming-minimal/tools/capture-agy-pty.ts`
- `.omo/evidence/agy-streaming-minimal/runs/long/command.json`
- `.omo/evidence/agy-streaming-minimal/runs/long/raw-pty.ndjson`
- `.omo/evidence/agy-streaming-minimal/runs/long/final-raw-reconstructed.txt`
- `.omo/evidence/agy-streaming-minimal/runs/long/final-sanitized-output.txt`
- `.omo/evidence/agy-streaming-minimal/runs/long/exit.json`

### Unresolved unknowns

- These direct PTY captures do not establish whether every `agy` model, prompt length, quota state, or terminal state follows the same timing and chunking pattern.
- The capture records raw PTY byte timing but does not reconstruct the full terminal screen state that a terminal emulator would display after every control sequence.
- The direct PTY captures do not include an OpenCode reproduction and therefore do not directly measure OpenCode JSON event timing.
- No line-erase CSI sequence was observed in these two raw PTY runs, although CR, CSI, OSC, screen clear, and cursor movement were observed.