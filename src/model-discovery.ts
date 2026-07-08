import { statSync } from "node:fs"
import path from "node:path"
import {
  AntigravityCliProviderError,
  AntigravityCliTimeoutError,
  createExitError,
  createInteractiveSetupError,
  createNoOutputError,
  isInteractivePrompt,
} from "./errors"
import type { AgyClearTimeout, AgySetTimeout } from "./types"

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

export type AgyPtySpawnOptions = {
  name: string
  cols: number
  rows: number
  cwd: string
  env: NodeJS.ProcessEnv
}

export type AgyPtyExitEvent = {
  exitCode: number
  signal?: number
}

export type AgyPtyDisposable = {
  dispose(): void
}

export type AgyPtyProcess = {
  onData(listener: (data: string) => void): AgyPtyDisposable
  onExit(listener: (event: AgyPtyExitEvent) => void): AgyPtyDisposable
  kill(signal?: string): void
}

export type AgyPtySpawn = (command: string, args: string[], options: AgyPtySpawnOptions) => AgyPtyProcess

export type AgyPtyModule = {
  spawn: AgyPtySpawn
}

export type DiscoverAgyModelsDependencies = {
  ptySpawn?: AgyPtySpawn
  loadNodePty?: () => Promise<AgyPtyModule>
  setTimeout?: AgySetTimeout
  clearTimeout?: AgyClearTimeout
  platform?: NodeJS.Platform
}

const defaultDiscoveryTimeoutMs = 60_000

const defaultLoadNodePty = async (): Promise<AgyPtyModule> => {
  const nodePty = await import("node-pty")
  return { spawn: nodePty.spawn }
}

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

const hasPathSeparator = (command: string) => command.includes("/") || command.includes("\\")

const getWindowsEnvValue = (env: NodeJS.ProcessEnv, key: string) => {
  const entry = Object.entries(env).toReversed().find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase())
  return entry?.[1]
}

const normalizeWindowsExtension = (extension: string) => {
  const normalized = extension.trim()
  return normalized.length === 0 ? "" : normalized.startsWith(".") ? normalized.toUpperCase() : `.${normalized.toUpperCase()}`
}

const windowsPathextPriority = (extension: string) => {
  switch (extension) {
    case ".EXE":
      return 0
    case ".COM":
      return 1
    case ".CMD":
      return 2
    case ".BAT":
      return 3
    default:
      return 4
  }
}

const getWindowsPathext = (env: NodeJS.ProcessEnv) => {
  const rawPathext = getWindowsEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD"
  const extensions = rawPathext.split(";").map(normalizeWindowsExtension).filter((extension) => extension.length > 0)
  const uniqueExtensions = [...new Set(extensions)]
  return uniqueExtensions.sort((left, right) => windowsPathextPriority(left) - windowsPathextPriority(right))
}

const isExecutableFile = (candidate: string) => {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

export const resolveAgyExecutable = (command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) => {
  if (hasPathSeparator(command) || platform !== "win32") {
    return command
  }

  const pathValue = getWindowsEnvValue(env, "PATH") ?? ""
  const pathEntries = pathValue.split(";").map((entry) => entry.replace(/^"|"$/g, "")).filter((entry) => entry.length > 0)
  const hasKnownExtension = getWindowsPathext(env).includes(path.win32.extname(command).toUpperCase())
  const candidateNames = hasKnownExtension ? [command] : getWindowsPathext(env).map((extension) => `${command}${extension.toLowerCase()}`)

  for (const pathEntry of pathEntries) {
    for (const candidateName of candidateNames) {
      const candidatePath = path.join(pathEntry, candidateName)
      if (isExecutableFile(candidatePath)) {
        return candidatePath
      }
    }
  }

  throw new AntigravityCliProviderError(`Antigravity CLI executable "${command}" was not found on PATH.`)
}

const ansiCsiPattern = new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, "g")
const ansiOscPattern = new RegExp(String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`, "g")
const controlResiduePattern = new RegExp(String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`, "g")
const fetchingOrSpinnerPattern = /^(?:[|/\\\-◐◓◑◒⠁-⣿]\s*)?(?:fetching|fetched)\b/i
// Cursor-home (CSI H) marks the start of a new visual frame on the same PTY
// row. `agy models` uses `\x1b[H\x1b[K` to clear the spinner row before
// writing the first model name, but it does NOT emit a `\r` or `\n` between
// the spinner cycle and the model name. Splitting on cursor home isolates
// each frame so the spinner filter can drop spinner frames without erasing
// the model frame that follows on the same logical line.
const cursorHomePattern = new RegExp(String.raw`\x1b\[H`, "g")
// Screen-clear (`\x1b[2J`) and cursor-home-with-clear (`\x1b[H\x1b[2J`) also
// reset the visible PTY state. They must never silently erase prior content.
const screenClearPattern = new RegExp(String.raw`\x1b\[2J`, "g")

