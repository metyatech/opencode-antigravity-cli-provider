import { describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildAgyCommandInvocation, runAgyCommand, sanitizeAgyGenerationPtyOutput } from "./agy-command"
import { AntigravityCliTimeoutError, getPromptCleanupError } from "./errors"
import type { AgyPtyDisposable, AgyPtyExitEvent, AgyPtyProcess, AgyPtySpawn, AgyPtySpawnOptions } from "./model-discovery"
import type { PromptFileTransport } from "./prompt-transport"
import type { AgyProgressMonitor, AgyTerminalOutputParser } from "./types"

class FakeAgyPty implements AgyPtyProcess {
  pid?: number
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(event: AgyPtyExitEvent) => void> = []
  killSignals: Array<string | undefined> = []
  writeCalls: string[] = []
  disposeEvents: string[] = []
  releaseEvents: string[] = []
  _agent = {
    _inSocket: { destroy: () => this.releaseEvents.push("in") },
    _outSocket: { destroy: () => this.releaseEvents.push("out") },
    _conoutSocketWorker: { dispose: () => this.releaseEvents.push("worker") },
  }

  onData(listener: (data: string) => void): AgyPtyDisposable {
    this.dataListeners.push(listener)
    return {
      dispose: () => {
        this.disposeEvents.push("data")
        this.removeDataListener(listener)
      },
    }
  }

  onExit(listener: (event: AgyPtyExitEvent) => void): AgyPtyDisposable {
    this.exitListeners.push(listener)
    return {
      dispose: () => {
        this.disposeEvents.push("exit")
        this.removeExitListener(listener)
      },
    }
  }

  write(data: string) {
    this.writeCalls.push(data)
  }

