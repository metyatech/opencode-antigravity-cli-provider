import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
  buildAgyModelDiscoveryResult,
  discoverAgyModels,
  parseAgyModelListOutput,
  slugifyAgyModelName,
} from "./model-discovery"
import type { AgyChildProcess, AgySpawn, AgySpawnOptions } from "./types"

class FakeAgyChild extends EventEmitter implements AgyChildProcess {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killSignals: Array<NodeJS.Signals | number | undefined> = []

  kill(signal?: NodeJS.Signals | number) {
    this.killSignals.push(signal)
    queueMicrotask(() => this.emit("close", null, "SIGTERM"))
    return true
  }

  close(code: number | null) {
    this.emit("close", code, null)
  }
}

const createFakeSpawn = (schedule?: (child: FakeAgyChild) => void) => {
  const calls: Array<{ command: string; args: string[]; options: AgySpawnOptions; child: FakeAgyChild }> = []
  const spawn: AgySpawn = (command, args, options) => {
    const child = new FakeAgyChild()
    calls.push({ command, args, options, child })
    schedule?.(child)
    return child
  }

  return { calls, spawn }
}

const actualAgyModelsOutput = `Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.5 Flash (Low)
Gemini 3.1 Pro (Low)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
Claude Opus 4.6 (Thinking)
GPT-OSS 120B (Medium)
`

describe("slugifyAgyModelName", () => {
  test("trims, lowercases, replaces non-alphanumeric runs, and trims dashes", () => {
    expect(slugifyAgyModelName("  Gemini 3.5 Flash (Medium)  ")).toBe("gemini-3-5-flash-medium")
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

    expect(parsed).toEqual([
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.5 Flash (High)",
      "Gemini 3.5 Flash (Low)",
      "Gemini 3.1 Pro (Low)",
      "Gemini 3.1 Pro (High)",
      "Claude Sonnet 4.6 (Thinking)",
      "Claude Opus 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
    ])
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
  test("spawns official agy models with shell false", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.write(actualAgyModelsOutput)
        child.close(0)
      })
    })

    const result = await discoverAgyModels({ command: "fake-agy", timeoutMs: 1_000, cwd: ".", env: { AGY_TEST_ENV: "1" } }, { spawn: fake.spawn })

    expect(result.discovered).toHaveLength(8)
    expect(fake.calls[0].command).toBe("fake-agy")
    expect(fake.calls[0].args).toEqual(["models"])
    expect(fake.calls[0].options.shell).toBe(false)
    expect(fake.calls[0].options.env.AGY_TEST_ENV).toBe("1")
  })

  test("fails fast on interactive prompts and kills the child", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => child.stderr.write("Please sign in to continue"))
    })

    await expect(discoverAgyModels({ command: "fake-agy", timeoutMs: 1_000 }, { spawn: fake.spawn })).rejects.toThrow("Run `agy` directly to complete setup")
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
  })

  test("kills the child on timeout", async () => {
    const fake = createFakeSpawn()
    const discovery = discoverAgyModels(
      { command: "fake-agy", timeoutMs: 1_000 },
      {
        spawn: fake.spawn,
        setTimeout: (handler) => {
          queueMicrotask(() => handler())
          return 1 as unknown as ReturnType<typeof setTimeout>
        },
        clearTimeout: () => undefined,
      },
    )

    await expect(discovery).rejects.toThrow("Antigravity CLI timed out after 1000ms.")
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
  })

  test("propagates nonzero exit diagnostics", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stderr.write("flags provided but not defined: -json")
        child.close(1)
      })
    })

    await expect(discoverAgyModels({ command: "fake-agy", timeoutMs: 1_000 }, { spawn: fake.spawn })).rejects.toThrow(
      "Antigravity CLI failed with exit code 1. flags provided but not defined: -json",
    )
  })
})
