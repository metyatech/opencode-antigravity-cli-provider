import { runAgyCommand } from "./agy-command"
import { AntigravityCliConfigurationError } from "./errors"
import { normalizeOptions } from "./options"
import { buildAgyPrompt } from "./prompt"
import { APPROXIMATION_WARNINGS, createStopFinishReason, createUnknownUsage } from "./types"
import type {
  AntigravityCliProviderOptions,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  ProviderV3,
  ResolvedAntigravityCliProviderOptions,
  RunAgyCommandDependencies,
} from "./types"

class AntigravityCliLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = "antigravity-cli"
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    private readonly options: ResolvedAntigravityCliProviderOptions,
    private readonly dependencies: RunAgyCommandDependencies,
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const result = await runAgyCommand(
      {
        modelId: this.modelId,
        prompt: buildAgyPrompt(options.prompt),
        options: this.options,
        abortSignal: options.abortSignal,
      },
      this.dependencies,
    )

    return {
      content: [{ type: "text", text: result.stdout }],
      finishReason: createStopFinishReason(),
      usage: createUnknownUsage(),
      warnings: APPROXIMATION_WARNINGS,
    }
  }

  async doStream(options: LanguageModelV3CallOptions) {
    const stream = (await import("./stream")).createAgyTextStream(
      {
        modelId: this.modelId,
        prompt: buildAgyPrompt(options.prompt),
        options: this.options,
        abortSignal: options.abortSignal,
      },
      this.dependencies,
    )

    return { stream }
  }
}

const unsupportedModel = (modelType: string, modelId: string): never => {
  throw new AntigravityCliConfigurationError(`Antigravity CLI provider does not support ${modelType} model "${modelId}".`)
}

export const createAntigravityCliProvider = (options: AntigravityCliProviderOptions = {}, dependencies: RunAgyCommandDependencies = {}): ProviderV3 => {
  const resolvedOptions = normalizeOptions(options)
  return {
    specificationVersion: "v3",
    languageModel: (modelId) => new AntigravityCliLanguageModel(modelId, resolvedOptions, dependencies),
    embeddingModel: (modelId) => unsupportedModel("embedding", modelId),
    textEmbeddingModel: (modelId) => unsupportedModel("text embedding", modelId),
    imageModel: (modelId) => unsupportedModel("image", modelId),
  }
}

export const antigravityCliProvider = createAntigravityCliProvider()

export default antigravityCliProvider
