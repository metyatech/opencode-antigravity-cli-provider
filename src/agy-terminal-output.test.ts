import { describe, expect, test } from "bun:test"
import { buildAgyTerminalOptions, createAgyTerminalOutputParser } from "./agy-terminal-output"

const esc = String.fromCharCode(27)

describe("buildAgyTerminalOptions", () => {
  test("uses conpty and the Windows build number for Windows", () => {
    expect(buildAgyTerminalOptions("win32", "10.0.26100").windowsPty).toEqual({ backend: "conpty", buildNumber: 26100 })
  })

  test("does not set windowsPty outside Windows", () => {
    expect(buildAgyTerminalOptions("linux", "10.0.26100").windowsPty).toBeUndefined()
  })
})

describe("createAgyTerminalOutputParser", () => {
  test("excludes the progress line and keeps answer text from the same screen chunk", async () => {
    const deltas: string[] = []
    const parser = createAgyTerminalOutputParser((delta) => deltas.push(delta), "linux")
    await parser.push(`${esc}[2J${esc}[Hprogress frame\r\n回答です\r\n`)
    await expect(parser.finish()).resolves.toBe("回答です")
    expect(deltas).toEqual(["回答です"])
    parser.dispose()
  })

  test("does not emit control-only output and accepts a single answer line after a clear", async () => {
    const deltas: string[] = []
    const parser = createAgyTerminalOutputParser((delta) => deltas.push(delta), "linux")
    await parser.push(`${esc}[2J${esc}[H`)
    await expect(parser.finish()).resolves.toBe("")
    expect(deltas).toEqual([])
    parser.dispose()

    const singleLineDeltas: string[] = []
    const singleLineParser = createAgyTerminalOutputParser((delta) => singleLineDeltas.push(delta), "linux")
    await singleLineParser.push(`${esc}[2J${esc}[HOK\r\n`)
    await expect(singleLineParser.finish()).resolves.toBe("OK")
    expect(singleLineDeltas).toEqual(["OK"])
    singleLineParser.dispose()
  })

  test("streams only monotonic suffixes across multiple chunks", async () => {
    const deltas: string[] = []
    const parser = createAgyTerminalOutputParser((delta) => deltas.push(delta), "linux")
    await parser.push("長い回答")
    await parser.push("です。\r\n次の行")
    await expect(parser.finish()).resolves.toBe("長い回答です。\n次の行")
    expect(deltas).toEqual(["長い回答です。\n次の行"])
    parser.dispose()
  })

  test("absorbs a terminal redraw in the mutable tail without duplicate deltas", async () => {
    const deltas: string[] = []
    const parser = createAgyTerminalOutputParser((delta) => deltas.push(delta), "linux")
    await parser.push("fixed\r\nold-tail\r\nopen")
    expect(deltas).toEqual(["fixed\n"])

    await parser.push(`${esc}[1A${esc}[1G${esc}[2Knew-tail`)
    expect(deltas).toEqual(["fixed\n"])

    await parser.push(`${esc}[1B${esc}[1G\r\nfourth`)
    expect(deltas).toEqual(["fixed\n", "new-tail\n"])

    const final = await parser.finish()
    expect(final).toBe("fixed\nnew-tail\nopen\nfourth")
    expect(deltas.join("")).toBe(final)
    parser.dispose()
  })

  test("retains the last committed answer when redraw cleanup leaves an empty terminal", async () => {
    const deltas: string[] = []
    const parser = createAgyTerminalOutputParser((delta) => deltas.push(delta), "linux")
    await parser.push("確定行\n末尾\n表示中")
    await parser.push(`${esc}[2J${esc}[H`)
    await expect(parser.finish()).resolves.toBe("確定行\n")
    expect(deltas).toEqual(["確定行\n"])
    parser.dispose()
  })

  test("restores wrapped CJK lines, carriage returns, and cursor overwrites without duplication", async () => {
    const deltas: string[] = []
    const parser = createAgyTerminalOutputParser((delta) => deltas.push(delta), "linux")
    const wrapped = "あ".repeat(121)
    await parser.push(wrapped)
    await expect(parser.finish()).resolves.toBe(wrapped)
    expect(deltas.join("")).toBe(wrapped)
    parser.dispose()

    const carriageParser = createAgyTerminalOutputParser(() => undefined, "linux")
    await carriageParser.push("old\rnew")
    await expect(carriageParser.finish()).resolves.toBe("new")
    carriageParser.dispose()

    const cursorParser = createAgyTerminalOutputParser(() => undefined, "linux")
    await cursorParser.push(`abc${esc}[Hxyz`)
    await expect(cursorParser.finish()).resolves.toBe("xyz")
    cursorParser.dispose()
  })

  test("fails closed on non-monotonic output after streaming begins", async () => {
    const parser = createAgyTerminalOutputParser(() => undefined, "linux")
    await parser.push("committed\nstable\nvolatile")
    await expect(parser.push(`${esc}[2J${esc}[Hchanged\nstable\nvolatile`)).rejects.toThrow("Antigravity CLI terminal output became non-monotonic after streaming started.")
    parser.dispose()
  })
})
