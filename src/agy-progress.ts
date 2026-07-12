import { promises as fs } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import type { AgyProgressMonitor, AgyProgressMonitorFactoryOptions } from "./types"

const progressMonitoringErrorMessage = "Antigravity CLI progress log monitoring failed."
const progressIntervalMs = 100
const unknownProgressIntervalMs = 30_000

const fixedMessageForLogLine = (line: string) => {
  if (/Starting new conversation/i.test(line)) {
    return "Starting new conversation"
  }

  if (/Created conversation/i.test(line)) {
    return "Created conversation"
  }

  if (/Sending user message/i.test(line)) {
    return "→ リクエストを送信しています"
  }

  if (/Streaming conversation/i.test(line) || /streamGenerateContent/i.test(line)) {
    return "→ 応答を生成しています"
  }

  if (/Tool confirmation/i.test(line) && /ReadFile/i.test(line)) {
    return "→ ファイルを読み取っています"
  }

  if (/Tool confirmation/i.test(line)) {
    return "→ ツールを実行しています"
  }

  return undefined
}

export type AgyProgressMonitorDependencies = {
  now?: () => number
  intervalMs?: number
}

export const createAgyProgressMonitor = (
  options: AgyProgressMonitorFactoryOptions,
  dependencies: AgyProgressMonitorDependencies = {},
): AgyProgressMonitor => {
  const now = dependencies.now ?? Date.now
  const intervalMs = dependencies.intervalMs ?? progressIntervalMs
  const decoder = new StringDecoder("utf8")
  let offset = 0
  let pendingLine = ""
  let timer: ReturnType<typeof setInterval> | undefined
  let readChain = Promise.resolve()
  let stopped = false
  let failed = false
  let activityReported = false
  let lastMessage: string | undefined
  let lastProgressAt = 0

  const emit = (message: string) => {
    if (message === lastMessage) {
      return
    }

    lastMessage = message
    lastProgressAt = now()
    options.onProgress(message)
  }

  const processLine = (line: string) => {
    const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line
    if (normalizedLine.trim().length === 0) {
      return
    }

    if (!activityReported) {
      activityReported = true
      emit("Antigravity CLIを起動しています")
    }

    const fixedMessage = fixedMessageForLogLine(normalizedLine)
    if (fixedMessage !== undefined) {
      emit(fixedMessage)
      return
    }

    if (now() - lastProgressAt >= unknownProgressIntervalMs) {
      emit("Antigravity CLIで処理を続けています")
    }
  }

  const processText = (text: string, flush: boolean) => {
    pendingLine += text
    const lines = pendingLine.split("\n")
    pendingLine = lines.pop() ?? ""
    for (const line of lines) {
      processLine(line)
    }

    if (flush && pendingLine.length > 0) {
      processLine(pendingLine)
      pendingLine = ""
    }
  }

  const fail = (error: unknown) => {
    if (failed) {
      return
    }

    failed = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    options.onError(new Error(progressMonitoringErrorMessage, { cause: error }))
  }

  const readAvailable = async (flush: boolean) => {
    if (failed) {
      throw new Error(progressMonitoringErrorMessage)
    }

    const stat = await fs.stat(options.logFile)
    if (stat.size < offset) {
      offset = 0
    }

    if (stat.size > offset) {
      const handle = await fs.open(options.logFile, "r")
      try {
        const bytesToRead = stat.size - offset
        const buffer = Buffer.alloc(bytesToRead)
        const result = await handle.read(buffer, 0, bytesToRead, offset)
        offset += result.bytesRead
        processText(decoder.write(buffer.subarray(0, result.bytesRead)), false)
      } finally {
        await handle.close()
      }
    }

    if (flush) {
      processText(decoder.end(), true)
    }
  }

  const scheduleRead = () => {
    readChain = readChain.then(
      () => readAvailable(false),
      () => undefined,
    ).catch(fail)
  }

  return {
    start() {
      if (timer !== undefined || stopped || failed) {
        return
      }

      timer = setInterval(scheduleRead, intervalMs)
    },
    async stop() {
      if (stopped) {
        return
      }

      stopped = true
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }

      await readChain
      if (failed) {
        throw new Error(progressMonitoringErrorMessage)
      }

      try {
        await readAvailable(true)
      } catch (error) {
        fail(error)
        throw new Error(progressMonitoringErrorMessage)
      }
    },
  }
}
