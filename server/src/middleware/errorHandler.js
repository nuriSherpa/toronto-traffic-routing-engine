// server/src/middleware/errorHandler.js
// Central error handler — must be registered LAST, after all routers,
// in src/index.js. Anything thrown in a controller/service (or passed
// to next(err)) ends up here.
import { sendError, ApiError } from '../utils/apiResponse.js';

export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return sendError(res, err.message, {
      status: err.status,
      code: err.code,
      details: err.details,
    });
  }

  console.error('Unhandled error:', err);
  return sendError(res, 'Something went wrong', {
    status: 500,
    code: 'INTERNAL_ERROR',
  });
}

// 404 fallback for unmatched routes — register right before errorHandler.
export function notFoundHandler(req, res) {
  return sendError(res, `No route for ${req.method} ${req.originalUrl}`, {
    status: 404,
    code: 'NOT_FOUND',
  });
}
