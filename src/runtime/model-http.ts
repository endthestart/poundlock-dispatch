import { Agent, install, setGlobalDispatcher } from "undici";

/**
 * How long a model request may wait for its answer to start, and then between
 * the parts of its answer: the OpenAI SDK's own default. Node's fetch gives up
 * after 5 minutes, and Pi asks the SDK for the same 5, which a local model
 * reading a long prompt, or a request queued for a busy model, can outlast.
 */
export const MODEL_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Gives this process's fetch the model request limit. Pi's own setup does the
 * same but is not exported. Fetch is replaced with this undici's, as Pi does,
 * so fetch and its dispatcher are one implementation: Node's built-in fetch on
 * another undici's dispatcher can leave compressed answers undecoded.
 */
export function configureModelHttp(): void {
  setGlobalDispatcher(
    new Agent({
      headersTimeout: MODEL_REQUEST_TIMEOUT_MS,
      bodyTimeout: MODEL_REQUEST_TIMEOUT_MS,
    }),
  );
  install();
}
