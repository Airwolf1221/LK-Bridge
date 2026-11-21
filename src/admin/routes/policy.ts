import type { FastifyRequest } from 'fastify';
import * as z from 'zod';
import { PROFILE_KINDS, PROPOSAL_STATES, SCOPES, type Scope } from '../../policy/index.js';
import { redactDeep } from '../redact.js';
import { hasStepUp, requireReauth } from '../guard.js';
import { csv, idSchema, limitSchema, parseInput, projectParam, type Register } from './util.js';

const scope = z.enum(SCOPES);

/**
 * The order of the scopes, for telling a raise from a lowering. ADR 0062 (the owner's rule, 19 November 2026): tightening
 * is one click, loosening asks for the step-up.
 */
const SCOPE_RANK: Readonly<Record<Scope, number>> = { read: 0, propose: 1, write: 2 };

export const registerPolicy: Register = (api, ctx) => {
  const { policy } = ctx.deps.runtime;
  const { actions } = ctx;
  const cmd = policy.commands;
  const profileScope = (id: string): Scope | undefined =>
    cmd.listProfiles('owner').find((p) => p.id === id)?.scope;
  /**
   * ADR 0062: approving a proposal of the owner's guarded kinds (a delete, more than 10 pages, an asset delete or move)
   * needs the step-up; judged on the whole proposal (whatever is selected), every proposal of a bulk approval, by
   * `LivePolicyGate.approvalVerdict`: CR-2026-11-R4, the rail that made it a proposal (its recorded reason) and its
   * operations with the removals through a low-level tool (its recorded tool) and member administration's removals
   * counted. A session that has stepped up within the window is not judged (nothing is read).
   */
  const stepUpIfGuarded = async (req: FastifyRequest, ids: readonly string[]) => {
    if (hasStepUp(ctx.deps.services, req)) return;
    for (const id of ids) {
      const d = policy.proposals.detail(id);
      if (!d) continue;
      const items = d.ops.map((o) => ({
        opId: o.op,
        kind: o.opKind,
        params: o.params ?? {},
        options: o.options ?? {},
      }));
      const tool = policy.proposals.originOf(id)?.tool;
      const verdict = await policy.gate.approvalVerdict(d.projectId, items, {
        ...(tool !== undefined ? { tool } : {}),
        proposedBecause: d.proposedBecause,
      });
      if (verdict !== null) {
        requireReauth(ctx.deps.services, req);
        return;
      }
    }
  };

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
    return {
      project,
      proposals: redactDeep(proposals),
      hasMore: proposals.length === q.limit,
      principals: ctx.principals(proposals.map((p) => p.principalId)),
    };
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
    await stepUpIfGuarded(req, [id]);
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
    await stepUpIfGuarded(req, [id]);
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
    const ids = z.array(idSchema).min(1).max(100);
    const b = parseInput(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('approve'), ids }),
        z.object({ action: z.literal('reject'), ids, reason: z.string().max(1000).optional() }),
        z.object({ action: z.literal('approve-as-canon'), ids, confirm: z.literal(true) }),
      ]),
      req.body,
    );
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    if (b.action !== 'reject') await stepUpIfGuarded(req, b.ids);
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
    const b = parseInput(
      z.object({ label: z.string().min(1).max(64), kind: z.enum(PROFILE_KINDS), scope: scope.optional() }),
      req.body,
    );
    // ADR 0062: a scope set is a scope change: the step-up first.
    if (b.scope !== undefined) requireReauth(ctx.deps.services, req);
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
    // R2-50, ADR 0062 (the owner's rule: tightening is one click, loosening asks): a raise needs the step-up; a lowering
    // is one click.
    const current = profileScope(id);
    if (current !== undefined && SCOPE_RANK[b.scope] > SCOPE_RANK[current])
      requireReauth(ctx.deps.services, req);
    return { profile: actions.setScope(id, b.scope, b.confirmRaise) };
  });

  /** v2 B2: whether the profile's connections are shown the low-level tools (hiding is cosmetic; policy is unchanged). */
  api.put('/clients/profiles/:id/low-level-tools', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0062: a profile's settings
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(z.object({ show: z.boolean() }), req.body);
    return { profile: actions.setShowLowLevelTools(id, b.show) };
  });

  /**
   * v3 F3.4 (ADR 0055): a profile's safety rails at scope `write` (the kinds of change that still become proposals).
   * A partial change keeps the other switches. Re-authentication first (a rail switched off lets more go straight
   * through), then the owner's confirmation; audited `profile.set_rails`.
   */
  api.put('/clients/profiles/:id/rails', (req) => {
    requireReauth(ctx.deps.services, req);
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(
      z
        .object({
          rails: z
            .object({
              deletes: z.boolean().optional(),
              bulk: z.boolean().optional(),
              bulkPages: z.number().int().min(1).max(1000).optional(),
              renamesMoves: z.boolean().optional(),
              assets: z.boolean().optional(),
            })
            .strict(),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    return { profile: actions.setRails(id, b.rails) };
  });

  api.put('/clients/default-scope', (req) => {
    const b = parseInput(z.object({ scope, confirmRaise: z.boolean().default(false) }), req.body);
    // R2-50, ADR 0062: new connections would start able to do more (a raise asks; a lowering is one click).
    if (SCOPE_RANK[b.scope] > SCOPE_RANK[cmd.getDefaultScope('owner')]) requireReauth(ctx.deps.services, req);
    return { defaultScope: actions.setDefaultScope(b.scope, b.confirmRaise) };
  });

  api.put('/clients/connections/:id/profile', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const b = parseInput(z.object({ profileId: idSchema }), req.body);
    // R2-50, ADR 0062: to a higher scope, or to a profile at scope write (its rails may be weaker than the connection's
    // now), asks for the step-up; moving it down (or sideways below write) is one click.
    const from = policy.store.lookupPrincipal(id)?.scope;
    const to = profileScope(b.profileId);
    if (to !== undefined && (to === 'write' || from === undefined || SCOPE_RANK[to] > SCOPE_RANK[from]))
      requireReauth(ctx.deps.services, req);
    return { connection: redactDeep(actions.setConnectionProfile(id, b.profileId)) };
  });

  api.post('/clients/connections/:id/revoke', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    return { revoked: actions.revokeConnection(id) };
  });

  // ADR 0033: removing revoked and expired connections. An active connection is refused (409 CONNECTION_ACTIVE).
  // The fixed path is registered before `:id/remove`, so `remove-inactive` is never read as an id.
  api.post('/clients/connections/remove-inactive', () => actions.removeInactiveConnections());

  api.post('/clients/connections/:id/remove', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    return { removed: actions.removeConnection(id) };
  });

  /** Revokes the stale connections of one profile (unused for `settings.staleAfterDays`). */
  api.post('/clients/connections/revoke-stale', (req) => {
    const b = parseInput(z.object({ profileId: idSchema }), req.body);
    return actions.revokeStaleConnections(b.profileId);
  });

  const days = z.object({ days: z.number().int().min(0).max(3650) });
  api.put('/clients/settings/auto-remove-days', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
    const b = parseInput(days, req.body);
    return { autoRemoveDays: actions.setAutoRemoveDays(b.days) };
  });
  api.put('/clients/settings/stale-after-days', (req) => {
    requireReauth(ctx.deps.services, req); // ADR 0062: a setting
    const b = parseInput(days, req.body);
    return { staleAfterDays: actions.setStaleAfterDays(b.days) };
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
    // R2-50, ADR 0062: a new credential (a key), at any scope.
    requireReauth(ctx.deps.services, req);
    const created = actions.createPat({
      name: b.name,
      profileId: b.profileId,
      ...(b.expiresInDays !== undefined ? { expiresInDays: b.expiresInDays } : {}),
    });
    return reply.code(201).send({ token: created.token, pat: created.pat, shownOnce: true });
  });
};
