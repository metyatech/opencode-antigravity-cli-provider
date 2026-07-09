import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildAgyModelDiscoveryResult,
  discoverAgyModels,
  parseAgyModelListOutput,
  resolveAgyExecutable,
  sanitizeAgyModelsPtyOutput,
  slugifyAgyModelName,
} from "./model-discovery"
import type { AgyPtyDisposable, AgyPtyProcess, AgyPtySpawn, AgyPtySpawnOptions, AgyPtyExitEvent } from "./model-discovery"

class FakeAgyPty implements AgyPtyProcess {
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(event: AgyPtyExitEvent) => void> = []
  killSignals: Array<string | undefined> = []
  releaseEvents: string[] = []
  _agent = {
    _inSocket: { destroy: () => this.releaseEvents.push("in") },
    _outSocket: { destroy: () => this.releaseEvents.push("out") },
    _conoutSocketWorker: { dispose: () => this.releaseEvents.push("worker") },
  }

  onData(listener: (data: string) => void): AgyPtyDisposable {
    this.dataListeners.push(listener)
    return { dispose: () => this.removeDataListener(listener) }
  }

  onExit(listener: (event: AgyPtyExitEvent) => void): AgyPtyDisposable {
    this.exitListeners.push(listener)
    return { dispose: () => this.removeExitListener(listener) }
  }

  kill(signal?: string) {
    this.killSignals.push(signal)
    queueMicrotask(() => this.exit(1))
  }

  writeData(data: string) {
    for (const listener of [...this.dataListeners]) {
      listener(data)
    }
  }

  exit(exitCode: number) {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode })
    }
  }

  private removeDataListener(listener: (data: string) => void) {
    this.dataListeners = this.dataListeners.filter((candidate) => candidate !== listener)
  }

  private removeExitListener(listener: (event: AgyPtyExitEvent) => void) {
    this.exitListeners = this.exitListeners.filter((candidate) => candidate !== listener)
  }
}

const createFakePtySpawn = (schedule?: (child: FakeAgyPty) => void) => {
  const calls: Array<{ command: string; args: string[]; options: AgyPtySpawnOptions; child: FakeAgyPty }> = []
  const ptySpawn: AgyPtySpawn = (command, args, options) => {
    const child = new FakeAgyPty()
    calls.push({ command, args, options, child })
    schedule?.(child)
    return child
  }

  return { calls, ptySpawn }
}

const actualAgyModelNames = [
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Low)",
  "Gemini 3.1 Pro (Low)",
  "Gemini 3.1 Pro (High)",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
  "GPT-OSS 120B (Medium)",
]

const actualAgyModelsOutput = `${actualAgyModelNames.join("\n")}\n`

const ptyAgyModelsOutput = `\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[H⠋ Fetching available models...\u001b]0;C:\\Users\\Origin\\AppData\\Local\\agy\\bin\\agy.exe\u0007\u001b[H\u001b[K${actualAgyModelNames[0]}\r\n${actualAgyModelNames[1]}\r\n\u001b[32m${actualAgyModelNames[2]}\u001b[0m\r\n${actualAgyModelNames[3]}\r\n${actualAgyModelNames[4]}\r\n${actualAgyModelNames[5]}\r\n${actualAgyModelNames[6]}\r\n\u001b[K${actualAgyModelNames[7]}\r\n\u001b[?25h\n`

// Regression: real `agy models` emits the first model line, then a spinner
// redraws the same PTY row using a bare `\r`. A sanitizer that collapses to
// the last `\r`-separated segment (`.at(-1)`) drops the model line. Bare `\r`
// must be treated as a line break so both fragments are evaluated, with the
// spinner fragment then filtered out by `fetchingOrSpinnerPattern`.
const ptyAgyModelsBareCrFixture = `\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[H⠋ Fetching available models...\u001b]0;C:\\Users\\Origin\\AppData\\Local\\agy\\bin\\agy.exe\u0007\u001b[H\u001b[K${actualAgyModelNames[0]}\r⠋ Fetching available models...\rFetched 8 models\r\n\u001b[K${actualAgyModelNames[1]}\r\n${actualAgyModelNames[2]}\n${actualAgyModelNames[3]}\r\n${actualAgyModelNames[4]}\n${actualAgyModelNames[5]}\n${actualAgyModelNames[6]}\n${actualAgyModelNames[7]}\u001b[?25h\n`

