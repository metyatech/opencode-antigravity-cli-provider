import { describe, expect, test } from "bun:test"
import pluginModule from "./index"

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
