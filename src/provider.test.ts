import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { createAntigravityCliProvider } from "./provider"
import type { AgyPtyDisposable, AgyPtyExitEvent, AgyPtyProcess, AgyPtySpawn, AgyPtySpawnOptions } from "./model-discovery"
import type { LanguageModelV3StreamPart } from "./types"

class FakeAgyPty implements AgyPtyProcess {
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(event: AgyPtyExitEvent) => void> = []
  killSignals: Array<string | undefined> = []

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

const collectStream = async (stream: ReadableStream<LanguageModelV3StreamPart>) => {
  const reader = stream.getReader()
  const parts: LanguageModelV3StreamPart[] = []

  while (true) {
    const result = await reader.read()
    if (result.done) {
      return parts
    }

    parts.push(result.value)
  }
}

const getPromptTempDir = (args: string[]) => {
  const addDirIndex = args.indexOf("--add-dir")
  expect(addDirIndex).toBeGreaterThanOrEqual(0)
  return args[addDirIndex + 1]
}

const expectWrapperPrompt = (args: string[], promptBody: string) => {
  const tempDir = getPromptTempDir(args)
  const wrapperPrompt = args.at(-1)
  const promptFile = path.join(tempDir, "prompt.txt")

  expect(wrapperPrompt).toContain(promptFile)
  expect(wrapperPrompt).toContain(`Read the prompt file at '${promptFile}'`)
  expect(wrapperPrompt).toContain("answer the request written in that file")
  expect(wrapperPrompt).toContain("file contents as the user's full request")
  expect(wrapperPrompt).toContain("Return only the final answer")
  expect(wrapperPrompt).toContain("Do not summarize or echo the file unless it asks for that")
  expect(wrapperPrompt).not.toContain(promptBody)
  expect(JSON.stringify(args)).not.toContain(promptBody)

  return tempDir
}

describe("createAntigravityCliProvider", () => {
  test("creates local AI SDK V3 language models", () => {
    const provider = createAntigravityCliProvider({ command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } })
    const model = provider.languageModel("gemini")

    expect(provider.specificationVersion).toBe("v3")
    expect(model.specificationVersion).toBe("v3")
    expect(model.provider).toBe("antigravity-cli")
    expect(model.supportedUrls).toEqual({})
  })

  test("generate returns sanitized PTY stdout text and unknown usage", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("\u001b[2J\u001b[HOK\r\n")
        child.exit(0)
      })
    })
    const provider = createAntigravityCliProvider({ command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } }, { ptySpawn: fake.ptySpawn, platform: "linux" })
    const result = await provider.languageModel("gemini").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })

    expect(result.content).toEqual([{ type: "text", text: "OK" }])
    expect(result.usage.inputTokens.total).toBeUndefined()
    expect(result.finishReason).toEqual({ unified: "stop", raw: undefined })
    expect(existsSync(expectWrapperPrompt(fake.calls[0].args, "hello"))).toBe(false)
    expect(fake.calls[0].options.name).toBe("xterm-color")
  })

  test("stream returns the final sanitized PTY text delta", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("\u001b[2J\u001b[Hstreamed\r\n")
        child.exit(0)
      })
    })
    const provider = createAntigravityCliProvider({ command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } }, { ptySpawn: fake.ptySpawn, platform: "linux" })
    const result = await provider.languageModel("gemini").doStream({ prompt: [{ role: "user", content: "hello" }] })
    const parts = await collectStream(result.stream)

    expect(parts).toContainEqual({ type: "text-delta", id: "antigravity-cli-text", delta: "streamed" })
  })

  test("unknown mapped models fail before command launch", async () => {
    const fake = createFakePtySpawn()
    const provider = createAntigravityCliProvider({ command: "fake-agy", timeoutMs: 1_000, modelMap: {} }, { ptySpawn: fake.ptySpawn })

    await expect(provider.languageModel("missing").doGenerate({ prompt: [{ role: "user", content: "hello" }] })).rejects.toThrow("No Antigravity CLI model mapping configured")
    expect(fake.calls).toHaveLength(0)
  })

  test("non-language models are explicitly unsupported", () => {
    const provider = createAntigravityCliProvider({ command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } })

    expect(() => provider.embeddingModel("default")).toThrow("does not support embedding model")
    expect(() => provider.imageModel("default")).toThrow("does not support image model")
  })

  test("only createAntigravityCliProvider is exported as a create* named export", async () => {
    const mod = await import("./provider")
    const createExports = Object.keys(mod).filter((key) => key.startsWith("create")).sort()
    expect(createExports).toEqual(["createAntigravityCliProvider"])
  })

  test("loader simulation: first create* key returns a v3 provider", async () => {
    interface LoaderSimulationResult {
      specificationVersion: string
      languageModel: (modelId: string) => { provider: string }
    }

    const mod = await import("./provider")
    const firstCreateKey = Object.keys(mod).find((key) => key.startsWith("create"))!
    const createFn = mod[firstCreateKey as keyof typeof mod] as (options: object) => LoaderSimulationResult
    const provider = createFn({ command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } })

    expect(provider.specificationVersion).toBe("v3")
    expect(typeof provider.languageModel).toBe("function")
    expect(provider.languageModel("gemini").provider).toBe("antigravity-cli")
  })
})