const withTempDirectory = (callback: (directory: string) => void) => {
  const directory = mkdtempSync(path.join(tmpdir(), "agy-resolve-"))
  try {
    callback(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("slugifyAgyModelName", () => {
  test("trims, lowercases, replaces non-alphanumeric runs, and trims dashes", () => {
    expect(slugifyAgyModelName("  Gemini 3.5 Flash (Medium)  ")).toBe("gemini-3-5-flash-medium")
  })
})

describe("resolveAgyExecutable", () => {
  test("finds agy.exe from PATH and PATHEXT on Windows", () => {
    withTempDirectory((directory) => {
      const executable = path.join(directory, "agy.exe")
      writeFileSync(executable, "")
      const env: NodeJS.ProcessEnv = { PATH: directory, PATHEXT: ".CMD;.EXE" }

      expect(resolveAgyExecutable("agy", env, "win32")).toBe(executable)
    })
  })

  test("prefers agy.exe over agy.cmd when both exist", () => {
    withTempDirectory((directory) => {
      const cmd = path.join(directory, "agy.cmd")
      const exe = path.join(directory, "agy.exe")
      writeFileSync(cmd, "")
      writeFileSync(exe, "")
      const env: NodeJS.ProcessEnv = { PATH: directory, PATHEXT: ".CMD;.EXE" }

      expect(resolveAgyExecutable("agy", env, "win32")).toBe(exe)
    })
  })

  test("preserves explicit paths", () => {
    expect(resolveAgyExecutable("C:\\tools\\agy.cmd", {}, "win32")).toBe("C:\\tools\\agy.cmd")
    expect(resolveAgyExecutable("./bin/agy", {}, "linux")).toBe("./bin/agy")
  })
})

describe("sanitizeAgyModelsPtyOutput", () => {
  test("removes ANSI, OSC title, BEL, spinner/fetching lines, carriage returns, and residue", () => {
    const sanitized = sanitizeAgyModelsPtyOutput(ptyAgyModelsOutput)
    expect(sanitized.split("\n")).toEqual(actualAgyModelNames)
    expect(parseAgyModelListOutput(sanitized)).toEqual(actualAgyModelNames)
  })

  test("preserves the first model line when a bare-CR spinner redraws the same PTY row", () => {
    // Under the previous last-segment sanitizer, the first model line would
    // be replaced by the trailing spinner fragment and dropped by the
    // spinner filter. The new sanitizer splits bare `\r` into new lines so
    // the model line is preserved and the spinner fragment is filtered out.
    const sanitized = sanitizeAgyModelsPtyOutput(ptyAgyModelsBareCrFixture)
    expect(sanitized.split("\n")).toEqual(actualAgyModelNames)
    expect(sanitized).toContain("Gemini 3.5 Flash (Medium)")
  })
})

describe("buildAgyModelDiscoveryResult", () => {
  test("deduplicates duplicate slugs with -2 and -3 suffixes", () => {
    const result = buildAgyModelDiscoveryResult(["Model A", "Model-A", "Model A"])

    expect(result.discovered.map((model) => model.id)).toEqual(["model-a", "model-a-2", "model-a-3"])
    expect(result.modelMap).toEqual({ "model-a": "Model A", "model-a-2": "Model-A", "model-a-3": "Model A" })
  })

  test("excludes entries with empty slugs", () => {
    const result = buildAgyModelDiscoveryResult(["!!!", "Gemini"])

    expect(result.discovered).toEqual([{ id: "gemini", name: "Gemini", agyModel: "Gemini" }])
    expect(result.models).toEqual({ gemini: { name: "Gemini" } })
  })
})

describe("parseAgyModelListOutput", () => {
  test("parses the real agy models stdout fixture conservatively", () => {
    const parsed = parseAgyModelListOutput(actualAgyModelsOutput)
    const result = buildAgyModelDiscoveryResult(parsed)

    expect(parsed).toEqual(actualAgyModelNames)
    expect(result.discovered[0]).toEqual({
      id: "gemini-3-5-flash-medium",
      name: "Gemini 3.5 Flash (Medium)",
      agyModel: "Gemini 3.5 Flash (Medium)",
    })
    expect(result.modelMap["gemini-3-5-flash-medium"]).toBe("Gemini 3.5 Flash (Medium)")
  })

  test("ignores blanks, help text, headings, footers, and list prefixes", () => {
    const result = parseAgyModelListOutput(`Usage: agy.exe models [flags]

List available models
Flags:
  -h      Show help
Models:
1. Gemini 3.5 Flash (Medium)
- Claude Sonnet 4.6 (Thinking)
[exit=0]
`)

    expect(result).toEqual(["Gemini 3.5 Flash (Medium)", "Claude Sonnet 4.6 (Thinking)"])
  })
})

describe("discoverAgyModels", () => {
  test("spawns official agy models through PTY with terminal dimensions and environment", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData(actualAgyModelsOutput)
        child.exit(0)
      })
    })

    const result = await discoverAgyModels({ command: "fake-agy", timeoutMs: 1_000, cwd: ".", env: { AGY_TEST_ENV: "1" } }, { ptySpawn: fake.ptySpawn, platform: "linux" })

    expect(result.discovered).toHaveLength(8)
    expect(fake.calls[0].command).toBe("fake-agy")
    expect(fake.calls[0].args).toEqual(["models"])
    expect(fake.calls[0].options.name).toBe("xterm-color")
    expect(fake.calls[0].options.cols).toBe(120)
    expect(fake.calls[0].options.rows).toBe(30)
    expect(fake.calls[0].options.env.AGY_TEST_ENV).toBe("1")
  })

  test("discovers PTY output after sanitizing spinner and terminal control sequences", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData(ptyAgyModelsOutput)
        child.exit(0)
      })
    })

    const result = await discoverAgyModels({ command: "fake-agy", timeoutMs: 1_000 }, { ptySpawn: fake.ptySpawn, platform: "linux" })

    expect(result.discovered).toHaveLength(8)
    expect(result.modelMap).toMatchObject({
      "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)",
      "claude-opus-4-6-thinking": "Claude Opus 4.6 (Thinking)",
      "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
    })
  })

  test("releases Windows PTY internals after successful discovery", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData(actualAgyModelsOutput)
        child.exit(0)
      })
    })

    await discoverAgyModels({ command: "./fake-agy", timeoutMs: 1_000 }, { ptySpawn: fake.ptySpawn, platform: "win32" })

    expect(fake.calls[0].child.releaseEvents).toEqual(["in", "out", "worker"])
  })

  test("preserves the first model line when bare-CR spinner redraws the same PTY row", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData(ptyAgyModelsBareCrFixture)
        child.exit(0)
      })
    })

    const result = await discoverAgyModels({ command: "fake-agy", timeoutMs: 1_000 }, { ptySpawn: fake.ptySpawn, platform: "linux" })

    expect(result.discovered).toHaveLength(8)
    expect(result.discovered.map((model) => model.id)).toEqual([
      "gemini-3-5-flash-medium",
      "gemini-3-5-flash-high",
      "gemini-3-5-flash-low",
      "gemini-3-1-pro-low",
      "gemini-3-1-pro-high",
      "claude-sonnet-4-6-thinking",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ])
    expect(result.modelMap["gemini-3-5-flash-medium"]).toBe("Gemini 3.5 Flash (Medium)")
  })

  test("fails fast on interactive prompts and kills the PTY child", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => child.writeData("Please sign in to continue"))
    })

    await expect(discoverAgyModels({ command: "./fake-agy", timeoutMs: 1_000 }, { ptySpawn: fake.ptySpawn, platform: "win32" })).rejects.toThrow(
      "Run `agy` directly to complete setup",
    )
    expect(fake.calls[0].child.killSignals).toEqual([undefined])
  })

  test("kills the PTY child on timeout", async () => {
    const fake = createFakePtySpawn()
    const discovery = discoverAgyModels(
      { command: "./fake-agy", timeoutMs: 1_000 },
      {
        ptySpawn: fake.ptySpawn,
        platform: "win32",
        setTimeout: (handler) => {
          queueMicrotask(() => handler())
          return setTimeout(() => undefined, 0)
        },
        clearTimeout: () => undefined,
      },
    )

    await expect(discovery).rejects.toThrow("Antigravity CLI timed out after 1000ms.")
    expect(fake.calls[0].child.killSignals).toEqual([undefined])
  })

  test("propagates nonzero exit diagnostics", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("flags provided but not defined: -json")
        child.exit(1)
      })
    })

    await expect(discoverAgyModels({ command: "fake-agy", timeoutMs: 1_000 }, { ptySpawn: fake.ptySpawn, platform: "linux" })).rejects.toThrow(
      "Antigravity CLI failed with exit code 1. flags provided but not defined: -json",
    )
  })
})
