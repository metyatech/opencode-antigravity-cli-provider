import { beforeEach, describe, expect, test } from "bun:test"
import type { PluginModule } from "@opencode-ai/plugin"
import { createAntigravityCliPluginModule } from "./index"
import type { AgyModelDiscoveryResult, DiscoverAgyModelsOptions } from "./model-discovery"

type MutableConfig = {
  provider?: Record<string, unknown>
  model?: string
  [key: string]: unknown
}

const defaultDiscovery: AgyModelDiscoveryResult = {
  discovered: [
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking", agyModel: "Claude Opus 4.6 Thinking" },
    { id: "gemini-3-1-pro-preview", name: "Gemini 3.1 Pro Preview", agyModel: "Gemini 3.1 Pro Preview" },
  ],
  models: {
    "claude-opus-4-6-thinking": { name: "Claude Opus 4.6 Thinking" },
    "gemini-3-1-pro-preview": { name: "Gemini 3.1 Pro Preview" },
  },
  modelMap: {
    "claude-opus-4-6-thinking": "Claude Opus 4.6 Thinking",
    "gemini-3-1-pro-preview": "Gemini 3.1 Pro Preview",
  },
}

const discoverCalls: DiscoverAgyModelsOptions[] = []
const warnings: string[] = []
const discoveryQueue: Array<() => Promise<AgyModelDiscoveryResult>> = []

const discoverAgyModels = (options: DiscoverAgyModelsOptions = {}) => {
  discoverCalls.push(options)
  const next = discoveryQueue.shift()
  return next === undefined ? Promise.resolve(defaultDiscovery) : next()
}

const warn = (message: string) => warnings.push(message)

const pluginModule = (): PluginModule => createAntigravityCliPluginModule({ discoverAgyModels, warn })

const createServerHooks = (options: Record<string, unknown> = {}) => pluginModule().server({ directory: process.cwd(), client: {} } as Parameters<PluginModule["server"]>[0], options)

const createConfig = (overrides: Partial<MutableConfig> = {}): MutableConfig => ({ ...overrides })

beforeEach(() => {
  discoverCalls.length = 0
  warnings.length = 0
  discoveryQueue.length = 0
})

describe("OpenCode plugin entrypoint", () => {
  test("exports the requested PluginModule shape and id", () => {
    const module = pluginModule()

    expect(module.id).toBe("opencode-antigravity-cli-provider")
    expect(typeof module.server).toBe("function")
  })

  test("discovers models and injects the antigravity-cli provider without setting top-level default model", async () => {
    const hooks = await createServerHooks()
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toEqual({
      provider: {
        "antigravity-cli": {
          npm: new URL("./provider.js", import.meta.url).href,
          name: "Antigravity CLI",
          options: {
            command: "agy",
            timeoutMs: 1_800_000,
            modelMap: defaultDiscovery.modelMap,
            extraArgs: [],
          },
          models: defaultDiscovery.models,
        },
      },
    })
    expect(config.model).toBeUndefined()
    expect(discoverCalls).toEqual([{ command: "agy", timeoutMs: undefined }])
  })

  test("sets top-level model from explicit prefixed discovered model when config.model is absent", async () => {
    const hooks = await createServerHooks({ model: "antigravity-cli/claude-opus-4-6-thinking" })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config.model).toBe("antigravity-cli/claude-opus-4-6-thinking")
    expect(config.provider?.["antigravity-cli"]).toMatchObject({
      name: "Antigravity CLI",
      options: { command: "agy" },
    })
  })

  test("sets top-level model from explicit discovered slug without provider prefix", async () => {
    const hooks = await createServerHooks({ model: "claude-opus-4-6-thinking" })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config.model).toBe("antigravity-cli/claude-opus-4-6-thinking")
  })

  test("warns and leaves top-level model unset for a requested slug that was not discovered", async () => {
    const hooks = await createServerHooks({ model: "missing-model" })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config.model).toBeUndefined()
    expect(config.provider?.["antigravity-cli"]).toBeDefined()
    expect(warnings[0]).toContain("missing-model")
  })

  test("treats whitespace-only plugin option model as no model override", async () => {
    const hooks = await createServerHooks({ model: "   " })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config.model).toBeUndefined()
    expect(config.provider?.["antigravity-cli"]).toBeDefined()
  })

  test("ignores non-string plugin option model", async () => {
    const hooks = await createServerHooks({ model: 42 })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config.model).toBeUndefined()
    expect(config.provider?.["antigravity-cli"]).toBeDefined()
  })

  test("preserves an existing top-level model and provider without discovery", async () => {
    const hooks = await createServerHooks({ model: "claude-opus-4-6-thinking" })
    const config = createConfig({
      provider: {
        "antigravity-cli": {
          npm: "custom-provider",
        },
      },
      model: "custom/model",
    })

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config.model).toBe("custom/model")
    expect(config.provider?.["antigravity-cli"]).toEqual({ npm: "custom-provider" })
    expect(discoverCalls).toEqual([])
  })

  test("does not replace an existing antigravity-cli provider", async () => {
    const hooks = await createServerHooks({ command: "ignored-agy" })
    const config = createConfig({
      provider: {
        "antigravity-cli": {
          npm: "custom-provider",
        },
      },
      model: "custom/model",
    })

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config.provider?.["antigravity-cli"]).toEqual({ npm: "custom-provider" })
    expect(config.model).toBe("custom/model")
    expect(discoverCalls).toEqual([])
  })

  test("respects enabled false", async () => {
    const hooks = await createServerHooks({ enabled: false })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toEqual({})
    expect(discoverCalls).toEqual([])
  })

  test("respects enabled false even when plugin options request a model", async () => {
    const hooks = await createServerHooks({ enabled: false, model: "claude-opus-4-6-thinking" })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toEqual({})
    expect(discoverCalls).toEqual([])
  })

  test("applies supported plugin option overrides when injecting provider config", async () => {
    const hooks = await createServerHooks({
      command: "custom-agy",
      timeoutMs: 2_000,
      discoveryTimeoutMs: 3_000,
      extraArgs: ["--verbose"],
    })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toMatchObject({
      provider: {
        "antigravity-cli": {
          options: {
            command: "custom-agy",
            timeoutMs: 2_000,
            modelMap: defaultDiscovery.modelMap,
            extraArgs: ["--verbose"],
          },
          models: defaultDiscovery.models,
        },
      },
    })
    expect(config.model).toBeUndefined()
    expect(discoverCalls).toEqual([{ command: "custom-agy", timeoutMs: 3_000 }])
  })

  test("warns and skips provider injection when discovery fails", async () => {
    discoveryQueue.push(() => Promise.reject(new Error("discovery boom")))
    const hooks = await createServerHooks()
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toEqual({})
    expect(warnings[0]).toContain("discovery boom")
  })

  test("warns and skips provider injection when discovery returns zero models", async () => {
    discoveryQueue.push(() => Promise.resolve({ discovered: [], models: {}, modelMap: {} }))
    const hooks = await createServerHooks()
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toEqual({})
    expect(warnings[0]).toContain("returned no models")
  })
})
