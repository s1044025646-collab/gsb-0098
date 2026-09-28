export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STATE_ERROR"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  status: number;
  code: ErrorCode;
  details?: unknown;
  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  static validation(message: string, details?: unknown): ApiError {
    return new ApiError(400, "VALIDATION_ERROR", message, details);
  }
  static notFound(what: string): ApiError {
    return new ApiError(404, "NOT_FOUND", `${what} not found`);
  }
  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(409, "CONFLICT", message, details);
  }
  static state(message: string, details?: unknown): ApiError {
    return new ApiError(422, "STATE_ERROR", message, details);
  }
}

export function toErrorBody(err: unknown): { status: number; body: unknown } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, details: err.details ?? null } },
    };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: (err as Error)?.message ?? "internal error" } },
  };
}
