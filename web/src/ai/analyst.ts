/**
 * Steps 3 and 4. Everything here receives the redacted bill only, and every
 * call passes through `guard`, which refuses to send text that still contains
 * a value from the vault.
 */
import { Schema } from 'firebase/ai';
import { findLeaks, type Vault } from '../lib/redaction';
import { newEntry, type LedgerEntry } from '../lib/ledger';
import { analystModel, helperModel, userTurn, whereOf, writerModel } from './models';

export type Verdict = 'looks_normal' | 'worth_asking' | 'likely_error';

export interface Analysis {
  summary: string;
  documentType: string;
  youOwe: string;
  lines: Array<{ code: string; label: string; plain: string; amount: string; verdict: Verdict; note: string }>;
  findings: Array<{ title: string; severity: 'high' | 'medium' | 'low'; detail: string; ask: string }>;
  questions: string[];
}

export class LeakError extends Error {
  constructor(public leaks: string[]) {
    super(`Blocked: ${leaks.length} personal detail(s) were still in the text.`);
  }
}

/** The gate. Nothing is handed to a cloud-capable model without passing it. */
function guard(outbound: string, vault: Vault) {
  const leaks = findLeaks(outbound, vault);
  if (leaks.length) throw new LeakError(leaks);
}

const ANALYST_SYSTEM = `You help a patient in the United States understand a medical bill or insurance explanation of benefits.
The document has been redacted on the patient's device: tokens such as [NAME_1], [ACCOUNT_1] or [PROVIDER_1] stand for details you are not allowed to see. Never guess what they are; reuse the tokens as written.
Be concrete and calm. Explain each line in plain English a tired person can follow. Flag only what the document itself supports: duplicate lines, a code level that looks high for the visit, charges that are usually bundled, out-of-network or balance-billing language (mention the federal No Surprises Act for emergency care when it applies), denials that can be appealed, missing insurance billing, fees with no service behind them.
Amounts are strings copied from the document. You give information, not medical, legal or financial advice.`;

const cloudSchema = Schema.object({
  properties: {
    summary: Schema.string({ description: 'Two or three sentences: what this document is and what stands out.' }),
    documentType: Schema.string({ description: 'For example: hospital statement, explanation of benefits, ambulance invoice.' }),
    youOwe: Schema.string({ description: 'The amount the patient is being asked to pay, as printed, or "not stated".' }),
    lines: Schema.array({
      items: Schema.object({
        properties: {
          code: Schema.string(),
          label: Schema.string({ description: 'The line as printed, shortened.' }),
          plain: Schema.string({ description: 'What it is, in one plain sentence.' }),
          amount: Schema.string(),
          verdict: Schema.enumString({ enum: ['looks_normal', 'worth_asking', 'likely_error'] }),
          note: Schema.string({ description: 'Why, if not looks_normal. Empty otherwise.' }),
        },
      }),
    }),
    findings: Schema.array({
      items: Schema.object({
        properties: {
          title: Schema.string(),
          severity: Schema.enumString({ enum: ['high', 'medium', 'low'] }),
          detail: Schema.string(),
          ask: Schema.string({ description: 'The exact thing to ask the billing office or insurer.' }),
        },
      }),
    }),
    questions: Schema.array({ items: Schema.string(), description: 'Three short questions the patient may want to ask an assistant about terms on this document, such as "What is a contractual adjustment?". Not questions for the billing office.' }),
  },
});

// The same shape as JSON Schema, for the on-device fallback when the cloud cannot be reached.
const str = { type: 'string' };
const deviceSchema = {
  type: 'object',
  properties: {
    summary: str, documentType: str, youOwe: str,
    lines: { type: 'array', items: { type: 'object', properties: { code: str, label: str, plain: str, amount: str, verdict: { type: 'string', enum: ['looks_normal', 'worth_asking', 'likely_error'] }, note: str }, required: ['code', 'label', 'plain', 'amount', 'verdict', 'note'] } },
    findings: { type: 'array', items: { type: 'object', properties: { title: str, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, detail: str, ask: str }, required: ['title', 'severity', 'detail', 'ask'] } },
    questions: { type: 'array', items: str },
  },
  required: ['summary', 'documentType', 'youOwe', 'lines', 'findings', 'questions'],
};

