import type * as z from 'zod';
import type { McpToolProvider } from '../server.js';

/**
 * Types a tool with its own input schema and widens it to the registry's `McpToolProvider`. The `access` tag is
 * required here (it is optional on the shared type, because chunk 4's stub and test tools predate it).
 */
export function defineTool<S extends z.ZodObject>(
  tool: McpToolProvider<S> & { readonly access: 'read' | 'write' },
): McpToolProvider {
  return tool;
}

export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
