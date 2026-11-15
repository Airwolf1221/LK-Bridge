/**
 * v2 E4 (backlog 7): CI runs exactly the server's Node. `.nvmrc` (which CI's setup-node reads) names the version
 * deploy/install-node.sh installs by default, and both are Node 24 (package.json's engines).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const file = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('the Node version CI uses', () => {
  it('is the one the server installs, Node 24', () => {
    const nvmrc = file('.nvmrc').trim();
    const installer = /NODE_VERSION="\$\{NODE_VERSION:-(v\d+\.\d+\.\d+)\}"/.exec(
      file('deploy/install-node.sh'),
    )?.[1];
    expect(nvmrc).toBe(installer);
    expect(nvmrc).toMatch(/^v24\./);
    expect(file('.github/workflows/ci.yml')).toMatch(/node-version-file: \.nvmrc/);
    expect((JSON.parse(file('package.json')) as { engines: { node: string } }).engines.node).toBe('>=24');
  });
});
