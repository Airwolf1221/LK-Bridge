/**
 * Chunk 6 adds no MCP tool for mappings or maintenance: both are owner-only (dashboard). The real runtime's tool list
 * is checked at the highest scope, and no MCP module may import the owner commands.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { startStack, type Stack } from '../tools/helpers.js';

let stack: Stack;
let client: Client;
beforeAll(async () => {
  stack = await startStack();
  client = await stack.connect();
});
afterAll(() => stack.close());

describe('no MCP surface for mappings or maintenance', () => {
  it('no registered tool is about them', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
    for (const t of tools) {
      expect(`${t.name} ${t.description ?? ''}`, t.name).not.toMatch(/mapping|maintenance job/i);
    }
  });

  it('no MCP module imports the maintenance or mappings code', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join('src', 'mcp'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/from '\.\.\/(\.\.\/)?(maintenance|mappings)\//);
    }
  });
});
