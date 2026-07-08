import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildAgyCommandInvocation, runAgyCommand, sanitizeAgyGenerationPtyOutput } from "./agy-command"
import type { AgyPtyDisposable, AgyPtyExitEvent, AgyPtyProcess, AgyPtySpawn, AgyPtySpawnOptions } from "./model-discovery"

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

const withTempDirectory = (callback: (directory: string) => void) => {
  const directory = mkdtempSync(path.join(tmpdir(), "agy-generation-resolve-"))
  try {
    callback(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const generationFixture = "\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[HOK\u001b]0;C:\\Users\\Origin\\AppData\\Local\\agy\\bin\\agy.exe\u0007\u001b[?25h\r\n"

describe("sanitizeAgyGenerationPtyOutput", () => {
  test("removes terminal control sequences from the observed agy generation fixture", () => {
    expect(sanitizeAgyGenerationPtyOutput(generationFixture)).toBe("OK")
  })

  test("preserves normal generated Japanese text while trimming outer blank lines", () => {
    expect(sanitizeAgyGenerationPtyOutput("\r\n  こんにちは\n世界  \r\n")).toBe("こんにちは\n世界")
  })
})

describe("buildAgyCommandInvocation", () => {
  test("builds extra args, mapped model, and prompt in the required order", () => {
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
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => {
        child.writeData(generationFixture)
        child.exit(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello",
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
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].command).toBe("fake-agy")
    expect(fake.calls[0].options).toMatchObject({ name: "xterm-color", cols: 120, rows: 30, cwd: "." })
    expect(fake.calls[0].options.env.AGY_TEST_ENV).toBe("1")
    expect(fake.calls[0].args).toEqual(["--model", "Gemini 3.5 Flash (Medium)", "-p", "hello"])
    expect(fake.calls[0].args.at(-2)).toBe("-p")
  })

  test("resolves agy.exe from PATH before spawning the PTY on Windows", async () => {
    await new Promise<void>((resolve, reject) => {
      withTempDirectory((directory) => {
        const executable = path.join(directory, "agy.exe")
        writeFileSync(executable, "")
        const fake = createFakePtySpawn((child) => {
          queueMicrotask(() => {
            child.writeData("OK")
            child.exit(0)
          })
        })

        void runAgyCommand(
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
        ).then((result) => {
          expect(result.stdout).toBe("OK")
          expect(fake.calls[0].command).toBe(executable)
          resolve()
        }, reject)
      })
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
          prompt: "hello",
          options: {
            command: "fake-agy",
            timeoutMs: 1_000,
            modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
          },
        },
        { ptySpawn: fake.ptySpawn, platform: "linux" },
      ),
    ).rejects.toThrow("Antigravity CLI failed with exit code 2. boom")
  })

  test("rejects empty sanitized output with the required no-output message", async () => {
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
          prompt: "hello",
          options: {
            command: "fake-agy",
            timeoutMs: 1_000,
            modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
          },
        },
        { ptySpawn: fake.ptySpawn, platform: "linux" },
      ),
    ).rejects.toThrow("Antigravity CLI returned no output.")
  })

  test("fails fast on interactive prompts and kills the PTY child", async () => {
    const fake = createFakePtySpawn((child) => {
      queueMicrotask(() => child.writeData("Please login to continue"))
    })

    await expect(
      runAgyCommand(
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
    ).rejects.toThrow("Run `agy` directly to complete setup")
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
  })

  test("kills the PTY child and reports the exact timeout message", async () => {
    const fake = createFakePtySpawn()
    const run = runAgyCommand(
      {
        modelId: "gemini-3-5-flash-medium",
        prompt: "hello",
        options: {
          command: "./fake-agy",
          timeoutMs: 1_000,
          modelMap: { "gemini-3-5-flash-medium": "Gemini 3.5 Flash (Medium)" },
        },
      },
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

    await expect(run).rejects.toThrow("Antigravity CLI timed out after 1000ms.")
    expect(fake.calls[0].child.killSignals).toEqual([undefined])
  })

  test("kills the PTY child and raises AbortError on abort", async () => {
    const fake = createFakePtySpawn()
    const abortController = new AbortController()
    const run = runAgyCommand(
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
      { ptySpawn: fake.ptySpawn, platform: "linux" },
    )

    abortController.abort()

    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
  })
})
