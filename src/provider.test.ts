import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { createAntigravityCliProvider } from "./provider"
import type { AgyChildProcess, AgySpawn, AgySpawnOptions, LanguageModelV3StreamPart } from "./types"

class FakeAgyChild extends EventEmitter implements AgyChildProcess {
  stdout = new PassThrough()
  stderr = new PassThrough()

  kill() {
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

describe("createAntigravityCliProvider", () => {
  test("creates local AI SDK V3 language models", () => {
    const provider = createAntigravityCliProvider({ command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } })
    const model = provider.languageModel("gemini")

    expect(provider.specificationVersion).toBe("v3")
    expect(model.specificationVersion).toBe("v3")
    expect(model.provider).toBe("antigravity-cli")
    expect(model.supportedUrls).toEqual({})
  })

  test("generate returns stdout text and unknown usage", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.write("provider text")
        child.close(0)
      })
    })
    const provider = createAntigravityCliProvider({ command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } }, { spawn: fake.spawn })
    const result = await provider.languageModel("gemini").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })

    expect(result.content).toEqual([{ type: "text", text: "provider text" }])
    expect(result.usage.inputTokens.total).toBeUndefined()
    expect(result.finishReason).toEqual({ unified: "stop", raw: undefined })
    expect(fake.calls[0].args.at(-1)).toContain("hello")
    expect(fake.calls[0].options.shell).toBe(false)
  })

  test("stream returns text deltas from stdout", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.write("streamed")
        child.close(0)
      })
    })
    const provider = createAntigravityCliProvider({ command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } }, { spawn: fake.spawn })
    const result = await provider.languageModel("gemini").doStream({ prompt: [{ role: "user", content: "hello" }] })
    const parts = await collectStream(result.stream)

    expect(parts).toContainEqual({ type: "text-delta", id: "antigravity-cli-text", delta: "streamed" })
  })

  test("unknown mapped models fail before command launch", async () => {
    const fake = createFakeSpawn()
    const provider = createAntigravityCliProvider({ command: "fake-agy", timeoutMs: 1_000, modelMap: {} }, { spawn: fake.spawn })

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