// Bare `\r` is treated as a line break rather than an overwrite so a spinner
// redraw on the same PTY row can never erase a model line that was emitted
// before it. Spinner/fetching fragments produced by those redraws are dropped
// by `fetchingOrSpinnerPattern` during sanitization.
const normalizeCarriageReturns = (output: string) =>
  output
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")

export const sanitizeAgyModelsPtyOutput = (output: string) => {
  const withoutOsc = output.replace(ansiOscPattern, "")
  // Split into frames on cursor-home / screen-clear sequences BEFORE stripping
  // remaining CSI escapes. Each frame is treated as a separate logical line,
  // so spinner redraws and the trailing model row never share a single line.
  const frameSeparator = new RegExp(`${cursorHomePattern.source}|${screenClearPattern.source}`, "g")
  const frames = withoutOsc.split(frameSeparator)
  const stripped = normalizeCarriageReturns(
    frames
      .map((frame) => frame.replace(ansiCsiPattern, "").replace(new RegExp(String.raw`\x07`, "g"), ""))
      .join("\n"),
  )
  return stripped
    .split("\n")
    .map((line) => line.replace(controlResiduePattern, "").trim())
    .filter((line) => line.length > 0 && !fetchingOrSpinnerPattern.test(line))
    .join("\n")
}

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

export const discoverAgyModels = async (options: DiscoverAgyModelsOptions = {}, dependencies: DiscoverAgyModelsDependencies = {}) => {
  const command = options.command ?? "agy"
  const timeoutMs = options.timeoutMs ?? defaultDiscoveryTimeoutMs
  const loadNodePty = dependencies.loadNodePty ?? defaultLoadNodePty
  const ptySpawn = dependencies.ptySpawn ?? (await loadNodePty()).spawn
  const setTimer = dependencies.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout))
  const clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer))
  const platform = dependencies.platform ?? process.platform
  const cwd = options.cwd ?? process.cwd()
  const env = { ...process.env, ...(options.env ?? {}) }
  const resolvedCommand = resolveAgyExecutable(command, env, platform)

  return new Promise<AgyModelDiscoveryResult>((resolve, reject) => {
    let child: AgyPtyProcess
    try {
      child = ptySpawn(resolvedCommand, ["models"], {
        name: "xterm-color",
        cols: 120,
        rows: 30,
        cwd,
        env,
      })
    } catch (error) {
      reject(
        new AntigravityCliProviderError(`Antigravity CLI model discovery failed to start. ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        }),
      )
      return
    }

    let output = ""
    let settled = false
    const disposables: AgyPtyDisposable[] = []

    const cleanup = () => {
      clearTimer(timeout)
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

    const timeout = setTimer(() => killAndFail(new AntigravityCliTimeoutError(timeoutMs)), timeoutMs)

    disposables.push(child.onData((text) => {
      if (settled) {
        return
      }

      output += text
      if (isInteractivePrompt(text) || isInteractivePrompt(output)) {
        killAndFail(createInteractiveSetupError(text))
      }
    }))

    disposables.push(child.onExit(({ exitCode }) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      const sanitizedOutput = sanitizeAgyModelsPtyOutput(output)
      if (exitCode !== 0) {
        reject(createExitError(exitCode, sanitizedOutput))
        return
      }

      if (sanitizedOutput.trim().length === 0) {
        reject(createNoOutputError(output))
        return
      }

      resolve(buildAgyModelDiscoveryResult(parseAgyModelListOutput(sanitizedOutput)))
    }))
  })
}
