/**
 * Firebase wiring: App Check (required by Firebase AI Logic), AI Logic with the
 * Gemini Developer API backend, Firestore for redacted cases, Remote Config for
 * the knobs we want to turn without shipping a build.
 */
import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, GoogleAIBackend } from 'firebase/ai';
import { getFirestore } from 'firebase/firestore';
import { fetchAndActivate, getRemoteConfig, getValue } from 'firebase/remote-config';

const env = import.meta.env;

const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
});

// Local development and CI use an App Check debug token; production attests with reCAPTCHA Enterprise.
if (env.VITE_APPCHECK_DEBUG_TOKEN) {
  (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
    env.VITE_APPCHECK_DEBUG_TOKEN === 'true' ? true : env.VITE_APPCHECK_DEBUG_TOKEN;
}
if (env.VITE_RECAPTCHA_ENTERPRISE_KEY) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(env.VITE_RECAPTCHA_ENTERPRISE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

export const ai = getAI(app, { backend: new GoogleAIBackend() });
export const db = getFirestore(app);

export interface Knobs {
  /** Cloud model for the bill analysis and the letter. */
  cloudModel: string;
  /** Upper bound on characters handed to the on-device model per redaction pass. */
  chunkChars: number;
  /** Turn shareable redacted cases on or off. */
  cloudSave: boolean;
  /** Optional one-line notice shown under the header. */
  notice: string;
}

const DEFAULTS: Knobs = { cloudModel: 'gemini-3.5-flash-lite', chunkChars: 600, cloudSave: true, notice: '' };

export async function loadKnobs(): Promise<Knobs> {
  try {
    const rc = getRemoteConfig(app);
    rc.settings.minimumFetchIntervalMillis = 10 * 60 * 1000;
    rc.settings.fetchTimeoutMillis = 4000;
    rc.defaultConfig = {
      cloud_model: DEFAULTS.cloudModel, chunk_chars: DEFAULTS.chunkChars,
      cloud_save: DEFAULTS.cloudSave, notice: DEFAULTS.notice,
    };
    await fetchAndActivate(rc);
    return {
      cloudModel: getValue(rc, 'cloud_model').asString() || DEFAULTS.cloudModel,
      chunkChars: getValue(rc, 'chunk_chars').asNumber() || DEFAULTS.chunkChars,
      cloudSave: getValue(rc, 'cloud_save').asBoolean(),
      notice: getValue(rc, 'notice').asString(),
    };
  } catch {
    return DEFAULTS; // offline or blocked: the app still works on defaults
  }
}
