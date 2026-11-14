/**
 * Shareable cases. Only redacted material is ever written: the redacted bill,
 * the analysis and the letter with its placeholders. The document id is a
 * 128-bit random secret; Firestore rules allow get and create by id and nothing
 * else, so a case can be read only by someone holding its link.
 */
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import type { Analysis } from '../ai/analyst';
import { findLeaks, type Vault } from './redaction';

export interface SharedCase { redacted: string; analysis: Analysis; letter: string }

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

export async function saveCase(c: SharedCase, vault: Vault): Promise<string> {
  const body = JSON.stringify(c);
  const leaks = findLeaks(body, vault);
  if (leaks.length) throw new Error('Blocked: this case still contains personal details.');
  const id = newId();
  await setDoc(doc(db, 'cases', id), { v: 1, redacted: c.redacted, analysis: JSON.stringify(c.analysis), letter: c.letter, createdAt: serverTimestamp() });
  return id;
}

export async function loadCase(id: string): Promise<SharedCase | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const snap = await getDoc(doc(db, 'cases', id));
  if (!snap.exists()) return null;
  const d = snap.data() as { redacted: string; analysis: string; letter: string };
  return { redacted: d.redacted, analysis: JSON.parse(d.analysis) as Analysis, letter: d.letter };
}
