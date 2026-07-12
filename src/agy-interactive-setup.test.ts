import { describe, expect, test } from "bun:test"
import { createAgyInteractiveSetupDetector } from "./agy-interactive-setup"

describe("AgyInteractiveSetupDetector", () => {
  test("detects prompts split across chunks", () => {
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push("Please log")).toBeUndefined()
    expect(detector.push("in to continue\r\n")).toEqual({ line: "Please login to continue" })
  })

  test("detects ANSI-decorated prompts and retains only the prompt line", () => {
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push("noise\n\u001b[2KAuthorization URL: https://example.test\u0007\n")).toEqual({ line: "Authorization URL: https://example.test" })
  })

  test("handles ANSI CSI and OSC sequences split across chunks", () => {
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push("\u001b[31")).toBeUndefined()
    expect(detector.push("mPlease login to continue\u001b]0;agy-title")).toEqual({ line: "Please login to continue" })
    expect(detector.push("\u0007\r\n")).toEqual({ line: "Please login to continue" })
  })

  test("keeps the rolling buffer bounded while detecting a trailing prompt", () => {
    const detector = createAgyInteractiveSetupDetector({ maxBufferSize: 4096 })

    expect(detector.push("x".repeat(100_000))).toBeUndefined()
    expect(detector.push("\r\nPlease login to continue\r\n")).toEqual({ line: "Please login to continue" })
  })

  test("does not match source or prose and can be disabled", () => {
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push('const pattern = /sign in/i')).toBeUndefined()
    expect(detector.push("This section explains how users sign in.")).toBeUndefined()
    expect(detector.push("Please login to continue\nThis is the answer continuation")).toBeUndefined()
    detector.clear()
    detector.disable()
    expect(detector.push("Please login to continue\nPress Enter to continue\nPermission required")).toBeUndefined()
  })
})
