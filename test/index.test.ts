import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pluginModule from "../src/index"
import { buildAgyCommandInvocation, runAgyCommand } from "../src/agy-command"
import { normalizeOptions } from "../src/options"
import { createAntigravityCliProvider } from "../src/provider"
import type { AgyChildProcess, AgySpawn, AgySpawnOptions } from "../src/types"

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

const createServerHooks = (options: Record<string, unknown> = {}) => pluginModule.server({ directory: process.cwd(), client: {} } as Parameters<typeof pluginModule.server>[0], options)

describe("OpenCode plugin entrypoint", () => {
  test("exports the requested PluginModule shape and id", () => {
    expect(pluginModule.id).toBe("opencode-antigravity-cli-provider")
    expect(typeof pluginModule.server).toBe("function")
  })

  test("injects the antigravity-cli provider and default model when absent", async () => {
    const hooks = await createServerHooks()
    const config = {}

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toEqual({
      provider: {
        "antigravity-cli": {
          npm: new URL("../src/provider.js", import.meta.url).href,
          name: "Antigravity CLI",
          options: {
            command: "agy",
            timeoutMs: 1_800_000,
            modelMap: { default: null },
            extraArgs: [],
          },
          models: {
            default: {
              name: "Antigravity CLI Default",
            },
          },
        },
      },
      model: "antigravity-cli/default",
    })
  })

  test("does not replace an existing antigravity-cli provider", async () => {
    const hooks = await createServerHooks({ command: "ignored-agy" })
    const config = {
      provider: {
        "antigravity-cli": {
          npm: "custom-provider",
        },
      },
      model: "custom/model",
    }

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config.provider["antigravity-cli"]).toEqual({ npm: "custom-provider" })
    expect(config.model).toBe("custom/model")
  })

  test("respects enabled false", async () => {
    const hooks = await createServerHooks({ enabled: false })
    const config = {}

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toEqual({})
  })

  test("applies plugin option overrides when injecting provider config", async () => {
    const hooks = await createServerHooks({
      command: "custom-agy",
      timeoutMs: 2_000,
      modelMap: { default: null, pro: "Agy Pro" },
      extraArgs: ["--verbose"],
      model: "antigravity-cli/pro",
      models: {
        pro: {
          name: "Agy Pro",
        },
      },
    })
    const config = {}

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toMatchObject({
      provider: {
        "antigravity-cli": {
          options: {
            command: "custom-agy",
            timeoutMs: 2_000,
            modelMap: { default: null, pro: "Agy Pro" },
            extraArgs: ["--verbose"],
          },
          models: {
            pro: {
              name: "Agy Pro",
            },
          },
        },
      },
      model: "antigravity-cli/pro",
    })
  })
})

describe("AI SDK provider entrypoint", () => {
  test("only createAntigravityCliProvider is exported as a create* named export", async () => {
    const mod = await import("../src/provider")
    const createExports = Object.keys(mod).filter((key) => key.startsWith("create")).sort()

    expect(createExports).toEqual(["createAntigravityCliProvider"])
  })

  test("creates v3 language models and returns stdout text without usage guesses", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.write("provider text")
        child.close(0)
      })
    })
    const provider = createAntigravityCliProvider({ command: "fake-agy", timeoutMs: 1_000 }, { spawn: fake.spawn })
    const model = provider.languageModel("default")
    const result = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })

    expect(provider.specificationVersion).toBe("v3")
    expect(model.provider).toBe("antigravity-cli")
    expect(result.content).toEqual([{ type: "text", text: "provider text" }])
    expect(result.usage.inputTokens.total).toBeUndefined()
    expect(fake.calls[0].args.at(-1)).toContain("hello")
    expect(fake.calls[0].options.shell).toBe(false)
  })
})

describe("agy subprocess safety", () => {
  test("builds extra args, mapped model, and prompt in official CLI argument order", () => {
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

  test("rejects auth, account, project, and credential extra args", () => {
    for (const arg of ["--api-key", "--token=value", "--auth", "--credential", "--credentials", "--project", "--account", "--login", "--logout"]) {
      expect(() => normalizeOptions({ extraArgs: [arg] })).toThrow("Configure authentication by running agy directly")
    }
  })

  test("spawns the command without a shell and fails fast on interactive setup prompts", async () => {
    const fake = createFakeSpawn((child) => {
      queueMicrotask(() => child.stdout.write("Please login to continue"))
    })

    await expect(runAgyCommand({ modelId: "default", prompt: "hello", options: { command: "fake-agy", timeoutMs: 1_000 } }, { spawn: fake.spawn })).rejects.toThrow(
      "Run `agy` directly to complete setup",
    )
    expect(fake.calls[0].options.shell).toBe(false)
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM"])
  })
})
