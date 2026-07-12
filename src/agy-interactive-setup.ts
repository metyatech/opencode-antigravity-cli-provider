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
  return /^(?:not signed in|you are not signed in|please sign in to continue|please login to continue|login to continue|authorization url:\s+\S+|do you trust this folder|trust this folder|requires permission|this action requires permission|permission required(?: before use)?|select a theme|accept the terms|press enter to continue|↑\/↓ navigate)$/iu.test(line)
}

export type AgyInteractiveSetupDetector = {
  push(chunk: string): AgyInteractivePromptCandidate | undefined
  clear(): void
  disable(): void
}

export type AgyInteractivePromptCandidate = {
  line: string
}

const terminalFrameResetPattern = /\x1b\[(?:2J|H|K|2K)/

const incompleteAnsiSuffix = (text: string) => {
  const escapeIndex = text.lastIndexOf("\u001b")
  if (escapeIndex < 0) {
    return ""
  }

  const suffix = text.slice(escapeIndex)
  if (suffix === "\u001b") {
    return suffix
  }

  if (suffix.startsWith("\u001b]") && !suffix.includes("\u0007") && !suffix.includes("\u001b\\")) {
    return suffix
  }

  if (suffix.startsWith("\u001b[") && !/^\u001b\[[0-?]*[ -/]*[@-~]/.test(suffix)) {
    return suffix
  }

  return ""
}

export const createAgyInteractiveSetupDetector = (options: { maxBufferSize?: number } = {}): AgyInteractiveSetupDetector => {
  const maxBufferSize = Math.max(1, options.maxBufferSize ?? defaultMaxBufferSize)
  let lineBuffer = ""
  let ansiCarry = ""
  let currentCandidate: AgyInteractivePromptCandidate | undefined
  let enabled = true

  return {
    push(chunk) {
      if (!enabled || chunk.length === 0) {
        return undefined
      }

      if (terminalFrameResetPattern.test(chunk)) {
        lineBuffer = ""
        currentCandidate = undefined
      }

      const rawChunk = `${ansiCarry}${chunk}`
      ansiCarry = incompleteAnsiSuffix(rawChunk).slice(-maxBufferSize)
      const completeChunk = ansiCarry.length === 0 ? rawChunk : rawChunk.slice(0, -ansiCarry.length)
      lineBuffer = `${lineBuffer}${normalizeAgyInteractiveSetupText(completeChunk)}`.slice(-maxBufferSize)
      const normalized = lineBuffer
      const lines = normalized.split("\n")
      const trailingLine = lines.pop() ?? ""
      for (const line of lines) {
        const trimmedLine = line.trim()
        if (trimmedLine.length === 0) {
          continue
        }

        currentCandidate = isInteractivePrompt(trimmedLine) ? { line: trimmedLine } : undefined
      }

      const trimmedTrailingLine = trailingLine.trim()
      if (trimmedTrailingLine.length > 0) {
        currentCandidate = isInteractivePrompt(trimmedTrailingLine) ? { line: trimmedTrailingLine } : undefined
      }

      lineBuffer = trailingLine.slice(-maxBufferSize)
      return currentCandidate
    },
    clear() {
      lineBuffer = ""
      ansiCarry = ""
      currentCandidate = undefined
    },
    disable() {
      enabled = false
      lineBuffer = ""
      ansiCarry = ""
      currentCandidate = undefined
    },
  }
}
