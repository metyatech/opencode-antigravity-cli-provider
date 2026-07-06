export const AGY_PROMPT_PREFIX = `You are being invoked through opencode-antigravity-cli-provider, a text-only bridge to the official agy CLI.

Safety and implementation boundaries:
- Use only the official agy CLI behavior available in this subprocess invocation.
- If you edit files or run commands, do it only as required by the user request and summarize what changed. Do not push, reset, delete branches, rotate credentials, or modify authentication unless explicitly requested in the transcript.
- Do not request, create, inspect, rotate, or bypass OAuth sessions, API keys, tokens, keyrings, credentials, accounts, projects, login/logout flows, sidecars, proxies, internal APIs, auth packages, quota systems, quota bypasses, or account rotation.
- If setup, login, permissions, or browser authorization are required, tell the user to run agy directly to complete setup.
- Tool calls, approval flows, usage/token counts, cache control, and conversation resume are approximate/not supported through this provider.
- Return plain text only. Do not invent token counts, tool calls, approvals, cache state, or resumed conversation state.`

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }

  if (value === undefined) {
    return "undefined"
  }

  try {
    const json = JSON.stringify(value)
    return json ?? String(value)
  } catch {
    return "[Unserializable value]"
  }
}

const formatPart = (part: unknown) => {
  if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
    return part.text
  }

  return stringifyUnknown(part)
}

const formatContent = (content: unknown) => {
  if (typeof content === "string") {
    return content
  }

  if (Array.isArray(content)) {
    return content.map(formatPart).join("\n")
  }

  return stringifyUnknown(content)
}

const formatMessage = (message: unknown, index: number) => {
  if (!isRecord(message)) {
    return `[message ${index + 1}]\n${stringifyUnknown(message)}`
  }

  const role = typeof message.role === "string" ? message.role : `message-${index + 1}`
  return `[${role}]\n${formatContent(message.content)}`
}

export const buildAgyPrompt = (prompt: unknown) => `${AGY_PROMPT_PREFIX}\n\nConversation:\n${(Array.isArray(prompt) ? prompt : [prompt]).map(formatMessage).join("\n\n")}`
