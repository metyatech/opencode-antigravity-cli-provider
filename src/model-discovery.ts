import { spawn as nodeSpawn } from "node:child_process"
import {
  AntigravityCliProviderError,
  AntigravityCliTimeoutError,
  createExitError,
  createInteractiveSetupError,
  createNoOutputError,
  isInteractivePrompt,
} from "./errors"
import type { AgyClearTimeout, AgySetTimeout, AgySpawn } from "./types"

export type DiscoveredAgyModel = {
  id: string
  name: string
  agyModel: string
}

export type AgyModelDiscoveryResult = {
  discovered: DiscoveredAgyModel[]
  models: Record<string, { name: string }>
  modelMap: Record<string, string>
}

export type DiscoverAgyModelsOptions = {
  command?: string
  timeoutMs?: number
  cwd?: string
  env?: Record<string, string>
}

export type DiscoverAgyModelsDependencies = {
  spawn?: AgySpawn
  setTimeout?: AgySetTimeout
  clearTimeout?: AgyClearTimeout
}

const defaultSpawn: AgySpawn = (command, args, options) => nodeSpawn(command, args, options)
const defaultDiscoveryTimeoutMs = 10_000

const decodeChunk = (chunk: unknown) => (chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : String(chunk))

const ignoredLinePatterns = [
  /^usage\b/i,
  /^list available models\.?$/i,
  /^flags:?$/i,
  /^available subcommands:?$/i,
  /^available models:?$/i,
  /^models:?$/i,
  /^error:/i,
  /^\[exit=/i,
  /^-?h\b/i,
  /^--?help\b/i,
]

export const slugifyAgyModelName = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

const stripListPrefix = (line: string) => line.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").trim()

const shouldIgnoreLine = (line: string) => line.length === 0 || line.endsWith(":") || ignoredLinePatterns.some((pattern) => pattern.test(line))

export const buildAgyModelDiscoveryResult = (names: string[]): AgyModelDiscoveryResult => {
  const slugCounts = new Map<string, number>()
  const discovered: DiscoveredAgyModel[] = []
  const models: Record<string, { name: string }> = {}
  const modelMap: Record<string, string> = {}

  for (const rawName of names) {
    const name = rawName.trim()
    const baseSlug = slugifyAgyModelName(name)
    if (baseSlug.length === 0) {
      continue
    }

    const nextCount = (slugCounts.get(baseSlug) ?? 0) + 1
    slugCounts.set(baseSlug, nextCount)
    const id = nextCount === 1 ? baseSlug : `${baseSlug}-${nextCount}`
    discovered.push({ id, name, agyModel: name })
    models[id] = { name }
    modelMap[id] = name
  }

  return { discovered, models, modelMap }
}

export const parseAgyModelListOutput = (output: string): string[] => output.split(/\r?\n/).map(stripListPrefix).filter((line) => !shouldIgnoreLine(line))

export const discoverAgyModels = (options: DiscoverAgyModelsOptions = {}, dependencies: DiscoverAgyModelsDependencies = {}) => {
  const command = options.command ?? "agy"
  const timeoutMs = options.timeoutMs ?? defaultDiscoveryTimeoutMs
  const spawnCommand = dependencies.spawn ?? defaultSpawn
  const setTimer = dependencies.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout))
  const clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer))

  return new Promise<AgyModelDiscoveryResult>((resolve, reject) => {
    const child = spawnCommand(command, ["models"], {
      shell: false,
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
    })
    let stdout = ""
    let stderr = ""
    let settled = false

    const cleanup = () => clearTimer(timeout)

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

    const timeout = setTimer(() => killAndFail(new AntigravityCliTimeoutError(timeoutMs)), timeoutMs)

    child.stdout.on("data", (chunk) => {
      if (settled) {
        return
      }

      const text = decodeChunk(chunk)
      stdout += text
      if (isInteractivePrompt(text) || isInteractivePrompt(stdout)) {
        killAndFail(createInteractiveSetupError(text))
      }
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

    child.once("error", (error) => fail(new AntigravityCliProviderError(`Antigravity CLI model discovery failed to start. ${error.message}`, { cause: error })))

    child.once("close", (code) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      if (code !== 0) {
        reject(createExitError(code, stderr))
        return
      }

      if (stdout.trim().length === 0) {
        reject(createNoOutputError(stderr))
        return
      }

      resolve(buildAgyModelDiscoveryResult(parseAgyModelListOutput(stdout)))
    })
  })
}
