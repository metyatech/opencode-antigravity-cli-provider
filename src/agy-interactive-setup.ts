const defaultMaxBufferSize = 8 * 1024

const ansiCsiPattern = new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, "g")
const ansiOscPattern = new RegExp(String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`, "g")
const terminalControlPattern = new RegExp(String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`, "g")

export const normalizeAgyInteractiveSetupText = (text: string) =>
  text
    .replace(ansiOscPattern, "")
    .replace(ansiCsiPattern, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(terminalControlPattern, "")

const trimPromptPunctuation = (line: string) => line.trim().replace(/[.!?！。！？]+$/u, "")

export const isInteractivePrompt = (text: string) => {
  const line = trimPromptPunctuation(normalizeAgyInteractiveSetupText(text))
  return /^(?:not signed in|you are not signed in|please sign in to continue|please login to continue|login to continue|authorization url:\s+\S+|do you trust this folder|trust this folder|this action requires permission|permission required(?: before use)?|select a theme|accept the terms|press enter to continue|↑\/↓ navigate)$/iu.test(line)
}

export type AgyInteractiveSetupDetector = {
  push(chunk: string): string | undefined
  disable(): void
}

export const createAgyInteractiveSetupDetector = (options: { maxBufferSize?: number } = {}): AgyInteractiveSetupDetector => {
  const maxBufferSize = Math.max(1, options.maxBufferSize ?? defaultMaxBufferSize)
  let buffer = ""
  let enabled = true

  return {
    push(chunk) {
      if (!enabled || chunk.length === 0) {
        return undefined
      }

      buffer = `${buffer}${chunk}`.slice(-maxBufferSize)
      const normalized = normalizeAgyInteractiveSetupText(buffer)
      const lines = normalized.split("\n")
      for (const line of lines) {
        if (isInteractivePrompt(line)) {
          return line.trim()
        }
      }
      return undefined
    },
    disable() {
      enabled = false
      buffer = ""
    },
  }
}
