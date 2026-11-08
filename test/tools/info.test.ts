/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { startStack, PROJECT, type Stack } from './helpers.js';

/**
 * Regression (chunk 6): `bridge_info` used to call getProject and listMembers with `{ path: … }`, which the registry
 * rejects, so it always reported an unknown role and no project name.
 */
let stack: Stack;
let client: Client;
// The client sends a trailing slash; match with or without it.
const isProject = (p: string) => p.replace(/\/$/, '').endsWith(`/projects/${PROJECT}`);
const isMembers = (p: string) => p.replace(/\/$/, '').endsWith(`/projects/${PROJECT}/members`);
let members: { id: string; email?: string }[] = [{ id: 'u1', email: 'owner@example.test' }];

beforeAll(async () => {
  stack = await startStack({
    respond: (req) => {
      if (req.method !== 'GET') return undefined;
      if (isProject(req.path)) return { status: 200, body: { id: PROJECT, name: 'Baisheng' } };
      if (isMembers(req.path)) return { status: 200, body: { data: members } };
      return undefined;
    },
  });
  client = await stack.connect();
});
afterAll(() => stack.close());

describe('bridge_info', () => {
  it('reports the project name and the key role that LegendKeeper returns', async () => {
    const info = await stack.call(client, 'bridge_info');
    expect(info.body.project).toEqual({ id: PROJECT, name: 'Baisheng' });
    expect(info.body.key.role).toBe('ADMIN'); // member emails are visible to ADMIN keys only
    expect(info.body.key.note).toMatch(/inferred from listMembers/);
    const reads = stack.mock.calls.filter((c) => c.method === 'GET');
    expect(reads.some((c) => isProject(c.path))).toBe(true);
    expect(reads.some((c) => isMembers(c.path))).toBe(true);
    expect(stack.mock.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('reports MEMBER when emails are hidden (a fresh bridge, so the cache is not hit)', async () => {
    members = [{ id: 'u1' }];
    const s2 = await startStack({
      respond: (req) =>
        isProject(req.path)
          ? { status: 200, body: { id: PROJECT, name: 'Sandbox' } }
          : isMembers(req.path)
            ? { status: 200, body: { data: members } }
            : undefined,
    });
    try {
      const c2 = await s2.connect();
      const info = await s2.call(c2, 'bridge_info');
      expect(info.body.project.name).toBe('Sandbox');
      expect(info.body.key.role).toBe('MEMBER');
    } finally {
      await s2.close();
    }
  });
});
