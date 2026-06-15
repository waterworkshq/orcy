export class WorkdirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkdirError";
  }
}
