import { describe, expect, test } from "bun:test"
import { AGY_PROMPT_PREFIX, buildAgyPrompt, stringifyUnknown } from "./prompt"

describe("stringifyUnknown", () => {
  test("passes through strings and serializes JSON-compatible values", () => {
    expect(stringifyUnknown("hello")).toBe("hello")
    expect(stringifyUnknown({ ok: true })).toBe('{"ok":true}')
    expect(stringifyUnknown(undefined)).toBe("undefined")
  })

  test("handles unserializable values without throwing", () => {
    const value: Record<string, unknown> = {}
    value.self = value

    expect(stringifyUnknown(value)).toBe("[Unserializable value]")
  })
})

describe("buildAgyPrompt", () => {
  test("adds safety boundaries and formats text message parts", () => {
    const prompt = buildAgyPrompt([{ role: "user", content: [{ type: "text", text: "hello" }] }])

    expect(prompt).toContain(AGY_PROMPT_PREFIX)
    expect(prompt).toContain("official agy CLI")
    expect(prompt).toContain("Do not request, create, inspect, rotate, or bypass OAuth sessions")
    expect(prompt).toContain("[user]\nhello")
  })

  test("formats non-text content without losing message order", () => {
    const prompt = buildAgyPrompt([
      { role: "system", content: "system prompt" },
      { role: "user", content: [{ type: "image", url: "file.png" }] },
    ])

    expect(prompt.indexOf("[system]")).toBeLessThan(prompt.indexOf("[user]"))
    expect(prompt).toContain('{"type":"image","url":"file.png"}')
  })
})
