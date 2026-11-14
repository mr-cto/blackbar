/**
 * Deterministic redaction. Runs before the model and without it. Patterns catch
 * what has a shape (numbers, labelled fields, street addresses); the on-device
 * model is only asked for what has none (names in prose, clinics, employers).
 */
import { findAll, type Kind, type Span } from './redaction';

const NOT_A_NAME = new Set([
  'responsibility', 'balance', 'amount', 'payment', 'payments', 'total', 'account', 'name', 'id',
  'number', 'date', 'services', 'service', 'statement', 'due', 'portion', 'paid', 'owes', 'copay',
  'deductible', 'coinsurance', 'information', 'summary', 'billing', 'insurance', 'visit', 'type',
  'customer', 'sir', 'madam', 'patient', 'member', 'valued', 'and', 'the', 'of', 'llc', 'inc',
]);

const DATE = String.raw`(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})`;

const ID_LABELS: Array<[RegExp, Kind]> = [
  [/(?:member|subscriber|insured|policy|certificate)\s*(?:id|no\.?|number|#)/i, 'MEMBER_ID'],
  [/group\s*(?:id|no\.?|number|#)/i, 'MEMBER_ID'],
  [/(?:mrn|medical\s*record\s*(?:no\.?|number|#)?|patient\s*(?:id|no\.?|number|#)|chart\s*(?:no\.?|number|#))/i, 'MRN'],
  [/(?:claim|icn|reference|ref\.?)\s*(?:id|no\.?|number|#)/i, 'CLAIM'],
  [/(?:account|acct\.?|guarantor|invoice|statement|visit|encounter|incident)\s*(?:id|no\.?|number|#)/i, 'ACCOUNT'],
];

const NAME_LABEL = /(?:patient(?:\s*name)?|guarantor(?:\s*name)?|subscriber(?:\s*name)?|insured(?:\s*name)?|member(?:\s*name)?|responsible\s*party|bill\s*to|attn\.?|attention)\s*:\s*/gi;
const NAME_AFTER = /^((?:[A-Z][A-Za-z'’.-]*)(?:,?[ \t]{1,2}[A-Z][A-Za-z'’.-]*){1,3})/;

const STREET = /\b\d{1,6}[ \t]+(?:[NSEW]\.?[ \t]+)?(?:[A-Z0-9][A-Za-z0-9'.]*[ \t]+){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace|Trl|Trail)\b\.?(?:,?[ \t]*(?:Apt|Suite|Ste|Unit|#)\.?[ \t]*[\w-]+)?/gi;
const PO_BOX = /\bP\.?[ \t]?O\.?[ \t]*Box[ \t]+\d+\b/gi;
const CITY_STATE_ZIP = /\b[A-Z][A-Za-z.'-]+(?:[ \t][A-Z][A-Za-z.'-]+){0,2},[ \t]*[A-Z]{2}[ \t]+\d{5}(?:-\d{4})?\b/g;

function each(re: RegExp, text: string, fn: (m: RegExpExecArray) => void) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    fn(m);
    if (m[0].length === 0) g.lastIndex++;
  }
}

export function looksLikeName(candidate: string): boolean {
  const parts = candidate.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((p) => /^[A-Z][A-Za-z'’.-]*$/.test(p) && !NOT_A_NAME.has(p.toLowerCase()));
}

export interface OwnDetails { names: string[]; extras: string[] }

export function patternSpans(text: string, own: OwnDetails = { names: [], extras: [] }): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number, kind: Kind) => spans.push({ start, end, kind, source: 'pattern' });

  each(/\b\d{3}-\d{2}-\d{4}\b/g, text, (m) => add(m.index, m.index + m[0].length, 'SSN'));
  each(/(?:\*{3}|x{3})-(?:\*{2}|x{2})-\d{4}\b/gi, text, (m) => add(m.index, m.index + m[0].length, 'SSN'));
  each(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, text, (m) => add(m.index, m.index + m[0].length, 'EMAIL'));
  each(/(?:\(\d{3}\)[ \t]?|\b\d{3}[-. ])\d{3}[-. ]\d{4}\b/g, text, (m) => add(m.index, m.index + m[0].length, 'PHONE'));

  each(new RegExp(String.raw`(?:d\.?o\.?b\.?|date\s*of\s*birth|birth\s*date|birthdate|born)\s*[:#]?\s*(${DATE})`, 'gi'), text, (m) => {
    const start = m.index + m[0].length - m[1].length;
    add(start, start + m[1].length, 'DOB');
  });

  for (const [label, kind] of ID_LABELS) {
    each(new RegExp(`${label.source}\\s*[:#]?\\s*([A-Z0-9][A-Z0-9-]{3,})`, 'gi'), text, (m) => {
      if (!/\d/.test(m[1])) return;
      const start = m.index + m[0].length - m[1].length;
      add(start, start + m[1].length, kind);
    });
  }

  each(NAME_LABEL, text, (m) => {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
    const hit = NAME_AFTER.exec(rest);
    if (hit && looksLikeName(hit[1])) add(m.index + m[0].length, m.index + m[0].length + hit[1].length, 'NAME');
  });
  each(/\bDear[ \t]+(?:Mr\.?|Mrs\.?|Ms\.?|Mx\.?|Dr\.?)?[ \t]*((?:[A-Z][A-Za-z'’.-]*)(?:[ \t]+[A-Z][A-Za-z'’.-]*){0,2})/g, text, (m) => {
    const parts = m[1].split(/\s+/);
    if (parts.some((p) => NOT_A_NAME.has(p.toLowerCase()))) return;
    const start = m.index + m[0].length - m[1].length;
    add(start, start + m[1].length, 'NAME');
  });

  // Clinicians: "Dr. Alan Whitcombe", "Helen Marsh, MD".
  each(/\bDr\.?[ \t]+((?:[A-Z][A-Za-z'’-]+)(?:[ \t][A-Z]\.?)?(?:[ \t][A-Z][A-Za-z'’-]+)?)/g, text, (m) => {
    const start = m.index + m[0].length - m[1].length;
    add(start, start + m[1].length, 'NAME');
  });
  each(/\b((?:[A-Z][a-z'’-]+[ \t]){1,2}[A-Z][a-z'’-]+),?[ \t]+(?:MD|M\.D\.|DO|D\.O\.|NP|PA-C|RN)\b/g, text, (m) => add(m.index, m.index + m[1].length, 'NAME'));

  each(STREET, text, (m) => add(m.index, m.index + m[0].length, 'ADDRESS'));
  each(PO_BOX, text, (m) => add(m.index, m.index + m[0].length, 'ADDRESS'));
  each(CITY_STATE_ZIP, text, (m) => add(m.index, m.index + m[0].length, 'ADDRESS'));

  for (const n of own.names) spans.push(...nameEverywhere(text, n, 'you'));
  for (const x of own.extras) spans.push(...findAll(text, x, 'OTHER', 'you'));

  // A name found once is blacked out everywhere, including "DELGADO, MARIA" and bare surnames.
  const found = spans.filter((s) => s.kind === 'NAME').map((s) => text.slice(s.start, s.end));
  for (const n of new Set(found)) spans.push(...nameEverywhere(text, n, 'pattern'));
  return spans;
}

/** All occurrences of a full name and of each of its parts (3+ letters). */
export function nameEverywhere(text: string, name: string, source: Span['source']): Span[] {
  const spans = findAll(text, name, 'NAME', source);
  for (const part of name.split(/[\s,]+/)) {
    if (part.length < 3 || NOT_A_NAME.has(part.toLowerCase())) continue;
    const re = new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    each(re, text, (m) => spans.push({ start: m.index, end: m.index + m[0].length, kind: 'NAME', source }));
  }
  return spans;
}
