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

type RemovePromptTempDirDependencies = {
  rm?: (target: string, options: { recursive: true; force: true; maxRetries: number; retryDelay: number }) => Promise<void>
  stat?: (target: string) => Promise<unknown>
  delay?: (timeoutMs: number) => Promise<void>
  attempts?: number
  retryDelayMs?: number
}

const cleanupAttempts = 60
const cleanupRetryDelayMs = 500

const isNotFoundError = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"

const createCleanupError = (tempDir: string, error: unknown) =>
  new Error(`Failed to remove prompt temp directory ${tempDir}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })

export const removePromptTempDir = async (tempDir: string, dependencies: RemovePromptTempDirDependencies = {}) => {
  const rm = dependencies.rm ?? fs.rm
  const stat = dependencies.stat ?? fs.stat
  const wait = dependencies.delay ?? delay
  const attempts = dependencies.attempts ?? cleanupAttempts
  const retryDelayMs = dependencies.retryDelayMs ?? cleanupRetryDelayMs
  let lastError: unknown = new Error(`Prompt temp directory still exists: ${tempDir}`)

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      if (isNotFoundError(error)) {
        return
      }

      lastError = error
      if (attempt < attempts) {
        await wait(retryDelayMs)
        continue
      }

      throw createCleanupError(tempDir, lastError)
    }

    try {
      await stat(tempDir)
      lastError = new Error(`directory still exists after removal attempt ${attempt}`)
    } catch (error) {
      if (isNotFoundError(error)) {
        return
      }

      lastError = error
    }

    if (attempt < attempts) {
      await wait(retryDelayMs)
      continue
    }

    throw createCleanupError(tempDir, lastError)
  }
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

    await removePromptTempDir(tempDir)
    cleaned = true
  }

  return {
    tempDir,
    promptFile,
    wrapperPrompt: buildWrapperPrompt(promptFile),
    cleanup,
  }
}
