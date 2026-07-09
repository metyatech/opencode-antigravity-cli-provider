import { describe, expect, test } from "bun:test"
import { AntigravityCliConfigurationError } from "./errors"
import { buildAgyArgs, normalizeOptions, resolveAgyModel } from "./options"
import type { AntigravityCliProviderOptions } from "./types"

describe("normalizeOptions", () => {
  test("applies safe defaults without credentials", () => {
    const options = normalizeOptions()

    expect(options.command).toBe("agy")
    expect(options.timeoutMs).toBe(1_800_000)
    expect(options.modelMap).toEqual({})
    expect(options.extraArgs).toEqual([])
    expect(options.env).toEqual({})
  })

  test("rejects an empty command", () => {
    expect(() => normalizeOptions({ command: " " })).toThrow(AntigravityCliConfigurationError)
  })

  test("rejects timeout values outside the supported range", () => {
    expect(() => normalizeOptions({ timeoutMs: 999 })).toThrow("between 1000 and 7200000")
    expect(() => normalizeOptions({ timeoutMs: 7_200_001 })).toThrow("between 1000 and 7200000")
  })

  test("rejects string extraArgs instead of treating them as a shell command", () => {
    const options = { extraArgs: "--verbose" } as unknown as AntigravityCliProviderOptions

    expect(() => normalizeOptions(options)).toThrow("extraArgs must be an array, not a string")
  })

  test("rejects auth, account, project, credential, model, and add-dir extra args", () => {
    for (const arg of ["--api-key", "--token=value", "--auth", "--credential", "--credentials", "--project", "--account", "--login", "--logout", "--model", "--model=Some Model", "--add-dir", "--add-dir=/tmp/prompt"]) {
      expect(() => normalizeOptions({ extraArgs: [arg] })).toThrow("Configure authentication by running agy directly")
    }
  })

  test("rejects non-string and empty model mappings", () => {
    expect(() => normalizeOptions({ modelMap: { empty: " " } })).toThrow("Model mappings must be non-empty strings")
    const invalid = { modelMap: { broken: null } } as unknown as AntigravityCliProviderOptions
    expect(() => normalizeOptions(invalid)).toThrow("Model mappings must be non-empty strings")
  })
})

describe("resolveAgyModel", () => {
  test("returns exact configured agy model names", () => {
    expect(resolveAgyModel("workspace-pro", { "workspace-pro": "exact-agy-model" })).toBe("exact-agy-model")
  })

  test("throws before launch when a model mapping is missing", () => {
    expect(() => resolveAgyModel("missing", {})).toThrow("No Antigravity CLI model mapping configured")
  })

  test("'default' is not special-cased: missing modelMap.default raises the same error as any other slug", () => {
    expect(() => resolveAgyModel("default", {})).toThrow("No Antigravity CLI model mapping configured")
  })

  test("rejects invalid mappings before launch", () => {
    const invalid = { broken: null } as unknown as Record<string, string>
    expect(() => resolveAgyModel("broken", invalid)).toThrow("Model mappings must be non-empty strings")
  })
})

describe("buildAgyArgs", () => {
  test("file transport adds the temp directory and only the short wrapper prompt", () => {
    expect(buildAgyArgs(["--verbose"], "exact-agy-model", { type: "file", tempDir: "/tmp/opencode-antigravity-prompt-abc", wrapperPrompt: "Read prompt.txt." })).toEqual([
      "--verbose",
      "--add-dir",
      "/tmp/opencode-antigravity-prompt-abc",
      "--model",
      "exact-agy-model",
      "-p",
      "Read prompt.txt.",
    ])
  })

  test("direct transport preserves legacy prompt args for tests and future callers", () => {
    expect(buildAgyArgs(["--verbose"], "exact-agy-model", { type: "direct", prompt: "hello" })).toEqual(["--verbose", "--model", "exact-agy-model", "-p", "hello"])
  })
})
