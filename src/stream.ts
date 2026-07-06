import { runAgyCommand } from "./agy-command"
import { APPROXIMATION_WARNINGS, createStopFinishReason, createUnknownUsage } from "./types"
import type { LanguageModelV3StreamPart, RunAgyCommandDependencies, RunAgyCommandRequest } from "./types"

const textStreamId = "antigravity-cli-text"

export const createAgyTextStream = (request: RunAgyCommandRequest, dependencies: RunAgyCommandDependencies = {}) => {
  let abortController: AbortController | undefined
  let removeAbortListener: () => void = () => undefined

  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      abortController = new AbortController()
      let textStarted = false

      const abort = () => abortController?.abort()
      request.abortSignal?.addEventListener("abort", abort, { once: true })
      removeAbortListener = () => request.abortSignal?.removeEventListener("abort", abort)
      controller.enqueue({ type: "stream-start", warnings: APPROXIMATION_WARNINGS })

      void runAgyCommand(
        {
          ...request,
          abortSignal: abortController.signal,
          onStdout: (chunk) => {
            if (!textStarted) {
              textStarted = true
              controller.enqueue({ type: "text-start", id: textStreamId })
            }

            controller.enqueue({ type: "text-delta", id: textStreamId, delta: chunk })
            request.onStdout?.(chunk)
          },
        },
        dependencies,
      )
        .then(() => {
          removeAbortListener()
          if (textStarted) {
            controller.enqueue({ type: "text-end", id: textStreamId })
          }

          controller.enqueue({ type: "finish", usage: createUnknownUsage(), finishReason: createStopFinishReason() })
          controller.close()
        })
        .catch((error: unknown) => {
          removeAbortListener()
          controller.error(error)
        })
    },
    cancel() {
      removeAbortListener()
      abortController?.abort()
    },
  })
}
