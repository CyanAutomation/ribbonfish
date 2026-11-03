/** An error whose status and message are safe to return to an HTTP client. */
export class HTTPError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
