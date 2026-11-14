/**
 * The redaction model. Everything in this file is deterministic and runs on the
 * device. A Span marks a range of the raw bill that must not leave; the vault
 * maps each placeholder back to the original so the finished letter can be
 * re-personalised locally.
 */

export type Kind =
  | 'NAME' | 'ADDRESS' | 'PHONE' | 'EMAIL' | 'DOB' | 'SSN'
  | 'MEMBER_ID' | 'ACCOUNT' | 'MRN' | 'CLAIM' | 'PROVIDER' | 'OTHER';

export type SpanSource = 'pattern' | 'model' | 'you';

export interface Span {
  start: number;
  end: number;
  kind: Kind;
  source: SpanSource;
}

export const KIND_LABEL: Record<Kind, string> = {
  NAME: 'Name', ADDRESS: 'Address', PHONE: 'Phone', EMAIL: 'Email', DOB: 'Date of birth',
  SSN: 'SSN', MEMBER_ID: 'Member ID', ACCOUNT: 'Account no.', MRN: 'Record no.',
  CLAIM: 'Claim no.', PROVIDER: 'Provider', OTHER: 'Other',
};

/** Merge overlapping spans. Earlier sources win on kind; ranges are unioned. */
export function normalizeSpans(spans: Span[], textLength: number): Span[] {
  const rank: Record<SpanSource, number> = { you: 0, pattern: 1, model: 2 };
  const sorted = spans
    .filter((s) => s.end > s.start && s.start >= 0 && s.end <= textLength)
    .sort((a, b) => a.start - b.start || rank[a.source] - rank[b.source]);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
      if (rank[s.source] < rank[last.source]) { last.kind = s.kind; last.source = s.source; }
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** A span that wraps across lines becomes one span per line, so bars never swallow a line break. */
function splitAtLineBreaks(text: string, s: Span): Span[] {
  const out: Span[] = [];
  let start = s.start;
  for (let i = s.start; i <= s.end; i++) {
    if (i === s.end || text[i] === '\n') {
      const piece = text.slice(start, i);
      const lead = piece.length - piece.trimStart().length;
      const trimmed = piece.trim();
      if (trimmed) out.push({ ...s, start: start + lead, end: start + lead + trimmed.length });
      start = i + 1;
    }
  }
  return out;
}

export type Vault = Record<string, string>;

export interface Redacted {
  /** What the cloud is allowed to see. */
  text: string;
  /** placeholder → original. Never leaves the device. */
  vault: Vault;
  /** Each span with the placeholder it was given, for rendering. */
  marks: Array<Span & { placeholder: string }>;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Replace every span with a stable placeholder such as [NAME_1]. */
export function redact(text: string, spans: Span[]): Redacted {
  const clean = normalizeSpans(spans, text.length).flatMap((s) => splitAtLineBreaks(text, s));
  const vault: Vault = {};
  const seen = new Map<string, string>();
  const counters: Partial<Record<Kind, number>> = {};
  const marks: Redacted['marks'] = [];
  let out = '';
  let cursor = 0;
  for (const s of clean) {
    const original = text.slice(s.start, s.end);
    const key = `${s.kind}:${squash(original)}`;
    let placeholder = seen.get(key);
    if (!placeholder) {
      const n = (counters[s.kind] = (counters[s.kind] ?? 0) + 1);
      placeholder = `[${s.kind}_${n}]`;
      seen.set(key, placeholder);
      vault[placeholder] = original.trim();
    }
    out += text.slice(cursor, s.start) + placeholder;
    cursor = s.end;
    marks.push({ ...s, placeholder });
  }
  out += text.slice(cursor);
  return { text: out, vault, marks };
}

/** Put the real details back. Runs locally, after the cloud has answered. */
export function rehydrate(text: string, vault: Vault): string {
  return text.replace(/\[([A-Z_]+_\d+)\]/g, (m) => vault[m] ?? m);
}

/**
 * The last gate before anything is sent. Returns the vault values that still
 * appear in the outbound text; an empty array means the text is clean.
 */
export function findLeaks(outbound: string, vault: Vault): string[] {
  const hay = outbound.toLowerCase();
  const leaks: string[] = [];
  for (const original of Object.values(vault)) {
    const needle = original.toLowerCase().trim();
    if (needle.length >= 4 && hay.includes(needle)) leaks.push(original);
  }
  return leaks;
}

/** Scrub free text the user typed (a follow-up question) with the same vault. */
export function scrubWithVault(text: string, vault: Vault): string {
  let out = text;
  const entries = Object.entries(vault).sort((a, b) => b[1].length - a[1].length);
  for (const [placeholder, original] of entries) {
    if (original.length < 3) continue;
    const re = new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, placeholder);
    if (placeholder.startsWith('[NAME_')) {
      for (const part of original.split(/[\s,]+/)) {
        if (part.length < 3) continue;
        out = out.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), placeholder);
      }
    }
  }
  return out;
}

/** Every occurrence of `value` in `text`, case-insensitive. */
export function findAll(text: string, value: string, kind: Kind, source: SpanSource): Span[] {
  const v = value.trim();
  if (v.length < 2) return [];
  const spans: Span[] = [];
  const hay = text.toLowerCase();
  const needle = v.toLowerCase();
  let i = hay.indexOf(needle);
  while (i !== -1) {
    spans.push({ start: i, end: i + needle.length, kind, source });
    i = hay.indexOf(needle, i + needle.length);
  }
  return spans;
}

/** Word boundaries around an index, for tap-to-redact. */
export function wordAt(text: string, index: number): { start: number; end: number } | null {
  const isWord = (c: string) => /[A-Za-z0-9@._'’#-]/.test(c);
  if (index < 0 || index >= text.length || !isWord(text[index])) return null;
  let start = index;
  let end = index + 1;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  return { start, end };
}