export async function analyse(redacted: string, vault: Vault, cloudModel: string): Promise<{ analysis: Analysis; entry: LedgerEntry }> {
  const prompt = `Here is the redacted document.\n\n${redacted}`;
  guard(prompt, vault);
  const t0 = performance.now();
  const model = analystModel(cloudModel, ANALYST_SYSTEM, cloudSchema, deviceSchema);
  const result = await model.generateContent(userTurn(prompt));
  const where = whereOf(result.response.inferenceSource);
  const parsed = JSON.parse(result.response.text()) as Partial<Analysis>;
  const analysis: Analysis = {
    summary: parsed.summary ?? '', documentType: parsed.documentType ?? 'document', youOwe: parsed.youOwe ?? 'not stated',
    lines: parsed.lines ?? [], findings: parsed.findings ?? [], questions: parsed.questions ?? [],
  };
  return {
    analysis,
    entry: newEntry({
      step: 'Read the bill', mode: 'PREFER_IN_CLOUD', where, ms: performance.now() - t0,
      sentChars: where === 'in_cloud' ? prompt.length : 0, sent: where === 'in_cloud' ? prompt : '',
      note: where === 'on_device' ? 'Cloud unreachable, so the on-device model gave a shorter read.' : `Model: ${cloudModel}`,
    }),
  };
}

const WRITER_SYSTEM = `You write a short, firm, polite dispute or appeal letter for a patient about a US medical bill.
The bill was redacted on the patient's device. Tokens such as [NAME_1], [ADDRESS_1], [ACCOUNT_1], [MEMBER_ID_1], [CLAIM_1], [PROVIDER_1] stand for real details. Use the tokens exactly as written wherever the real detail belongs; the patient's device will fill them in. Never invent names, numbers or addresses.
Format: plain text, no markdown. Sender block, date line "[Today's date]", recipient, a subject line with the account or claim token, three to five short paragraphs, a numbered list of the specific requests, a closing and signature token. Ask for an itemised bill and a hold on collections while the dispute is open. Cite the No Surprises Act only if the findings mention out-of-network emergency care.`;

export async function writeLetter(
  redacted: string, analysis: Analysis, vault: Vault, cloudModel: string, onText: (soFar: string) => void,
): Promise<{ letter: string; entry: LedgerEntry }> {
  const prompt = `Redacted document:\n\n${redacted}\n\nFindings to raise:\n${analysis.findings.map((f, i) => `${i + 1}. ${f.title}: ${f.detail} Ask: ${f.ask}`).join('\n')}\n\nWrite the letter.`;
  guard(prompt, vault);
  const t0 = performance.now();
  const model = writerModel(cloudModel, WRITER_SYSTEM);
  const result = await model.generateContentStream(userTurn(prompt));
  let letter = '';
  for await (const chunk of result.stream) {
    letter += chunk.text();
    onText(letter);
  }
  return {
    letter,
    entry: newEntry({ step: 'Draft the letter', mode: 'ONLY_IN_CLOUD', where: 'in_cloud', ms: performance.now() - t0, sentChars: prompt.length, sent: prompt, note: `Model: ${cloudModel}` }),
  };
}

const HELPER_SYSTEM = `You answer one short question about a medical bill in two to four plain sentences.
The bill is redacted: tokens like [NAME_1] stand for details you cannot see; leave them as they are.
Answer directly from what the bill shows; say what it most likely means before any caveat. Only if the question truly cannot be answered from a bill, say who to ask, in one sentence. Information only, not advice.`;

export async function ask(
  question: string, redacted: string, vault: Vault, cloudModel: string, onText: (soFar: string) => void,
): Promise<{ answer: string; entry: LedgerEntry }> {
  // The on-device model has a small window; give it the lines most likely to matter.
  const context = redacted.length > 3500 ? redacted.slice(0, 3500) + '\n[...]' : redacted;
  const prompt = `Bill:\n${context}\n\nQuestion: ${question}`;
  guard(prompt, vault);
  const t0 = performance.now();
  const model = helperModel(cloudModel, HELPER_SYSTEM);
  const result = await model.generateContentStream(userTurn(prompt));
  let answer = '';
  for await (const chunk of result.stream) {
    answer += chunk.text();
    onText(answer);
  }
  const where = whereOf((await result.response).inferenceSource);
  return {
    answer,
    entry: newEntry({
      step: 'Follow-up question', mode: 'PREFER_ON_DEVICE', where, ms: performance.now() - t0,
      sentChars: where === 'in_cloud' ? prompt.length : 0, sent: where === 'in_cloud' ? prompt : '',
      note: where === 'in_cloud' ? 'No on-device model here, so the redacted question went to the cloud.' : undefined,
    }),
  };
}
