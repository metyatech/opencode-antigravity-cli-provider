import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { PromptCleanupError } from "./errors"
import { createAgyTextStream } from "./stream"
import type { AgyPtyDisposable, AgyPtyExitEvent, AgyPtyProcess, AgyPtySpawn, AgyPtySpawnOptions } from "./model-discovery"
import type { LanguageModelV3StreamPart } from "./types"
import type { PromptFileTransport } from "./prompt-transport"

class FakeAgyPty implements AgyPtyProcess {
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(event: AgyPtyExitEvent) => void> = []
  killSignals: Array<string | undefined> = []
  writeCalls: string[] = []

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
  }

  write(data: string) {
    this.writeCalls.push(data)
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

type ManualTimer = ReturnType<typeof setTimeout> & {
  handler: () => void
  timeoutMs: number
  cleared: boolean
}

const createManualTimers = () => {
  const timers: ManualTimer[] = []
  return {
    setTimeout: (handler: () => void, timeoutMs: number) => {
      const timer = { handler, timeoutMs, cleared: false } as ManualTimer
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      const manualTimer = timer as ManualTimer
      manualTimer.cleared = true
    },
    fire: (timeoutMs: number) => {
      const timer = timers.find((candidate) => candidate.timeoutMs === timeoutMs && !candidate.cleared)
      expect(timer).toBeDefined()
      timer?.handler()
    },
  }
}

const expectPromisePending = async <T>(promise: Promise<T>) => {
  let settled = false
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(settled).toBe(false)
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

const createInjectedPromptTransport = (cleanup: () => Promise<void>) => {
  const tempDir = `/tmp/opencode-antigravity-prompt-stream-${Math.random().toString(16).slice(2)}`
  const promptFile = path.join(tempDir, "prompt.txt")
  const transport: PromptFileTransport = {
    tempDir,
    promptFile,
    wrapperPrompt: `Read the prompt file at '${promptFile}' and answer the request written in that file. Treat the file contents as the user's full request. Return only the final answer. Do not summarize or echo the file unless it asks for that.`,
    cleanup,
  }
  return transport
}

describe("createAgyTextStream", () => {
  test("emits the final sanitized PTY output as one text delta and finishes", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("\u001b[2J\u001b[HOK\r\n")
        child.exit(0)
      })
    })

    const parts = await collectStream(
      createAgyTextStream(
        {
          modelId: "gemini-3-5-flash-medium",
          prompt: "hello",
          options: {
            command: "fake-agy",
            timeoutMs: 1_000,
            modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
          },
        },
        { ptySpawn: fake.ptySpawn, platform: "linux" },
      ),
    )

    expect(parts.map((part) => part.type)).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"])
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["OK"])
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop", raw: undefined } })
    expect(fake.calls[0].options.name).toBe("xterm-color")
    expect(existsSync(expectWrapperPrompt(fake.calls[0].args, "hello"))).toBe(false)
    expect(fake.calls[0].args[fake.calls[0].args.indexOf("--model") + 1]).toBe("Gemini 3.5 Flash (Medium)")
  })

  test("propagates interactive setup errors", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("Permission required before use")
        child.exit(1)
      })
    })

    await expect(
      collectStream(
        createAgyTextStream(
          {
            modelId: "gemini-3-5-flash-medium",
            prompt: "hello",
            options: {
              command: "fake-agy",
              timeoutMs: 1_000,
              modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
            },
          },
          { ptySpawn: fake.ptySpawn, platform: "linux" },
        ),
      ),
    ).rejects.toThrow("Run `agy` directly to complete setup")
  })

  test("propagates nonzero exit errors", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("\u001b[31mboom\u001b[0m")
        child.exit(1)
      })
    })

    await expect(
      collectStream(
        createAgyTextStream(
          {
            modelId: "gemini-3-5-flash-medium",
            prompt: "hello",
            options: {
              command: "fake-agy",
              timeoutMs: 1_000,
              modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
            },
          },
          { ptySpawn: fake.ptySpawn, platform: "linux" },
        ),
      ),
    ).rejects.toThrow("Antigravity CLI failed with exit code 1. boom")
  })

  test("reader.cancel waits for child exit and cleanup after requesting cancellation", async () => {
    let markSpawned: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
    const fake = createFakePtySpawn(() => markSpawned())
    const timers = createManualTimers()
    const stream = createAgyTextStream(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello",
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationGraceMs: 25,
      },
    )
    const reader = stream.getReader()

    await reader.read()
    await spawned
    const tempDir = getPromptTempDir(fake.calls[0].args)
    const cancelPromise = reader.cancel()

    await expectPromisePending(cancelPromise)
    expect(fake.calls[0].child.writeCalls).toEqual(["\x03"])
    expect(fake.calls[0].child.killSignals).toEqual([])
    expect(existsSync(tempDir)).toBe(true)
    timers.fire(25)
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
    await expectPromisePending(cancelPromise)
    fake.calls[0].child.exit(1)
    await expect(cancelPromise).resolves.toBeUndefined()
    expect(existsSync(tempDir)).toBe(false)
  })

  test("reader.cancel swallows ordinary AbortError", async () => {
    let markSpawned: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
    const fake = createFakePtySpawn(() => markSpawned())
    const stream = createAgyTextStream(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello ordinary abort",
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )
    const reader = stream.getReader()

    await reader.read()
    await spawned
    const cancelPromise = reader.cancel()
    fake.calls[0].child.exit(1)

    await expect(cancelPromise).resolves.toBeUndefined()
  })

  test("reader.cancel rejects cleanup failure attached to AbortError", async () => {
    let markSpawned: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
    const cleanupError = new Error("stream cleanup failed")
    const fake = createFakePtySpawn(() => markSpawned())
    const stream = createAgyTextStream(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello cleanup cancel failure",
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        createPromptFileTransport: async () => createInjectedPromptTransport(async () => Promise.reject(cleanupError)),
      },
    )
    const reader = stream.getReader()

    await reader.read()
    await spawned
    const cancelPromise = reader.cancel()
    fake.calls[0].child.exit(1)

    await expect(cancelPromise).rejects.toBe(cleanupError)
  })

  test("reader.cancel waits for and rejects direct cleanup failure after command success", async () => {
    let markSpawned: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
    let markCleanupStarted: () => void = () => undefined
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve
    })
    let rejectCleanup: (error: unknown) => void = () => undefined
    const cleanupError = new PromptCleanupError("/tmp/opencode-antigravity-prompt-direct-stream", new Error("rm still busy"))
    const fake = createFakePtySpawn(() => markSpawned())
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason)
    }
    process.on("unhandledRejection", onUnhandledRejection)

    try {
      const stream = createAgyTextStream(
        {
          modelId: "gemini-3-5-flash-medium",
          prompt: "hello direct cleanup race",
          options: {
            command: "fake-agy",
            timeoutMs: 1_000,
            modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
          },
        },
        {
          ptySpawn: fake.ptySpawn,
          platform: "linux",
          createPromptFileTransport: async () =>
            createInjectedPromptTransport(
              () =>
                new Promise<void>((_, reject) => {
                  rejectCleanup = reject
                  markCleanupStarted()
                }),
            ),
        },
      )
      const reader = stream.getReader()

      await reader.read()
      await spawned
      fake.calls[0].child.writeData("OK")
      fake.calls[0].child.exit(0)
      await cleanupStarted
      const cancelPromise = reader.cancel()

      await expectPromisePending(cancelPromise)
      rejectCleanup(cleanupError)

      await expect(cancelPromise).rejects.toBe(cleanupError)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
    }
  })

  test("cancel after child exit resolves without unhandled rejection", async () => {
    let markSpawned: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
    const fake = createFakePtySpawn(() => markSpawned())
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason)
    }
    process.on("unhandledRejection", onUnhandledRejection)

    try {
      const stream = createAgyTextStream(
        {
          modelId: "gemini-3-5-flash-medium",
          prompt: "hello",
          options: {
            command: "fake-agy",
            timeoutMs: 1_000,
            modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
          },
        },
        { ptySpawn: fake.ptySpawn, platform: "linux" },
      )
      const reader = stream.getReader()

      await reader.read()
      await spawned
      fake.calls[0].child.exit(1)
      await expect(reader.cancel()).resolves.toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(unhandledRejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
    }
  })

  test("cancel after streamCancelled ignores later child output and exit", async () => {
    let markSpawned: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
    const onStdoutChunks: string[] = []
    const fake = createFakePtySpawn(() => markSpawned())
    const stream = createAgyTextStream(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello ignored after cancel",
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        onStdout: (chunk) => onStdoutChunks.push(chunk),
      },
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )
    const reader = stream.getReader()

    await reader.read()
    await spawned
    const cancelPromise = reader.cancel()
    fake.calls[0].child.writeData("OK")
    fake.calls[0].child.exit(0)

    await expect(cancelPromise).resolves.toBeUndefined()
    expect(onStdoutChunks).toEqual([])
  })

  test("keeps prompt temp dir until stream cancel cleanup settles", async () => {
    let markSpawned: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
    const fake = createFakePtySpawn(() => markSpawned())
    const timers = createManualTimers()
    const stream = createAgyTextStream(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello temp cleanup",
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationGraceMs: 25,
      },
    )
    const reader = stream.getReader()

    await reader.read()
    await spawned
    const tempDir = getPromptTempDir(fake.calls[0].args)
    const cancelPromise = reader.cancel()

    await expectPromisePending(cancelPromise)
    expect(existsSync(tempDir)).toBe(true)
    timers.fire(25)
    fake.calls[0].child.exit(1)

    await expect(cancelPromise).resolves.toBeUndefined()
    expect(existsSync(tempDir)).toBe(false)
  })

  test("final cleanup fallback resolves stream cancel and removes prompt temp dir", async () => {
    let markSpawned: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
    const fake = createFakePtySpawn(() => markSpawned())
    const timers = createManualTimers()
    const stream = createAgyTextStream(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello final cleanup",
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationGraceMs: 25,
        cancellationForceCleanupMs: 100,
      },
    )
    const reader = stream.getReader()

    await reader.read()
    await spawned
    const tempDir = getPromptTempDir(fake.calls[0].args)
    const cancelPromise = reader.cancel()

    timers.fire(25)
    await expectPromisePending(cancelPromise)
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
    expect(existsSync(tempDir)).toBe(true)

    timers.fire(100)

    await expect(cancelPromise).resolves.toBeUndefined()
    expect(existsSync(tempDir)).toBe(false)
  })

  test("waits for PTY exit when the request abort signal fires", async () => {
    let markSpawned: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
    const fake = createFakePtySpawn(() => markSpawned())
    const timers = createManualTimers()
    const abortController = new AbortController()
    const stream = createAgyTextStream(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello",
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      { ptySpawn: fake.ptySpawn, platform: "linux", setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )
    const reader = stream.getReader()

    await reader.read()
    await spawned
    abortController.abort()

    const read = reader.read()
    await expectPromisePending(read)
    expect(fake.calls[0].child.writeCalls).toEqual(["\x03"])
    expect(fake.calls[0].child.killSignals).toEqual([])

    fake.calls[0].child.exit(1)

    await expect(read).rejects.toThrow("Antigravity CLI call aborted.")
  })
})
