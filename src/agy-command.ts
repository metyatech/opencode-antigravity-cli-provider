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
    const loadNodePty = dependencies.loadNodePty ?? defaultLoadNodePty
    const ptySpawn = dependencies.ptySpawn ?? (await loadNodePty()).spawn
    const setTimer = dependencies.setTimeout ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs))
    const clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer))
    const platform = dependencies.platform ?? process.platform
    const env = { ...process.env, ...invocation.options.env }
    const resolvedCommand = resolveAgyExecutable(invocation.command, env, platform)

    try {
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
        const disposables: AgyPtyDisposable[] = []
        let timeout: ReturnType<typeof setTimer> | undefined

        const cleanup = () => {
          if (timeout !== undefined) {
            clearTimer(timeout)
          }
          request.abortSignal?.removeEventListener("abort", abort)
          releaseAgyPtyProcess(child, platform)
          for (const disposable of disposables) {
            disposable.dispose()
          }
        }

        const fail = (error: Error) => {
          if (settled) {
            return
          }

          settled = true
          cleanup()
          reject(error)
        }

        const killChild = () => {
          if (platform === "win32") {
            child.kill()
            return
          }

          child.kill("SIGTERM")
        }

        const killAndFail = (error: Error) => {
          killChild()
          fail(error)
        }

        timeout = setTimer(() => killAndFail(new AntigravityCliTimeoutError(invocation.options.timeoutMs)), invocation.options.timeoutMs)
        const abort = () => killAndFail(createAbortError())

        if (request.abortSignal?.aborted) {
          abort()
          return
        }

        request.abortSignal?.addEventListener("abort", abort, { once: true })

        disposables.push(child.onData((text) => {
          if (settled) {
            return
          }

          output += text
          if (isInteractivePrompt(text) || isInteractivePrompt(output)) {
            killAndFail(createInteractiveSetupError(sanitizeAgyGenerationPtyOutput(text)))
          }
        }))

        disposables.push(child.onExit(({ exitCode }) => {
          if (settled) {
            return
          }

          settled = true
          cleanup()
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
      })
    } finally {
      await promptFileTransport.cleanup()
    }
  }

  return run()
}
