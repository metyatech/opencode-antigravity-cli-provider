import os from "node:os"
import { Terminal } from "@xterm/headless"
import type { AgyTerminalOutputParser } from "./types"

const progressScreenClear = "\u001b[2J"
const progressScreenHome = "\u001b[H"

const getLogicalLines = (terminal: Terminal) => {
  const lines: string[] = []
  const buffer = terminal.buffer.active
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index)
    if (line === undefined) {
      continue
    }

    const text = line.translateToString(true)
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text
    } else {
      lines.push(text)
    }
  }

  while (lines.length > 0 && lines[lines.length - 1].length === 0) {
    lines.pop()
  }
  return lines
}

const firstVisibleText = (lines: string[]) => {
  const firstVisibleIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstVisibleIndex < 0) {
    return ""
  }

  return lines.slice(firstVisibleIndex).join("\n")
}

export const buildAgyTerminalOptions = (platform: NodeJS.Platform, osRelease = os.release()) => ({
    cols: 120,
    rows: 30,
    scrollback: 100_000,
    allowProposedApi: true,
    convertEol: false,
    logLevel: "off",
    windowsPty: getAgyWindowsPtyOptions(platform, osRelease),
  } as const)

export const createAgyTerminalOutputParser = (onDelta: (delta: string) => void, platform: NodeJS.Platform): AgyTerminalOutputParser => {
  const terminal = new Terminal(buildAgyTerminalOptions(platform))
  let writeChain = Promise.resolve()
  let previousAnswer = ""
  let answerStarted = false
  let excludeProgressLine = false
  let disposed = false

  const readCandidate = (finalize = false) => {
    const lines = getLogicalLines(terminal)
    const fullCandidate = firstVisibleText(lines)
    let candidate = fullCandidate
    if (excludeProgressLine) {
      const firstVisibleIndex = lines.findIndex((line) => line.trim().length > 0)
      if (firstVisibleIndex >= 0) {
        const visibleLineCount = lines.slice(firstVisibleIndex).filter((line) => line.trim().length > 0).length
        if (visibleLineCount > 1) {
          const withoutProgressLine = [...lines]
          withoutProgressLine.splice(firstVisibleIndex, 1)
          const withoutProgressCandidate = firstVisibleText(withoutProgressLine)
          if (!answerStarted || (!fullCandidate.startsWith(previousAnswer) && withoutProgressCandidate.startsWith(previousAnswer))) {
            candidate = withoutProgressCandidate
          }
        } else if (!finalize) {
          return ""
        }
      }
    }

    if (candidate.length === 0) {
      return ""
    }

    if (!candidate.startsWith(previousAnswer)) {
      throw new Error("Antigravity CLI terminal output became non-monotonic after streaming started.")
    }

    const suffix = candidate.slice(previousAnswer.length)
    previousAnswer = candidate
    if (suffix.length > 0) {
      answerStarted = true
      onDelta(suffix)
    }
    return candidate
  }

  const push = (data: string) => {
    if (disposed) {
      return Promise.reject(new Error("Antigravity CLI terminal output parser is disposed."))
    }

    writeChain = writeChain.then(
      () => new Promise<void>((resolve, reject) => {
        try {
          terminal.write(data, () => {
            try {
              if (data.includes(progressScreenClear) && data.includes(progressScreenHome) && !answerStarted) {
                excludeProgressLine = true
              }
              readCandidate()
              resolve()
            } catch (error) {
              reject(error)
            }
          })
        } catch (error) {
          reject(error)
        }
      }),
    )
    return writeChain
  }

  return {
    push,
    async finish() {
      await writeChain
      return readCandidate(true)
    },
    dispose() {
      disposed = true
      terminal.dispose()
    },
  }
}

export const getAgyWindowsPtyOptions = (platform: NodeJS.Platform, osRelease = os.release()) => {
  if (platform !== "win32") {
    return undefined
  }

  const buildNumber = Number(osRelease.split(".").at(-1))
  return Number.isFinite(buildNumber) ? { backend: "conpty" as const, buildNumber } : { backend: "conpty" as const }
}
