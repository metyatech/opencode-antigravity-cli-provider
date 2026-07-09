import { AntigravityCliConfigurationError } from "./errors"
import type { AntigravityCliProviderOptions, ResolvedAntigravityCliProviderOptions } from "./types"

export const DEFAULT_ANTIGRAVITY_CLI_OPTIONS: ResolvedAntigravityCliProviderOptions = {
  command: "agy",
  timeoutMs: 1_800_000,
  modelMap: {},
  extraArgs: [],
  cwd: process.cwd(),
  env: {},
}

export type AgyPromptTransport =
  | { type: "file"; tempDir: string; wrapperPrompt: string }
  | { type: "direct"; prompt: string }

const forbiddenExtraArgs = ["--api-key", "--token", "--auth", "--credential", "--credentials", "--project", "--account", "--login", "--logout", "--model", "--add-dir"]

const hasOwn = (record: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(record, key)

const isForbiddenExtraArg = (arg: string) => forbiddenExtraArgs.some((forbidden) => arg === forbidden || arg.startsWith(`${forbidden}=`))

export const normalizeOptions = (options: AntigravityCliProviderOptions = {}): ResolvedAntigravityCliProviderOptions => {
  const command = options.command ?? DEFAULT_ANTIGRAVITY_CLI_OPTIONS.command
  if (command.trim().length === 0) {
    throw new AntigravityCliConfigurationError("Antigravity CLI command must be a non-empty string.")
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_ANTIGRAVITY_CLI_OPTIONS.timeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 7_200_000) {
    throw new AntigravityCliConfigurationError("Antigravity CLI timeoutMs must be between 1000 and 7200000.")
  }

  if (typeof options.extraArgs === "string") {
    throw new AntigravityCliConfigurationError("Antigravity CLI extraArgs must be an array, not a string.")
  }

  if (options.extraArgs !== undefined && !Array.isArray(options.extraArgs)) {
    throw new AntigravityCliConfigurationError("Antigravity CLI extraArgs must be an array.")
  }

  const extraArgs = options.extraArgs ?? DEFAULT_ANTIGRAVITY_CLI_OPTIONS.extraArgs
  const forbiddenArg = extraArgs.find(isForbiddenExtraArg)
  if (forbiddenArg) {
    throw new AntigravityCliConfigurationError(`Antigravity CLI extraArgs cannot include ${forbiddenArg}. Configure authentication by running agy directly.`)
  }

  const modelMap = options.modelMap ?? DEFAULT_ANTIGRAVITY_CLI_OPTIONS.modelMap
  for (const [modelId, mappedModel] of Object.entries(modelMap)) {
    if (typeof mappedModel !== "string" || mappedModel.trim().length === 0) {
      throw new AntigravityCliConfigurationError(`Invalid Antigravity CLI model mapping for model "${modelId}". Model mappings must be non-empty strings.`)
    }
  }

  return {
    command,
    timeoutMs,
    modelMap: { ...modelMap },
    extraArgs: [...extraArgs],
    cwd: options.cwd ?? process.cwd(),
    env: { ...(options.env ?? DEFAULT_ANTIGRAVITY_CLI_OPTIONS.env) },
  }
}

export const resolveAgyModel = (modelId: string, modelMap: Record<string, string>) => {
  if (!hasOwn(modelMap, modelId)) {
    throw new AntigravityCliConfigurationError(`No Antigravity CLI model mapping configured for model "${modelId}".`)
  }

  const mappedModel = modelMap[modelId]
  if (typeof mappedModel === "string" && mappedModel.trim().length > 0) {
    return mappedModel
  }

  throw new AntigravityCliConfigurationError(`Invalid Antigravity CLI model mapping for model "${modelId}". Model mappings must be non-empty strings.`)
}

export const buildAgyArgs = (extraArgs: string[], agyModel: string, promptTransport: AgyPromptTransport) => {
  if (promptTransport.type === "file") {
    return [...extraArgs, "--add-dir", promptTransport.tempDir, "--model", agyModel, "-p", promptTransport.wrapperPrompt]
  }

  return [...extraArgs, "--model", agyModel, "-p", promptTransport.prompt]
}
