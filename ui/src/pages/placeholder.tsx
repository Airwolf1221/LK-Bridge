import { PageHeader } from '../components';

/** Navigation entries for pages a later chunk builds (chunk 6). No data model here. */
export function Placeholder({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="card">
        <p>Coming in a later chunk.</p>
        <p className="muted">
          This page is reserved so the navigation is complete. It has no data yet, and nothing here changes
          how the bridge behaves.
        </p>
      </div>
    </>
  );
}
