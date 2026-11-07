/** Public surface of the auth module (chunk 4). The dashboard (chunk 5) builds on these. */
export { authPlugin, type AuthPluginOptions } from './plugin.js';
export { createAuthServices, type AuthServices, type CreateAuthServicesOptions } from './services.js';
export { BearerGuard, type BearerResult, type CallerIdentity } from './bearer.js';
export { PatService, PAT_PREFIX, type CreatedPat, type PatView } from './pats.js';
export { OwnerAuth, DEFAULT_LOGIN_LIMITS, type LoginLimits } from './owner.js';
export { AuthStore, type ClientRecord, type FamilyRecord, type AccessRecord } from './store.js';
export { hashPassword, verifyPassword } from './password.js';
export { authorizationServerMetadata, protectedResourceMetadata, OAUTH_PATHS } from './routes/metadata.js';
export { canonicaliseResource } from './url.js';
export { createSafeJsonFetcher, type JsonFetcher, type SafeFetchOptions } from './safe-fetch.js';
