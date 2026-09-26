const AppError = require('../common/errors/app-error');

// Keys that must never reach a database query or an object merge.
// `$...` turns a value into a MongoDB operator ({ "$ne": null } matches everything); the others
// are the classic prototype-pollution keys.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 10;

function findForbiddenKey(value, depth = 0) {
  if (value === null || typeof value !== 'object') return null;
  if (depth > MAX_DEPTH) return '(too deeply nested)';
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || FORBIDDEN_KEYS.has(key)) return key;
    const nested = findForbiddenKey(value[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * Rejects any request whose body, query or route params contain a MongoDB operator key or a
 * prototype-pollution key. No legitimate client of this API ever sends one, so this is a single,
 * global guard against NoSQL-injection ({ "otp": { "$ne": "" } }) and object-merge attacks.
 */
function rejectOperatorKeys(req, res, next) {
  const bad = findForbiddenKey(req.body) || findForbiddenKey(req.query) || findForbiddenKey(req.params);
  if (bad) return next(new AppError('Invalid request', 400));
  next();
}

module.exports = rejectOperatorKeys;
module.exports.findForbiddenKey = findForbiddenKey;
