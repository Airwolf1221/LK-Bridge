# LK-Bridge — standing instructions
- Read docs/PLAN.md before any work. Follow its decisions; propose an ADR to change one.
- TypeScript strict, ESM, Node 24. Fastify 5. SQLite via better-sqlite3. Vitest.
- NEVER call LegendKeeper except through src/lk/governor (no raw fetch to legendkeeper.com).
- NEVER write a versioned LK entity without If-Match. NEVER drop `unsupported` blocks.
- NEVER commit secrets or real API keys; this repo may be public. Use .env.example names only.
- Tests: unit + contract (mock LK) must pass before finishing. Sandbox tests are opt-in (npm run test:sandbox).
- Work only on this session's own automatic branch; never create another branch; never force-push; merge `main` in rather than rebasing. End with a summary of what changed and what's left.
- British English in docs and UI copy.
- Every new setting goes in `src/config/registry.ts` (it then appears on the Settings page); secrets and bootstrap settings are marked so.
