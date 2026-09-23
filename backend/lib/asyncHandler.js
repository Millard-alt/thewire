/* Express 4 does not catch rejected promises thrown by async route handlers or
   async middleware — an unhandled rejection would leave the request hanging with
   no response. Wrapping every async handler in this forwards failures to the
   central error handler in server.js instead. */
module.exports = function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
