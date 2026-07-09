import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export type PromptFileTransport = {
  tempDir: string
  promptFile: string
  wrapperPrompt: string
  cleanup: () => Promise<void>
}

const buildWrapperPrompt = (promptFile: string) =>
  `Read the prompt file at '${promptFile}' and answer the request written in that file. Treat the file contents as the user's full request. Return only the final answer. Do not summarize or echo the file unless it asks for that.`

const isNotFoundError = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"

const verifyRemoved = async (tempDir: string) => {
  try {
    await fs.stat(tempDir)
  } catch (error) {
    if (isNotFoundError(error)) {
      return
    }

    throw error
  }

  throw new Error(`Prompt temp directory still exists after cleanup attempt: ${tempDir}`)
}

const removeTempDir = async (tempDir: string) => {
  let lastError: unknown
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      await verifyRemoved(tempDir)
      return
    } catch (error) {
      lastError = error
      if (attempt < 20) {
        await delay(250)
      }
    }
  }

  throw lastError
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
    await removeTempDir(tempDir)
  }

  return {
    tempDir,
    promptFile,
    wrapperPrompt: buildWrapperPrompt(promptFile),
    cleanup,
  }
}
