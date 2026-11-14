import type { LedgerEntry } from '../lib/ledger';
import { ms, WhereBadge } from './bits';

export function Ledger({ entries, vaultSize, onClose }: { entries: LedgerEntry[]; vaultSize: number; onClose: () => void }) {
  const sent = entries.reduce((n, e) => n + e.sentChars, 0);
  const local = entries.filter((e) => e.where !== 'in_cloud').length;
  return (
    <div className="drawer-wrap" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="What left this device" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>What left this device</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">Close</button>
        </header>
        <dl className="ledger-totals">
          <div><dt>Sent to the cloud</dt><dd>{sent.toLocaleString()} characters</dd></div>
          <div><dt>Handled on device</dt><dd>{local} of {entries.length} steps</dd></div>
          <div><dt>Details kept here</dt><dd>{vaultSize} values</dd></div>
        </dl>
        {entries.length === 0 && <p className="muted">Nothing has been sent. Your bill is only in this browser tab.</p>}
        <ol className="ledger">
          {entries.map((e) => (
            <li key={e.id}>
              <div className="ledger-row">
                <strong>{e.step}</strong><WhereBadge where={e.where} />
              </div>
              <div className="ledger-meta">
                <code>{e.mode}</code><span>{ms(e.ms)}</span>
                <span>{e.sentChars ? `${e.sentChars.toLocaleString()} characters sent` : 'nothing sent'}</span>
              </div>
              {e.note && <p className="muted">{e.note}</p>}
              {e.sent && (
                <details>
                  <summary>Show exactly what was sent</summary>
                  <pre>{e.sent}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
