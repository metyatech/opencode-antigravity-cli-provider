import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { createAgyTextStream } from "./stream"
import type { AgyChildProcess, AgySpawn, AgySpawnOptions, LanguageModelV3StreamPart } from "./types"

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

describe("createAgyTextStream", () => {
  test("emits stdout chunks as text deltas and finishes with unknown usage", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.write("hello ")
        child.stdout.write("world")
        child.close(0)
      })
    })

    const parts = await collectStream(
      createAgyTextStream({ modelId: "gemini", prompt: "hello", options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } } }, { spawn: fake.spawn }),
    )

    expect(parts.map((part) => part.type)).toEqual(["stream-start", "text-start", "text-delta", "text-delta", "text-end", "finish"])
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["hello ", "world"])
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop", raw: undefined } })
    expect(fake.calls[0].options.shell).toBe(false)
  })

  test("propagates interactive setup errors", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => child.stderr.write("Permission required before use"))
    })

    await expect(
      collectStream(createAgyTextStream({ modelId: "gemini", prompt: "hello", options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } } }, { spawn: fake.spawn })),
    ).rejects.toThrow(
      "Run `agy` directly to complete setup",
    )
  })

  test("kills the child when the stream reader cancels", async () => {
    const fake = createFakeSpawn()
    const stream = createAgyTextStream({ modelId: "gemini", prompt: "hello", options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { gemini: "Gemini" } } }, { spawn: fake.spawn })
    const reader = stream.getReader()

    await reader.read()
    await reader.cancel()

    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
  })
})
