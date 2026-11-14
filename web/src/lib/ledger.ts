/** A plain record of every model call and what, if anything, left the device. */
export type Where = 'on_device' | 'in_cloud' | 'rules';

export interface LedgerEntry {
  id: number;
  at: number;
  step: string;
  mode: string;
  where: Where;
  /** Characters sent to Google. Zero for on-device and rules. */
  sentChars: number;
  /** Exactly what was sent, already redacted. Empty when nothing left. */
  sent: string;
  ms: number;
  note?: string;
}

let nextId = 1;
export const newEntry = (e: Omit<LedgerEntry, 'id' | 'at'>): LedgerEntry => ({ ...e, id: nextId++, at: Date.now() });
