/** Public surface of `src/secrets` (OPS2, ADR 0028): the encrypted secret store. */
export {
  MASTER_KEY_MISSING,
  OWNER_SCOPE,
  SecretStore,
  SecretStoreError,
  openSecretStore,
  type ReadResult,
  type SecretKeys,
  type SecretMeta,
  type SecretPurpose,
  type SecretSource,
  type SecretStoreState,
  type UnreadableReason,
} from './store.js';
export { MIN_MASTER_KEY_LENGTH, deriveMasterKey, envValueDigest, keyHint } from './crypto.js';
