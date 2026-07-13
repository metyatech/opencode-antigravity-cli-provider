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

  test("keeps only the latest candidate while preserving a split replacement prompt", () => {
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push("Permission required\n")).toEqual({ line: "Permission required" })
    expect(detector.push("Please log")).toBeUndefined()
    expect(detector.push("in to continue")).toEqual({ line: "Please login to continue" })
  })

  test("processes line and screen erase controls in sequence", () => {
    const esc = "\u001b"
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push(`Please login to continue${esc}[K`)).toBeUndefined()
    expect(detector.push(`Please login to continue${esc}[2K`)).toBeUndefined()
    expect(detector.push(`Please login to continue${esc}[2J`)).toBeUndefined()
    expect(detector.push(`old text${esc}[2J${esc}[HPlease login to continue`)).toEqual({ line: "Please login to continue" })
    const cursorHomeDetector = createAgyInteractiveSetupDetector()
    expect(cursorHomeDetector.push(`Please login to continue${esc}[H`)).toEqual({ line: "Please login to continue" })
  })

  test("preserves a completed prompt when CSI K erases the new CRLF line", () => {
    const esc = "\u001b"
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push(`Please login to continue\r\n${esc}[K`)).toEqual({ line: "Please login to continue" })

    const secondDetector = createAgyInteractiveSetupDetector()
    expect(secondDetector.push(`Please login to continue\r\n${esc}[2K`)).toEqual({ line: "Please login to continue" })

    const blankLineDetector = createAgyInteractiveSetupDetector()
    expect(blankLineDetector.push(`Please login to continue\r\n\r\n${esc}[K`)).toEqual({ line: "Please login to continue" })
  })

  test("uses cursor positioning to erase only the candidate row", () => {
    const esc = "\u001b"

    expect(createAgyInteractiveSetupDetector().push(`Please login to continue\r\n${esc}[H${esc}[K`)).toBeUndefined()
    expect(createAgyInteractiveSetupDetector().push(`Please login to continue\r\n${esc}[1;1H${esc}[2K`)).toBeUndefined()
    expect(createAgyInteractiveSetupDetector().push(`Please login to continue\r\n${esc}[1;1f${esc}[2K`)).toBeUndefined()

    expect(createAgyInteractiveSetupDetector().push(`Welcome\r\nPlease login to continue\r\n${esc}[H${esc}[2K`)).toEqual({ line: "Please login to continue" })
    expect(createAgyInteractiveSetupDetector().push(`Welcome\r\nPlease login to continue\r\n${esc}[2;1H${esc}[2K`)).toBeUndefined()
    expect(createAgyInteractiveSetupDetector().push(`Welcome\r\nPlease login to continue\r\n${esc}[3;1H${esc}[2K`)).toEqual({ line: "Please login to continue" })
  })

  test("defaults cursor positioning to row one and handles split cursor CSI", () => {
    const esc = "\u001b"
    for (const cursorPosition of [`${esc}[H`, `${esc}[f`, `${esc}[0;0H`, `${esc}[;H`]) {
      expect(createAgyInteractiveSetupDetector().push(`Please login to continue\r\n${cursorPosition}${esc}[2K`)).toBeUndefined()
    }

    const homeDetector = createAgyInteractiveSetupDetector()
    expect(homeDetector.push(`Please login to continue\r\n${esc}[`)).toEqual({ line: "Please login to continue" })
    expect(homeDetector.push(`H${esc}[`)).toEqual({ line: "Please login to continue" })
    expect(homeDetector.push("2K")).toBeUndefined()

    const rowTwoDetector = createAgyInteractiveSetupDetector()
    expect(rowTwoDetector.push(`Welcome\r\nPlease login to continue\r\n${esc}[2;`)).toEqual({ line: "Please login to continue" })
    expect(rowTwoDetector.push(`1H${esc}[2`)).toEqual({ line: "Please login to continue" })
    expect(rowTwoDetector.push("K")).toBeUndefined()
  })

  test("uses relative cursor movement to erase only the candidate row", () => {
    const esc = "\u001b"

    expect(createAgyInteractiveSetupDetector().push(`Please login to continue\r\n${esc}[1A${esc}[2K`)).toBeUndefined()
    expect(createAgyInteractiveSetupDetector().push(`Welcome\r\nPlease login to continue\r\n${esc}[2A${esc}[2K`)).toEqual({ line: "Please login to continue" })
    expect(createAgyInteractiveSetupDetector().push(`Welcome\r\nPlease login to continue\r\n${esc}[1A${esc}[2K`)).toBeUndefined()
    expect(createAgyInteractiveSetupDetector().push(`Please login to continue\r\n${esc}[999A${esc}[2K`)).toBeUndefined()
    expect(createAgyInteractiveSetupDetector().push(`Please login to continue\r\n${esc}[H${esc}[1B${esc}[2K`)).toEqual({ line: "Please login to continue" })
    expect(createAgyInteractiveSetupDetector().push(`Welcome\r\nPlease login to continue\r\n${esc}[H${esc}[1B${esc}[2K`)).toBeUndefined()
  })

  test("defaults relative cursor distance to one and handles split movement CSI", () => {
    const esc = "\u001b"
    for (const up of [`${esc}[A`, `${esc}[0A`, `${esc}[;A`]) {
      expect(createAgyInteractiveSetupDetector().push(`Please login to continue\r\n${up}${esc}[2K`)).toBeUndefined()
    }
    for (const down of [`${esc}[B`, `${esc}[0B`, `${esc}[;B`]) {
      expect(createAgyInteractiveSetupDetector().push(`Please login to continue\r\n${esc}[H${down}${esc}[2K`)).toEqual({ line: "Please login to continue" })
    }

    const upDetector = createAgyInteractiveSetupDetector()
    expect(upDetector.push(`Please login to continue\r\n${esc}[`)).toEqual({ line: "Please login to continue" })
    expect(upDetector.push(`1A${esc}[2`)).toEqual({ line: "Please login to continue" })
    expect(upDetector.push("K")).toBeUndefined()

    const downDetector = createAgyInteractiveSetupDetector()
    expect(downDetector.push(`Welcome\r\nPlease login to continue\r\n${esc}[H${esc}[`)).toEqual({ line: "Please login to continue" })
    expect(downDetector.push(`1B${esc}[2`)).toEqual({ line: "Please login to continue" })
    expect(downDetector.push("K")).toBeUndefined()
  })

  test("ignores CSI G while preserving relative cursor row tracking", () => {
    const esc = "\u001b"

    expect(createAgyInteractiveSetupDetector().push(`Welcome\r\nPlease login to continue\r\n${esc}[2A${esc}[1G${esc}[2K`)).toEqual({ line: "Please login to continue" })
    expect(createAgyInteractiveSetupDetector().push(`Please login to continue\r\nopen${esc}[1A${esc}[1G${esc}[2Knormal text`)).toBeUndefined()
  })

  test("clears a completed prompt only for screen erase and clears it on the next normal line", () => {
    const esc = "\u001b"
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push(`Please login to continue\r\n${esc}[2J`)).toBeUndefined()

    const thirdScreenDetector = createAgyInteractiveSetupDetector()
    expect(thirdScreenDetector.push(`Please login to continue\r\n${esc}[3J`)).toBeUndefined()

    const continuationDetector = createAgyInteractiveSetupDetector()
    expect(continuationDetector.push("Please login to continue\r\nこれは回答です")).toBeUndefined()
  })

  test("applies bare CR only to the active line", () => {
    const activeLineDetector = createAgyInteractiveSetupDetector()
    expect(activeLineDetector.push("Please login to continue\rnormal text")).toBeUndefined()

    const completedLineDetector = createAgyInteractiveSetupDetector()
    expect(completedLineDetector.push("Please login to continue\r\n\r")).toEqual({ line: "Please login to continue" })
  })

  test("handles an erase sequence split across chunks without retaining the erased prompt", () => {
    const detector = createAgyInteractiveSetupDetector()

    expect(detector.push("Please login to continue\u001b[")).toEqual({ line: "Please login to continue" })
    expect(detector.push("2K")).toBeUndefined()
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
