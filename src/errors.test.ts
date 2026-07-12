import { describe, expect, test } from "bun:test"
import {
  AntigravityCliInteractiveSetupError,
  PromptCleanupError,
  attachPromptCleanupError,
  createAbortError,
  createExitError,
  createInteractiveSetupError,
  createNoOutputError,
  getPromptCleanupError,
  isInteractivePrompt,
  summarizeStderr,
} from "./errors"

describe("interactive setup detection", () => {
  test("detects login, authorization, permission, terms, theme, and trust prompts", () => {
    for (const prompt of [
      "not signed in",
      "Authorization URL: https://example.test",
      "Do you trust this folder?",
      "This action requires permission",
      "requires permission",
      "Select a theme",
      "accept the terms",
      "press enter to continue",
      "↑/↓ Navigate",
    ]) {
      expect(isInteractivePrompt(prompt)).toBe(true)
    }
  })

  test("does not classify ordinary model output as setup", () => {
    expect(isInteractivePrompt("Here is the generated answer.")).toBe(false)
  })

  test("does not classify prompt patterns quoted in generated source as setup", () => {
    for (const text of [
      "const interactivePromptPatterns = [\n  /not signed in/i,\n  /sign in/i,\n  /press enter/i,\n]",
      'This section explains how users sign in.',
      'The code detects "press enter" messages.',
      "Use the authorization URL pattern for detection.",
      'isInteractivePrompt("Please login to continue")',
      "The CLI may display: Please login to continue",
    ]) {
      expect(isInteractivePrompt(text)).toBe(false)
    }
  })

  test("accepts case and punctuation variations of complete prompt lines", () => {
    for (const prompt of [
      "NOT SIGNED IN",
      "You are not signed in.",
      "Please sign in to continue!",
      "Permission required.",
      "Press Enter to continue.",
    ]) {
      expect(isInteractivePrompt(prompt)).toBe(true)
    }
  })

  test("accepts ANSI-decorated prompt lines", () => {
    expect(isInteractivePrompt("\u001b[31mPlease login to continue\u001b[0m\r")).toBe(true)
  })
})

describe("error helpers", () => {
  test("summarizes stderr without preserving noisy whitespace", () => {
    expect(summarizeStderr("  first\n\nsecond\tthird  ")).toBe("first second third")
  })

  test("truncates long stderr summaries", () => {
    const summary = summarizeStderr("x".repeat(300), 12)

    expect(summary).toBe(`${"x".repeat(11)}…`)
  })

  test("creates actionable interactive setup errors", () => {
    const error = createInteractiveSetupError("Please login to continue")

    expect(error).toBeInstanceOf(AntigravityCliInteractiveSetupError)
    expect(error.message).toContain("Run `agy` directly to complete setup")
  })

  test("creates exit, no-output, and abort errors", () => {
    expect(createExitError(2, "boom").message).toBe("Antigravity CLI failed with exit code 2. boom")
    expect(createNoOutputError("").message).toBe("Antigravity CLI returned no output.")
    expect(createAbortError().name).toBe("AbortError")
  })

  test("returns a direct prompt cleanup error", () => {
    const cause = new Error("rm failed")
    const cleanupError = new PromptCleanupError("/tmp/opencode-antigravity-prompt-direct", cause)

    expect(getPromptCleanupError(cleanupError)).toBe(cleanupError)
    expect(cleanupError.name).toBe("PromptCleanupError")
    expect(cleanupError.message).toContain("/tmp/opencode-antigravity-prompt-direct")
    expect(cleanupError.cause).toBe(cause)
  })

  test("returns cleanup errors attached to abort errors", () => {
    const abortError = createAbortError()
    const cleanupError = new PromptCleanupError("/tmp/opencode-antigravity-prompt-attached", new Error("cleanup failed"))

    const attached = attachPromptCleanupError(abortError, cleanupError)

    expect(attached).toBe(abortError)
    expect(getPromptCleanupError(attached)).toBe(cleanupError)
  })

  test("returns undefined for ordinary errors without cleanup failure", () => {
    expect(getPromptCleanupError(new Error("ordinary"))).toBeUndefined()
  })
})
