import type { SerializedError } from "./types.ts";

declare const self: Worker;

type InflightController = AbortController;
type RunMessage = {
  type: "run";
  id: string;
  fnSource: string;
  args: unknown[];
  timeoutMs?: number;
};
type CancelMessage = { type: "cancel"; id: string };
type WorkerMessage = RunMessage | CancelMessage;

function workerMain() {
  const inflight = new Map<string, InflightController>();

  function serializeError(error: unknown): SerializedError {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: error.cause ? serializeError(error.cause) : undefined,
      };
    }
    return { name: "Error", message: String(error) };
  }

  self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;

    if (message.type === "run") {
      const { id, fnSource, args, timeoutMs } = message;
      const controller = new AbortController();
      inflight.set(id, controller);

      try {
        const fn = new Function(`return (${fnSource})`)();

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          timeoutId = setTimeout(() => {
            controller.abort(new Error("Timeout"));
          }, timeoutMs);
        }

        const result = await fn(...args);

        if (timeoutId) clearTimeout(timeoutId);

        if (controller.signal.aborted) {
          throw controller.signal.reason || new Error("Cancelled");
        }

        self.postMessage({ type: "ok", id, value: result });
      } catch (error) {
        self.postMessage({ type: "err", id, error: serializeError(error) });
      } finally {
        inflight.delete(id);
      }
    } else if (message.type === "cancel") {
      const { id } = message;
      const controller = inflight.get(id);
      if (controller) {
        controller.abort(new Error("Cancelled"));
      }
    }
  };

  self.postMessage({ type: "ready" });
}

export const WORKER_SCRIPT = `(${workerMain.toString()})();`;

let workerBlobUrl: string | null = null;

export function getWorkerBlobUrl(): string {
  if (workerBlobUrl === null) {
    const blob = new Blob([WORKER_SCRIPT], { type: "application/javascript" });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  return workerBlobUrl;
}

export function revokeWorkerBlobUrl(): void {
  if (workerBlobUrl !== null) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
  }
}
