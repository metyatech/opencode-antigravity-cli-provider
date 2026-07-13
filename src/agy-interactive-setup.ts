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

export const createAgyInteractiveSetupDetector = (options: { maxBufferSize?: number } = {}): AgyInteractiveSetupDetector => {
  const maxBufferSize = Math.max(1, options.maxBufferSize ?? defaultMaxBufferSize)
  let lineBuffer = ""
  let ansiCarry = ""
  let currentCandidate: AgyInteractivePromptCandidate | undefined
  let currentCandidateOrigin: "active" | "completed" | undefined
  let enabled = true

  const clearActiveLine = () => {
    lineBuffer = ""
    if (currentCandidateOrigin === "active") {
      currentCandidate = undefined
      currentCandidateOrigin = undefined
    }
  }

  const clearScreenState = () => {
    lineBuffer = ""
    currentCandidate = undefined
    currentCandidateOrigin = undefined
  }

  const evaluateActiveLine = () => {
    const trimmedLine = lineBuffer.trim()
    if (trimmedLine.length === 0) {
      return
    }

    if (isInteractivePrompt(trimmedLine)) {
      currentCandidate = { line: trimmedLine }
      currentCandidateOrigin = "active"
      return
    }

    currentCandidate = undefined
    currentCandidateOrigin = undefined
  }

  const completeLine = () => {
    const trimmedLine = lineBuffer.trim()
    if (trimmedLine.length > 0) {
      if (isInteractivePrompt(trimmedLine)) {
        currentCandidate = { line: trimmedLine }
        currentCandidateOrigin = "completed"
      } else {
        currentCandidate = undefined
        currentCandidateOrigin = undefined
      }
    }
    lineBuffer = ""
  }

  const appendText = (text: string) => {
    lineBuffer = `${lineBuffer}${text}`.slice(-maxBufferSize)
    evaluateActiveLine()
  }

  const findAnsiSequenceEnd = (text: string, start: number) => {
    if (text[start + 1] === "[") {
      for (let index = start + 2; index < text.length; index += 1) {
        const code = text.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) {
          return index + 1
        }
      }
      return undefined
    }

    if (text[start + 1] === "]") {
      for (let index = start + 2; index < text.length; index += 1) {
        if (text[index] === "\u0007") {
          return index + 1
        }
        if (text[index] === "\u001b" && text[index + 1] === "\\") {
          return index + 2
        }
      }
      return undefined
    }

    return start + 2 <= text.length ? start + 2 : undefined
  }

  const processCsi = (sequence: string) => {
    const finalByte = sequence.at(-1)
    const parameters = sequence.slice(2, -1)
    if (finalByte === "K") {
      clearActiveLine()
      return
    }

    if (finalByte === "J" && (parameters === "2" || parameters === "3")) {
      clearScreenState()
    }
  }

  return {
    push(chunk) {
      if (!enabled || chunk.length === 0) {
        return undefined
      }

      const rawChunk = `${ansiCarry}${chunk}`
      ansiCarry = ""
      let index = 0
      while (index < rawChunk.length) {
        const character = rawChunk[index]
        if (character === "\u001b") {
          const sequenceEnd = findAnsiSequenceEnd(rawChunk, index)
          if (sequenceEnd === undefined) {
            ansiCarry = rawChunk.slice(index).slice(-maxBufferSize)
            break
          }

          const sequence = rawChunk.slice(index, sequenceEnd)
          if (sequence.startsWith("\u001b[")) {
            processCsi(sequence)
          }
          index = sequenceEnd
          continue
        }

        if (character === "\r") {
          if (rawChunk[index + 1] === "\n") {
            completeLine()
            index += 2
          } else {
            clearActiveLine()
            index += 1
          }
          continue
        }

        if (character === "\n") {
          completeLine()
          index += 1
          continue
        }

        if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) {
          index += 1
          continue
        }

        appendText(character)
        index += 1
      }

      return currentCandidate
    },
    clear() {
      lineBuffer = ""
      ansiCarry = ""
      currentCandidate = undefined
      currentCandidateOrigin = undefined
    },
    disable() {
      enabled = false
      lineBuffer = ""
      ansiCarry = ""
      currentCandidate = undefined
      currentCandidateOrigin = undefined
    },
  }
}
