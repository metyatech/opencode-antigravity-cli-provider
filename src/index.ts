import type { Config, PluginModule, PluginOptions } from "@opencode-ai/plugin"

type ProviderModelConfig = {
  name: string
}

type AntigravityCliPluginOptions = PluginOptions & {
  enabled?: boolean
  command?: string
  timeoutMs?: number
  modelMap?: Record<string, string | null>
  extraArgs?: string[]
  models?: Record<string, ProviderModelConfig>
  model?: string
}

type MutableOpenCodeConfig = Config & {
  provider?: Record<string, unknown>
  model?: string
}

const providerId = "antigravity-cli"

const defaultModels = {
  default: {
    name: "Antigravity CLI Default",
  },
}

const createProviderConfig = (options: AntigravityCliPluginOptions) => ({
  npm: new URL("./provider.js", import.meta.url).href,
  name: "Antigravity CLI",
  options: {
    command: options.command ?? "agy",
    timeoutMs: options.timeoutMs ?? 1_800_000,
    modelMap: options.modelMap ?? { default: null },
    extraArgs: options.extraArgs ?? [],
  },
  models: options.models ?? defaultModels,
})

const pluginModule: PluginModule = {
  id: "opencode-antigravity-cli-provider",
  server: async (_input, options = {}) => {
    const pluginOptions = options as AntigravityCliPluginOptions
    return {
      config: async (input) => {
        if (pluginOptions.enabled === false) {
          return
        }

        const config = input as MutableOpenCodeConfig
        config.provider ??= {}
        if (config.provider[providerId]) {
          return
        }

        config.provider[providerId] = createProviderConfig(pluginOptions)

        if (config.model === undefined) {
          const requestedModel =
            typeof pluginOptions.model === "string" ? pluginOptions.model.trim() : ""
          if (requestedModel.length > 0) {
            config.model = requestedModel
          }
        }
      },
    }
  },
}

export default pluginModule
