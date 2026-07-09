import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

export type PromptFileTransport = {
  tempDir: string
  promptFile: string
  wrapperPrompt: string
  cleanup: () => Promise<void>
}

export const createPromptFileTransport = async (prompt: string): Promise<PromptFileTransport> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-antigravity-prompt-"))
  const promptFile = path.join(tempDir, "prompt.txt")
  try {
    await fs.writeFile(promptFile, prompt, "utf8")
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  let cleaned = false
  const cleanup = async () => {
    if (cleaned) {
      return
    }

    cleaned = true
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup: keep the primary CLI result/error intact.
    }
  }

  return {
    tempDir,
    promptFile,
    wrapperPrompt: "Read prompt.txt from the added directory and follow it exactly.",
    cleanup,
  }
}
