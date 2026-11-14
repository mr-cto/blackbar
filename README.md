# Blackbar

**Understand a medical bill without handing over who you are.**

Blackbar blacks out your name, address and account numbers on your own device, shows you exactly what is
left, and only then asks a cloud model what the charges mean, which ones look wrong, and how to dispute
them. The finished letter gets your details back on your device. The cloud never sees them.

Built for [#BuildHybridAI 2026](https://firebasehybridaihackathon.devpost.com/) with
**Firebase AI Logic hybrid inference**.

## Why

Medical bills are hard to read and often wrong, so people paste them into chatbots. A bill carries a name,
home address, date of birth, member ID, account number and a diagnosis in one document. Most people would
rather not send that anywhere, and they are right.

The usual answer is "run everything locally" (too weak to reason about billing codes) or "trust the cloud"
(the thing people are worried about). Blackbar uses each side for the part only it can do.

## How hybrid inference is used

The on-device model is the privacy boundary, not a cheaper fallback. Each step has its own inference mode,
set in one file: [`web/src/ai/models.ts`](web/src/ai/models.ts).

| Step | What happens | Mode | If that side is missing |
|---|---|---|---|
| 1. Black out | Rules mark everything with a shape (IDs, dates of birth, phones, addresses, labelled names). The on-device model then reads the raw bill in small pieces and names what rules cannot: clinicians, clinics, employers. | `ONLY_ON_DEVICE` | Rules plus your own review. There is no cloud fallback for raw text, by construction. |
| 2. You approve | Side by side: the bill on your device, and the bill as the cloud will see it. Tap a word to black it out, tap a mark to restore it. | none | |
| 3. Read | The redacted bill is explained line by line, with likely errors and what to ask. Structured output, streamed. | `PREFER_IN_CLOUD` | If the cloud cannot be reached, the on-device model streams a short plain-text read of the same redacted text. |
| 4. Ask | Short follow-up questions, streamed. | `PREFER_ON_DEVICE` | No local model: the redacted question goes to the cloud. |
| 5. Letter | A dispute letter written around placeholders like `[NAME_1]`, streamed. | `ONLY_IN_CLOUD` | Needs a connection. |
| 6. Fill in | Placeholders are swapped for your real details. | no model | Always local. |

Every answer shows where it ran, read from `response.inferenceSource`. A ledger ("What left this device")
lists every model call, its mode, and the exact text that was sent.

Three deterministic guards sit around the models:

- **Model output is checked before it is trusted.** An item the on-device model returns is used only if it
  is quoted from the bill and is not a code, an amount or an insurer ([`acceptItem`](web/src/ai/redactor.ts)).
- **A leak gate runs before every cloud-capable call.** If any value held in the local vault is still in
  the outbound text, the call is refused ([`findLeaks`](web/src/lib/redaction.ts)).
- **Typed questions are scrubbed** with the same vault before they are used.

## Firebase products

- **Firebase AI Logic** (Gemini Developer API backend): all model calls, on-device and cloud.
- **App Check** (reCAPTCHA Enterprise; debug token for local development).
- **Remote Config**: cloud model name, on-device piece size, share switch, notice line.
- **Cloud Firestore**: optional shareable case holding redacted material only. The document id is a
  128-bit secret; [rules](firestore.rules) allow `get` and `create` by id and nothing else.
- **Firebase Hosting**.

## Platforms

| Where | On-device model | Status |
|---|---|---|
| Chrome desktop 139+ | Gemini Nano through the Prompt API | Built and tested end to end. |
| Any other browser, phones included | none | Works: rules and your review do the redaction, the cloud does the rest. Tested in WebKit at phone width. |

Native iOS (Apple Foundation Models) and Android (Gemini Nano) clients are not part of this repository.
The same four-mode design maps onto the Firebase AI Logic hybrid APIs for those platforms.

Add `?device=off` to the URL to see the no-on-device behaviour in Chrome.

## Run it

Requirements: Node 22, a Firebase project with AI Logic enabled (Gemini Developer API, free tier), Chrome
139 or newer on a desktop that [meets Chrome's on-device requirements](https://developer.chrome.com/docs/ai/get-started#hardware).

```bash
cd web
npm install
cp .env.example .env.local   # fill in your Firebase web app config
npm run dev                  # http://localhost:5199
```

For local development set `VITE_APPCHECK_DEBUG_TOKEN=true`, open the console, copy the printed debug
token and register it under App Check in the Firebase console. Then:

```bash
npm test         # deterministic redaction tests
npm run build    # type-check and production build to web/dist
```

Deploy rules and hosting with the Firebase CLI: `firebase deploy --only firestore:rules,hosting`.

To try the on-device path, open the app in Chrome and watch the pill in the header. The model is loaded
into memory when the page opens ("On-device model loading", then "ready"), which can take a minute on
older hardware. `scripts/walkthrough.mjs` drives the hosted app through the no-on-device path with
Playwright and saves screenshots.

## Project layout

```
web/src/ai/models.ts      every Firebase AI Logic model and its inference mode
web/src/ai/redactor.ts    on-device pass: prompt, schema, validation of model output
web/src/ai/analyst.ts     cloud analysis, letter and follow-up, each behind the leak gate
web/src/lib/patterns.ts   deterministic redaction rules
web/src/lib/redaction.ts  spans, placeholders, vault, rehydrate, leak gate
web/src/lib/cases.ts      shareable redacted cases in Firestore
web/src/App.tsx           the four screens
firestore.rules           capability-link rules for redacted cases
scripts/walkthrough.mjs   Playwright walkthrough of the hosted app
```

## Limits, stated plainly

- Redaction is not perfect. Rules and a small on-device model will miss things, which is why step 2 exists
  and why the leak gate only knows about values that were found. Read the right-hand pane before you send.
- Dates of service, procedure codes, amounts and the insurer's name are kept on purpose; the analysis needs
  them. Taken together they are far less identifying than a name and member ID, but they are not nothing.
- The on-device model has a small context window, so the bill is read in pieces. A piece that takes too
  long is dropped and left to the rules; the interface says so.
- Blackbar gives information, not medical, legal or financial advice.
- All sample bills in this repository are invented. Any resemblance to a real person or provider is
  coincidental.

## What was built during the contest

Everything in this repository was written during the submission period (Nov 11 to Nov 30, 2026). No
pre-existing application code was reused. Development used an AI coding assistant.

## License

[Apache 2.0](LICENSE).
