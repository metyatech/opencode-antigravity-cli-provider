import { spawn as nodeSpawn } from "node:child_process"
import {
  AntigravityCliProviderError,
  AntigravityCliTimeoutError,
  createAbortError,
  createExitError,
  createInteractiveSetupError,
  createNoOutputError,
  isInteractivePrompt,
} from "./errors"
import { buildAgyArgs, normalizeOptions, resolveAgyModel } from "./options"
import type { AgyCommandInvocation, AgyCommandResult, AgySpawn, RunAgyCommandDependencies, RunAgyCommandRequest } from "./types"

const defaultSpawn: AgySpawn = (command, args, options) => nodeSpawn(command, args, options)

const decodeChunk = (chunk: unknown) => (chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : String(chunk))

export const buildAgyCommandInvocation = (request: RunAgyCommandRequest): AgyCommandInvocation => {
  const options = normalizeOptions(request.options)
  const agyModel = resolveAgyModel(request.modelId, options.modelMap)
  return {
    command: options.command,
    args: buildAgyArgs(options.extraArgs, agyModel, request.prompt),
    options,
    agyModel,
  }
}

export const runAgyCommand = (request: RunAgyCommandRequest, dependencies: RunAgyCommandDependencies = {}) => {
  const invocation = buildAgyCommandInvocation(request)
  const spawnCommand = dependencies.spawn ?? defaultSpawn
  const setTimer = dependencies.setTimeout ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs))
  const clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer))

  return new Promise<AgyCommandResult>((resolve, reject) => {
    const child = spawnCommand(invocation.command, invocation.args, {
      shell: false,
      cwd: invocation.options.cwd,
      env: { ...process.env, ...invocation.options.env },
    })
    let stdout = ""
    let stderr = ""
    let settled = false

    const cleanup = () => {
      clearTimer(timeout)
      request.abortSignal?.removeEventListener("abort", abort)
    }

    const fail = (error: Error) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(error)
    }

    const killAndFail = (error: Error) => {
      child.kill("SIGTERM")
      fail(error)
    }

    const timeout = setTimer(() => killAndFail(new AntigravityCliTimeoutError(invocation.options.timeoutMs)), invocation.options.timeoutMs)
    const abort = () => killAndFail(createAbortError())

    if (request.abortSignal?.aborted) {
      abort()
      return
    }

    request.abortSignal?.addEventListener("abort", abort, { once: true })

    child.stdout.on("data", (chunk) => {
      if (settled) {
        return
      }

      const text = decodeChunk(chunk)
      stdout += text
      if (isInteractivePrompt(text) || isInteractivePrompt(stdout)) {
        killAndFail(createInteractiveSetupError(text))
        return
      }

      request.onStdout?.(text)
    })

    child.stderr.on("data", (chunk) => {
      if (settled) {
        return
      }

      const text = decodeChunk(chunk)
      stderr += text
      if (isInteractivePrompt(text) || isInteractivePrompt(stderr)) {
        killAndFail(createInteractiveSetupError(text))
      }
    })

    child.once("error", (error) => fail(new AntigravityCliProviderError(`Antigravity CLI failed to start. ${error.message}`, { cause: error })))

    child.once("close", (code) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      if (code === 0 && stdout.trim().length > 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(code === 0 ? createNoOutputError(stderr) : createExitError(code, stderr))
    })
  })
}
