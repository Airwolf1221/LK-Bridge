import * as z from 'zod';
import { PROFILE_KINDS, PROPOSAL_STATES, SCOPES } from '../../policy/index.js';
import { redactDeep } from '../redact.js';
import { csv, idSchema, limitSchema, parseInput, projectParam, type Register } from './util.js';

const scope = z.enum(SCOPES);

export const registerPolicy: Register = (api, ctx) => {
  const { policy } = ctx.deps.runtime;
  const { actions } = ctx;
  const cmd = policy.commands;

  // ---------------------------------------------------------------------------------------------- proposals

  api.get('/proposals', (req) => {
    const q = parseInput(
      z.object({
        state: csv.optional(),
        group: z.enum(['pending', 'conflicted', 'history']).optional(),
        principalId: idSchema.optional(),
        profile: idSchema.optional(),
        before: z.coerce.number().int().optional(),
        limit: limitSchema(50, 200),
        project: projectParam,
      }),
      req.query,
    );
    const project = ctx.project(q.project);
    const groups: Record<string, readonly (typeof PROPOSAL_STATES)[number][]> = {
      pending: ['pending'],
      conflicted: ['conflicted'],
      history: ['approved', 'executing', 'executed', 'rejected', 'expired', 'failed'],
    };
    const states = q.state?.length
      ? q.state.filter((s): s is (typeof PROPOSAL_STATES)[number] =>
          (PROPOSAL_STATES as readonly string[]).includes(s),
        )
      : q.group
        ? groups[q.group]
        : undefined;
    const proposals = cmd.listProposals('owner', {
      project: project.id,
      ...(states ? { state: states } : {}),
      ...(q.principalId ? { principalId: q.principalId } : {}),
      ...(q.profile ? { profile: q.profile } : {}),
      ...(q.before !== undefined ? { before: q.before } : {}),
      limit: q.limit,
    });
    return { project, proposals: redactDeep(proposals), hasMore: proposals.length === q.limit };
  });

  const projectQuery = z.object({ project: projectParam });

  /** Proposal counts by state, for the page's tabs; `byProject` holds every project's pending count (v2 A1). */
  api.get('/proposals/counts', (req) => {
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const counts: Record<string, number> = {};
    for (const state of PROPOSAL_STATES) {
      counts[state] = cmd.listProposals('owner', { project: project.id, state, limit: 500 }).length;
    }
    const byProject: Record<string, number> = {};
    for (const p of ctx.deps.runtime.projects.list()) {
      if (p.id) {
        byProject[p.name] = cmd.listProposals('owner', {
          project: p.id,
          state: 'pending',
          limit: 500,
        }).length;
      }
    }
    return { project, counts, byProject };
  });

  api.get('/proposals/:id', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    // Block trees and pre-states can be large; the diff view needs them whole, so only secrets are removed here.
    return {
      proposal: redactDeep(actions.getProposal(project.id, id), {
        maxString: 200_000,
        maxItems: 5000,
        maxKeys: 1000,
        maxDepth: 64,
      }),
    };
  });

  api.post('/proposals/:id/approve', async (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { proposal: redactDeep(await actions.approve(project.id, id)) };
  });

  api.post('/proposals/:id/reject', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(z.object({ reason: z.string().max(1000).optional() }), req.body);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { proposal: redactDeep(actions.reject(project.id, id, b.reason)) };
  });

  api.post('/proposals/bulk', async (req) => {
    const b = parseInput(
      z.object({
        action: z.enum(['approve', 'reject']),
        ids: z.array(idSchema).min(1).max(100),
        reason: z.string().max(1000).optional(),
      }),
      req.body,
    );
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const results =
      b.action === 'approve'
        ? await actions.bulkApprove(project.id, b.ids)
        : actions.bulkReject(project.id, b.ids, b.reason);
    return { results };
  });

  // --------------------------------------------------------------------------------------- clients & access

  /** Profiles, the default scope, and grants and PATs (each with its profile, last use and expiry). */
  api.get('/clients', () => ({
    profiles: cmd.listProfiles('owner'),
    defaultScope: cmd.getDefaultScope('owner'),
    connections: redactDeep(cmd.listGrantsAndPats('owner')),
    kinds: PROFILE_KINDS,
    scopes: SCOPES,
  }));

  api.post('/clients/profiles', (req) => {
    const b = parseInput(
      z.object({ label: z.string().min(1).max(64), kind: z.enum(PROFILE_KINDS), scope: scope.optional() }),
      req.body,
    );
    return {
      profile: actions.createProfile({
        label: b.label,
        kind: b.kind,
        ...(b.scope ? { scope: b.scope } : {}),
      }),
    };
  });

  api.put('/clients/profiles/:id/scope', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(z.object({ scope, confirmRaise: z.boolean().default(false) }), req.body);
    return { profile: actions.setScope(id, b.scope, b.confirmRaise) };
  });

  /** v2 B2: whether the profile's connections are shown the low-level tools (hiding is cosmetic; policy is unchanged). */
  api.put('/clients/profiles/:id/low-level-tools', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(z.object({ show: z.boolean() }), req.body);
    return { profile: actions.setShowLowLevelTools(id, b.show) };
  });

  api.put('/clients/default-scope', (req) => {
    const b = parseInput(z.object({ scope, confirmRaise: z.boolean().default(false) }), req.body);
    return { defaultScope: actions.setDefaultScope(b.scope, b.confirmRaise) };
  });

  api.put('/clients/connections/:id/profile', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(z.object({ profileId: idSchema }), req.body);
    return { connection: redactDeep(actions.setConnectionProfile(id, b.profileId)) };
  });

  api.post('/clients/connections/:id/revoke', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    return { revoked: actions.revokeConnection(id) };
  });

  /** The one response that carries a token value, once. Nothing stores or logs it; only its hash is kept. */
  api.post('/clients/pats', (req, reply) => {
    const b = parseInput(
      z.object({
        name: z.string().min(1).max(100),
        profileId: idSchema,
        expiresInDays: z.number().int().min(1).max(3650).optional(),
      }),
      req.body,
    );
    const created = actions.createPat({
      name: b.name,
      profileId: b.profileId,
      ...(b.expiresInDays !== undefined ? { expiresInDays: b.expiresInDays } : {}),
    });
    return reply.code(201).send({ token: created.token, pat: created.pat, shownOnce: true });
  });
};
