/**
 * Step 1, on the device only. Patterns have already marked everything with a
 * shape. The on-device model reads the bill in small pieces and names what is
 * left: people, clinics, employers. Its answers are checked deterministically
 * before they are trusted, and the raw text never leaves this function.
 */
import { looksLikeName, nameEverywhere } from '../lib/patterns';
import type { Kind, Span } from '../lib/redaction';
import { redactorModel, userTurn } from './models';

const SYSTEM = `You find personal identifiers in pieces of US medical bills so they can be blacked out.
Return only what identifies a person or a place of care:
- PERSON: any patient, guarantor, family member, doctor, nurse or staff name
- PROVIDER: the name of a hospital, clinic, practice, lab, ambulance company or physician group
- EMPLOYER: an employer or school name
- OTHER_ID: any other id number, licence, plate, or web login
Never return: insurance company names, service or procedure descriptions (visits, tests, x-rays, drugs, supplies), department names such as "Emergency Department", procedure or remark codes, dates of service, money amounts, column headings.
Copy each item exactly as written, character for character. If there is nothing, return an empty list.`;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: 8, // a small model will happily list forever; the schema says when to stop
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 60 },
          kind: { type: 'string', enum: ['PERSON', 'PROVIDER', 'EMPLOYER', 'OTHER_ID'] },
        },
        required: ['text', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const KIND: Record<string, Kind> = { PERSON: 'NAME', PROVIDER: 'PROVIDER', EMPLOYER: 'OTHER', OTHER_ID: 'OTHER' };

const INSURER_WORDS = /\b(mutual|health plan|ppo|hmo|medicare|medicaid|insurance|blue|aetna|cigna|united|humana|anthem|kaiser|tricare)\b/i;
const NEVER = /^(?:[\d$.,\s/]+|[A-Z]\d{4}|\d{5}|total.*|patient|member|provider|statement|invoice|claim|account|description|charge|amount|code|qty|units|service|none provided|not a bill)$/i;

const ORG_WORD = /\b(hospital|medical center|health center|clinic|practice|physicians?|associates|group|partners|ems|ambulance|laborator(?:y|ies)|labs?|imaging|radiology|urgent care|pharmacy|surgery center|pediatrics|orthopedics|cardiology|dental|llc|inc|p\.?c\.?|university|school|college|company|corp(?:oration)?)\b/i;
const GENERIC = new Set(['emergency', 'department', 'medical', 'center', 'health', 'patient', 'financial', 'services', 'billing', 'the', 'of', 'and', 'general', 'family', 'care', 'urgent', 'group', 'clinic', 'hospital', 'practice', 'physicians', 'associates', 'laboratory', 'lab', 'imaging', 'radiology', 'ems', 'ambulance']);

/** A row of the charges table, a total, or a column heading. These never go to the model. */
export function isTableRow(line: string): boolean {
  if (/\d[\d,]*\.\d{2}\s*(?:[A-Z]{1,3}-?\d{1,3})?\s*$/.test(line)) return true; // ends in money (and maybe a remark code)
  if (/^\s*(?:[A-Z]\d{4}|\d{5})\s{2,}/.test(line)) return true; // starts with a CPT/HCPCS code
  return /^[A-Z#/ ]+$/.test(line.trim()) && line.trim().split(/\s{2,}/).length >= 3; // column headings
}

/** Matches the words of `t` with any whitespace between them, so a name that wraps across lines still matches. */
const flex = (t: string) => new RegExp(t.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gi');

function findFlexible(raw: string, t: string, kind: Kind): Span[] {
  const spans: Span[] = [];
  for (const m of raw.matchAll(flex(t))) spans.push({ start: m.index, end: m.index + m[0].length, kind, source: 'model' });
  return spans;
}

/** Deterministic checks on what the model returned. A miss here is dropped, never sent on. */
export function acceptItem(textItem: string, kind: string, chunk: string): Kind | null {
  const t = textItem.trim();
  if (t.length < 3 || t.length > 80) return null;
  if (!flex(t).test(chunk)) return null; // the model must quote, not invent
  if (NEVER.test(t)) return null;
  if (INSURER_WORDS.test(t)) return null;
  const mapped = KIND[kind];
  if (!mapped) return null;
  if (kind === 'OTHER_ID') {
    // An id is one token with a digit in it, and is not a date, an amount or a procedure code.
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{4,}$/.test(t) || !/\d/.test(t)) return null;
    if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(t) || /^(?:[A-Z]\d{4}|\d{5})$/.test(t)) return null;
  }
  if (mapped === 'PROVIDER' || kind === 'EMPLOYER') {
    // An organisation needs an organisation word and at least one word that is actually a name.
    const words = t.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter(Boolean);
    if (!ORG_WORD.test(t) || !words.some((w) => w.length > 2 && !GENERIC.has(w))) return null;
  }
  if (mapped === 'NAME') {
    const bare = t.replace(/^(?:dr|mr|mrs|ms|mx)\.?\s+/i, '');
    const titled = bare.split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(' ');
    if (!looksLikeName(titled) && !/^[A-Z][a-z'’-]{2,}$/.test(titled)) return null;
  }
  return mapped;
}

/** Split on lines so no piece exceeds the budget; bills are line-oriented. */
export function chunkLines(text: string, maxChars: number): Array<{ start: number; text: string }> {
  const chunks: Array<{ start: number; text: string }> = [];
  let start = 0;
  let buf = '';
  let offset = 0;
  for (const line of text.split('\n')) {
    const withBreak = line + '\n';
    if (buf.length + withBreak.length > maxChars && buf.trim()) {
      chunks.push({ start, text: buf });
      start = offset;
      buf = '';
    }
    buf += withBreak;
    offset += withBreak.length;
  }
  if (buf.trim()) chunks.push({ start, text: buf });
  return chunks;
}

export interface RedactProgress { done: number; total: number; spans: Span[]; ms: number; timedOut: number }

/** Generous for a cold model on an old laptop, short enough that a runaway piece cannot stall the step. */
const PIECE_TIMEOUT_MS = 90_000;
const FIRST_PIECE_TIMEOUT_MS = 240_000; // the first piece also pays for loading the model
const isTimeout = (e: unknown) => e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');

/**
 * Runs the on-device pass. Throws if there is no on-device model: the caller
 * then stays on patterns and manual review. There is no cloud fallback here by
 * construction (InferenceMode.ONLY_ON_DEVICE).
 */
export async function modelSpans(
  raw: string,
  chunkChars: number,
  onProgress: (p: RedactProgress) => void,
  signal?: AbortSignal,
): Promise<{ spans: Span[]; timedOut: number; pieces: number }> {
  // The charges table has no identity in it and is most of a bill's length: keep it away from the model.
  const prose = raw.split('\n').filter((l) => l.trim() && !isTableRow(l)).join('\n');
  const chunks = chunkLines(prose, chunkChars);
  const all: Span[] = [];
  let timedOut = 0;
  const t0 = performance.now();
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) break;
    const chunk = chunks[i];
    let items: Array<{ text: string; kind: string }> = [];
    try {
      // One model per piece so each gets its own deadline: a piece that runs away is dropped, not waited on.
      const model = redactorModel(SYSTEM, SCHEMA, AbortSignal.any([AbortSignal.timeout(i === 0 ? FIRST_PIECE_TIMEOUT_MS : PIECE_TIMEOUT_MS), ...(signal ? [signal] : [])]));
      const result = await model.generateContent(userTurn(`Piece ${i + 1} of ${chunks.length}:\n\n${chunk.text}`));
      items = (JSON.parse(result.response.text()) as { items?: typeof items }).items ?? [];
    } catch (e) {
      if (i === 0 && !isTimeout(e)) throw e; // no usable on-device model at all: let the caller fall back to rules
      items = []; // a timed-out or unparseable piece is treated as "found nothing"; rules still cover it
      timedOut += isTimeout(e) ? 1 : 0;
    }
    for (const item of items) {
      const kind = acceptItem(item.text, item.kind, chunk.text);
      if (!kind) continue;
      // Black it out everywhere in the bill, not only in this piece.
      all.push(...(kind === 'NAME'
        ? nameEverywhere(raw, item.text.replace(/^(?:dr|mr|mrs|ms|mx)\.?\s+/i, ''), 'model')
        : findFlexible(raw, item.text, kind)));
    }
    onProgress({ done: i + 1, total: chunks.length, spans: [...all], ms: performance.now() - t0, timedOut });
  }
  return { spans: all, timedOut, pieces: chunks.length };
}
