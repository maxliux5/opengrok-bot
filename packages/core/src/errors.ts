export class DomainError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly code: string = "invalid_request",
  ) {
    super(message);
  }
}
