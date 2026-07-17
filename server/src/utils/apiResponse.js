// server/src/utils/apiResponse.js
// Standard response envelope used by every API endpoint so the frontend
// can rely on one consistent shape no matter which route it hits.
//
// Success: { success: true, data: <payload>, meta?: { ... } }
// Error:   { success: false, error: { message, code, details? } }

export function sendSuccess(res, data, { status = 200, meta = null } = {}) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export function sendError(
  res,
  message,
  { status = 500, code = 'INTERNAL_ERROR', details = null } = {},
) {
  const body = { success: false, error: { message, code } };
  if (details) body.error.details = details;
  return res.status(status).json(body);
}

// Throw this from a service/controller to control the exact HTTP status
// and error code the client receives (e.g. 404 ROUTE_NOT_FOUND) instead
// of falling through to a generic 500.
export class ApiError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
