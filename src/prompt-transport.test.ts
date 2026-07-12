import { describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PromptCleanupError } from "./errors"
import { createPromptFileTransport } from "./prompt-transport"
import type { Stats } from "node:fs"

const nodeError = (code: string) => Object.assign(new Error(code), { code })
const statSuccess = {} as Stats

const withTransport = async (callback: (transport: Awaited<ReturnType<typeof createPromptFileTransport>>) => Promise<void>) => {
  const transport = await createPromptFileTransport("hello")
  try {
    await callback(transport)
  } finally {
    rmSync(transport.tempDir, { recursive: true, force: true })
  }
}

describe("createPromptFileTransport", () => {
  test("writes the rendered prompt to an OS-temp UTF-8 prompt.txt", async () => {
    const renderedPrompt = "system: follow instructions\nuser: こんにちは 🌱"
    const transport = await createPromptFileTransport(renderedPrompt)

    try {
      expect(transport.tempDir.startsWith(path.join(os.tmpdir(), "opencode-antigravity-prompt-"))).toBe(true)
      expect(transport.promptFile).toBe(path.join(transport.tempDir, "prompt.txt"))
      expect(transport.logFile).toBe(path.join(transport.tempDir, "agy.log"))
      expect(transport.wrapperPrompt).toContain(transport.promptFile)
      expect(transport.wrapperPrompt).toContain(`Read the prompt file at '${transport.promptFile}'`)
      expect(transport.wrapperPrompt).toContain("answer the request written in that file")
      expect(transport.wrapperPrompt).toContain("file contents as the user's full request")
      expect(transport.wrapperPrompt).toContain("Return only the final answer")
      expect(transport.wrapperPrompt).toContain("Do not summarize or echo the file unless it asks for that")
      expect(transport.wrapperPrompt).not.toContain("Read this exact file")
      expect(transport.wrapperPrompt).not.toContain("complete OpenCode conversation/user request")
      await expect(readFile(transport.promptFile, "utf8")).resolves.toBe(renderedPrompt)
      await expect(readFile(transport.logFile, "utf8")).resolves.toBe("")
    } finally {
      await transport.cleanup()
    }
  })

  test("wrapper names the prompt file without embedding long prompt bodies", async () => {
    const longPrompt = `BODY_MARKER_${"x".repeat(100_000)}`
    const transport = await createPromptFileTransport(longPrompt)

    try {
      expect(transport.wrapperPrompt).toContain(transport.promptFile)
      expect(transport.wrapperPrompt).not.toContain(longPrompt)
      expect(transport.wrapperPrompt).not.toContain("BODY_MARKER_")
      expect(transport.wrapperPrompt.length).toBeLessThan(512)
      await expect(readFile(transport.promptFile, "utf8")).resolves.toBe(longPrompt)
    } finally {
      await transport.cleanup()
    }
  })

  test("normal cleanup removes the temp directory", async () => {
    const transport = await createPromptFileTransport("hello")

    expect(existsSync(transport.tempDir)).toBe(true)
    expect(existsSync(transport.promptFile)).toBe(true)
    expect(existsSync(transport.logFile)).toBe(true)
    await transport.cleanup()

    expect(existsSync(transport.tempDir)).toBe(false)
    expect(existsSync(transport.promptFile)).toBe(false)
    expect(existsSync(transport.logFile)).toBe(false)
  })

  test("successful cleanup is idempotent", async () => {
    let rmCalls = 0
    let statCalls = 0
    await withTransport(async (transport) => {
      const cleanupTransport = await createPromptFileTransport("hello", {
        rm: async () => {
          rmCalls += 1
        },
        stat: async () => {
          statCalls += 1
          throw nodeError("ENOENT")
        },
      })
      try {
        await cleanupTransport.cleanup()
        await cleanupTransport.cleanup()
      } finally {
        rmSync(cleanupTransport.tempDir, { recursive: true, force: true })
      }

      expect(transport.tempDir).toContain("opencode-antigravity-prompt-")
    })

    expect(rmCalls).toBe(1)
    expect(statCalls).toBe(1)
  })

  test("transient EPERM and EBUSY cleanup errors are retried", async () => {
    const rmCodes = ["EPERM", "EBUSY"]
    const delays: number[] = []
    const transport = await createPromptFileTransport("hello", {
      rm: async () => {
        const code = rmCodes.shift()
        if (code !== undefined) {
          throw nodeError(code)
        }
      },
      stat: async () => {
        throw nodeError("ENOENT")
      },
      delay: async (ms) => {
        delays.push(ms)
      },
      attempts: 4,
      retryDelayMs: 100,
    })

    try {
      await transport.cleanup()
    } finally {
      rmSync(transport.tempDir, { recursive: true, force: true })
    }

    expect(delays).toEqual([100, 100])
  })

  test("cleanup succeeds after a transient retry", async () => {
    let rmCalls = 0
    const transport = await createPromptFileTransport("hello", {
      rm: async () => {
        rmCalls += 1
        if (rmCalls === 1) {
          throw nodeError("EPERM")
        }
      },
      stat: async () => {
        throw nodeError("ENOENT")
      },
      delay: async () => undefined,
      attempts: 3,
      retryDelayMs: 100,
    })

    try {
      await transport.cleanup()
    } finally {
      rmSync(transport.tempDir, { recursive: true, force: true })
    }

    expect(rmCalls).toBe(2)
  })

  test("rm success but stat still sees the directory causes a retry", async () => {
    let rmCalls = 0
    let statCalls = 0
    const transport = await createPromptFileTransport("hello", {
      rm: async () => {
        rmCalls += 1
      },
      stat: async () => {
        statCalls += 1
        if (statCalls === 1) {
          return statSuccess
        }
        throw nodeError("ENOENT")
      },
      delay: async () => undefined,
      attempts: 3,
      retryDelayMs: 100,
    })

    try {
      await transport.cleanup()
    } finally {
      rmSync(transport.tempDir, { recursive: true, force: true })
    }

    expect(rmCalls).toBe(2)
    expect(statCalls).toBe(2)
  })

  test("ENOENT during rm is cleanup success", async () => {
    let statCalls = 0
    const transport = await createPromptFileTransport("hello", {
      rm: async () => {
        throw nodeError("ENOENT")
      },
      stat: async () => {
        statCalls += 1
        throw nodeError("ENOENT")
      },
    })

    try {
      await transport.cleanup()
    } finally {
      rmSync(transport.tempDir, { recursive: true, force: true })
    }

    expect(statCalls).toBe(0)
  })

  test("persistent cleanup failure throws", async () => {
    let rmCalls = 0
    const rmError = nodeError("EPERM")
    const transport = await createPromptFileTransport("hello", {
      rm: async () => {
        rmCalls += 1
        throw rmError
      },
      stat: async () => statSuccess,
      delay: async () => undefined,
      attempts: 2,
      retryDelayMs: 100,
    })

    try {
      try {
        await transport.cleanup()
        throw new Error("Expected cleanup to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(PromptCleanupError)
        expect(error).toMatchObject({
          name: "PromptCleanupError",
          tempDir: transport.tempDir,
          cause: rmError,
        })
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain(transport.tempDir)
      }
    } finally {
      rmSync(transport.tempDir, { recursive: true, force: true })
    }

    expect(rmCalls).toBe(2)
  })

  test("cleanup can be retried after failure", async () => {
    let rmCalls = 0
    const transport = await createPromptFileTransport("hello", {
      rm: async () => {
        rmCalls += 1
        if (rmCalls === 1) {
          throw nodeError("EPERM")
        }
      },
      stat: async () => {
        throw nodeError("ENOENT")
      },
      delay: async () => undefined,
      attempts: 1,
      retryDelayMs: 100,
    })

    try {
      await expect(transport.cleanup()).rejects.toThrow("Prompt cleanup failed")
      await expect(transport.cleanup()).resolves.toBeUndefined()
    } finally {
      rmSync(transport.tempDir, { recursive: true, force: true })
    }

    expect(rmCalls).toBe(2)
  })

  test("concurrent cleanup calls share in-flight work", async () => {
    let finishRm: () => void = () => undefined
    const rmStarted = new Promise<void>((resolve) => {
      finishRm = resolve
    })
    let rmCalls = 0
    const transport = await createPromptFileTransport("hello", {
      rm: async () => {
        rmCalls += 1
        await rmStarted
      },
      stat: async () => {
        throw nodeError("ENOENT")
      },
    })

    try {
      const first = transport.cleanup()
      const second = transport.cleanup()
      expect(rmCalls).toBe(1)
      finishRm()
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    } finally {
      rmSync(transport.tempDir, { recursive: true, force: true })
    }

    expect(rmCalls).toBe(1)
  })

  test("cleanup removes the temp directory and is safe to call repeatedly", async () => {
    const transport = await createPromptFileTransport("hello")

    expect(existsSync(transport.tempDir)).toBe(true)
    await transport.cleanup()
    await transport.cleanup()

    expect(existsSync(transport.tempDir)).toBe(false)
  })
})
