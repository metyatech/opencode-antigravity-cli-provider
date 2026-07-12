export class AntigravityCliProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "AntigravityCliProviderError"
  }
}

export class PromptCleanupError extends AntigravityCliProviderError {
  readonly tempDir: string

  constructor(tempDir: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause)
    super(`Prompt cleanup failed for ${tempDir}. ${causeMessage}`, { cause })
    this.name = "PromptCleanupError"
    this.tempDir = tempDir
  }
}

export type PromptCleanupErrorCarrier = Error & {
  cleanupError?: Error
}

const cleanupFailureNotePrefix = "Prompt cleanup also failed:"

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

export const attachPromptCleanupError = (primaryError: unknown, cleanupError: unknown) => {
  const cleanup = toError(cleanupError)
  if (primaryError instanceof Error) {
    const carrier: PromptCleanupErrorCarrier = primaryError
    carrier.cleanupError = cleanup
    if (!primaryError.message.includes(cleanupFailureNotePrefix)) {
      primaryError.message = `${primaryError.message} ${cleanupFailureNotePrefix} ${cleanup.message}`
    }
    return primaryError
  }

  const wrapped: PromptCleanupErrorCarrier = new AntigravityCliProviderError(`Antigravity CLI failed. ${cleanupFailureNotePrefix} ${cleanup.message}`, { cause: primaryError })
  wrapped.cleanupError = cleanup
  return wrapped
}

export const getPromptCleanupError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return undefined
  }

  if (error instanceof PromptCleanupError) {
    return error
  }

  const carrier: PromptCleanupErrorCarrier = error
  return carrier.cleanupError
}

export class AntigravityCliConfigurationError extends AntigravityCliProviderError {
  constructor(message: string) {
    super(message)
    this.name = "AntigravityCliConfigurationError"
  }
}

export class AntigravityCliInteractiveSetupError extends AntigravityCliProviderError {
  constructor(summary: string) {
    super(`Antigravity CLI requires interactive setup. Run \`agy\` directly to complete setup, then retry.${summary ? ` ${summary}` : ""}`)
    this.name = "AntigravityCliInteractiveSetupError"
  }
}

export class AntigravityCliTimeoutError extends AntigravityCliProviderError {
  constructor(timeoutMs: number) {
    super(`Antigravity CLI timed out after ${timeoutMs}ms.`)
    this.name = "AntigravityCliTimeoutError"
  }
}

export const summarizeStderr = (stderr: string, maxLength = 240) => {
  const summary = stderr.replace(/\s+/g, " ").trim()
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1)}…` : summary
}

export const createInteractiveSetupError = (text: string) => new AntigravityCliInteractiveSetupError(summarizeStderr(text))

export const createExitError = (code: number | null, stderr: string) =>
  new AntigravityCliProviderError(`Antigravity CLI failed with exit code ${code ?? "unknown"}.${summarizeStderr(stderr) ? ` ${summarizeStderr(stderr)}` : ""}`)

export const createNoOutputError = (stderr: string) =>
  new AntigravityCliProviderError(summarizeStderr(stderr) ? `Antigravity CLI returned no output. ${summarizeStderr(stderr)}` : "Antigravity CLI returned no output.")

export const createAbortError = () => {
  const error = new Error("Antigravity CLI call aborted.")
  error.name = "AbortError"
  return error
}
export { isInteractivePrompt } from "./agy-interactive-setup"
