import { describe, expect, it, vi } from 'vitest';

vi.mock('./models', () => ({ redactorModel: () => ({}), userTurn: (p: string) => p }));
import { acceptItem, chunkLines, isTableRow } from './redactor';
import { SAMPLES } from '../lib/samples';

const er = SAMPLES[0].text;

describe('checks on what the on-device model returns', () => {
  it('accepts real providers and people that are quoted from the bill', () => {
    expect(acceptItem('LAKEMONT REGIONAL MEDICAL CENTER', 'PROVIDER', er)).toBe('PROVIDER');
    expect(acceptItem('Summit Emergency\nPhysicians Group'.replace('\n', ' '), 'PROVIDER', er.replace(/\n/g, ' '))).toBe('PROVIDER');
    expect(acceptItem('Dr. Alan Whitcombe', 'PERSON', er)).toBe('NAME');
    expect(acceptItem('Maria Delgado', 'PERSON', er)).toBe('NAME');
  });
  it('rejects service lines, departments, codes, amounts and insurers', () => {
    for (const bad of ['EMERGENCY DEPARTMENT', 'ED VISIT LEVEL 5 HIGH COMPLEXITY', 'XR CHEST 2 VIEWS', 'Patient Financial Services']) {
      expect(acceptItem(bad, 'PROVIDER', er), bad).toBeNull();
    }
    for (const bad of ['Patient Financial Services', 'STATEMENT DATE: 10/28/2026', 'DATE OF SERVICE: 09/19/2026', 'EMERGENCY DEPARTMENT', '09/19/2026', 'J1885']) {
      expect(acceptItem(bad, 'OTHER_ID', er), bad).toBeNull();
      expect(acceptItem(bad, 'EMPLOYER', er), bad).toBeNull();
    }
    expect(acceptItem('26-091187', 'OTHER_ID', SAMPLES[2].text)).toBe('OTHER');
    expect(acceptItem('99285', 'OTHER_ID', er)).toBeNull();
    expect(acceptItem('2,840.00', 'OTHER_ID', er)).toBeNull();
    expect(acceptItem('Buckeye Mutual PPO', 'PROVIDER', er)).toBeNull();
  });
  it('rejects anything the model did not quote from the bill', () => {
    expect(acceptItem('John Smith', 'PERSON', er)).toBeNull();
    expect(acceptItem('Mercy Hospital', 'PROVIDER', er)).toBeNull();
  });
  it('table rows are recognised and kept away from the model', () => {
    expect(isTableRow('99285    ED VISIT LEVEL 5 HIGH COMPLEXITY               1    2,840.00')).toBe(true);
    expect(isTableRow('CODE     DESCRIPTION                                   QTY     CHARGE')).toBe(true);
    expect(isTableRow('82306    VITAMIN D 25 HYDROXY         142.00     0.00      0.00    142.00   CO-50')).toBe(true);
    expect(isTableRow('Patient: Maria Delgado                     Account Number: 7741-208-3391')).toBe(false);
    expect(isTableRow('NOTE: Physician services by Dr. Alan Whitcombe (Summit Emergency')).toBe(false);
  });
  it('chunks cover the text without exceeding the budget by more than a line', () => {
    const chunks = chunkLines(er, 600);
    expect(chunks.map((c) => c.text).join('')).toBe(er + '\n');
    expect(chunks.length).toBeGreaterThan(2);
  });
});
