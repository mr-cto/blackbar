import { useMemo, useState, type MouseEvent } from 'react';
import { KIND_LABEL, wordAt, type Redacted } from '../lib/redaction';

interface Props {
  raw: string;
  redacted: Redacted;
  onBlackOut: (start: number, end: number) => void;
  onRestore: (start: number, end: number) => void;
}

type Seg = { start: number; end: number; mark?: Redacted['marks'][number] };

function segments(raw: string, marks: Redacted['marks']): Seg[] {
  const segs: Seg[] = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start > cursor) segs.push({ start: cursor, end: m.start });
    segs.push({ start: m.start, end: m.end, mark: m });
    cursor = m.end;
  }
  if (cursor < raw.length) segs.push({ start: cursor, end: raw.length });
  return segs;
}

/** Character offset of a click inside a [data-start] text segment. */
function offsetFromPoint(x: number, y: number): number | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (p) { node = p.offsetNode; offset = p.offset; }
  } else if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  }
  const el = node?.parentElement?.closest<HTMLElement>('[data-start]');
  if (!el) return null;
  return Number(el.dataset.start) + offset;
}

export function BillPanes({ raw, redacted, onBlackOut, onRestore }: Props) {
  const segs = useMemo(() => segments(raw, redacted.marks), [raw, redacted.marks]);
  const [tab, setTab] = useState<'device' | 'cloud'>('device');

  const onClick = (e: MouseEvent<HTMLPreElement>) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // handled by mouseup
    const target = e.target as HTMLElement;
    if (target.closest('[data-mark]')) return;
    const at = offsetFromPoint(e.clientX, e.clientY);
    if (at == null) return;
    const w = wordAt(raw, Math.min(at, raw.length - 1)) ?? wordAt(raw, at - 1);
    if (w) onBlackOut(w.start, w.end);
  };

  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const a = range.startContainer.parentElement?.closest<HTMLElement>('[data-start]');
    const b = range.endContainer.parentElement?.closest<HTMLElement>('[data-start]');
    if (!a || !b) return;
    const start = Number(a.dataset.start) + (a.dataset.mark ? 0 : range.startOffset);
    const end = Number(b.dataset.start) + (b.dataset.mark ? Number(b.dataset.len) : range.endOffset);
    sel.removeAllRanges();
    if (end > start) onBlackOut(start, end);
  };

  return (
    <div className="panes" data-tab={tab}>
      <div className="pane-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'device'} onClick={() => setTab('device')}>On your device</button>
        <button role="tab" aria-selected={tab === 'cloud'} onClick={() => setTab('cloud')}>What the cloud sees</button>
      </div>

      <article className="pane pane-device" aria-label="The bill as it is on your device">
        <header><span className="pane-title">On your device</span><span className="pane-sub">Tap a word to black it out. Tap a mark to restore it.</span></header>
        <pre className="bill" onClick={onClick} onMouseUp={onMouseUp} data-testid="bill-device">
          {segs.map((s) => s.mark ? (
            <button
              key={s.start} type="button" className={`mark mark-${s.mark.source}`}
              data-mark="1" data-start={s.start} data-len={s.end - s.start}
              title={`${KIND_LABEL[s.mark.kind]} · found by ${s.mark.source === 'pattern' ? 'rules' : s.mark.source === 'model' ? 'the on-device model' : 'you'} · tap to restore`}
              onClick={() => onRestore(s.start, s.end)}
            >{raw.slice(s.start, s.end)}</button>
          ) : (
            <span key={s.start} data-start={s.start}>{raw.slice(s.start, s.end)}</span>
          ))}
        </pre>
      </article>

      <article className="pane pane-cloud" aria-label="The bill as the cloud will see it">
        <header><span className="pane-title">What the cloud sees</span><span className="pane-sub">This text, and nothing else, is sent.</span></header>
        <pre className="bill" data-testid="bill-cloud">
          {segs.map((s) => s.mark ? (
            <span key={s.start} className="bar" style={{ width: `${s.end - s.start}ch` }} title={s.mark.placeholder}>
              <span>{s.mark.placeholder.slice(1, -1).replace(/_/g, ' ')}</span>
            </span>
          ) : (
            <span key={s.start}>{raw.slice(s.start, s.end)}</span>
          ))}
        </pre>
      </article>
    </div>
  );
}
