import {
  AntigravityCliProviderError,
  AntigravityCliTimeoutError,
  attachPromptCleanupError,
  createAbortError,
  createExitError,
  createInteractiveSetupError,
  createNoOutputError,
  isInteractivePrompt,
} from "./errors"
import { releaseAgyPtyProcess, resolveAgyExecutable } from "./model-discovery"
import { buildAgyArgs, normalizeOptions, resolveAgyModel } from "./options"
import { createPromptFileTransport } from "./prompt-transport"
import { createAgyProgressMonitor } from "./agy-progress"
import { createAgyTerminalOutputParser, getAgyWindowsPtyOptions } from "./agy-terminal-output"
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

const isEsrchError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false
  }

  return ["code", "name", "message"].some((property) => String((error as Error & Record<string, unknown>)[property]).includes("ESRCH"))
}

const isValidProcessKillPid = (pid: number | undefined): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid !== process.pid

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
    const promptTransportFactory = dependencies.createPromptFileTransport ?? createPromptFileTransport
    const promptFileTransport = await promptTransportFactory(request.prompt)
    const invocation: AgyCommandInvocation = {
      command: options.command,
      args: buildAgyArgs(options.extraArgs, agyModel, {
        type: "file",
        tempDir: promptFileTransport.tempDir,
        wrapperPrompt: promptFileTransport.wrapperPrompt,
      }, request.onProgress === undefined ? undefined : promptFileTransport.logFile),
      options,
      agyModel,
    }
    const runCommand = async () => {
      const loadNodePty = dependencies.loadNodePty ?? defaultLoadNodePty
      const ptySpawn = dependencies.ptySpawn ?? (await loadNodePty()).spawn
      const setTimer = dependencies.setTimeout ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs))
      const clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer))
      const platform = dependencies.platform ?? process.platform
      const processKill = dependencies.processKill ?? ((pid: number) => {
        process.kill(pid)
      })
      const env = { ...process.env, ...invocation.options.env }
      const resolvedCommand = resolveAgyExecutable(invocation.command, env, platform)

      return new Promise<AgyCommandResult>((resolve, reject) => {
        let child: AgyPtyProcess
        try {
          child = ptySpawn(resolvedCommand, invocation.args, {
            name: "xterm-color",
            cols: 120,
            rows: 30,
            cwd: invocation.options.cwd,
            env,
            windowsPty: getAgyWindowsPtyOptions(platform),
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
        let terminalOutputParser: ReturnType<typeof createAgyTerminalOutputParser>
        let terminalWriteChain = Promise.resolve()
        let terminalOutputError: Error | undefined
        let progressMonitor: ReturnType<typeof createAgyProgressMonitor> | undefined
        let progressMonitorError: Error | undefined
        let exitEvent: { exitCode: number } | undefined
        let finalizationStarted = false

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
          terminalOutputParser.dispose()
        }

        const forceKillChild = () => {
          if (settled || forceKillSent) {
            return
          }

          forceKillSent = true
          if (platform === "win32") {
            const childPid = child.pid
            if (isValidProcessKillPid(childPid)) {
              try {
                processKill(childPid)
              } catch (error) {
                if (!isEsrchError(error)) {
                  child.kill()
                }
              }
              return
            }

            child.kill()
            return
          }

          child.kill("SIGTERM")
        }

        const rejectAfterFinalCleanup = () => {
          if (settled || finalizationStarted) {
            return
          }

          void finalize(undefined)
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

        const failTerminalOutput = (error: unknown) => {
          if (terminalOutputError !== undefined || settled) {
            return
          }

          terminalOutputError = error instanceof Error ? error : new Error(String(error))
          requestCancellation(new AntigravityCliProviderError(terminalOutputError.message, { cause: error }))
        }

        const failProgressMonitor = (error: Error) => {
          if (progressMonitorError !== undefined || settled) {
            return
          }

          progressMonitorError = new AntigravityCliProviderError("Antigravity CLI progress log monitoring failed.", { cause: error })
          requestCancellation(progressMonitorError)
        }

        const finalize = async (exitCode: number | undefined) => {
          if (settled || finalizationStarted) {
            return
          }

          finalizationStarted = true
          let flushError: Error | undefined
          let finalOutput = ""
          try {
            await terminalWriteChain
            await progressMonitor?.stop()
            finalOutput = await terminalOutputParser.finish()
          } catch (error) {
            flushError = error instanceof Error ? error : new Error(String(error))
          }

          settled = true
          cleanup()

          if (cancellationError !== undefined) {
            reject(cancellationError)
            return
          }

          if (progressMonitorError !== undefined) {
            reject(progressMonitorError)
            return
          }

          if (terminalOutputError !== undefined) {
            reject(new AntigravityCliProviderError(terminalOutputError.message, { cause: terminalOutputError }))
            return
          }

          if (flushError !== undefined) {
            reject(new AntigravityCliProviderError("Antigravity CLI terminal output processing failed.", { cause: flushError }))
            return
          }

          if (exitCode === undefined) {
            reject(cancellationError ?? new AntigravityCliProviderError("Antigravity CLI cancellation cleanup completed without a cancellation error."))
            return
          }

          if (exitCode !== 0) {
            reject(createExitError(exitCode, sanitizeAgyGenerationPtyOutput(output)))
            return
          }

          if (finalOutput.length === 0) {
            reject(createNoOutputError(sanitizeAgyGenerationPtyOutput(output)))
            return
          }

          resolve({ stdout: finalOutput, stderr: "" })
        }

        timeout = setTimer(() => requestCancellation(new AntigravityCliTimeoutError(invocation.options.timeoutMs)), invocation.options.timeoutMs)
        const abort = () => requestCancellation(createAbortError())

        terminalOutputParser = (dependencies.createAgyTerminalOutputParser ?? createAgyTerminalOutputParser)((chunk) => {
          if (settled) {
            return
          }

          request.onStdout?.(chunk)
        }, platform)

        if (request.onProgress !== undefined) {
          progressMonitor = (dependencies.createAgyProgressMonitor ?? createAgyProgressMonitor)({
            logFile: promptFileTransport.logFile,
            onProgress: request.onProgress,
            onError: failProgressMonitor,
          })
          progressMonitor.start()
        }

        disposables.push(child.onData((text) => {
          if (settled) {
            return
          }

          output += text
          terminalWriteChain = terminalWriteChain.then(() => terminalOutputParser.push(text)).catch((error: unknown) => {
            failTerminalOutput(error)
          })
          if (isInteractivePrompt(text) || isInteractivePrompt(output)) {
            requestCancellation(createInteractiveSetupError(sanitizeAgyGenerationPtyOutput(text)))
          }
        }))

        disposables.push(child.onExit(({ exitCode }) => {
          if (settled || exitEvent !== undefined) {
            return
          }

          exitEvent = { exitCode }
          void finalize(exitCode)
        }))

        request.abortSignal?.addEventListener("abort", abort, { once: true })
        if (request.abortSignal?.aborted) {
          abort()
        }
      })
    }

    let commandResult: AgyCommandResult
    try {
      commandResult = await runCommand()
    } catch (primaryError) {
      try {
        await promptFileTransport.cleanup()
      } catch (cleanupError) {
        throw attachPromptCleanupError(primaryError, cleanupError)
      }

      throw primaryError
    }

    await promptFileTransport.cleanup()
    return commandResult
  }

  return run()
}
