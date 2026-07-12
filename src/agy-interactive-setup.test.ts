import { describe, expect, test } from "bun:test"
import { createAgyInteractiveSetupDetector } from "./agy-interactive-setup"

describe("AgyInteractiveSetupDetector", () => {
  test("detects prompts split across chunks", () => {
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push("Please log")).toBeUndefined()
    expect(detector.push("in to continue\r\n")).toBe("Please login to continue")
  })

  test("detects ANSI-decorated prompts and retains only the prompt line", () => {
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push("noise\n\u001b[2KAuthorization URL: https://example.test\u0007\nmore")).toBe("Authorization URL: https://example.test")
  })

  test("keeps the rolling buffer bounded while detecting a trailing prompt", () => {
    const detector = createAgyInteractiveSetupDetector({ maxBufferSize: 4096 })

    expect(detector.push("x".repeat(100_000))).toBeUndefined()
    expect(detector.push("\r\nPlease login to continue\r\n")).toBe("Please login to continue")
  })

  test("does not match source or prose and can be disabled", () => {
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push('const pattern = /sign in/i')).toBeUndefined()
    expect(detector.push("This section explains how users sign in.")).toBeUndefined()
    detector.disable()
    expect(detector.push("Please login to continue\nPress Enter to continue\nPermission required")).toBeUndefined()
  })
})
