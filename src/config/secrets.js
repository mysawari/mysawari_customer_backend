const isProduction = process.env.NODE_ENV === 'production';
// Only an explicit development/test run may use the built-in secrets or print OTPs to the console.
// A server where NODE_ENV was simply never set must be treated like production.
const isDevelopment = ['development', 'test'].includes(process.env.NODE_ENV);

// Legacy defaults. They must stay identical to what the API used before, otherwise
// tokens already issued to users stop verifying and everyone gets logged out.
const LEGACY_JWT_SECRET = 'mysawari_super_secret_key_123!';
const LEGACY_JWT_REFRESH_SECRET = 'mysawari_refresh_super_secret_key_123!';

const fromEnv = (name, legacyFallback) => {
  const value = process.env[name];
  if (value) return value;
  // The legacy fallback is a fixed string sitting in source control — anyone who can read this
  // repo can forge a valid token with it. That's fine for a throwaway local dev server, but using
  // it in production means auth is broken for every customer, so refuse to boot rather than do that.
  if (!isDevelopment) {
    throw new Error(`${name} is not set. Refusing to start with a publicly-known JWT secret (set NODE_ENV=development to use the local default).`);
  }
  console.warn(`⚠️  ${name} is not set — falling back to the built-in development default.`);
  return legacyFallback;
};

module.exports = {
  isProduction,
  isDevelopment,
  JWT_SECRET: fromEnv('JWT_SECRET', LEGACY_JWT_SECRET),
  JWT_REFRESH_SECRET: fromEnv('JWT_REFRESH_SECRET', LEGACY_JWT_REFRESH_SECRET),
  JWT_ISSUER: 'mysawari',
  JWT_AUDIENCE: 'mysawari-customer-app',
};
