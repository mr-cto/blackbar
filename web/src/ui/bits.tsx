import type { ReactNode } from 'react';
import type { Where } from '../lib/ledger';

export function WhereBadge({ where }: { where: Where }) {
  const label = where === 'on_device' ? 'On device' : where === 'in_cloud' ? 'Cloud' : 'Rules';
  return (
    <span className={`where where-${where}`} data-testid={`where-${where}`}>
      <i aria-hidden="true" />{label}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return <span className="spinner" role="status"><i aria-hidden="true" />{label}</span>;
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head"><h2>{title}</h2>{aside}</header>
      {children}
    </section>
  );
}

export const ms = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
