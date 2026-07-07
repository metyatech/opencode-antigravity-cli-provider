import type { Config, PluginModule, PluginOptions } from "@opencode-ai/plugin"
import { discoverAgyModels } from "./model-discovery"
import type { AgyModelDiscoveryResult } from "./model-discovery"

type ProviderModelConfig = {
  name: string
}

type AntigravityCliPluginOptions = PluginOptions & {
  enabled?: boolean
  command?: string
  timeoutMs?: number
  discoveryTimeoutMs?: number
  extraArgs?: string[]
  model?: string
}

type MutableOpenCodeConfig = Config & {
  provider?: Record<string, unknown>
  model?: string
}

type AntigravityCliPluginModuleDependencies = {
  discoverAgyModels?: typeof discoverAgyModels
  warn?: (message: string) => void
}

const providerId = "antigravity-cli"

const defaultWarn = (message: string) => console.warn(`[opencode-antigravity-cli-provider] ${message}`)

const createProviderConfig = (options: AntigravityCliPluginOptions, discovery: AgyModelDiscoveryResult) => ({
  npm: new URL("./provider.js", import.meta.url).href,
  name: "Antigravity CLI",
  options: {
    command: options.command ?? "agy",
    timeoutMs: options.timeoutMs ?? 1_800_000,
    modelMap: discovery.modelMap,
    extraArgs: options.extraArgs ?? [],
  },
  models: discovery.models,
})

export const createAntigravityCliPluginModule = (dependencies: AntigravityCliPluginModuleDependencies = {}): PluginModule => ({
  id: "opencode-antigravity-cli-provider",
  server: async (_input, options = {}) => {
    const discoverModels = dependencies.discoverAgyModels ?? discoverAgyModels
    const warn = dependencies.warn ?? defaultWarn
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

        const discovery = await discoverModels({ command: pluginOptions.command ?? "agy", timeoutMs: pluginOptions.discoveryTimeoutMs })
          .catch((error: unknown) => {
            warn(`Skipping provider injection because agy models discovery failed: ${error instanceof Error ? error.message : String(error)}`)
            return undefined
          })
        if (discovery === undefined) {
          return
        }

        if (discovery.discovered.length === 0) {
          warn("Skipping provider injection because agy models discovery returned no models.")
          return
        }

        config.provider[providerId] = createProviderConfig(pluginOptions, discovery)

        if (config.model === undefined) {
          const requestedModel =
            typeof pluginOptions.model === "string" ? pluginOptions.model.trim() : ""
          if (requestedModel.length > 0) {
            if (Object.prototype.hasOwnProperty.call(discovery.modelMap, requestedModel)) {
              config.model = `${providerId}/${requestedModel}`
            } else {
              warn(`Skipping default model selection because discovered model slug "${requestedModel}" was not found.`)
            }
          }
        }
      },
    }
  },
})

const pluginModule: PluginModule = createAntigravityCliPluginModule()

export default pluginModule
