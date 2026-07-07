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

  test("rejects auth, account, project, and credential extra args", () => {
    for (const arg of ["--api-key", "--token=value", "--auth", "--credential", "--credentials", "--project", "--account", "--login", "--logout"]) {
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

  test("rejects invalid mappings before launch", () => {
    const invalid = { broken: null } as unknown as Record<string, string>
    expect(() => resolveAgyModel("broken", invalid)).toThrow("Model mappings must be non-empty strings")
  })
})

describe("buildAgyArgs", () => {
  test("always includes the exact model name before the prompt", () => {
    expect(buildAgyArgs(["--verbose"], "exact-agy-model", "hello")).toEqual(["--verbose", "--model", "exact-agy-model", "-p", "hello"])
  })
})
