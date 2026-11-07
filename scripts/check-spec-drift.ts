/**
 * CI drift check (PLAN §4). Fails when:
 *  1. the installed SDK's openapi.json has operations the registry lacks (or the reverse);
 *  2. the vendored spec differs from the SDK's copy (re-vendor and regenerate); or
 *  3. the generated registry files are stale relative to the vendored spec.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operations } from '../src/lk/registry.generated.js';
import { DEFS_PATH, generate, REGISTRY_PATH, SPEC_PATH } from './gen-registry.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkSpecPath = resolve(root, 'node_modules/@legendkeeper/sdk/openapi.json');
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const problems: string[] = [];

if (!existsSync(sdkSpecPath)) {
  console.error(`SDK spec not found at ${sdkSpecPath}. Run npm ci first.`);
  process.exit(2);
}
const sdkText = readFileSync(sdkSpecPath, 'utf8');
const vendoredText = readFileSync(SPEC_PATH, 'utf8');

const sdkSpec = JSON.parse(sdkText) as { paths: Record<string, Record<string, { operationId?: string }>> };
const sdkIds = new Set<string>();
for (const item of Object.values(sdkSpec.paths)) {
  for (const m of METHODS) {
    const id = item[m]?.operationId;
    if (id) sdkIds.add(id);
  }
}
const registryIds = new Set(operations.map((o) => o.operationId));

for (const id of sdkIds) if (!registryIds.has(id)) problems.push(`SDK has operation not in registry: ${id}`);
for (const id of registryIds) if (!sdkIds.has(id)) problems.push(`Registry has operation not in SDK: ${id}`);
if (sha(sdkText) !== sha(vendoredText)) {
  problems.push(
    'spec/legendkeeper-openapi.json differs from the installed SDK spec: copy it over and run npm run gen:registry',
  );
}
const expected = generate(vendoredText);
if (
  readFileSync(REGISTRY_PATH, 'utf8') !== expected.registry ||
  readFileSync(DEFS_PATH, 'utf8') !== expected.defs
) {
  problems.push('Generated registry files are stale: run npm run gen:registry');
}

if (problems.length > 0) {
  console.error('Spec drift detected:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log(`No drift: ${registryIds.size} operations, SDK spec and vendored spec identical.`);