  kill(signal?: string) {
    this.killSignals.push(signal)
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

const createFakePtySpawn = (schedule?: (child: FakeAgyPty, call: { command: string; args: string[]; options: AgyPtySpawnOptions; child: FakeAgyPty }) => void) => {
  const calls: Array<{ command: string; args: string[]; options: AgyPtySpawnOptions; child: FakeAgyPty }> = []
  const ptySpawn: AgyPtySpawn = (command, args, options) => {
    const child = new FakeAgyPty()
    const call = { command, args, options, child }
    calls.push(call)
    schedule?.(child, call)
    return child
  }

  return { calls, ptySpawn }
}

const withTempDirectory = async (callback: (directory: string) => Promise<void>) => {
  const directory = mkdtempSync(path.join(tmpdir(), "agy-generation-resolve-"))
  try {
    await callback(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const generationFixture = "\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[HOK\u001b]0;C:\\Users\\Origin\\AppData\\Local\\agy\\bin\\agy.exe\u0007\u001b[?25h\r\n"

const listPromptTempDirs = () => new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("opencode-antigravity-prompt-")))

type ManualTimer = ReturnType<typeof setTimeout> & {
  handler: () => void
  timeoutMs: number
  cleared: boolean
}

const createManualTimers = () => {
  const timers: ManualTimer[] = []
  return {
    timers,
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

const waitForSpawn = async (calls: Array<unknown>) => {
  for (let attempt = 0; attempt < 10 && calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(calls).toHaveLength(1)
}

const waitForWrite = async (child: FakeAgyPty) => {
  for (let attempt = 0; attempt < 20 && child.writeCalls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(child.writeCalls).toContain("\x03")
}

const waitForManualTimer = async (timers: ReturnType<typeof createManualTimers>, timeoutMs: number) => {
  for (let attempt = 0; attempt < 20 && !timers.timers.some((timer) => timer.timeoutMs === timeoutMs && !timer.cleared); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  timers.fire(timeoutMs)
}

const waitForCondition = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 30 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(condition()).toBe(true)
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

const getPromptTempDir = (args: string[]) => {
  const addDirIndex = args.indexOf("--add-dir")
  expect(addDirIndex).toBeGreaterThanOrEqual(0)
  return args[addDirIndex + 1]
}

const expectFilePromptArgs = (args: string[], agyModel: string, longPrompt: string) => {
  const tempDir = getPromptTempDir(args)
  const promptIndex = args.indexOf("-p")
  const promptFile = path.join(tempDir, "prompt.txt")
  const wrapperPrompt = args[promptIndex + 1]

  expect(args).toContain("--add-dir")
  expect(args).toContain("--model")
  expect(args[args.indexOf("--model") + 1]).toBe(agyModel)
  expect(promptIndex).toBeGreaterThanOrEqual(0)
  expect(wrapperPrompt).toContain(promptFile)
  expect(wrapperPrompt).toContain(`Read the prompt file at '${promptFile}'`)
  expect(wrapperPrompt).toContain("answer the request written in that file")
  expect(wrapperPrompt).toContain("file contents as the user's full request")
  expect(wrapperPrompt).toContain("Return only the final answer")
  expect(wrapperPrompt).toContain("Do not summarize or echo the file unless it asks for that")
  expect(wrapperPrompt).not.toContain("Read this exact file")
  expect(wrapperPrompt).not.toContain("complete OpenCode conversation/user request")
  expect(wrapperPrompt.length).toBeLessThan(promptFile.length + 240)
  expect(wrapperPrompt).not.toContain(longPrompt)
  expect(args).not.toContain(longPrompt)
  expect(JSON.stringify(args)).not.toContain(longPrompt)
  expect(args).not.toContain("--prompt-file")
  expect(args).not.toContain("@prompt.txt")
  expect(path.basename(promptFile)).toBe("prompt.txt")

  return tempDir
}

const createInjectedPromptTransport = (cleanup: () => Promise<void> = async () => undefined) => {
  const tempDir = path.join(tmpdir(), `opencode-antigravity-prompt-injected-${Math.random().toString(16).slice(2)}`)
  const promptFile = path.join(tempDir, "prompt.txt")
  const logFile = path.join(tempDir, "agy.log")
  const transport: PromptFileTransport = {
    tempDir,
    promptFile,
    logFile,
    wrapperPrompt: `Read the prompt file at '${promptFile}' and answer the request written in that file. Treat the file contents as the user's full request. Return only the final answer. Do not summarize or echo the file unless it asks for that.`,
    cleanup,
  }
  return transport
}

describe("sanitizeAgyGenerationPtyOutput", () => {
  test("removes terminal control sequences from the observed agy generation fixture", () => {
    expect(sanitizeAgyGenerationPtyOutput(generationFixture)).toBe("OK")
  })

  test("preserves normal generated Japanese text while trimming outer blank lines", () => {
    expect(sanitizeAgyGenerationPtyOutput("\r\n  こんにちは\n世界  \r\n")).toBe("こんにちは\n世界")
  })
})

describe("buildAgyCommandInvocation", () => {
  test("preserves direct prompt args for legacy invocation tests", () => {
    const invocation = buildAgyCommandInvocation({
      modelId: "workspace-pro",
      prompt: "hello",
      options: {
        command: "fake-agy",
        timeoutMs: 1_000,
        modelMap: { "workspace-pro": "exact-agy-model" },
        extraArgs: ["--verbose"],
      },
    })

    expect(invocation.command).toBe("fake-agy")
    expect(invocation.args).toEqual(["--verbose", "--model", "exact-agy-model", "-p", "hello"])
  })

  test("builds file transport args with add-dir and wrapper prompt", () => {
    const invocation = buildAgyCommandInvocation(
      {
        modelId: "workspace-pro",
        prompt: "long prompt must not be in args",
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "workspace-pro": "exact-agy-model" },
          extraArgs: ["--verbose"],
        },
      },
      { type: "file", tempDir: "/tmp/opencode-antigravity-prompt-abc", wrapperPrompt: "Read prompt.txt." },
    )

    expect(invocation.args).toEqual(["--verbose", "--add-dir", "/tmp/opencode-antigravity-prompt-abc", "--model", "exact-agy-model", "-p", "Read prompt.txt."])
    expect(invocation.args).not.toContain("long prompt must not be in args")
  })

  test("maps the discovered gemini-3-5-flash-medium slug to its exact agy display name", () => {
    const invocation = buildAgyCommandInvocation({
      modelId: "gemini-3-5-flash-medium",
      prompt: "hello",
      options: {
        command: "fake-agy",
        timeoutMs: 1_000,
        modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
      },
    })

    expect(invocation.agyModel).toBe("Gemini 3.5 Flash (Medium)")
    expect(invocation.args).toEqual(["--model", "Gemini 3.5 Flash (Medium)", "-p", "hello"])
    expect(invocation.args).toContain("--model")
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("Gemini 3.5 Flash (Medium)")
    expect(invocation.args).toContain("-p")
  })
})

describe("runAgyCommand", () => {
  const interactivePromptPatternSource = `const interactivePromptPatterns = [
  /not signed in/i,
  /sign in/i,
  /authorization URL/i,
  /do you trust/i,
  /trust this folder/i,
  /requires permission/i,
  /select .*theme/i,
  /accept .*terms/i,
  /press enter/i,
  /↑\/↓ Navigate/i,
  /login to continue/i,
  /permission required/i,
]`

  test("does not let a stale confirmation timer cancel after exit code 0", async () => {
    const timers = createManualTimers()
    let releaseFinish: (() => void) | undefined
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("Please login to continue")
      })
    })
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "exit race",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        createAgyTerminalOutputParser: () => ({
          push: async () => undefined,
          finish: () => new Promise<string>((resolve) => {
            releaseFinish = () => resolve("Please login to continue")
          }),
          dispose: () => undefined,
        }),
      },
    )

    await waitForCondition(() => timers.timers.some((timer) => timer.timeoutMs === 750 && !timer.cleared))
    const confirmationTimer = timers.timers.find((timer) => timer.timeoutMs === 750)
    expect(confirmationTimer).toBeDefined()
    fake.calls[0].child.exit(0)
    await waitForCondition(() => releaseFinish !== undefined)
    confirmationTimer?.handler()
    expect(fake.calls[0].child.writeCalls).toEqual([])
    releaseFinish?.()
    await expect(run).resolves.toEqual({ stdout: "Please login to continue", stderr: "" })
    expect(existsSync(getPromptTempDir(fake.calls[0].args))).toBe(false)
  })

  test("does not force-kill after a genuine setup cancellation has already exited on Linux", async () => {
    const timers = createManualTimers()
    let releaseFinish: (() => void) | undefined
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => child.writeData("Please login to continue"))
    })
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "stale Linux force kill",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        createAgyTerminalOutputParser: () => ({
          push: async () => undefined,
          finish: () => new Promise<string>((resolve) => {
            releaseFinish = () => resolve("Please login to continue")
          }),
          dispose: () => undefined,
        }),
      },
    )

    await waitForManualTimer(timers, 750)
    await waitForWrite(fake.calls[0].child)
    const forceKillTimer = timers.timers.find((timer) => timer.timeoutMs === 1_500)
    expect(forceKillTimer).toBeDefined()
    fake.calls[0].child.exit(1)
    expect(forceKillTimer?.cleared).toBe(true)
    forceKillTimer?.handler()
    expect(fake.calls[0].child.killSignals).toEqual([])
    await waitForCondition(() => releaseFinish !== undefined)
    releaseFinish?.()
    await expect(run).rejects.toThrow("Please login to continue")
    expect(existsSync(getPromptTempDir(fake.calls[0].args))).toBe(false)
  })

  test("does not call processKill after a genuine setup cancellation has already exited on Windows", async () => {
    const timers = createManualTimers()
    const processKillCalls: number[] = []
    let releaseFinish: (() => void) | undefined
    const fake = createFakePtySpawn((child) => {
      child.pid = 4_242
      queueMicrotask(() => child.writeData("Please login to continue"))
    })
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "stale Windows force kill",
        options: { command: "./fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "win32",
        processKill: (pid) => processKillCalls.push(pid),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        createAgyTerminalOutputParser: () => ({
          push: async () => undefined,
          finish: () => new Promise<string>((resolve) => {
            releaseFinish = () => resolve("Please login to continue")
          }),
          dispose: () => undefined,
        }),
      },
    )

    await waitForManualTimer(timers, 750)
    await waitForWrite(fake.calls[0].child)
    const forceKillTimer = timers.timers.find((timer) => timer.timeoutMs === 1_500)
    expect(forceKillTimer).toBeDefined()
    fake.calls[0].child.exit(1)
    expect(forceKillTimer?.cleared).toBe(true)
    forceKillTimer?.handler()
    expect(processKillCalls).toEqual([])
    expect(fake.calls[0].child.killSignals).toEqual([])
    await waitForCondition(() => releaseFinish !== undefined)
    releaseFinish?.()
    await expect(run).rejects.toThrow("Please login to continue")
    expect(existsSync(getPromptTempDir(fake.calls[0].args))).toBe(false)
  })

  test("keeps queued prompt data for exit nonzero setup diagnosis without starting a post-exit timer", async () => {
    const timers = createManualTimers()
    let releasePush: (() => void) | undefined
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("Please login to continue")
        child.exit(1)
      })
    })
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "queued exit setup",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        createAgyTerminalOutputParser: () => ({
          push: () => new Promise<void>((resolve) => {
            releasePush = resolve
          }),
          finish: async () => "Please login to continue",
          dispose: () => undefined,
        }),
      },
    )

    await waitForCondition(() => releasePush !== undefined)
    expect(timers.timers.some((timer) => timer.timeoutMs === 750 && !timer.cleared)).toBe(false)
    releasePush?.()
    await expect(run).rejects.toThrow("Please login to continue")
    expect(fake.calls[0].child.writeCalls).toEqual([])
  })

  test("replaces a pending candidate with a prompt completed across later chunks", async () => {
    const timers = createManualTimers()
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("Permission required\n")
        child.writeData("Please log")
        child.writeData("in to continue")
      })
    })
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "candidate replacement",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        createAgyTerminalOutputParser: () => ({
          push: async () => undefined,
          finish: async () => "Please login to continue",
          dispose: () => undefined,
        }),
      },
    )

    await waitForManualTimer(timers, 750)
    await waitForWrite(fake.calls[0].child)
    fake.calls[0].child.exit(1)
    await expect(run).rejects.toThrow("Please login to continue")
  })

  test("does not cancel normal streamed output that quotes setup patterns", async () => {
    const onStdoutChunks: string[] = []
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData(`Answer starts\r\n${interactivePromptPatternSource.replaceAll("\n", "\r\n")}\r\nMore explanation\r\nEND_OF_FALSE_POSITIVE_TEST`)
        child.exit(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "explain the detector",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
        onStdout: (chunk) => onStdoutChunks.push(chunk),
      },
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )

    expect(result.stdout).toContain(interactivePromptPatternSource)
    expect(result.stdout).toContain("END_OF_FALSE_POSITIVE_TEST")
    expect(onStdoutChunks.join("")).toBe(result.stdout)
    expect(fake.calls[0].child.writeCalls).toEqual([])
    expect(fake.calls[0].child.killSignals).toEqual([])
    expect(existsSync(getPromptTempDir(fake.calls[0].args))).toBe(false)
  })

  test("resolves a two-line normal answer ending with an exact prompt line", async () => {
    const onStdoutChunks: string[] = []
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("説明文です\r\nPlease login to continue")
        child.exit(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "two-line normal answer",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
        onStdout: (chunk) => onStdoutChunks.push(chunk),
      },
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )

    expect(result.stdout).toBe("説明文です\nPlease login to continue")
    expect(onStdoutChunks.join("")).toBe(result.stdout)
    expect(fake.calls[0].child.writeCalls).toEqual([])
    expect(fake.calls[0].child.killSignals).toEqual([])
    expect(existsSync(getPromptTempDir(fake.calls[0].args))).toBe(false)
  })

  test("resolves a one-line normal answer that is itself an exact prompt", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("Please login to continue")
        child.exit(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "one-line normal answer",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )

    expect(result.stdout).toBe("Please login to continue")
    expect(fake.calls[0].child.writeCalls).toEqual([])
  })

  test.each([
    ["three-line", "Welcome\r\nPlease login to continue\r\nPress Enter to continue"],
    ["two-line", "Welcome\r\nPlease login to continue"],
  ])("confirms a %s genuine setup screen without parser delta coupling", async (_name, screen) => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => child.writeData(screen))
    })
    const timers = createManualTimers()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "genuine setup screen",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux", setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )

    await waitForSpawn(fake.calls)
    await expectPromisePending(run)
    expect(fake.calls[0].child.writeCalls).toEqual([])
    await waitForManualTimer(timers, 750)
    await waitForWrite(fake.calls[0].child)
    await expectPromisePending(run)
    fake.calls[0].child.exit(1)
    await expect(run).rejects.toThrow(screen.includes("Press Enter") ? "Press Enter to continue" : "Please login to continue")
    expect(existsSync(getPromptTempDir(fake.calls[0].args))).toBe(false)
  })

  test("confirms a prompt preserved after CRLF followed by CSI 2K", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => child.writeData("Please login to continue\r\n\u001b[2K"))
    })
    const timers = createManualTimers()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "CRLF followed by line erase",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux", setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )

    await waitForSpawn(fake.calls)
    await expectPromisePending(run)
    await waitForManualTimer(timers, 750)
    await waitForWrite(fake.calls[0].child)
    await expectPromisePending(run)
    fake.calls[0].child.exit(1)
    await expect(run).rejects.toThrow("Please login to continue")
    expect(existsSync(getPromptTempDir(fake.calls[0].args))).toBe(false)
  })

  test("does not confirm a prompt erased after cursor home before normal output", async () => {
    const timers = createManualTimers()
    const processKillCalls: number[] = []
    let parserOutput = ""
    let firstPushProcessed = false
    const fake = createFakePtySpawn()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "cursor erase normal answer",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        processKill: (pid) => processKillCalls.push(pid),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        createAgyTerminalOutputParser: () => ({
          push: async (chunk) => {
            firstPushProcessed = true
            if (chunk.includes("通常回答です")) {
              parserOutput = "通常回答です\nEND_OF_CURSOR_ERASE_TEST"
            }
          },
          finish: async () => parserOutput,
          dispose: () => undefined,
        }),
      },
    )

    await waitForSpawn(fake.calls)
    fake.calls[0].child.writeData("Please login to continue\r\n\u001b[H\u001b[2K")
    await waitForCondition(() => firstPushProcessed)
    expect(timers.timers.some((timer) => timer.timeoutMs === 750 && !timer.cleared)).toBe(false)
    fake.calls[0].child.writeData("通常回答です\r\nEND_OF_CURSOR_ERASE_TEST")
    fake.calls[0].child.exit(0)

    await expect(run).resolves.toEqual({ stdout: "通常回答です\nEND_OF_CURSOR_ERASE_TEST", stderr: "" })
    expect(fake.calls[0].child.writeCalls).toEqual([])
    expect(fake.calls[0].child.killSignals).toEqual([])
    expect(processKillCalls).toEqual([])
    expect(existsSync(getPromptTempDir(fake.calls[0].args))).toBe(false)
  })

  test("confirms a prompt when cursor home erases a different row", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => child.writeData("Welcome\r\nPlease login to continue\r\n\u001b[H\u001b[2K"))
    })
    const timers = createManualTimers()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "cursor erase different row",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux", setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )

    await waitForManualTimer(timers, 750)
    await waitForWrite(fake.calls[0].child)
    await expectPromisePending(run)
    fake.calls[0].child.exit(1)
    await expect(run).rejects.toThrow("Please login to continue")
    expect(existsSync(getPromptTempDir(fake.calls[0].args))).toBe(false)
  })

  test("discards a prompt candidate when a later chunk continues the answer", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("Please login to continue")
        child.writeData("\r\nこれは回答中の引用です\r\nEND_OF_FALSE_POSITIVE_TEST")
        child.exit(0)
      })
    })
    const timers = createManualTimers()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "candidate followed by output",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux", setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )

    const result = await run
    expect(result.stdout).toContain("END_OF_FALSE_POSITIVE_TEST")
    expect(fake.calls[0].child.writeCalls).toEqual([])
    expect(timers.timers.filter((timer) => timer.timeoutMs === 750 && !timer.cleared)).toHaveLength(0)
  })

  test("does not treat a prompt line followed by continuation in one chunk as setup", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("説明文です\r\nPlease login to continue\r\nこれは回答の続きです\r\nEND_OF_FALSE_POSITIVE_TEST")
        child.exit(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "same chunk continuation",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )

    expect(result.stdout).toContain("END_OF_FALSE_POSITIVE_TEST")
    expect(fake.calls[0].child.writeCalls).toEqual([])
  })

  test("prefers a confirmed setup diagnosis when a pending prompt is followed by nonzero exit", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("Please login to continue")
        child.exit(1)
      })
    })
    const timers = createManualTimers()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "pending setup nonzero",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux", setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )

    await expect(run).rejects.toThrow("Please login to continue")
  })

  test("does not cancel when the answer and quoted patterns share one PTY chunk", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData(`First answer line\r\nSecond answer line\r\n${interactivePromptPatternSource.replaceAll("\n", "\r\n")}\r\nEND_OF_FALSE_POSITIVE_TEST`)
        child.exit(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "same chunk",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )

    expect(result.stdout).toContain("END_OF_FALSE_POSITIVE_TEST")
    expect(fake.calls[0].child.writeCalls).toEqual([])
  })

  test("does not classify an exact prompt as setup after answer streaming starts", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("First answer line\nSecond answer line\nThird answer line\nPlease login to continue\nEND_OF_FALSE_POSITIVE_TEST")
        child.exit(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "exact prompt after answer",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )

    expect(result.stdout).toContain("Please login to continue")
    expect(fake.calls[0].child.writeCalls).toEqual([])
  })

  test("detects a genuine setup prompt split across PTY chunks", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("Please log")
        child.writeData("in to continue")
      })
    })
    const timers = createManualTimers()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "split setup",
        options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" } },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux", setTimeout: (handler, timeoutMs) => timers.setTimeout(handler, timeoutMs), clearTimeout: timers.clearTimeout },
    )

    await waitForSpawn(fake.calls)
    await waitForManualTimer(timers, 750)
    await waitForWrite(fake.calls[0].child)
    await expectPromisePending(run)
    expect(fake.calls[0].child.writeCalls).toEqual(["\x03"])
    fake.calls[0].child.exit(1)
    await expect(run).rejects.toThrow("Antigravity CLI requires interactive setup")
  })

  test("spawns the resolved command through PTY and returns final sanitized output", async () => {
    const onStdoutChunks: string[] = []
    const longPrompt = "hello".repeat(20_000)
    let promptFileContent = ""
    const fake = createFakePtySpawn((child, call) => {
      queueMicrotask(() => {
        const tempDir = getPromptTempDir(call.args)
        promptFileContent = readFileSync(path.join(tempDir, "prompt.txt"), "utf8")
        child.writeData(generationFixture)
        child.exit(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: longPrompt,
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
          env: { AGY_TEST_ENV: "1" },
          cwd: ".",
        },
        onStdout: (chunk) => onStdoutChunks.push(chunk),
      },
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )

    expect(result).toEqual({ stdout: "OK", stderr: "" })
    expect(onStdoutChunks).toEqual(["OK"])
    expect(promptFileContent).toBe(longPrompt)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].command).toBe("fake-agy")
    expect(fake.calls[0].options).toMatchObject({ name: "xterm-color", cols: 120, rows: 30, cwd: "." })
    expect(Object.prototype.hasOwnProperty.call(fake.calls[0].options, "windowsPty")).toBe(false)
    expect(fake.calls[0].options.env.AGY_TEST_ENV).toBe("1")
    const tempDir = expectFilePromptArgs(fake.calls[0].args, "Gemini 3.5 Flash (Medium)", longPrompt)
    const wrapperPrompt = fake.calls[0].args[fake.calls[0].args.indexOf("-p") + 1]
    expect(JSON.stringify(fake.calls[0].args)).not.toContain(longPrompt)
    expect(wrapperPrompt).not.toContain(longPrompt)
    expect(wrapperPrompt).not.toContain("hello".repeat(1_000))
    expect(existsSync(tempDir)).toBe(false)
  })

  test("success with cleanup success resolves normally", async () => {
    let cleanupCalls = 0
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("OK")
        child.exit(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello cleanup success",
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
          createInjectedPromptTransport(async () => {
            cleanupCalls += 1
          }),
      },
    )

    expect(result.stdout).toBe("OK")
    expect(cleanupCalls).toBe(1)
  })

  test("adds the managed log file exactly once when progress streaming is requested", async () => {
    const progressMessages: string[] = []
    const fake = createFakePtySpawn((child, call) => {
      queueMicrotask(() => {
        const logIndex = call.args.indexOf("--log-file")
        expect(logIndex).toBeGreaterThanOrEqual(0)
        appendFileSync(call.args[logIndex + 1], "Starting new conversation\n")
        child.writeData("OK")
        child.exit(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello progress",
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        onProgress: (message) => progressMessages.push(message),
      },
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )

    expect(result.stdout).toBe("OK")
    expect(fake.calls[0].args.filter((arg) => arg === "--log-file")).toHaveLength(1)
    expect(fake.calls[0].args[fake.calls[0].args.indexOf("--log-file") + 1]).toBe(path.join(getPromptTempDir(fake.calls[0].args), "agy.log"))
    expect(progressMessages).toEqual(["Antigravity CLIを起動しています", "リクエストを送信しています"])
    expect(existsSync(getPromptTempDir(fake.calls[0].args))).toBe(false)
  })

  test("success with cleanup failure rejects the cleanup error", async () => {
    const cleanupError = new Error("cleanup exploded")
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("OK")
        child.exit(0)
      })
    })

    await expect(
      runAgyCommand(
        {
          modelId: "gemini-3-5-flash-medium",
          prompt: "hello cleanup failure",
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
      ),
    ).rejects.toBe(cleanupError)
  })

  test("resolves agy.exe from PATH before spawning the PTY on Windows", async () => {
    await withTempDirectory(async (directory) => {
      const executable = path.join(directory, "agy.exe")
      writeFileSync(executable, "")
      const fake = createFakePtySpawn((child) => {
        queueMicrotask(() => {
          child.writeData("OK")
          child.exit(0)
        })
      })

      const result = await runAgyCommand(
        {
          modelId: "gemini-3-5-flash-medium",
          prompt: "hello",
          options: {
            command: "agy",
            timeoutMs: 1_000,
            modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
            env: { PATH: directory, PATHEXT: ".EXE" },
          },
        },
        { ptySpawn: fake.ptySpawn, platform: "win32" },
      )

      expect(result.stdout).toBe("OK")
      expect(fake.calls[0].command).toBe(executable)
      expect(Object.prototype.hasOwnProperty.call(fake.calls[0].options, "windowsPty")).toBe(false)
      const tempDir = expectFilePromptArgs(fake.calls[0].args, "Gemini 3.5 Flash (Medium)", "hello")
      expect(existsSync(tempDir)).toBe(false)
      expect(fake.calls[0].child.releaseEvents).toEqual(["in", "out", "worker"])
    })
  })

  test("throws unknown model errors before launching the command", () => {
    const fake = createFakePtySpawn()

    expect(() =>
      runAgyCommand({ modelId: "unknown", prompt: "hello", options: { command: "fake-agy", timeoutMs: 1_000, modelMap: {} } }, { ptySpawn: fake.ptySpawn }),
    ).toThrow("No Antigravity CLI model mapping configured")
    expect(fake.calls).toHaveLength(0)
  })

  test("turns nonzero exits into sanitized diagnostic errors", async () => {
    const prompt = "hello nonzero"
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("\u001b[31mboom\u001b[0m")
        child.exit(2)
      })
    })

    await expect(
      runAgyCommand(
        {
          modelId: "gemini-3-5-flash-medium",
          prompt,
          options: {
            command: "fake-agy",
            timeoutMs: 1_000,
            modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
          },
        },
        { ptySpawn: fake.ptySpawn, platform: "linux" },
      ),
    ).rejects.toThrow("Antigravity CLI failed with exit code 2. boom")
    const tempDir = expectFilePromptArgs(fake.calls[0].args, "Gemini 3.5 Flash (Medium)", prompt)
    expect(existsSync(tempDir)).toBe(false)
  })

  test("rejects empty sanitized output with the required no-output message", async () => {
    const prompt = "hello no output"
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData("\u001b[?25h\r\n")
        child.exit(0)
      })
    })

    await expect(
      runAgyCommand(
        {
          modelId: "gemini-3-5-flash-medium",
          prompt,
          options: {
            command: "fake-agy",
            timeoutMs: 1_000,
            modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
          },
        },
        { ptySpawn: fake.ptySpawn, platform: "linux" },
      ),
    ).rejects.toThrow("Antigravity CLI returned no output.")
    const tempDir = expectFilePromptArgs(fake.calls[0].args, "Gemini 3.5 Flash (Medium)", prompt)
    expect(existsSync(tempDir)).toBe(false)
  })

  test("waits for PTY exit after interactive prompt cancellation", async () => {
    const prompt = "hello interactive"
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => child.writeData("Please login to continue"))
    })
    const timers = createManualTimers()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt,
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
      },
      { ptySpawn: fake.ptySpawn, platform: "linux", setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )

    await waitForSpawn(fake.calls)
    const tempDir = expectFilePromptArgs(fake.calls[0].args, "Gemini 3.5 Flash (Medium)", prompt)
    await expectPromisePending(run)
    timers.fire(750)
    await waitForWrite(fake.calls[0].child)
    expect(fake.calls[0].child.writeCalls).toEqual(["\x03"])
    expect(fake.calls[0].child.killSignals).toEqual([])
    expect(fake.calls[0].child.disposeEvents).toEqual([])
    expect(existsSync(tempDir)).toBe(true)

    fake.calls[0].child.exit(1)

    await expect(run).rejects.toThrow("Run `agy` directly to complete setup")
    expect(fake.calls[0].child.disposeEvents).toEqual(["data", "exit"])
    expect(existsSync(tempDir)).toBe(false)
  })

  test("waits for PTY exit after timeout cancellation", async () => {
    const prompt = "hello timeout"
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt,
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "win32",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
    )

    await waitForSpawn(fake.calls)
    const tempDir = expectFilePromptArgs(fake.calls[0].args, "Gemini 3.5 Flash (Medium)", prompt)
    timers.fire(1_000)
    await expectPromisePending(run)
    expect(fake.calls[0].child.writeCalls).toEqual(["\x03"])
    expect(fake.calls[0].child.killSignals).toEqual([])
    expect(fake.calls[0].child.releaseEvents).toEqual([])
    expect(existsSync(tempDir)).toBe(true)

    fake.calls[0].child.exit(1)

    await expect(run).rejects.toThrow("Antigravity CLI timed out after 1000ms.")
    expect(fake.calls[0].child.releaseEvents).toEqual(["in", "out", "worker"])
    expect(existsSync(tempDir)).toBe(false)
  })

  test("waits for PTY exit after abort cancellation", async () => {
    const prompt = "hello abort"
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const abortController = new AbortController()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt,
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      { ptySpawn: fake.ptySpawn, platform: "linux", setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )

    await waitForSpawn(fake.calls)
    const tempDir = expectFilePromptArgs(fake.calls[0].args, "Gemini 3.5 Flash (Medium)", prompt)
    abortController.abort()

    await expectPromisePending(run)
    expect(fake.calls[0].child.writeCalls).toEqual(["\x03"])
    expect(fake.calls[0].child.killSignals).toEqual([])
    expect(fake.calls[0].child.disposeEvents).toEqual([])
    expect(existsSync(tempDir)).toBe(true)

    fake.calls[0].child.exit(1)

    await expect(run).rejects.toMatchObject({ name: "AbortError", message: "Antigravity CLI call aborted." })
    expect(fake.calls[0].child.disposeEvents).toEqual(["data", "exit"])
    expect(existsSync(tempDir)).toBe(false)
  })

  test("abort with cleanup failure preserves AbortError and exposes cleanupError", async () => {
    const cleanupError = new Error("cleanup failed after abort")
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const abortController = new AbortController()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello abort cleanup failure",
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        createPromptFileTransport: async () => createInjectedPromptTransport(async () => Promise.reject(cleanupError)),
      },
    )

    await waitForSpawn(fake.calls)
    abortController.abort()
    fake.calls[0].child.exit(1)

    try {
      await run
      throw new Error("run unexpectedly resolved")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe("AbortError")
      expect((error as Error).message).toContain("Antigravity CLI call aborted.")
      expect((error as Error).message).toContain("Prompt cleanup also failed: cleanup failed after abort")
      expect(getPromptCleanupError(error)).toBe(cleanupError)
    }
  })

  test("force kills after cancellation grace without rejecting before PTY exit", async () => {
    const prompt = "hello force kill"
    const fake = createFakePtySpawn()
    const processKillCalls: number[] = []
    const timers = createManualTimers()
    const abortController = new AbortController()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt,
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        processKill: (pid) => processKillCalls.push(pid),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationGraceMs: 25,
        cancellationForceCleanupMs: 100,
      },
    )

    await waitForSpawn(fake.calls)
    abortController.abort()
    timers.fire(25)

    await expectPromisePending(run)
    expect(fake.calls[0].child.writeCalls).toEqual(["\x03"])
    expect(processKillCalls).toEqual([])
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
    expect(fake.calls[0].child.disposeEvents).toEqual([])

    fake.calls[0].child.exit(1)

    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
    expect(fake.calls[0].child.disposeEvents).toEqual(["data", "exit"])
  })

  test("final cleanup fallback rejects cancellation when PTY exit never arrives", async () => {
    const prompt = "hello final cleanup"
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const abortController = new AbortController()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt,
        options: {
          command: "fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
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

    await waitForSpawn(fake.calls)
    const tempDir = expectFilePromptArgs(fake.calls[0].args, "Gemini 3.5 Flash (Medium)", prompt)
    abortController.abort()
    timers.fire(25)
    await expectPromisePending(run)
    expect(existsSync(tempDir)).toBe(true)

    timers.fire(100)

    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
    expect(fake.calls[0].child.disposeEvents).toEqual(["data", "exit"])
    expect(existsSync(tempDir)).toBe(false)
  })

  test("force settles when terminal parser push never resolves", async () => {
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const abortController = new AbortController()
    let parserDisposeCalls = 0
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello pending parser",
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationForceCleanupMs: 100,
        createAgyTerminalOutputParser: (): AgyTerminalOutputParser => ({
          push: () => new Promise<void>(() => undefined),
          finish: async () => "",
          dispose: () => { parserDisposeCalls += 1 },
        }),
      },
    )

    await waitForSpawn(fake.calls)
    const tempDir = getPromptTempDir(fake.calls[0].args)
    fake.calls[0].child.writeData("pending")
    abortController.abort()
    timers.fire(100)

    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
    expect(parserDisposeCalls).toBe(1)
    expect(fake.calls[0].child.disposeEvents).toEqual(["data", "exit"])
    expect(existsSync(tempDir)).toBe(false)
  })

  test("force settles when progress monitor stop never resolves", async () => {
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const abortController = new AbortController()
    let parserDisposeCalls = 0
    let monitorDisposeCalls = 0
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello pending monitor",
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
        onProgress: () => undefined,
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationForceCleanupMs: 100,
        createAgyTerminalOutputParser: (): AgyTerminalOutputParser => ({
          push: async () => undefined,
          finish: async () => "OK",
          dispose: () => { parserDisposeCalls += 1 },
        }),
        createAgyProgressMonitor: (): AgyProgressMonitor => ({
          start: () => undefined,
          stop: () => new Promise<void>(() => undefined),
          dispose: () => { monitorDisposeCalls += 1 },
        }),
      },
    )

    await waitForSpawn(fake.calls)
    fake.calls[0].child.writeData("OK")
    abortController.abort()
    fake.calls[0].child.exit(0)
    timers.fire(100)

    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
    expect(parserDisposeCalls).toBe(1)
    expect(monitorDisposeCalls).toBe(1)
    expect(fake.calls[0].child.disposeEvents).toEqual(["data", "exit"])
  })

  test("does not settle twice when a parser resolves after forced cancellation", async () => {
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const abortController = new AbortController()
    let resolvePush: () => void = () => undefined
    let parserDisposeCalls = 0
    let finishCalls = 0
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello late parser",
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationForceCleanupMs: 100,
        createAgyTerminalOutputParser: (): AgyTerminalOutputParser => ({
          push: () => new Promise<void>((resolve) => { resolvePush = resolve }),
          finish: async () => { finishCalls += 1; return "late" },
          dispose: () => { parserDisposeCalls += 1 },
        }),
      },
    )

    await waitForSpawn(fake.calls)
    fake.calls[0].child.writeData("late")
    abortController.abort()
    timers.fire(100)
    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")

    resolvePush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(finishCalls).toBe(0)
    expect(parserDisposeCalls).toBe(1)
    expect(fake.calls[0].child.disposeEvents).toEqual(["data", "exit"])
  })

  test("Windows force kill calls processKill for a valid child pid", async () => {
    const prompt = "hello windows valid pid force kill"
    const fake = createFakePtySpawn()
    const processKillCalls: number[] = []
    const timers = createManualTimers()
    const abortController = new AbortController()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt,
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "win32",
        processKill: (pid) => processKillCalls.push(pid),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationGraceMs: 25,
        cancellationForceCleanupMs: 100,
      },
    )

    await waitForSpawn(fake.calls)
    fake.calls[0].child.pid = 12345
    const tempDir = expectFilePromptArgs(fake.calls[0].args, "Gemini 3.5 Flash (Medium)", prompt)
    abortController.abort()
    timers.fire(25)

    await expectPromisePending(run)
    expect(processKillCalls).toEqual([12345])
    expect(fake.calls[0].child.killSignals).toEqual([])
    expect(existsSync(tempDir)).toBe(true)
    fake.calls[0].child.exit(1)

    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
    expect(existsSync(tempDir)).toBe(false)
  })

  test("Windows force kill falls back to child.kill(undefined) when child pid is invalid", async () => {
    const fake = createFakePtySpawn()
    const processKillCalls: number[] = []
    const timers = createManualTimers()
    const abortController = new AbortController()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello windows invalid pid force kill",
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "win32",
        processKill: (pid) => processKillCalls.push(pid),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationGraceMs: 25,
        cancellationForceCleanupMs: 100,
      },
    )

    await waitForSpawn(fake.calls)
    abortController.abort()
    timers.fire(25)

    expect(processKillCalls).toEqual([])
    expect(fake.calls[0].child.killSignals).toEqual([undefined])
    fake.calls[0].child.exit(1)
    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
  })

  test("Windows force kill falls back to child.kill(undefined) when processKill fails without ESRCH", async () => {
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const abortController = new AbortController()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello windows direct kill failure",
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "win32",
        processKill: () => {
          throw new Error("access denied")
        },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationGraceMs: 25,
        cancellationForceCleanupMs: 100,
      },
    )

    await waitForSpawn(fake.calls)
    fake.calls[0].child.pid = 12345
    abortController.abort()
    timers.fire(25)

    expect(fake.calls[0].child.killSignals).toEqual([undefined])
    fake.calls[0].child.exit(1)
    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
  })

  test("Windows force kill ignores ESRCH processKill failures without child.kill fallback", async () => {
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const abortController = new AbortController()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello windows esrch direct kill",
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "win32",
        processKill: () => {
          throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
        },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationGraceMs: 25,
        cancellationForceCleanupMs: 100,
      },
    )

    await waitForSpawn(fake.calls)
    fake.calls[0].child.pid = 12345
    abortController.abort()
    timers.fire(25)

    await expectPromisePending(run)
    expect(fake.calls[0].child.killSignals).toEqual([])
    fake.calls[0].child.exit(1)
    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
  })

  test("timeout with cleanup failure preserves timeout error class and cleanupError", async () => {
    const cleanupError = new Error("cleanup failed after timeout")
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello timeout cleanup failure",
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
      },
      {
        ptySpawn: fake.ptySpawn,
        platform: "linux",
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        createPromptFileTransport: async () => createInjectedPromptTransport(async () => Promise.reject(cleanupError)),
      },
    )

    await waitForSpawn(fake.calls)
    timers.fire(1_000)
    fake.calls[0].child.exit(1)

    try {
      await run
      throw new Error("run unexpectedly resolved")
    } catch (error) {
      expect(error).toBeInstanceOf(AntigravityCliTimeoutError)
      expect((error as Error).name).toBe("AntigravityCliTimeoutError")
      expect((error as Error).message).toContain("Antigravity CLI timed out after 1000ms.")
      expect((error as Error).message).toContain("Prompt cleanup also failed: cleanup failed after timeout")
      expect(getPromptCleanupError(error)).toBe(cleanupError)
    }
  })

  test("releases Windows agent resources once after canceling and receiving PTY exit", async () => {
    const prompt = "hello windows release"
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const abortController = new AbortController()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt,
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
        abortSignal: abortController.signal,
      },
      { ptySpawn: fake.ptySpawn, platform: "win32", setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )

    await waitForSpawn(fake.calls)
    abortController.abort()

    await expectPromisePending(run)
    expect(fake.calls[0].child.writeCalls).toEqual(["\x03"])
    expect(fake.calls[0].child.releaseEvents).toEqual([])

    fake.calls[0].child.exit(1)

    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
    expect(fake.calls[0].child.releaseEvents).toEqual(["in", "out", "worker"])
  })

  test("cleans up the prompt temp directory when PTY spawn fails", async () => {
    const prompt = "hello spawn failure"
    let args: string[] = []
    const ptySpawn: AgyPtySpawn = (_command, spawnArgs) => {
      args = spawnArgs
      throw new Error("spawn exploded")
    }

    await expect(
      runAgyCommand(
        {
          modelId: "gemini-3-5-flash-medium",
          prompt,
          options: {
            command: "fake-agy",
            timeoutMs: 1_000,
            modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
          },
        },
        { ptySpawn, platform: "linux" },
      ),
    ).rejects.toThrow("Antigravity CLI failed to start. spawn exploded")

    const tempDir = expectFilePromptArgs(args, "Gemini 3.5 Flash (Medium)", prompt)
    expect(existsSync(tempDir)).toBe(false)
  })

  test("cleans up the prompt temp directory when loading node-pty fails", async () => {
    const promptTempDirsBefore = listPromptTempDirs()

    await expect(
      runAgyCommand(
        {
          modelId: "gemini-3-5-flash-medium",
          prompt: "hello node-pty load failure",
          options: {
            command: "fake-agy",
            timeoutMs: 1_000,
            modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
          },
        },
        {
          loadNodePty: async () => {
            throw new Error("node-pty import exploded")
          },
          platform: "linux",
        },
      ),
    ).rejects.toThrow("node-pty import exploded")

    const promptTempDirsAfter = listPromptTempDirs()
    expect([...promptTempDirsAfter].filter((entry) => !promptTempDirsBefore.has(entry))).toEqual([])
  })
})
