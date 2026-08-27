/** Error envelope shared by the HTTP API and the MCP server. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly type: string;
  readonly field?: string;

  constructor(statusCode: number, type: string, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.type = type;
    this.field = field;
  }

  toJSON(): { type: string; message: string; field?: string } {
    return this.field
      ? { type: this.type, message: this.message, field: this.field }
      : { type: this.type, message: this.message };
  }
}

export const badRequest = (message: string, field?: string): ApiError =>
  new ApiError(400, 'invalid_request', message, field);

export const unauthorized = (message = 'Missing or invalid API key.'): ApiError =>
  new ApiError(401, 'unauthorized', message);

export const forbidden = (message: string): ApiError =>
  new ApiError(403, 'forbidden', message);

export const notFound = (what: string): ApiError =>
  new ApiError(404, 'not_found', `${what} not found.`);

export const conflict = (message: string): ApiError =>
  new ApiError(409, 'conflict', message);

export const unprocessable = (message: string, field?: string): ApiError =>
  new ApiError(422, 'unprocessable', message, field);

export const rateLimited = (message: string): ApiError =>
  new ApiError(429, 'rate_limited', message);
