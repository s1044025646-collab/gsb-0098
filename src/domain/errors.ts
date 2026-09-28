export class DomainError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: unknown;
  constructor(code: string, message: string, httpStatus = 400, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const Errors = {
  validation: (msg: string, details?: unknown) => new DomainError("VALIDATION_ERROR", msg, 400, details),
  notFound: (what: string) => new DomainError("NOT_FOUND", `${what} 不存在`, 404),
  conflict: (code: string, msg: string, details?: unknown) => new DomainError(code, msg, 409, details),
  state: (code: string, msg: string, details?: unknown) => new DomainError(code, msg, 422, details),
  unauthorized: (msg = "未授权") => new DomainError("UNAUTHORIZED", msg, 401),
} as const;
