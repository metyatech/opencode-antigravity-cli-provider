import {
  AntigravityCliProviderError,
  AntigravityCliTimeoutError,
  createAbortError,
  createExitError,
  createInteractiveSetupError,
  createNoOutputError,
  isInteractivePrompt,
} from "./errors"
import { releaseAgyPtyProcess, resolveAgyExecutable } from "./model-discovery"
import { buildAgyArgs, normalizeOptions, resolveAgyModel } from "./options"
import { createPromptFileTransport } from "./prompt-transport"
import type { AgyPtyDisposable, AgyPtyModule, AgyPtyProcess } from "./model-discovery"
import type { AgyPromptTransport } from "./options"
import type { AgyCommandInvocation, AgyCommandResult, RunAgyCommandDependencies, RunAgyCommandRequest } from "./types"

type WritablePtySocket = {
  closed?: boolean
  destroyed?: boolean
  writable?: boolean
  writableEnded?: boolean
  write?: (data: string) => void
}

type AgyPtyProcessWithInputSocket = AgyPtyProcess & {
  _agent?: {
    _inSocket?: WritablePtySocket
    inSocket?: WritablePtySocket
  }
}

const defaultLoadNodePty = async (): Promise<AgyPtyModule> => {
  const nodePty = await import("node-pty")
  return { spawn: nodePty.spawn }
}

const inheritedEnvBlocklistPrefixes = ["AGENT", "OPENCODE"]

