import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operations } from '../../src/lk/index.js';
import { discoverWorld, type DiscoverWorld } from './world.js';

let w: DiscoverWorld;
beforeAll(async () => {
  w = await discoverWorld({ bulk: 20, env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' } });
});
afterAll(() => w.close());

const LOW = ['lk_api_list_operations', 'lk_api_describe_operation', 'lk_api_paginate_all'];
// v2 E3b (ADR 0045, P4 and P5): two rarely used tools, hidden by the same setting.
const RARE = ['lk_upload_image', 'create_bare_resource'];
const list = async (token: string) =>
  (await (await w.stack.connect(token)).listTools()).tools.map((t) => t.name).sort();

describe('showLowLevelTools, per profile', () => {
  it('is off by default: the low-level tools and every lk_op_* are hidden, the fallback stays', async () => {
    const names = await list(w.stack.token);
    for (const n of [...LOW, ...RARE]) expect(names, n).not.toContain(n);
    expect(names.filter((n) => n.startsWith('lk_op_'))).toEqual([]);
    for (const n of ['lk_api_read', 'lk_api_write', 'lk_api_batch']) expect(names, n).toContain(n);
    for (const n of ['browse_repository_tree', 'search', 'read_document', 'get_resource', 'get_bridge_guide'])
      expect(names, n).toContain(n);
    // The final list with the setting off (documented in docs/tools.md).
    // CR-2026-11-R4 (LD-01): the 12 consistency and narrative tools are listed only while the APPROVED pack version
    // carries their rules; this world attaches the pack without approving it, so they are not listed (they refused).
    expect(names).toEqual(
      [
        'bridge_budget',
        'bridge_errors_recent',
        'bridge_estimate',
        'bridge_info',
        'bridge_job_cancel',
        'bridge_job_status',
        'bridge_journal_lookup',
        'bridge_proposal_status',
        'bridge_result_page',
        'browse_asset_tree',
        'browse_repository_tree',
        'get_bridge_guide',
        'get_markdown_guide',
        'get_resource',
        'list_assets',
        'list_calendars',
        'list_projects',
        'list_tags',
        'list_templates',
        'lk_api_batch',
        'lk_api_read',
        'lk_api_write',
        'read_document',
        'search',
        'set_facts',
        'write_page',
        // v2 C2b: the Resources, Documents and character tools
        'create_character',
        'arkona_create_character',
        // v3 F3b: the Arkona pack's owner, relationship, art and brief tools
        'arkona_create_owner',
        'arkona_create_relationship',
        'arkona_add_character_art',
        'arkona_character_brief',
        // v3 F3c: the Arkona pack's appraisal tools
        'arkona_appraise_owner',
        'arkona_change_impact',
        'arkona_working_digest',
        'arkona_visual_hygiene',
        'arkona_appraisal_fix',
        // v3 F3d: the Arkona pack's rename, and resuming a job that stopped part-way
        'arkona_rename',
        // v3 F3e (ADR 0059): the split tools.
        'arkona_split_appraisal',
        'arkona_split_owner',
        // v3 F3f (ADR 0060): the retag tools.
        'arkona_retag_audit',
        'arkona_retag_apply',
        // v3 F4a (ADR 0063): the name check and the topic brief.
        'arkona_name_check',
        'arkona_brief',
        // v3 F4b's and F4c's tools: not listed here (the pack is not approved; CR-2026-11-R4, LD-01).
        'bridge_job_resume',
        'create_document',
        'create_index',
        'create_many_resources',
        'create_resource',
        'delete_document',
        'delete_resource',
        'move_resource',
        'restore_resource',
        'update_document',
        'update_resource',
        // v2 C2c: the page lifecycle
        'archive_page',
        'move_to_working',
        'promote_page',
        'unarchive_page',
        // v2 D1: the calendar and the timelines
        'calendar_date',
        'create_timeline_event',
        'update_timeline_event',
        'delete_timeline_event',
        'sync_timeline_event',
        'create_timeline_lane',
        // v2 D2: the map-feature tools
        'create_map_feature',
        'update_map_feature',
        'delete_map_feature',
        // v2 D3: the image pipeline
        'prepare_image_upload',
        'upload_image',
        // v2 E1a: snapshots and restores
        'list_snapshots',
        'snapshot_diff',
        'restore_snapshot',
        // v2 E2: the audits' findings
        'audit_findings',
      ].sort(),
    );
  });

  it('is per profile and takes effect on the next tools/list, with an audit row', async () => {
    const a = w.stack.newToken('shows-low', 'write');
    const b = w.stack.newToken('hides-low', 'write');
    expect(await list(a.token)).not.toContain('lk_api_describe_operation');
    const before = w.stack.policy.store.listAudit({ action: 'profile.set_low_level_tools' }).length;
    w.stack.policy.commands.setShowLowLevelTools('owner', a.profileId, true);
    expect(w.stack.policy.store.listAudit({ action: 'profile.set_low_level_tools' })).toHaveLength(
      before + 1,
    );
    const withLow = await list(a.token);
    for (const n of [...LOW, ...RARE]) expect(withLow, n).toContain(n);
    expect(withLow.filter((n) => n.startsWith('lk_op_'))).toHaveLength(operations.length);
    // Another profile is untouched.
    expect(await list(b.token)).not.toContain('lk_api_describe_operation');
    expect(await list(w.stack.token)).not.toContain('lk_api_paginate_all');
    // And back.
    w.stack.policy.commands.setShowLowLevelTools('owner', a.profileId, false);
    expect(await list(a.token)).not.toContain('lk_api_list_operations');
  });

  it('shows 86 tools off and 86 + 3 + 2 + 89 on', async () => {
    const t = w.stack.newToken('counting', 'write');
    // 61 before v2 E3b; get_resources, bridge_proposals_mine and bridge_job_wait were merged (-3) and lk_upload_image and
    // create_bare_resource are hidden by default (-2); v3 F3b's four pack tools (+4); v3 F3c's five appraisal tools (+5);
    // v3 F3d's bridge_job_resume and arkona_rename (+2); v3 F3e's arkona_split_appraisal and arkona_split_owner (+2);
    // v3 F3f's arkona_retag_audit and arkona_retag_apply (+2); v3 F4a's arkona_name_check and arkona_brief (+2); v3 F4b's four consistency tools (+4).
    // CR-2026-11-R4 (LD-01): the 12 consistency and narrative tools are not listed while the pack is not approved.
    expect(await list(t.token)).toHaveLength(86 - 12);
    w.stack.policy.commands.setShowLowLevelTools('owner', t.profileId, true);
    expect(await list(t.token)).toHaveLength(86 - 12 + 3 + 2 + operations.length);
  });

  it('leaves call-time enforcement exactly as it was: a hidden tool is still allowed or refused by policy', async () => {
    // read scope: the hidden read tools still work, the hidden write tools are refused as read-only.
    const reader = w.stack.newToken('hidden-reader', 'read');
    const rc = await w.stack.connect(reader.token);
    const describe = await w.stack.call(rc, 'lk_api_describe_operation', { operationId: 'getResource' });
    expect(describe.isError, describe.text).toBe(false);
    const list = await w.stack.call(rc, 'lk_api_list_operations', { kind: 'read' });
    expect(list.isError).toBe(false);
    const write = await rc.callTool({
      name: 'lk_op_updateResource',
      arguments: { path: { resourceId: 'kaede001' }, body: { name: 'x' } },
    });
    expect(write.isError).toBe(true);
    expect((write.content[0] as { text: string }).text).toMatch(/read-only/);
    // propose scope: a hidden write tool is captured as a proposal, nothing is sent.
    const proposer = w.stack.newToken('hidden-proposer', 'propose');
    const pc = await w.stack.connect(proposer.token);
    const writesBefore = w.stack.mock.calls.filter((x) => x.method !== 'GET').length;
    const prop = await w.stack.call(pc, 'lk_op_updateResource', {
      path: { resourceId: 'kaede001' },
      body: { name: 'x' },
    });
    expect(prop.body.status).toBe('proposal_captured');
    expect(w.stack.mock.calls.filter((x) => x.method !== 'GET').length).toBe(writesBefore);
    // write scope: it runs, with the caller's principal.
    const writer = w.stack.newToken('hidden-writer', 'write');
    const wc = await w.stack.connect(writer.token);
    const done = await w.stack.call(wc, 'lk_op_getResource', { path: { resourceId: 'kaede001' } });
    expect(done.body.status).toBe('succeeded');
    // Showing the tools changes none of that: the same refusal for the same read-only profile.
    w.stack.policy.commands.setShowLowLevelTools('owner', reader.profileId, true);
    const again = await rc.callTool({
      name: 'lk_op_updateResource',
      arguments: { path: { resourceId: 'kaede001' }, body: { name: 'x' } },
    });
    expect(again.isError).toBe(true);
    expect((again.content[0] as { text: string }).text).toMatch(/read-only/);
    const names = (await rc.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('lk_op_updateResource'); // read scope never lists write tools
    expect(names).toContain('lk_op_getResource'); // …but lists the read ones once shown
  });
});
