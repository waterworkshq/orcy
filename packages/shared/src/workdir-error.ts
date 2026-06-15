/** Sentinel error thrown when workdir setup fails. Caught separately in {@link runPollTick} to bucket workdir failures apart from other errors. */
export class WorkdirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkdirError";
  }
}
