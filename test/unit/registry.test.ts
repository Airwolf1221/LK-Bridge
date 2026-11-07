import { describe, expect, it } from 'vitest';
import { getOperation, operationInputSchema, operations, requireOperation } from '../../src/lk/registry.js';

describe('operation registry', () => {
  it('has all 89 operations with unique ids', () => {
    expect(operations).toHaveLength(89);
    expect(new Set(operations.map((o) => o.operationId)).size).toBe(89);
  });

  it('builds a zod schema for every operation', () => {
    for (const op of operations)
      expect(() => operationInputSchema(op.operationId), op.operationId).not.toThrow();
  });

  it('never exposes projectId or Idempotency-Key to callers', () => {
    for (const op of operations) {
      const props = op.inputJsonSchema.properties as Record<string, { properties?: Record<string, unknown> }>;
      expect(props.path?.properties ?? {}, op.operationId).not.toHaveProperty('projectId');
      expect(JSON.stringify(op.inputJsonSchema).toLowerCase(), op.operationId).not.toContain('idempotency');
    }
  });

  it('classifies kinds, costs and items', () => {
    expect(requireOperation('getResource')).toMatchObject({
      kind: 'read',
      concurrency: 'none',
      risk: 'safe',
    });
    expect(requireOperation('getResource').costs).not.toContain('write-min');
    const many = requireOperation('createManyResources');
    expect(many.itemsFrom).toBe('body.resources');
    expect(many.costs).toEqual(expect.arrayContaining(['write-min', 'items-min', 'items-hour']));
    expect(requireOperation('createImageUpload')).toMatchObject({ kind: 'upload' });
    expect(requireOperation('createImageUpload').costs).toContain('upload');
    expect(operations.filter((o) => o.itemsFrom)).toHaveLength(1);
  });

  it('flags versioned operations (those that accept If-Match)', () => {
    for (const id of [
      'replaceDocumentBlocks',
      'insertBlock',
      'replaceBoardContent',
      'updateCalendar',
      'deleteCalendar',
    ]) {
      expect(requireOperation(id).versioned, id).toBe(true);
    }
    expect(requireOperation('getDocumentBlocks').versioned).toBe(false);
    expect(requireOperation('updateResource').versioned).toBe(false);
  });

  it('assigns locks: document for content writes, resource for resource writes', () => {
    expect(requireOperation('replaceDocumentBlocks').concurrency).toBe('document');
    expect(requireOperation('createBlockRow').concurrency).toBe('document');
    expect(requireOperation('createEvent').concurrency).toBe('document');
    expect(requireOperation('moveResource').concurrency).toBe('resource');
    expect(requireOperation('updateProperty').concurrency).toBe('resource');
    expect(requireOperation('createResource').concurrency).toBe('none');
    expect(requireOperation('getDocumentBlocks').concurrency).toBe('none');
  });

  it('assigns risk levels', () => {
    for (const id of ['inviteMember', 'removeMember', 'revokeInvite'])
      expect(requireOperation(id).risk).toBe('admin');
    for (const id of [
      'deleteResource',
      'replaceDocumentBlocks',
      'replaceBoardContent',
      'updateCalendar',
      'deleteBoardShapes',
    ]) {
      expect(requireOperation(id).risk, id).toBe('destructive');
    }
    expect(requireOperation('listMembers').risk).toBe('safe');
  });

  it('marks paged operations', () => {
    expect(requireOperation('listResources').paged).toBe(true);
    expect(requireOperation('listEvents').paged).toBe(true);
    expect(requireOperation('search').paged).toBe(false);
  });

  it('validates input through the generated schema', () => {
    const schema = operationInputSchema('getResource');
    expect(schema.safeParse({ path: { resourceId: 'abc' } }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    const many = operationInputSchema('createManyResources');
    expect(many.safeParse({ body: { resources: 'nope' } }).success).toBe(false);
  });

  it('looks operations up', () => {
    expect(getOperation('nope')).toBeUndefined();
    expect(() => requireOperation('nope')).toThrow(/Unknown/);
  });
});
