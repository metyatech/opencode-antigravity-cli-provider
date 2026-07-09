import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPromptFileTransport } from "./prompt-transport"

describe("createPromptFileTransport", () => {
  test("writes the rendered prompt to an OS-temp UTF-8 prompt.txt", async () => {
    const renderedPrompt = "system: follow instructions\nuser: こんにちは 🌱"
    const transport = await createPromptFileTransport(renderedPrompt)

    try {
      expect(transport.tempDir.startsWith(path.join(os.tmpdir(), "opencode-antigravity-prompt-"))).toBe(true)
      expect(transport.promptFile).toBe(path.join(transport.tempDir, "prompt.txt"))
      expect(transport.wrapperPrompt).toBe("Read prompt.txt from the added directory and follow it exactly.")
      await expect(readFile(transport.promptFile, "utf8")).resolves.toBe(renderedPrompt)
    } finally {
      await transport.cleanup()
    }
  })

  test("cleanup removes the temp directory and is safe to call repeatedly", async () => {
    const transport = await createPromptFileTransport("hello")

    expect(existsSync(transport.tempDir)).toBe(true)
    await transport.cleanup()
    await transport.cleanup()

    expect(existsSync(transport.tempDir)).toBe(false)
  })
})
