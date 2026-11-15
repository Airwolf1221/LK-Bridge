import * as z from 'zod';
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

/**
 * A retired tool name (v2 E3b, ADR 0045): kept registered for one release but never listed. A client that still holds
 * an old tool list and calls it gets a short, plain "renamed to …" error naming the tool that took over and how to ask
 * for the same thing there. It accepts any arguments (so the client's old call is never turned into an input-validation
 * error first), does nothing, reads nothing and costs nothing.
 */
export function renamedTool(oldName: string, newName: string, how: string): McpToolProvider {
  return {
    name: oldName,
    title: `${oldName} (renamed)`,
    description: `Renamed to ${newName}: ${how}`,
    inputSchema: z.object({}).loose(),
    annotations: READ_ANNOTATIONS,
    access: 'read',
    retired: true,
    handler: () => ({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'TOOL_RENAMED',
              message: `${oldName} was renamed to ${newName}. ${how}`,
              hint: `Nothing was done. Call ${newName} instead; your tool list is out of date (refresh the connector).`,
            },
          }),
        },
      ],
    }),
  };
}
