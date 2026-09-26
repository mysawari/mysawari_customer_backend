const AppError = require('../common/errors/app-error');
const ApiResponse = require('../common/utils/api-response');

const errorMiddleware = (err, req, res, next) => {
  let statusCode = 500;
  let message = 'Internal Server Error';

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
  } else if (err && err.type === 'entity.parse.failed') {
    // Malformed JSON body — the client's mistake, not a server fault.
    statusCode = 400;
    message = 'Invalid request body';
  } else if (err && err.type === 'entity.too.large') {
    statusCode = 413;
    message = 'Request body is too large';
  } else if (err && (err.name === 'CastError' || err.name === 'ValidationError' || err.name === 'StrictModeError')) {
    // A value of the wrong type/shape reached Mongoose. Never echo its internal message back.
    statusCode = 400;
    message = 'Invalid request';
  } else if (err && err.message === 'Not allowed by CORS') {
    statusCode = 403;
    message = 'Origin not allowed';
  } else {
    console.error('[Unhandled Error]', err);
  }

  return ApiResponse.error(res, message, statusCode, process.env.NODE_ENV === 'development' ? err.stack : undefined);
};

module.exports = errorMiddleware;
