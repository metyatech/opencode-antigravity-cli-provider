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
      expect(transport.wrapperPrompt).toContain(transport.promptFile)
      expect(transport.wrapperPrompt).toContain(`Read the prompt file at '${transport.promptFile}'`)
      expect(transport.wrapperPrompt).toContain("answer the request written in that file")
      expect(transport.wrapperPrompt).toContain("file contents as the user's full request")
      expect(transport.wrapperPrompt).toContain("Return only the final answer")
      expect(transport.wrapperPrompt).toContain("Do not summarize or echo the file unless it asks for that")
      expect(transport.wrapperPrompt).not.toContain("Read this exact file")
      expect(transport.wrapperPrompt).not.toContain("complete OpenCode conversation/user request")
      await expect(readFile(transport.promptFile, "utf8")).resolves.toBe(renderedPrompt)
    } finally {
      await transport.cleanup()
    }
  })

  test("wrapper names the prompt file without embedding long prompt bodies", async () => {
    const longPrompt = `BODY_MARKER_${"x".repeat(100_000)}`
    const transport = await createPromptFileTransport(longPrompt)

    try {
      expect(transport.wrapperPrompt).toContain(transport.promptFile)
      expect(transport.wrapperPrompt).not.toContain(longPrompt)
      expect(transport.wrapperPrompt).not.toContain("BODY_MARKER_")
      expect(transport.wrapperPrompt.length).toBeLessThan(512)
      await expect(readFile(transport.promptFile, "utf8")).resolves.toBe(longPrompt)
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
