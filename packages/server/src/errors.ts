// The error every API route turns into a JSON reply: a code agents and the UI can test, a message for people, and
// the HTTP status.

export class AfError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AfError";
  }
}
