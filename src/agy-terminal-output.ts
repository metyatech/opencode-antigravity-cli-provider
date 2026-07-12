import os from "node:os"
import { Terminal } from "@xterm/headless"
import type { AgyTerminalOutputParser } from "./types"

const progressScreenClear = "\u001b[2J"
const progressScreenHome = "\u001b[H"

// The observed agy 1.1.1 redraw changed one logical answer line after text
// streaming had started. Keep that line and one adjacent line mutable so a
// redraw cannot invalidate text already sent to OpenCode.
const mutableTailLineCount = 2

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

const stablePrefixForLines = (lines: string[], tailLineCount: number) => {
  if (lines.length <= tailLineCount) {
    return ""
  }

  return `${lines.slice(0, -tailLineCount).join("\n")}\n`
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
  let committedPrefix = ""
  let lastAcceptedAnswer = ""
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
          if (!answerStarted || (!fullCandidate.startsWith(committedPrefix) && withoutProgressCandidate.startsWith(committedPrefix))) {
            candidate = withoutProgressCandidate
          }
        } else if (!finalize) {
          candidate = ""
        }
      }
    }

    if (candidate.length === 0 && !finalize) {
      return ""
    }

    if (finalize) {
      if (candidate.length === 0) {
        const retainedAnswer = lastAcceptedAnswer || committedPrefix
        if (!retainedAnswer.startsWith(committedPrefix)) {
          throw new Error("Antigravity CLI terminal output became non-monotonic after streaming started.")
        }
        const suffix = retainedAnswer.slice(committedPrefix.length)
        committedPrefix = retainedAnswer
        if (suffix.length > 0) onDelta(suffix)
        return retainedAnswer
      }

      if (!candidate.startsWith(committedPrefix)) {
        throw new Error("Antigravity CLI terminal output became non-monotonic after streaming started.")
      }

      const suffix = candidate.slice(committedPrefix.length)
      committedPrefix = candidate
      if (suffix.length > 0) {
        answerStarted = true
        onDelta(suffix)
      }
      return candidate
    }

    const stablePrefix = stablePrefixForLines(candidate.split("\n"), mutableTailLineCount)
    if (stablePrefix.length < committedPrefix.length && committedPrefix.startsWith(stablePrefix)) {
      if (candidate.startsWith(committedPrefix)) {
        lastAcceptedAnswer = candidate
      }
      return committedPrefix
    }

    if (!stablePrefix.startsWith(committedPrefix)) {
      throw new Error("Antigravity CLI terminal output became non-monotonic after streaming started.")
    }

    const suffix = stablePrefix.slice(committedPrefix.length)
    committedPrefix = stablePrefix
    lastAcceptedAnswer = candidate
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
