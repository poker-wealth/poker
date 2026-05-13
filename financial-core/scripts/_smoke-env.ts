// Loaded BEFORE any FC module to set required env vars. ESM hoists imports
// above top-level statements, so this needs to be its own file.
process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'warn';
process.env.MONGO_URI ??= 'mongodb://placeholder';
process.env.MONGO_DB_NAME ??= 'smoke';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_SECRET ??= 'smoke-secret-smoke-secret-smoke-secret';
process.env.INTERNAL_API_TOKEN ??= 'smoke-internal-token-smoke-internal-token';
