import { describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAgyProgressMonitor } from "./agy-progress"

const waitForMonitorTick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

const withLogFile = async (callback: (logFile: string) => Promise<void>) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-progress-test-"))
  const logFile = path.join(tempDir, "agy.log")
  await writeFile(logFile, "", "utf8")
  try {
    await callback(logFile)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

describe("createAgyProgressMonitor", () => {
  test("restores a UTF-8 log line split at a read boundary", async () => {
    await withLogFile(async (logFile) => {
      const messages: string[] = []
      const monitor = createAgyProgressMonitor(
        { logFile, onProgress: (message) => messages.push(message), onError: (error) => { throw error } },
        { intervalMs: 1 },
      )
      const bytes = Buffer.from("こ", "utf8")
      await appendFile(logFile, bytes.subarray(0, 1))
      monitor.start()
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
      expect(messages).toEqual([])
      await appendFile(logFile, Buffer.concat([bytes.subarray(1), Buffer.from("ん\n", "utf8")]))
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
      await monitor.stop()
      expect(messages).toEqual(["Antigravity CLIを起動しています"])
    })
  })

  test("reports startup once and maps known lifecycle lines to fixed messages", async () => {
    await withLogFile(async (logFile) => {
      const messages: string[] = []
      const monitor = createAgyProgressMonitor({ logFile, onProgress: (message) => messages.push(message), onError: () => undefined })
      await appendFile(logFile, "Starting new conversation\nCreated conversation\nSending user message\nStreaming conversation\nstreamGenerateContent\nTool confirmation ReadFile\nTool confirmation WriteFile\n")
      monitor.start()
      await monitor.stop()
      expect(messages).toEqual([
        "Antigravity CLIを起動しています",
        "リクエストを送信しています",
        "応答を生成しています",
        "ファイルを読み取っています",
        "ツールを実行しています",
      ])
      expect(messages.every((message) => !/Starting|Created|Sending|Streaming|streamGenerate|Tool confirmation|ReadFile/.test(message))).toBe(true)
    })
  })

  test("does not emit unknown progress before 30 seconds, then emits it only after new activity", async () => {
    await withLogFile(async (logFile) => {
      const messages: string[] = []
      let currentTime = 1_000
      const monitor = createAgyProgressMonitor(
        { logFile, onProgress: (message) => messages.push(message), onError: () => undefined },
        { intervalMs: 1, now: () => currentTime },
      )
      await appendFile(logFile, "opaque line with token=secret and path=C:\\private\\file\n")
      monitor.start()
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
      expect(messages).toEqual(["Antigravity CLIを起動しています"])
      currentTime += 30_000
      await appendFile(logFile, "another opaque line\n")
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
      await monitor.stop()
      expect(messages).toEqual(["Antigravity CLIを起動しています", "Antigravity CLIで処理を続けています"])
      expect(messages.join("\n")).not.toContain("secret")
      expect(messages.join("\n")).not.toContain("private")
      expect(messages.join("\n")).not.toContain("token")
    })
  })

  test("dispose stops scheduling and suppresses callbacks idempotently", async () => {
    await withLogFile(async (logFile) => {
      const messages: string[] = []
      const errors: Error[] = []
      const monitor = createAgyProgressMonitor({
        logFile,
        onProgress: (message) => messages.push(message),
        onError: (error) => errors.push(error),
      }, { intervalMs: 1 })
      monitor.start()
      monitor.dispose()
      monitor.dispose()
      await appendFile(logFile, "Starting new conversation\n")
      await monitor.stop()
      expect(messages).toEqual([])
      expect(errors).toEqual([])
    })
  })
})
