import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildAgyCommandInvocation, runAgyCommand, sanitizeAgyGenerationPtyOutput } from "./agy-command"
import type { AgyPtyDisposable, AgyPtyExitEvent, AgyPtyProcess, AgyPtySpawn, AgyPtySpawnOptions } from "./model-discovery"

class FakeAgyPty implements AgyPtyProcess {
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(event: AgyPtyExitEvent) => void> = []
  killSignals: Array<string | undefined> = []
  writeCalls: string[] = []
  disposeEvents: string[] = []
  releaseEvents: string[] = []
  pid?: number
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
    expect(fake.calls[0].options.env.AGY_TEST_ENV).toBe("1")
    const tempDir = expectFilePromptArgs(fake.calls[0].args, "Gemini 3.5 Flash (Medium)", longPrompt)
    const wrapperPrompt = fake.calls[0].args[fake.calls[0].args.indexOf("-p") + 1]
    expect(JSON.stringify(fake.calls[0].args)).not.toContain(longPrompt)
    expect(wrapperPrompt).not.toContain(longPrompt)
    expect(wrapperPrompt).not.toContain("hello".repeat(1_000))
    expect(existsSync(tempDir)).toBe(false)
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

    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
    expect(fake.calls[0].child.disposeEvents).toEqual(["data", "exit"])
    expect(existsSync(tempDir)).toBe(false)
  })

  test("force kills after cancellation grace without rejecting before PTY exit", async () => {
    const prompt = "hello force kill"
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
    abortController.abort()
    timers.fire(25)

    await expectPromisePending(run)
    expect(fake.calls[0].child.writeCalls).toEqual(["\x03"])
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

  test("uses a non-mutating Windows process force-kill when the PTY pid is available", async () => {
    const prompt = "hello windows force kill"
    const fake = createFakePtySpawn()
    const timers = createManualTimers()
    const abortController = new AbortController()
    const killedPids: number[] = []
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
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        cancellationGraceMs: 25,
        cancellationForceCleanupMs: 100,
        forceKillWindowsProcess: (pid) => {
          killedPids.push(pid)
        },
      },
    )

    await waitForSpawn(fake.calls)
    fake.calls[0].child.pid = 1234
    abortController.abort()
    timers.fire(25)

    expect(killedPids).toEqual([1234])
    expect(fake.calls[0].child.killSignals).toEqual([])
    fake.calls[0].child.exit(1)
    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
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
