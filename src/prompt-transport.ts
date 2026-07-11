import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { PromptCleanupError } from "./errors"

export type PromptFileTransport = {
  tempDir: string
  promptFile: string
  wrapperPrompt: string
  cleanup: () => Promise<void>
}

export type PromptCleanupDependencies = {
  rm?: typeof fs.rm
  stat?: (path: string) => Promise<unknown>
  delay?: (ms: number) => Promise<void>
  attempts?: number
  retryDelayMs?: number
}

const transientCleanupErrorCodes = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"])
const defaultCleanupAttempts = 18
const defaultCleanupRetryDelayMs = 125

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const getErrorCode = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined
  }

  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

const isEnoent = (error: unknown) => getErrorCode(error) === "ENOENT"
const isTransientCleanupError = (error: unknown) => {
  const code = getErrorCode(error)
  return code !== undefined && transientCleanupErrorCodes.has(code)
}

const toCleanupError = (tempDir: string, error: unknown) => new PromptCleanupError(tempDir, error)

const stillPresentError = () => new Error("Directory still exists after fs.rm.")

const cleanupPromptTempDir = async (tempDir: string, dependencies: PromptCleanupDependencies = {}) => {
  const rm = dependencies.rm ?? fs.rm
  const stat = dependencies.stat ?? fs.stat
  const wait = dependencies.delay ?? delay
  const attempts = dependencies.attempts ?? defaultCleanupAttempts
  const retryDelayMs = dependencies.retryDelayMs ?? defaultCleanupRetryDelayMs
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch (error) {
      if (isEnoent(error)) {
        return
      }

      if (!isTransientCleanupError(error)) {
        throw toCleanupError(tempDir, error)
      }

      lastError = error
      if (attempt < attempts) {
        await wait(retryDelayMs)
        continue
      }

      throw toCleanupError(tempDir, error)
    }

    try {
      await stat(tempDir)
      lastError = stillPresentError()
    } catch (error) {
      if (isEnoent(error)) {
        return
      }

      if (!isTransientCleanupError(error)) {
        throw toCleanupError(tempDir, error)
      }

      lastError = error
    }

    if (attempt < attempts) {
      await wait(retryDelayMs)
      continue
    }

    throw toCleanupError(tempDir, lastError)
  }
}

const buildWrapperPrompt = (promptFile: string) =>
  `Read the prompt file at '${promptFile}' and answer the request written in that file. Treat the file contents as the user's full request. Return only the final answer. Do not summarize or echo the file unless it asks for that.`

export const createPromptFileTransport = async (prompt: string, cleanupDependencies: PromptCleanupDependencies = {}): Promise<PromptFileTransport> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-antigravity-prompt-"))
  const promptFile = path.join(tempDir, "prompt.txt")
  try {
    await fs.writeFile(promptFile, prompt, "utf8")
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  let cleaned = false
  let cleanupPromise: Promise<void> | undefined
  const cleanup = async () => {
    if (cleaned) {
      return
    }

    if (cleanupPromise !== undefined) {
      return cleanupPromise
    }

    cleanupPromise = cleanupPromptTempDir(tempDir, cleanupDependencies).then(
      () => {
        cleaned = true
      },
      (error: unknown) => {
        cleanupPromise = undefined
        throw error
      },
    )
    return cleanupPromise
  }

  return {
    tempDir,
    promptFile,
    wrapperPrompt: buildWrapperPrompt(promptFile),
    cleanup,
  }
}
