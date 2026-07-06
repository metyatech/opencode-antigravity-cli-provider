import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { buildAgyCommandInvocation, runAgyCommand } from "./agy-command"
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
})

describe("runAgyCommand", () => {
  test("spawns the command without a shell and merges env overrides", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.write("generated")
        child.stderr.write("diagnostic")
        child.close(0)
      })
    })

    const result = await runAgyCommand(
      {
        modelId: "default",
        prompt: "hello",
        options: { command: "fake-agy", timeoutMs: 1_000, env: { AGY_TEST_ENV: "1" }, cwd: "." },
      },
      { spawn: fake.spawn },
    )

    expect(result).toEqual({ stdout: "generated", stderr: "diagnostic" })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].options.shell).toBe(false)
    expect(fake.calls[0].options.env.AGY_TEST_ENV).toBe("1")
    expect(fake.calls[0].args.at(-2)).toBe("-p")
  })

  test("throws unknown model errors before launching the command", async () => {
    const fake = createFakeSpawn()

    expect(() =>
      runAgyCommand(
        {
          modelId: "unknown",
          prompt: "hello",
          options: { command: "fake-agy", timeoutMs: 1_000, modelMap: { default: null } },
        },
        { spawn: fake.spawn },
      ),
    ).toThrow("No Antigravity CLI model mapping configured")
    expect(fake.calls).toHaveLength(0)
  })

  test("turns nonzero exits into diagnostic errors", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stderr.write("boom")
        child.close(2)
      })
    })

    await expect(runAgyCommand({ modelId: "default", prompt: "hello", options: { command: "fake-agy", timeoutMs: 1_000 } }, { spawn: fake.spawn })).rejects.toThrow(
      "Antigravity CLI failed with exit code 2. boom",
    )
  })

  test("rejects empty stdout and stderr with the required no-output message", async () => {
    const fake = createFakeSpawn((child) => queueMicrotask(() => child.close(0)))

    await expect(runAgyCommand({ modelId: "default", prompt: "hello", options: { command: "fake-agy", timeoutMs: 1_000 } }, { spawn: fake.spawn })).rejects.toThrow(
      "Antigravity CLI returned no output.",
    )
  })

  test("fails fast on interactive prompts and kills the child", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => child.stdout.write("Please login to continue"))
    })

    await expect(runAgyCommand({ modelId: "default", prompt: "hello", options: { command: "fake-agy", timeoutMs: 1_000 } }, { spawn: fake.spawn })).rejects.toThrow(
      "Run `agy` directly to complete setup",
    )
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
  })

  test("kills the child and reports the exact timeout message", async () => {
    const fake = createFakeSpawn()
    const run = runAgyCommand(
      { modelId: "default", prompt: "hello", options: { command: "fake-agy", timeoutMs: 1_000 } },
      {
        spawn: fake.spawn,
        setTimeout: (handler) => {
          queueMicrotask(() => handler())
          return 1 as unknown as ReturnType<typeof setTimeout>
        },
        clearTimeout: () => undefined,
      },
    )

    await expect(run).rejects.toThrow("Antigravity CLI timed out after 1000ms.")
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
  })

  test("kills the child and raises AbortError on abort", async () => {
    const fake = createFakeSpawn()
    const abortController = new AbortController()
    const run = runAgyCommand({ modelId: "default", prompt: "hello", options: { command: "fake-agy", timeoutMs: 1_000 }, abortSignal: abortController.signal }, { spawn: fake.spawn })

    abortController.abort()

    await expect(run).rejects.toThrow("Antigravity CLI call aborted.")
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
  })
})
