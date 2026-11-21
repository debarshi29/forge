/** A stream failure that is safe to retry by re-issuing the same turn. */
export class ProviderStreamError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderStreamError";
  }
}
