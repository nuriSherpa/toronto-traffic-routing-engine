// server/src/middleware/asyncHandler.js
// Wraps an async route handler so a thrown error or rejected promise is
// forwarded to Express's error middleware (errorHandler.js) instead of
// needing a try/catch in every single controller function.
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
