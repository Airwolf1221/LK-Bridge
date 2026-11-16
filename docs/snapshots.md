# Snapshots, restores and the rehearsal: what to know

The design is [ADR 0042](adr/0042-snapshots-restore-rehearsal.md). The dashboard's Snapshots page is in
[dashboard.md](dashboard.md), and the tools are in [tools.md](tools.md). This page collects what an owner runs into in
practice.

## Complete and partial snapshots

A snapshot is **partial** when a piece could not be read or stored. Each missing piece is listed on the page with why. A
partial full snapshot is kept, but a restore cannot bring back the missing pieces from it. The rehearsal and the audits
should use a **complete** one, and the dashboard's rehearsal picker preselects the newest complete full snapshot (v2 E5.4).

### A map LegendKeeper cannot list (v2 E5.4)

LegendKeeper's API contradicts itself on map label sizes ([ADR 0046](adr/0046-e4-owner-decisions.md) decision 14; the bug
report is [reviews/lk-bug-labelsize.md](reviews/lk-bug-labelsize.md)). Its writes take only `xs` to `3xl`, but
`listFeatures` returns only `small`, `medium` or `large`. It refuses to list a map if one feature holds anything else. The
snapshot then records that map document as missing:

> its features: LegendKeeper can't list this map's features: a feature holds a label size its API refuses to return (set
> its label size in the app)

The rest of the page and the rest of the snapshot are taken as usual, and the snapshot is partial. **To fix it,** find the
feature in the app and set its label size again (any of small, medium or large); the next snapshot is complete. The bridge
never writes a label size, so only a write from outside the bridge can cause this.

## Label sizes are not restored

A restore, a recreated page and a rehearsal never send a feature's `labelSize`, so a restored feature takes LegendKeeper's
default size. Each is listed under what could not be restored, once per map with a count:

> label size not restorable: LegendKeeper's API can't write the app's values (small/medium/large) and can't read its own
> (xs–3xl)

This is neither a failure nor a difference. A feature that differs from the snapshot only in its label size is not
updated. Set label sizes in the app if they matter. The switch that would turn this off when LegendKeeper fixes the API is
`LABEL_SIZE_WRITABLE` in `src/maps/features.ts`, and the sandbox assumption LS1 (`npm run test:sandbox`) shows when it is
safe.

## The rehearsal

A rehearsal restores a full snapshot into a throwaway root of a sandbox project, compares it, and deletes the root.

- **Sampled** (the default): about 50 pages chosen to cover every kind of block and document. Since v2 E5.4 a sample copies
  at most **25 events of each timeline** (spread over it, with every lane they use) and at most **40 features of each map**
  (a kept feature brings its folders; a region and a path are kept first if the map has them). The estimate lists what it
  leaves out. **Full** copies everything.
- **The estimate** is paced as the governor will pace the run at background priority (P3): the writes one after another
  at P3's write rate, and the reads at its request rate. At the default limits that is about a second a write and under
  half a second a read once the run is long. The plan shows the rates it assumed.
- **Reads never fail the run.** Any read in the comparison that fails (a map LegendKeeper cannot list, a timeout, an
  error) is a difference naming the page and the piece. The comparison carries on with the other pages, and the run
  finishes and deletes its root as usual.
- **Leftover roots.** A rehearsal the bridge was restarted during is marked stopped, and its root is kept. Delete it from
  the Snapshots page ("Delete its root"), or in the app (a top-level page named `lk-bridge rehearsal <time>`) if the page
  says the delete failed.