const shouldInheritEnvKey = (key: string) => {
  const normalized = key.toUpperCase()
  return !inheritedEnvBlocklistPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}_`))
}

const createAgyProcessEnv = (overrides: Record<string, string>) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => shouldInheritEnvKey(key))),
  ...overrides,
})

const getNodeExecutableForPtyHelper = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => {
  if (platform !== "win32" || process.execPath.toLowerCase().endsWith("node.exe")) {
    return undefined
  }

  try {
    return resolveAgyExecutable("node", env, platform)
  } catch {
    return undefined
  }
}

const runWithNodeExecPathForPtyHelper = (nodeExecutable: string | undefined, callback: () => void) => {
  if (nodeExecutable === undefined) {
    callback()
    return
  }

  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")
  const originalExecPath = process.execPath
  try {
    Object.defineProperty(process, "execPath", { configurable: true, value: nodeExecutable, writable: true })
    callback()
  } finally {
    if (originalDescriptor !== undefined) {
      Object.defineProperty(process, "execPath", originalDescriptor)
    } else {
      Object.defineProperty(process, "execPath", { configurable: true, value: originalExecPath, writable: true })
    }
  }
}

const ansiCsiPattern = new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, "g")
const ansiOscPattern = new RegExp(String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`, "g")
const belPattern = new RegExp(String.raw`\x07`, "g")
const residualControlPattern = new RegExp(String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`, "g")

export const sanitizeAgyGenerationPtyOutput = (output: string): string => {
  const sanitized = output
    .replace(ansiOscPattern, "")
    .replace(ansiCsiPattern, "")
    .replace(belPattern, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(residualControlPattern, "")
  const lines = sanitized.split("\n")

  while (lines.length > 0 && lines[0].trim().length === 0) {
    lines.shift()
  }

  while (lines.length > 0 && lines.at(-1)?.trim().length === 0) {
    lines.pop()
  }

  return lines.join("\n").trim()
}

export const buildAgyCommandInvocation = (request: RunAgyCommandRequest, promptTransport: AgyPromptTransport = { type: "direct", prompt: request.prompt }): AgyCommandInvocation => {
  const options = normalizeOptions(request.options)
  const agyModel = resolveAgyModel(request.modelId, options.modelMap)
  return {
    command: options.command,
    args: buildAgyArgs(options.extraArgs, agyModel, promptTransport),
    options,
    agyModel,
  }
}

const getWindowsInputSocket = (child: AgyPtyProcess) => {
  const inputSocket = (child as AgyPtyProcessWithInputSocket)._agent?._inSocket ?? (child as AgyPtyProcessWithInputSocket)._agent?.inSocket
  return inputSocket
}

const canWriteToSocket = (inputSocket: WritablePtySocket) =>
  inputSocket.closed !== true && inputSocket.destroyed !== true && inputSocket.writableEnded !== true && inputSocket.writable !== false

const writeCancellationInterrupt = (child: AgyPtyProcess, platform: NodeJS.Platform) => {
  if (platform === "win32") {
    const ptyChild = child as AgyPtyProcessWithInputSocket
    if (ptyChild._agent?.inSocket !== undefined) {
      return
    }

    const inputSocket = getWindowsInputSocket(child)
    if (inputSocket?.write !== undefined) {
      if (canWriteToSocket(inputSocket)) {
        inputSocket.write("\x03")
      }
      return
    }
  }

  child.write?.("\x03")
}

export const runAgyCommand = (request: RunAgyCommandRequest, dependencies: RunAgyCommandDependencies = {}) => {
  const options = normalizeOptions(request.options)
  const agyModel = resolveAgyModel(request.modelId, options.modelMap)
  const run = async () => {
    const promptFileTransport = await createPromptFileTransport(request.prompt)
    const invocation: AgyCommandInvocation = {
      command: options.command,
      args: buildAgyArgs(options.extraArgs, agyModel, {
        type: "file",
        tempDir: promptFileTransport.tempDir,
        wrapperPrompt: promptFileTransport.wrapperPrompt,
      }),
      options,
      agyModel,
    }
    try {
      const loadNodePty = dependencies.loadNodePty ?? defaultLoadNodePty
      const ptySpawn = dependencies.ptySpawn ?? (await loadNodePty()).spawn
      const setTimer = dependencies.setTimeout ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs))
      const clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer))
      const platform = dependencies.platform ?? process.platform
      const env = createAgyProcessEnv(invocation.options.env)
      const resolvedCommand = resolveAgyExecutable(invocation.command, env, platform)
      const nodeExecutableForPtyHelper = getNodeExecutableForPtyHelper(env, platform)

      return await new Promise<AgyCommandResult>((resolve, reject) => {
        let child: AgyPtyProcess
        try {
          child = ptySpawn(resolvedCommand, invocation.args, {
            name: "xterm-color",
            cols: 120,
            rows: 30,
            cwd: invocation.options.cwd,
            env,
          })
        } catch (error) {
          reject(new AntigravityCliProviderError(`Antigravity CLI failed to start. ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
          return
        }

        let output = ""
        let settled = false
        let cancellationRequested = false
        let cancellationError: Error | undefined
        let forceKillTimer: ReturnType<typeof setTimer> | undefined
        let finalCleanupTimer: ReturnType<typeof setTimer> | undefined
        let forceKillSent = false
        const disposables: AgyPtyDisposable[] = []
        let timeout: ReturnType<typeof setTimer> | undefined

        const clearMainTimeout = () => {
          if (timeout !== undefined) {
            clearTimer(timeout)
            timeout = undefined
          }
        }

        const clearForceKillTimer = () => {
          if (forceKillTimer !== undefined) {
            clearTimer(forceKillTimer)
            forceKillTimer = undefined
          }
        }

        const clearFinalCleanupTimer = () => {
          if (finalCleanupTimer !== undefined) {
            clearTimer(finalCleanupTimer)
            finalCleanupTimer = undefined
          }
        }

        const cleanup = () => {
          clearMainTimeout()
          clearForceKillTimer()
          clearFinalCleanupTimer()
          request.abortSignal?.removeEventListener("abort", abort)
          releaseAgyPtyProcess(child, platform)
          for (const disposable of disposables) {
            disposable.dispose()
          }
        }

        const forceKillChild = () => {
          if (settled || forceKillSent) {
            return
          }

          forceKillSent = true
          if (platform === "win32") {
            runWithNodeExecPathForPtyHelper(nodeExecutableForPtyHelper, () => child.kill())
            return
          }

          child.kill("SIGTERM")
        }

        const rejectAfterFinalCleanup = () => {
          if (settled) {
            return
          }

          settled = true
          cleanup()
          reject(cancellationError ?? new AntigravityCliProviderError("Antigravity CLI cancellation cleanup completed without a cancellation error."))
        }

        const requestCancellation = (error: Error) => {
          if (settled) {
            return
          }

          clearMainTimeout()
          if (!cancellationRequested) {
            cancellationRequested = true
            cancellationError = error
            try {
              writeCancellationInterrupt(child, platform)
            } catch {
              // Best-effort interrupt: fallback timers still enforce settlement.
            }
          }

          forceKillTimer ??= setTimer(() => {
            forceKillTimer = undefined
            forceKillChild()
          }, dependencies.cancellationGraceMs ?? 1_500)
          finalCleanupTimer ??= setTimer(() => {
            finalCleanupTimer = undefined
            rejectAfterFinalCleanup()
          }, dependencies.cancellationForceCleanupMs ?? 5_000)
        }

        timeout = setTimer(() => requestCancellation(new AntigravityCliTimeoutError(invocation.options.timeoutMs)), invocation.options.timeoutMs)
        const abort = () => requestCancellation(createAbortError())

        disposables.push(child.onData((text) => {
          if (settled) {
            return
          }

          output += text
          if (isInteractivePrompt(text) || isInteractivePrompt(output)) {
            requestCancellation(createInteractiveSetupError(sanitizeAgyGenerationPtyOutput(text)))
          }
        }))

        disposables.push(child.onExit(({ exitCode }) => {
          if (settled) {
            return
          }

          settled = true
          cleanup()
          if (cancellationError !== undefined) {
            reject(cancellationError)
            return
          }

          const sanitizedOutput = sanitizeAgyGenerationPtyOutput(output)
          if (exitCode !== 0) {
            reject(createExitError(exitCode, sanitizedOutput))
            return
          }

          if (sanitizedOutput.length === 0) {
            reject(createNoOutputError(sanitizedOutput))
            return
          }

          request.onStdout?.(sanitizedOutput)
          resolve({ stdout: sanitizedOutput, stderr: "" })
        }))

        request.abortSignal?.addEventListener("abort", abort, { once: true })
        if (request.abortSignal?.aborted) {
          abort()
        }
      })
    } finally {
      await promptFileTransport.cleanup()
    }
  }

  return run()
}
