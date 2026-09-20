const isProduction = process.env.NODE_ENV === 'production';

// Legacy defaults. They must stay identical to what the API used before, otherwise
// tokens already issued to users stop verifying and everyone gets logged out.
const LEGACY_JWT_SECRET = 'mysawari_super_secret_key_123!';
const LEGACY_JWT_REFRESH_SECRET = 'mysawari_refresh_super_secret_key_123!';

const fromEnv = (name, legacyFallback) => {
  const value = process.env[name];
  if (value) return value;
  console.warn(
    `⚠️  ${name} is not set — falling back to the built-in default.` +
      (isProduction ? ' Set it in production (changing it will sign everyone out once).' : '')
  );
  return legacyFallback;
};

module.exports = {
  isProduction,
  JWT_SECRET: fromEnv('JWT_SECRET', LEGACY_JWT_SECRET),
  JWT_REFRESH_SECRET: fromEnv('JWT_REFRESH_SECRET', LEGACY_JWT_REFRESH_SECRET),
  JWT_ISSUER: 'mysawari',
  JWT_AUDIENCE: 'mysawari-customer-app',
};
