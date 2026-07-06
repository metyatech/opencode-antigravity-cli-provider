export class AntigravityCliProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "AntigravityCliProviderError"
  }
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

const interactivePromptPatterns = [
  /not signed in/i,
  /sign in/i,
  /authorization URL/i,
  /do you trust/i,
  /trust this folder/i,
  /requires permission/i,
  /select .*theme/i,
  /accept .*terms/i,
  /press enter/i,
  /↑\/↓ Navigate/i,
  /login to continue/i,
  /permission required/i,
]

export const isInteractivePrompt = (text: string) => interactivePromptPatterns.some((pattern) => pattern.test(text))

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
