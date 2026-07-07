export type AntigravityCliProviderOptions = {
  command?: string
  timeoutMs?: number
  modelMap?: Record<string, string>
  extraArgs?: string[]
  cwd?: string
  env?: Record<string, string>
}

export type ResolvedAntigravityCliProviderOptions = {
  command: string
  timeoutMs: number
  modelMap: Record<string, string>
  extraArgs: string[]
  cwd: string
  env: Record<string, string>
}

export type AgyCommandInvocation = {
  command: string
  args: string[]
  options: ResolvedAntigravityCliProviderOptions
  agyModel: string
}

export type AgyCommandResult = {
  stdout: string
  stderr: string
}

export type AgySpawnOptions = {
  shell: false
  cwd: string
  env: NodeJS.ProcessEnv
}

export type AgyReadableStream = {
  on(event: "data", listener: (chunk: unknown) => void): unknown
}

export type AgyChildProcess = {
  stdout: AgyReadableStream
  stderr: AgyReadableStream
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: "error", listener: (error: Error) => void): unknown
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export type AgySpawn = (command: string, args: string[], options: AgySpawnOptions) => AgyChildProcess

export type AgySetTimeout = (handler: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>

export type AgyClearTimeout = (timer: ReturnType<typeof setTimeout>) => void

export type RunAgyCommandDependencies = {
  spawn?: AgySpawn
  setTimeout?: AgySetTimeout
  clearTimeout?: AgyClearTimeout
}

export type RunAgyCommandRequest = {
  modelId: string
  prompt: string
  options?: AntigravityCliProviderOptions | ResolvedAntigravityCliProviderOptions
  abortSignal?: AbortSignal
  onStdout?: (chunk: string) => void
}

export type LanguageModelV3Prompt = Array<{
  role: "system" | "user" | "assistant" | "tool"
  content: unknown
  providerOptions?: unknown
}>

export type LanguageModelV3CallOptions = {
  prompt: LanguageModelV3Prompt
  abortSignal?: AbortSignal
}

export type LanguageModelV3Usage = {
  inputTokens: {
    total: number | undefined
    noCache: number | undefined
    cacheRead: number | undefined
    cacheWrite: number | undefined
  }
  outputTokens: {
    total: number | undefined
    text: number | undefined
    reasoning: number | undefined
  }
  raw?: Record<string, unknown>
}

export type LanguageModelV3FinishReason = {
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"
  raw: string | undefined
}

export type LanguageModelV3Warning =
  | { type: "unsupported"; feature: string; details?: string }
  | { type: "compatibility"; feature: string; details?: string }
  | { type: "other"; message: string }

export type LanguageModelV3Text = {
  type: "text"
  text: string
  providerMetadata?: Record<string, Record<string, unknown>>
}

export type LanguageModelV3GenerateResult = {
  content: LanguageModelV3Text[]
  finishReason: LanguageModelV3FinishReason
  usage: LanguageModelV3Usage
  warnings: LanguageModelV3Warning[]
}

export type LanguageModelV3StreamPart =
  | { type: "stream-start"; warnings: LanguageModelV3Warning[] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "finish"; usage: LanguageModelV3Usage; finishReason: LanguageModelV3FinishReason }
  | { type: "error"; error: unknown }

export type LanguageModelV3StreamResult = {
  stream: ReadableStream<LanguageModelV3StreamPart>
}

export type LanguageModelV3 = {
  readonly specificationVersion: "v3"
  readonly provider: string
  readonly modelId: string
  supportedUrls: Record<string, RegExp[]>
  doGenerate(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3GenerateResult>
  doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult>
}

export type ProviderV3 = {
  readonly specificationVersion: "v3"
  languageModel(modelId: string): LanguageModelV3
  embeddingModel(modelId: string): never
  textEmbeddingModel?(modelId: string): never
  imageModel(modelId: string): never
}

export const APPROXIMATION_WARNINGS: LanguageModelV3Warning[] = [
  {
    type: "other",
    message: "Antigravity CLI provider is text-only; tool calls, approvals, usage, cache control, and conversation resume are approximate/not supported.",
  },
]

export const createUnknownUsage = (): LanguageModelV3Usage => ({
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
})

export const createStopFinishReason = (): LanguageModelV3FinishReason => ({ unified: "stop", raw: undefined })
