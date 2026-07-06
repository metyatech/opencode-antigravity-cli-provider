import { describe, expect, test } from "bun:test"
import pluginModule from "./index"

type MutableConfig = {
  provider?: Record<string, unknown>
  model?: string
  [key: string]: unknown
}

const createServerHooks = (options: Record<string, unknown> = {}) => pluginModule.server({ directory: process.cwd(), client: {} } as Parameters<typeof pluginModule.server>[0], options)

const createConfig = (overrides: Partial<MutableConfig> = {}): MutableConfig => ({ ...overrides })

describe("OpenCode plugin entrypoint", () => {
  test("exports the requested PluginModule shape and id", () => {
    expect(pluginModule.id).toBe("opencode-antigravity-cli-provider")
    expect(typeof pluginModule.server).toBe("function")
  })

  test("injects the antigravity-cli provider without setting top-level default model", async () => {
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
    })
    expect(config.model).toBeUndefined()
  })

  test("sets top-level model from explicit plugin option when config.model is absent", async () => {
    const hooks = await createServerHooks({ model: "antigravity-cli/default" })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config.model).toBe("antigravity-cli/default")
    expect(config.provider?.["antigravity-cli"]).toMatchObject({
      name: "Antigravity CLI",
      options: { command: "agy" },
    })
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

  test("preserves an existing top-level model and provider", async () => {
    const hooks = await createServerHooks({ model: "antigravity-cli/default" })
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
  })

  test("respects enabled false", async () => {
    const hooks = await createServerHooks({ enabled: false })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toEqual({})
  })

  test("respects enabled false even when plugin options request a model", async () => {
    const hooks = await createServerHooks({ enabled: false, model: "antigravity-cli/default" })
    const config = createConfig()

    await hooks.config?.(config as Parameters<NonNullable<typeof hooks.config>>[0])

    expect(config).toEqual({})
  })

  test("applies plugin option overrides when injecting provider config", async () => {
    const hooks = await createServerHooks({
      command: "custom-agy",
      timeoutMs: 2_000,
      modelMap: { default: null, pro: "Agy Pro" },
      extraArgs: ["--verbose"],
      models: {
        pro: {
          name: "Agy Pro",
        },
      },
    })
    const config = createConfig()

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
    })
    expect(config.model).toBeUndefined()
  })
})
