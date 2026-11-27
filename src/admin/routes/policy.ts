import * as z from 'zod';
import { PROFILE_KINDS, PROPOSAL_STATES, SCOPES } from '../../policy/index.js';
import { redactDeep } from '../redact.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { csv, idSchema, limitSchema, parseInput, projectParam, type Register } from './util.js';

const scope = z.enum(SCOPES);

/** v3 F5a (ADR 0067, H4): the most proposals one decision over a filter takes. */
const MATCH_MAX = 2000;

/** v3 F5a (H4): the Proposals page's filters: state (or group), tool, principal and age. */
const filterQuery = {
  state: csv.optional(),
  group: z.enum(['pending', 'conflicted', 'history']).optional(),
  tool: z.string().min(1).max(100).optional(),
  principalId: idSchema.optional(),
  /** Only proposals at least this many hours old. */
  olderThanHours: z.coerce
    .number()
    .min(0)
    .max(24 * 365)
    .optional(),
};

const GROUPS: Record<string, readonly (typeof PROPOSAL_STATES)[number][]> = {
  pending: ['pending'],
  conflicted: ['conflicted'],
  history: ['approved', 'executing', 'executed', 'rejected', 'expired', 'failed'],
};

export const registerPolicy: Register = (api, ctx) => {
  const { policy } = ctx.deps.runtime;
  /** v3 F5a (H4): a filter (state or group, tool, principal, age) as the proposal list reads it. */
  const matchingFilter = (
    projectId: string,
    q: {
      state?: string[] | undefined;
      group?: string | undefined;
      tool?: string | undefined;
      principalId?: string | undefined;
      olderThanHours?: number | undefined;
    },
  ) => {
    const states = q.state?.length
      ? q.state.filter((s): s is (typeof PROPOSAL_STATES)[number] =>
          (PROPOSAL_STATES as readonly string[]).includes(s),
        )
      : q.group
        ? GROUPS[q.group]
        : undefined;
    return {
      project: projectId,
      ...(states ? { state: states } : {}),
      ...(q.principalId ? { principalId: q.principalId } : {}),
      ...(q.tool ? { tool: q.tool } : {}),
      ...(q.olderThanHours !== undefined ? { before: ctx.now() - q.olderThanHours * 3_600_000 } : {}),
    };
  };
  const { actions } = ctx;
  const cmd = policy.commands;
  // ADR 0081 (the owner, 26 November 2026): approving a proposal never asks for a fresh code (a code at sign-in is
  // enough); the session, Origin and CSRF checks of every change still apply. The guarded approval's judgment is gone.

  // ---------------------------------------------------------------------------------------------- proposals

  api.get('/proposals', (req) => {
    const q = parseInput(
      z.object({
        profile: idSchema.optional(),
        before: z.coerce.number().int().optional(),
        ...filterQuery,
        limit: limitSchema(50, 200),
        project: projectParam,
      }),
      req.query,
    );
    const project = ctx.project(q.project);
    const filter = matchingFilter(project.id, q);
    const proposals = cmd.listProposals('owner', {
      ...filter,
      ...(q.profile ? { profile: q.profile } : {}),
      ...(q.before !== undefined
        ? { before: filter.before !== undefined ? Math.min(filter.before, q.before) : q.before }
        : {}),
      limit: q.limit,
    });
    // v3 F5a (ADR 0067, H4): how many the filter matches in all (for "select all matching", across pages).
    const total = cmd.listProposals('owner', {
      ...filter,
      ...(q.profile ? { profile: q.profile } : {}),
      limit: MATCH_MAX + 1,
    }).length;
    return {
      project,
      proposals: redactDeep(proposals),
      hasMore: proposals.length === q.limit,
      total: Math.min(total, MATCH_MAX),
      totalCapped: total > MATCH_MAX,
      principals: ctx.principals(proposals.map((p) => p.principalId)),
    };
  });

  /**
   * v3 F5a (ADR 0067, H4): one decision over EVERY proposal the filter matches, across pages: "Reject all conflicted",
   * or a select-all of a filtered list. `expect` is the count the owner confirmed: the request is refused with
   * `PROPOSALS_CHANGED` (409) when the set changed in the meantime. Rejecting and approving each take one
   * confirmation (ADR 0081: no fresh code). Each is decided on its own, in order, and
   * a proposal whose job is running is never touched; the results list each one.
   */
  api.post('/proposals/bulk-matching', async (req) => {
    const b = parseInput(
      z
        .object({
          action: z.enum(['approve', 'reject']),
          filter: z.object(filterQuery).strict(),
          expect: z.number().int().min(1).max(MATCH_MAX),
          reason: z.string().max(1000).optional(),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const filter = matchingFilter(project.id, b.filter);
    const states = Array.isArray(filter.state) ? filter.state : filter.state ? [filter.state] : [];
    if (states.length === 0 || states.some((s) => s !== 'pending' && s !== 'conflicted'))
      throw new AdminHttpError(
        400,
        'INVALID_INPUT',
        'A decision over a filter takes pending or conflicted proposals only (filter.group or filter.state).',
      );
    if (b.action === 'approve' && states.some((s) => s !== 'pending'))
      throw new AdminHttpError(400, 'INVALID_INPUT', 'Only pending proposals can be approved.');
    const ids = cmd.listProposals('owner', { ...filter, limit: MATCH_MAX + 1 }).map((p) => p.id);
    if (ids.length > MATCH_MAX)
      throw new AdminHttpError(400, 'TOO_MANY', `More than ${MATCH_MAX} proposals match: narrow the filter.`);
    if (ids.length !== b.expect)
      throw new AdminHttpError(
        409,
        'PROPOSALS_CHANGED',
        `The filter now matches ${ids.length} proposal${ids.length === 1 ? '' : 's'}, not the ${b.expect} you confirmed: look again.`,
        { details: { now: ids.length } },
      );
    const results =
      b.action === 'approve'
        ? await actions.bulkApprove(project.id, ids)
        : actions.bulkReject(project.id, ids, b.reason);
    return { results };
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
    const proposal = actions.getProposal(project.id, id);
    return {
      proposal: redactDeep(proposal, {
        maxString: 200_000,
        maxItems: 5000,
        maxKeys: 1000,
        maxDepth: 64,
      }),
      principals: ctx.principals([proposal.principalId]),
    };
  });

  /**
   * v3 F3d (ADR 0058): `items`, the owner's selection of a proposal made of items ("Approve selected"): it must be
   * closed (409 SELECTION_NOT_CLOSED names what else it would drop), and needs exactly what approving the whole proposal
   * would (an ordinary one nothing more; a canonical one only "Approve and accept as canon").
   */
  const itemsBody = z.object({ items: z.array(z.string().min(1).max(300)).min(1).max(2000).optional() });

  api.post('/proposals/:id/approve', async (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(itemsBody, req.body ?? {});
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { proposal: redactDeep(await actions.approve(project.id, id, b.items)) };
  });

  /**
   * v2 C2a (ADR 0032): the only approval of a proposal that makes a protected canonical change. A separate action, with
   * its own confirmation in the body; audited as `proposal.approve_as_canon`, with who accepted it as canon. v3 F3d:
   * `items` approves a selection (audited `proposal.approve_selected_as_canon`).
   */
  api.post('/proposals/:id/approve-as-canon', async (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(itemsBody.extend({ confirm: z.literal(true) }), req.body);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { proposal: redactDeep(await actions.approveAsCanon(project.id, id, b.items)) };
  });

  /**
   * v3 F3d (ADR 0058): "Propose these again": the items left out of an approved proposal, as a new proposal for the
   * owner (by the bridge, as "Propose a fix" is), captured afresh. Audited `proposal.repropose`.
   */
  api.post('/proposals/:id/repropose', async (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { repropose: await actions.reproposeOmitted(project.id, id) };
  });

  api.post('/proposals/:id/reject', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(z.object({ reason: z.string().max(1000).optional() }), req.body);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { proposal: redactDeep(actions.reject(project.id, id, b.reason)) };
  });

  /**
   * Bulk decisions, at most 100 ids. `approve` skips canonical proposals (reported as skipped); `approve-as-canon` is the
   * bulk "Approve and accept as canon" and, like the single route, needs `confirm: true`. Each id is decided on its own,
   * one at a time, in order.
   */
  api.post('/proposals/bulk', async (req) => {
    // v3 F5a (H4): a selection may span pages (select all on every page): at most 1,000 at once.
    const ids = z.array(idSchema).min(1).max(1000);
    const b = parseInput(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('approve'), ids }),
        z.object({ action: z.literal('reject'), ids, reason: z.string().max(1000).optional() }),
        z.object({ action: z.literal('approve-as-canon'), ids, confirm: z.literal(true) }),
      ]),
      req.body,
    );
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const results =
      b.action === 'approve'
        ? await actions.bulkApprove(project.id, b.ids)
        : b.action === 'approve-as-canon'
          ? await actions.bulkApproveAsCanon(project.id, b.ids)
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
    // Hotfix (ADR 0033): the connection settings, in days (0 = never).
    settings: {
      autoRemoveDays: cmd.getAutoRemoveDays('owner'),
      staleAfterDays: cmd.getStaleAfterDays('owner'),
    },
  }));

  api.post('/clients/profiles', (req) => {
    // ADR 0081: a profile holds its connections' scope: making one asks for a fresh code (whether a scope is given or
    // the default is taken).
    requireReauth(ctx.deps.services, req);
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
    // ADR 0081: a profile's scope is every one of its connections' scope: any change, a raise or a lowering, asks.
    requireReauth(ctx.deps.services, req);
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(z.object({ scope, confirmRaise: z.boolean().default(false) }), req.body);
    return { profile: actions.setScope(id, b.scope, b.confirmRaise) };
  });

  /** v2 B2: whether the profile's connections are shown the low-level tools (hiding is cosmetic; policy is unchanged). */
  api.put('/clients/profiles/:id/low-level-tools', (req) => {
    // ADR 0081: no fresh code (what the tool list shows, not what a connection may do).
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(z.object({ show: z.boolean() }), req.body);
    return { profile: actions.setShowLowLevelTools(id, b.show) };
  });

  api.put('/clients/default-scope', (req) => {
    // ADR 0081: the scope new connections start at: any change asks for a fresh code.
    requireReauth(ctx.deps.services, req);
    const b = parseInput(z.object({ scope, confirmRaise: z.boolean().default(false) }), req.body);
    return { defaultScope: actions.setDefaultScope(b.scope, b.confirmRaise) };
  });

  api.put('/clients/connections/:id/profile', (req) => {
    // ADR 0081: moving a connection to another profile changes what it may do: any move asks for a fresh code.
    requireReauth(ctx.deps.services, req);
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(z.object({ profileId: idSchema }), req.body);
    return { connection: redactDeep(actions.setConnectionProfile(id, b.profileId)) };
  });

  // ADR 0081 (the owner listed revoking): revoking or removing a connection asks for a fresh code, as making one does.
  api.post('/clients/connections/:id/revoke', (req) => {
    requireReauth(ctx.deps.services, req);
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    return { revoked: actions.revokeConnection(id) };
  });

  // ADR 0033: removing revoked and expired connections. An active connection is refused (409 CONNECTION_ACTIVE).
  // The fixed path is registered before `:id/remove`, so `remove-inactive` is never read as an id.
  api.post('/clients/connections/remove-inactive', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0081: a revoke in bulk
    return actions.removeInactiveConnections();
  });

  api.post('/clients/connections/:id/remove', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0081
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    return { removed: actions.removeConnection(id) };
  });

  /** Revokes the stale connections of one profile (unused for `settings.staleAfterDays`). */
  api.post('/clients/connections/revoke-stale', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0081: a revoke in bulk
    const b = parseInput(z.object({ profileId: idSchema }), req.body);
    return actions.revokeStaleConnections(b.profileId);
  });

  const days = z.object({ days: z.number().int().min(0).max(3650) });
  // ADR 0081: the clean-up settings revoke nothing (they remove the records of connections already dead, or mark stale
  // ones): no fresh code.
  api.put('/clients/settings/auto-remove-days', (req) => {
    const b = parseInput(days, req.body);
    return { autoRemoveDays: actions.setAutoRemoveDays(b.days) };
  });
  api.put('/clients/settings/stale-after-days', (req) => {
    const b = parseInput(days, req.body);
    return { staleAfterDays: actions.setStaleAfterDays(b.days) };
  });

  /** The one response that carries a token value, once. Nothing stores or logs it; only its hash is kept. */
  api.post('/clients/pats', (req, reply) => {
    // R2-50, ADR 0062, ADR 0081: a new credential (a key), at any scope.
    requireReauth(ctx.deps.services, req);
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
