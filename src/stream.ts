import { runAgyCommand } from "./agy-command"
import { getPromptCleanupError } from "./errors"
import { APPROXIMATION_WARNINGS, createStopFinishReason, createUnknownUsage } from "./types"
import type { LanguageModelV3StreamPart, RunAgyCommandDependencies, RunAgyCommandRequest } from "./types"

const textStreamId = "antigravity-cli-text"

const isAbortError = (error: unknown) => error instanceof Error && error.name === "AbortError"

export const createAgyTextStream = (request: RunAgyCommandRequest, dependencies: RunAgyCommandDependencies = {}) => {
  let abortController: AbortController | undefined
  let removeAbortListener: () => void = () => undefined
  let runPromise: Promise<unknown> | undefined
  let streamCancelled = false

  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      abortController = new AbortController()
      let textStarted = false
      let abortListenerRemoved = false

      const abort = () => abortController?.abort()
      request.abortSignal?.addEventListener("abort", abort, { once: true })
      removeAbortListener = () => {
        if (abortListenerRemoved) {
          return
        }

        abortListenerRemoved = true
        request.abortSignal?.removeEventListener("abort", abort)
      }
      controller.enqueue({ type: "stream-start", warnings: APPROXIMATION_WARNINGS })

      const commandPromise = runAgyCommand(
        {
          ...request,
          abortSignal: abortController.signal,
          onStdout: (chunk) => {
            if (streamCancelled) {
              return
            }

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
      runPromise = commandPromise
      void commandPromise
        .then(() => {
          removeAbortListener()
          if (streamCancelled) {
            return
          }

          if (textStarted) {
            controller.enqueue({ type: "text-end", id: textStreamId })
          }

          controller.enqueue({ type: "finish", usage: createUnknownUsage(), finishReason: createStopFinishReason() })
          controller.close()
        })
        .catch((error: unknown) => {
          removeAbortListener()
          if (streamCancelled) {
            return
          }

          controller.error(error)
        })
    },
    cancel() {
      streamCancelled = true
      removeAbortListener()
      abortController?.abort()
      return runPromise?.then(
        () => undefined,
        (error: unknown) => {
          const cleanupError = getPromptCleanupError(error)
          if (isAbortError(error) && cleanupError !== undefined) {
            return Promise.reject(cleanupError)
          }

          return undefined
        },
      )
    },
  })
}
