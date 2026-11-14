/**
 * One place where every Firebase AI Logic model is built, so the inference mode
 * of each step is a decision you can read:
 *
 *   redactor  ONLY_ON_DEVICE    the raw bill may never reach the cloud
 *   analyst   PREFER_IN_CLOUD   needs the big model; offline falls back to the device
 *   helper    PREFER_ON_DEVICE  short follow-ups: free and private when a local model exists
 *   writer    ONLY_IN_CLOUD     the dispute letter is long-form; quality matters
 */
import {
  getGenerativeModel, InferenceMode, InferenceSource,
  type GenerateContentRequest, type GenerativeModel, type HybridParams, type ObjectSchema,
} from 'firebase/ai';
import { ai } from '../firebase';
import type { Where } from '../lib/ledger';

type JsonSchema = Record<string, unknown>;

const text = (value: string) => ({ type: 'text' as const, value });
const system = (s: string) => [{ role: 'system' as const, content: [text(s)] }];
const EN = { expectedInputs: [{ type: 'text' as const, languages: ['en'] }], expectedOutputs: [{ type: 'text' as const, languages: ['en'] }] };

/**
 * `?device=off` makes the app behave as it does in a browser with no on-device
 * model, so the fallback path can be tried on any machine.
 */
export const deviceForcedOff = new URLSearchParams(location.search).get('device') === 'off';

function build(params: HybridParams): GenerativeModel {
  if (deviceForcedOff) {
    if (params.mode === InferenceMode.ONLY_ON_DEVICE) throw new Error('on-device model switched off for this session');
    return getGenerativeModel(ai, { ...params, mode: InferenceMode.ONLY_IN_CLOUD });
  }
  return getGenerativeModel(ai, params);
}

export function redactorModel(systemPrompt: string, schema: JsonSchema, signal?: AbortSignal) {
  return build({
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: { ...EN, initialPrompts: system(systemPrompt) },
      // `signal` is a Prompt API option the SDK passes through to session.prompt().
      promptOptions: { responseConstraint: schema, ...(signal ? { signal } : {}) } as { responseConstraint: object },
    },
  });
}

export function analystModel(cloudModel: string, systemPrompt: string, cloudSchema: ObjectSchema, deviceSystemPrompt: string, deviceSignal: AbortSignal) {
  return build({
    mode: InferenceMode.PREFER_IN_CLOUD,
    inCloudParams: {
      model: cloudModel,
      systemInstruction: systemPrompt,
      generationConfig: { responseMimeType: 'application/json', responseSchema: cloudSchema, temperature: 0.2 },
    },
    // Reached only when the cloud call fails. `signal` is a Prompt API option the SDK passes through.
    onDeviceParams: {
      createOptions: { ...EN, initialPrompts: system(deviceSystemPrompt) },
      promptOptions: { signal: deviceSignal } as unknown as { responseConstraint?: object },
    },
  });
}

export function helperModel(cloudModel: string, systemPrompt: string) {
  return build({
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: { model: cloudModel, systemInstruction: systemPrompt, generationConfig: { temperature: 0.3, maxOutputTokens: 500 } },
    onDeviceParams: { createOptions: { ...EN, initialPrompts: system(systemPrompt) } },
  });
}

export function writerModel(cloudModel: string, systemPrompt: string) {
  return build({
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: { model: cloudModel, systemInstruction: systemPrompt, generationConfig: { temperature: 0.4 } },
  });
}

export const userTurn = (prompt: string): GenerateContentRequest => ({ contents: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }] });

export const whereOf = (source: InferenceSource | undefined): Where =>
  source === InferenceSource.ON_DEVICE ? 'on_device' : 'in_cloud';

/** What Chrome says about the local model, for the status pill. */
export type DeviceStatus = 'checking' | 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface LanguageModelGlobal { availability(options?: unknown): Promise<string> }

export async function deviceStatus(): Promise<DeviceStatus> {
  const lm = (globalThis as unknown as { LanguageModel?: LanguageModelGlobal }).LanguageModel;
  if (!lm || deviceForcedOff) return 'unavailable';
  try {
    const a = await lm.availability(EN);
    return a === 'available' || a === 'downloadable' || a === 'downloading' ? a : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

interface WarmSession { destroy(): void }
let warm: Promise<WarmSession> | null = null;

/**
 * Loading the on-device model into memory is the slow part (a minute on older laptops), and Chrome
 * unloads it when no session is open. Opening one idle session at page load moves that wait to
 * before the user needs it and keeps the model resident for the Firebase AI Logic calls that follow.
 * This only touches the browser's Prompt API; no prompt is sent and nothing leaves the device.
 */
export function warmDevice(): Promise<boolean> {
  const lm = (globalThis as unknown as { LanguageModel?: LanguageModelGlobal & { create(options?: unknown): Promise<WarmSession> } }).LanguageModel;
  if (!lm || deviceForcedOff) return Promise.resolve(false);
  warm ??= lm.create(EN);
  return warm.then(() => true, () => { warm = null; return false; });
}
