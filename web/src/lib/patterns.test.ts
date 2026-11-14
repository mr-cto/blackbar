import { describe, expect, it } from 'vitest';
import { patternSpans } from './patterns';
import { findLeaks, redact, rehydrate, scrubWithVault } from './redaction';
import { SAMPLES } from './samples';

const run = (id: string) => {
  const text = SAMPLES.find((s) => s.id === id)!.text;
  return { text, r: redact(text, patternSpans(text)) };
};

describe('pattern redaction, no model', () => {
  it('ER bill: identity is gone, billing content stays', () => {
    const { r } = run('er');
    for (const secret of ['Maria', 'Delgado', '7741-208-3391', '03/14/1984', '00482917', 'BKM904417726',
      '0057731', '26-3381-99047', '218 Alder Creek Lane', 'Marlow, OH 44512', '(330) 555-0142', 'billing@lakemontregional.example', 'Whitcombe']) {
      expect(r.text, secret).not.toContain(secret);
    }
    for (const keep of ['99285', '2,840.00', '09/19/2026', 'OUT OF NETWORK', 'PATIENT BALANCE DUE', 'Buckeye Mutual PPO']) {
      expect(r.text, keep).toContain(keep);
    }
  });

  it('EOB: both family members and the member ID are gone', () => {
    const { r } = run('eob');
    for (const secret of ['Okafor', 'James', 'Priya', 'BKM771204583', '6027 Tanager Court', 'Fairlawn, OH 44333', 'P-558201', '800-555-0199', 'Helen Marsh']) {
      expect(r.text, secret).not.toContain(secret);
    }
    for (const keep of ['83036', 'CO-50', '142.00', '08/04/2026', 'Preventive'.toUpperCase()]) expect(r.text).toContain(keep);
  });

  it('ambulance: masked SSN, email, DOB, PO box, surname in prose', () => {
    const { r } = run('ambulance');
    for (const secret of ['Nakamura', 'Robert', '***-**-4471', 'r.nakamura57', '11/02/1957', '1509 W Sycamore St', 'Kettering, OH 45429', 'PO Box 88120']) {
      expect(r.text, secret).not.toContain(secret);
    }
    expect(r.text).toContain('A0427');
    expect(r.text).toContain('09/11/2026');
  });

  it('whole names are taken, never a fragment', () => {
    const er = run('er').r;
    expect(er.text).not.toMatch(/hitcombe|elgado|aria\b/);
    expect(Object.values(er.vault)).toContain('Alan Whitcombe');
    const eob = run('eob').r;
    expect(Object.values(eob.vault)).toContain('Helen Marsh');
    expect(Object.values(eob.vault)).toContain('James R. Okafor');
    expect(eob.text).not.toMatch(/kafor|arsh\b/);
    const t = 'Seen by Dr. J. Patel and Dr. Mary K. O’Neil today.';
    const r = redact(t, patternSpans(t));
    expect(r.text).toBe('Seen by Dr. [NAME_1] and Dr. [NAME_2] today.');
  });

  it('no mark starts or ends in the middle of a word, on any sample', () => {
    for (const sample of SAMPLES) {
      const r = redact(sample.text, patternSpans(sample.text));
      for (const m of r.marks) {
        const before = sample.text[m.start - 1] ?? ' ';
        const after = sample.text[m.end] ?? ' ';
        const cut = `${sample.id}: "${sample.text.slice(m.start - 3, m.end + 3)}"`;
        expect(/[A-Za-z0-9]/.test(before), cut).toBe(false);
        expect(/[A-Za-z0-9]/.test(after), cut).toBe(false);
      }
    }
  });

  it('same value gets the same placeholder, and rehydrate restores it', () => {
    const { text, r } = run('er');
    const names = r.marks.filter((m) => text.slice(m.start, m.end) === 'Maria Delgado').map((m) => m.placeholder);
    expect(new Set(names).size).toBe(1);
    expect(rehydrate(`Dear billing office, I am ${names[0]}.`, r.vault)).toContain('Maria Delgado');
  });

  it('leak gate catches a vault value in outbound text and passes clean text', () => {
    const { r } = run('er');
    expect(findLeaks(r.text, r.vault)).toEqual([]);
    expect(findLeaks('please help maria delgado', r.vault).length).toBeGreaterThan(0);
  });

  it('a typed question is scrubbed with the vault', () => {
    const { r } = run('er');
    const q = scrubWithVault('Why was Delgado charged twice on account 7741-208-3391?', r.vault);
    expect(q).not.toMatch(/Delgado|7741/);
  });

  it('a span that wraps across lines is split per line and keeps the line break', () => {
    const text = 'by Dr. X (Summit Emergency\nPhysicians Group) are';
    const start = text.indexOf('Summit');
    const r = redact(text, [{ start, end: text.indexOf(')'), kind: 'PROVIDER', source: 'model' }]);
    expect(r.text).toBe('by Dr. X ([PROVIDER_1]\n[PROVIDER_2]) are');
    expect(Object.values(r.vault)).toEqual(['Summit Emergency', 'Physicians Group']);
  });

  it('does not black out money, codes or service dates', () => {
    const text = 'Patient Responsibility: $420.00\nCPT 99214 on 08/04/2026\nTotal Balance Due 1,894.00';
    expect(redact(text, patternSpans(text)).text).toBe(text);
  });
});
