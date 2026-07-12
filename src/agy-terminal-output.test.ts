import { describe, expect, test } from "bun:test"
import { createAgyTerminalOutputParser } from "./agy-terminal-output"

const esc = String.fromCharCode(27)

describe("createAgyTerminalOutputParser", () => {
  test("excludes the progress line and keeps answer text from the same screen chunk", async () => {
    const deltas: string[] = []
    const parser = createAgyTerminalOutputParser((delta) => deltas.push(delta))
    await parser.push(`${esc}[2J${esc}[Hprogress frame\r\n回答です\r\n`)
    await expect(parser.finish()).resolves.toBe("回答です")
    expect(deltas).toEqual(["回答です"])
    parser.dispose()
  })

  test("does not emit control-only output and accepts a single answer line after a clear", async () => {
    const deltas: string[] = []
    const parser = createAgyTerminalOutputParser((delta) => deltas.push(delta))
    await parser.push(`${esc}[2J${esc}[H`)
    await expect(parser.finish()).resolves.toBe("")
    expect(deltas).toEqual([])
    parser.dispose()

    const singleLineDeltas: string[] = []
    const singleLineParser = createAgyTerminalOutputParser((delta) => singleLineDeltas.push(delta))
    await singleLineParser.push(`${esc}[2J${esc}[HOK\r\n`)
    await expect(singleLineParser.finish()).resolves.toBe("OK")
    expect(singleLineDeltas).toEqual(["OK"])
    singleLineParser.dispose()
  })

  test("streams only monotonic suffixes across multiple chunks", async () => {
    const deltas: string[] = []
    const parser = createAgyTerminalOutputParser((delta) => deltas.push(delta))
    await parser.push("長い回答")
    await parser.push("です。\r\n次の行")
    await expect(parser.finish()).resolves.toBe("長い回答です。\n次の行")
    expect(deltas).toEqual(["長い回答", "です。\n次の行"])
    parser.dispose()
  })

  test("restores wrapped CJK lines, carriage returns, and cursor overwrites without duplication", async () => {
    const deltas: string[] = []
    const parser = createAgyTerminalOutputParser((delta) => deltas.push(delta))
    const wrapped = "あ".repeat(121)
    await parser.push(wrapped)
    await expect(parser.finish()).resolves.toBe(wrapped)
    expect(deltas.join("")).toBe(wrapped)
    parser.dispose()

    const carriageParser = createAgyTerminalOutputParser(() => undefined)
    await carriageParser.push("old\rnew")
    await expect(carriageParser.finish()).resolves.toBe("new")
    carriageParser.dispose()

    const cursorParser = createAgyTerminalOutputParser(() => undefined)
    await cursorParser.push(`abc${esc}[Hxyz`)
    await expect(cursorParser.finish()).resolves.toBe("xyz")
    cursorParser.dispose()
  })

  test("fails closed on non-monotonic output after streaming begins", async () => {
    const parser = createAgyTerminalOutputParser(() => undefined)
    await parser.push("first")
    await expect(parser.push(`${esc}[2J${esc}[Hsecond`)).rejects.toThrow("Antigravity CLI terminal output became non-monotonic after streaming started.")
    parser.dispose()
  })
})

