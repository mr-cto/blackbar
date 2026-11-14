import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyse, ask, LeakError, writeLetter, type Analysis } from './ai/analyst';
import { deviceStatus, redactorModel, type DeviceStatus } from './ai/models';
import { modelSpans } from './ai/redactor';
import { loadKnobs, type Knobs } from './firebase';
import { loadCase, saveCase, type SharedCase } from './lib/cases';
import { newEntry, type LedgerEntry } from './lib/ledger';
import { patternSpans } from './lib/patterns';
import { redact, rehydrate, scrubWithVault, type Span } from './lib/redaction';
import { SAMPLES } from './lib/samples';
import { BillPanes } from './ui/BillPanes';
import { Ledger } from './ui/Ledger';
import { ms, Section, Spinner, WhereBadge } from './ui/bits';

type Stage = 'start' | 'redact' | 'read' | 'letter';
type Pass =
  | { state: 'idle' }
  | { state: 'waking'; since: number }
  | { state: 'running'; done: number; total: number }
  | { state: 'done'; ms: number; found: number }
  | { state: 'none'; reason: string };

interface QA { q: string; a: string; where?: 'on_device' | 'in_cloud'; busy: boolean }

const OWN_KEY = 'blackbar.own.v1';
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

export function App() {
  const sharedId = useMemo(() => /^#\/c\/([0-9a-f]{32})$/.exec(location.hash)?.[1] ?? null, []);
  if (sharedId) return <SharedView id={sharedId} />;
  return <Workbench />;
}

function Workbench() {
  const [knobs, setKnobs] = useState<Knobs | null>(null);
  const [device, setDevice] = useState<DeviceStatus>('checking');
  const [download, setDownload] = useState<number | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [stage, setStage] = useState<Stage>('start');

  const [raw, setRaw] = useState('');
  const [ownNames, setOwnNames] = useState(() => localStorage.getItem(OWN_KEY) ?? '');
  const [modelFound, setModelFound] = useState<Span[]>([]);
  const [manual, setManual] = useState<Span[]>([]);
  const [restored, setRestored] = useState<Array<{ start: number; end: number }>>([]);
  const [pass, setPass] = useState<Pass>({ state: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisWhere, setAnalysisWhere] = useState<'on_device' | 'in_cloud'>('in_cloud');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qa, setQa] = useState<QA[]>([]);
  const [question, setQuestion] = useState('');
  const [letter, setLetter] = useState('');
  const [letterBusy, setLetterBusy] = useState(false);
  const [mine, setMine] = useState(true);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const log = useCallback((e: LedgerEntry) => setLedger((l) => [...l, e]), []);

  useEffect(() => { loadKnobs().then(setKnobs); }, []);
  useEffect(() => { deviceStatus().then(setDevice); }, []);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => { localStorage.setItem(OWN_KEY, ownNames); }, [ownNames]);

  const own = useMemo(() => ({ names: ownNames.split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length > 2), extras: [] }), [ownNames]);
  const fromPatterns = useMemo(() => patternSpans(raw, own), [raw, own]);
  const spans = useMemo(
    () => [...fromPatterns, ...modelFound, ...manual].filter((s) => !restored.some((r) => overlaps(s, r))),
    [fromPatterns, modelFound, manual, restored],
  );
  const redacted = useMemo(() => redact(raw, spans), [raw, spans]);
  const counts = useMemo(() => {
    const c = { pattern: 0, model: 0, you: 0 };
    for (const m of redacted.marks) c[m.source]++;
    return c;
  }, [redacted.marks]);

  /** Step 1: patterns are instant; the on-device model then reads the bill piece by piece. */
  const startRedaction = useCallback(async (text: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRaw(text); setModelFound([]); setManual([]); setRestored([]);
    setAnalysis(null); setLetter(''); setQa([]); setShareUrl(null); setError(null);
    setStage('redact');
    window.scrollTo({ top: 0 });

    const t0 = performance.now();
    log(newEntry({ step: 'Black out: rules', mode: 'deterministic', where: 'rules', ms: 1, sentChars: 0, sent: '', note: 'Pattern matching in this tab. No model, no network.' }));

    const status = await deviceStatus();
    setDevice(status);
    if (status === 'unavailable') {
      setPass({ state: 'none', reason: 'This browser has no on-device model, so the rules did the first pass. Check the bill and tap anything they missed. Nothing is sent to the cloud to find your details.' });
      return;
    }
    setPass({ state: 'waking', since: Date.now() });
    try {
      const found = await modelSpans(text, knobs?.chunkChars ?? 900, (p) => {
        if (ac.signal.aborted) return;
        setModelFound(p.spans);
        setPass({ state: 'running', done: p.done, total: p.total });
      }, ac.signal);
      if (ac.signal.aborted) return;
      const elapsed = performance.now() - t0;
      setModelFound(found);
      setPass({ state: 'done', ms: elapsed, found: found.length });
      log(newEntry({ step: 'Black out: on-device model', mode: 'ONLY_ON_DEVICE', where: 'on_device', ms: elapsed, sentChars: 0, sent: '', note: 'The raw bill was read by the model inside this browser.' }));
    } catch (e) {
      if (ac.signal.aborted) return;
      setPass({ state: 'none', reason: `The on-device model could not run (${e instanceof Error ? e.message : 'unknown error'}). The rules did the first pass; check the bill and tap anything they missed.` });
    }
  }, [knobs, log]);

  const downloadModel = async () => {
    setDownload(0);
    try {
      await redactorModel('You are a helpful assistant.', { type: 'object' }).initializeDeviceModel((p) => setDownload(p));
    } finally {
      setDevice(await deviceStatus());
      setDownload(null);
    }
  };

  const fail = (e: unknown) => {
    if (e instanceof LeakError) setError(`${e.message} Nothing was sent. Go back and black them out: ${e.leaks.slice(0, 3).join(', ')}`);
    else setError(e instanceof Error ? e.message : 'Something went wrong.');
  };

  /** Step 3: the redacted bill goes to the cloud model (or the device if the cloud is unreachable). */
  const read = async () => {
    abortRef.current?.abort();
    setError(null); setAnalysis(null); setQa([]); setLetter(''); setShareUrl(null);
    setBusy(online ? 'Reading the redacted bill' : 'No connection, so the on-device model is reading the redacted bill. This is slower');
    setStage('read');
    window.scrollTo({ top: 0 });
    try {
      const { analysis: a, entry } = await analyse(redacted.text, redacted.vault, knobs?.cloudModel ?? 'gemini-3.5-flash-lite');
      setAnalysis(a); setAnalysisWhere(entry.where === 'on_device' ? 'on_device' : 'in_cloud'); log(entry);
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const askQuestion = async (qRaw: string) => {
    const q = scrubWithVault(qRaw.trim(), redacted.vault); // the question is scrubbed too
    if (!q) return;
    setQuestion('');
    const index = qa.length;
    setQa((l) => [...l, { q: qRaw.trim(), a: '', busy: true }]);
    try {
      const { answer, entry } = await ask(q, redacted.text, redacted.vault, knobs?.cloudModel ?? 'gemini-3.5-flash-lite', (soFar) =>
        setQa((l) => l.map((x, i) => (i === index ? { ...x, a: soFar } : x))));
      setQa((l) => l.map((x, i) => (i === index ? { ...x, a: answer, busy: false, where: entry.where === 'on_device' ? 'on_device' : 'in_cloud' } : x)));
      log(entry);
    } catch (e) {
      setQa((l) => l.map((x, i) => (i === index ? { ...x, a: e instanceof Error ? e.message : 'Could not answer.', busy: false } : x)));
    }
  };

  /** Step 4: the cloud writes around placeholders; this device fills them in. */
  const draft = async () => {
    if (!analysis) return;
    setError(null); setLetter(''); setLetterBusy(true); setStage('letter');
    window.scrollTo({ top: 0 });
    try {
      const { letter: l, entry } = await writeLetter(redacted.text, analysis, redacted.vault, knobs?.cloudModel ?? 'gemini-3.5-flash-lite', setLetter);
      setLetter(l); log(entry);
    } catch (e) { fail(e); } finally { setLetterBusy(false); }
  };

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const personal = useMemo(() => rehydrate(letter, redacted.vault).replace(/\[Today[’']s date\]/gi, today), [letter, redacted.vault, today]);

  /** Model output mentions placeholders; this device swaps the real details back in for display. */
  const show = useCallback((t: string) => rehydrate(t, redacted.vault), [redacted.vault]);

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1800);
  };

  const share = async () => {
    if (!analysis) return;
    setError(null); setBusy('Saving the redacted case');
    try {
      const id = await saveCase({ redacted: redacted.text, analysis, letter }, redacted.vault);
      const url = `${location.origin}/#/c/${id}`;
      setShareUrl(url);
      log(newEntry({ step: 'Share redacted case', mode: 'Firestore', where: 'in_cloud', ms: 0, sentChars: redacted.text.length + letter.length, sent: 'The redacted bill, the analysis and the letter with placeholders. No vault values.' }));
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const steps: Array<[Stage, string]> = [['start', 'Bill'], ['redact', 'Black out'], ['read', 'Read'], ['letter', 'Letter']];
  const reach: Record<Stage, boolean> = { start: true, redact: !!raw, read: !!analysis, letter: !!letter };

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => setStage('start')} aria-label="Blackbar, start over">
          <span className="brand-mark" aria-hidden="true" />Blackbar
        </button>
        <nav className="steps" aria-label="Progress">
          {steps.map(([s, label], i) => (
            <button key={s} disabled={!reach[s]} aria-current={stage === s ? 'step' : undefined} onClick={() => setStage(s)}>
              <b>{i + 1}</b>{label}
            </button>
          ))}
        </nav>
        <div className="top-right">
          <DevicePill device={device} online={online} />
          <button className="ghost ledger-btn" onClick={() => setLedgerOpen(true)} data-testid="open-ledger">
            What left this device{ledger.length ? ` (${ledger.filter((e) => e.where === 'in_cloud').length})` : ''}
          </button>
        </div>
      </header>

      {knobs?.notice && <p className="notice">{knobs.notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {stage === 'start' && (
        <main className="start">
          <div className="hero">
            <p className="eyebrow">Private medical bill help</p>
            <h1>Understand the bill.<br />Keep your <span className="strike">name</span> out&nbsp;of&nbsp;it.</h1>
            <p className="lede">
              Blackbar blacks out your name, address and account numbers <em>on this device</em>, shows you exactly what is
              left, and only then asks a cloud model what the charges mean and whether any look wrong.
            </p>
            <ol className="how">
              <li><WhereBadge where="on_device" /><span>Your details are found and blacked out here.</span></li>
              <li><span className="where where-you"><i aria-hidden="true" />You</span><span>You see what will be sent, and change it.</span></li>
              <li><WhereBadge where="in_cloud" /><span>The cloud reads a bill with no one's name on it.</span></li>
              <li><WhereBadge where="on_device" /><span>Your details go back into the letter, here.</span></li>
            </ol>
          </div>

          <div className="intake">
            <label htmlFor="bill">Paste your bill or explanation of benefits</label>
            <textarea
              id="bill" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false}
              placeholder="Paste the text of a medical bill, hospital statement or insurance EOB…"
            />
            <div className="samples">
              <span>No bill handy? Try an invented one:</span>
              {SAMPLES.map((s) => (
                <button key={s.id} className="chip" onClick={() => startRedaction(s.text)} title={s.blurb} data-testid={`sample-${s.id}`}>{s.title}</button>
              ))}
            </div>
            <label htmlFor="own" className="own-label">Names to always black out <span>(optional, stored only in this browser)</span></label>
            <input id="own" value={ownNames} onChange={(e) => setOwnNames(e.target.value)} placeholder="e.g. Maria Delgado, Tomás Delgado" autoComplete="off" />
            <div className="intake-actions">
              <button className="primary" disabled={raw.trim().length < 40} onClick={() => startRedaction(raw)} data-testid="start">
                Black out my details
              </button>
              {device === 'downloadable' && download == null && (
                <button className="ghost" onClick={downloadModel}>Download the on-device model (one time)</button>
              )}
              {download != null && <Spinner label={`Downloading the on-device model ${Math.round(download * 100)}%`} />}
            </div>
            <p className="fine">Nothing you paste is uploaded at this step. Information only, not medical, legal or financial advice.</p>
          </div>
        </main>
      )}

      {stage === 'redact' && (
        <main className="redact">
          <div className="redact-head">
            <div>
              <h1>Check what gets blacked out</h1>
              <p className="lede small">The left side never leaves this device. The right side is the only thing the cloud will read.</p>
            </div>
            <div className="tally" data-testid="tally">
              <span className="tally-item"><i className="sw sw-pattern" />{counts.pattern} by rules</span>
              <span className="tally-item"><i className="sw sw-model" />{counts.model} by the on-device model</span>
              <span className="tally-item"><i className="sw sw-you" />{counts.you} by you</span>
            </div>
          </div>

          <PassStatus pass={pass} />

          <BillPanes
            raw={raw} redacted={redacted}
            onBlackOut={(start, end) => {
              setRestored((r) => r.filter((x) => !overlaps(x, { start, end })));
              setManual((m) => [...m, { start, end, kind: 'OTHER', source: 'you' }]);
            }}
            onRestore={(start, end) => {
              setManual((m) => m.filter((x) => !overlaps(x, { start, end })));
              setRestored((r) => [...r, { start, end }]);
            }}
          />

          <footer className="actionbar">
            <span className="actionbar-note">
              {redacted.marks.length} details stay on this device. {redacted.text.length.toLocaleString()} characters would be sent.
            </span>
            <button className="primary" onClick={read} disabled={!online && device !== 'available'} data-testid="read">
              {pass.state === 'waking' || pass.state === 'running' ? 'Looks right, read it now' : 'Looks right. Read my bill'}
            </button>
          </footer>
        </main>
      )}

      {stage === 'read' && (
        <main className="read">
          {busy && !analysis && <div className="waiting"><Spinner label={`${busy}…`} /><p className="muted">Only the blacked-out version is being read.</p></div>}
          {analysis && (
            <>
              <div className="read-head">
                <div>
                  <p className="eyebrow">{analysis.documentType}</p>
                  <h1>{analysis.youOwe && analysis.youOwe !== 'not stated' ? <>You are being asked for <span className="amount">{analysis.youOwe}</span></> : 'Here is what this says'}</h1>
                </div>
                <WhereBadge where={analysisWhere} />
              </div>
              <p className="summary" data-testid="summary">{show(analysis.summary)}</p>

              {analysis.findings.length > 0 && (
                <Section title="Worth raising" aside={<span className="count">{analysis.findings.length}</span>}>
                  <ul className="findings">
                    {analysis.findings.map((f, i) => (
                      <li key={i} className={`finding sev-${f.severity}`}>
                        <div className="finding-top"><span className="sev">{f.severity}</span><h3>{show(f.title)}</h3></div>
                        <p>{show(f.detail)}</p>
                        <p className="ask-line"><b>Ask:</b> {show(f.ask)}</p>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section title="Line by line">
                <div className="lines" role="table">
                  {analysis.lines.map((l, i) => (
                    <div key={i} className={`line v-${l.verdict}`} role="row">
                      <span className="line-code">{l.code}</span>
                      <span className="line-main"><b>{show(l.label)}</b><span>{show(l.plain)}</span>{l.note && <em>{show(l.note)}</em>}</span>
                      <span className="line-amt">{l.amount}</span>
                      <span className="line-verdict">{l.verdict === 'looks_normal' ? 'Looks normal' : l.verdict === 'worth_asking' ? 'Worth asking' : 'Likely error'}</span>
                    </div>
                  ))}
                </div>
              </Section>

              <Section title="Ask about this bill" aside={<span className="muted small">Answered on this device when it can be</span>}>
                <div className="qa">
                  {qa.map((x, i) => (
                    <div key={i} className="qa-item">
                      <p className="qa-q">{x.q}</p>
                      <p className="qa-a" data-testid="answer">{show(x.a.trim()) || (x.busy ? '…' : '')}</p>
                      {x.busy ? <Spinner label="Thinking" /> : x.where && <WhereBadge where={x.where} />}
                    </div>
                  ))}
                  <div className="qa-suggest">
                    {(analysis.questions.length ? analysis.questions.slice(0, 3) : ['What is a contractual adjustment?']).map((q) => (
                      <button key={q} className="chip" onClick={() => askQuestion(q)}>{q}</button>
                    ))}
                  </div>
                  <form className="qa-form" onSubmit={(e) => { e.preventDefault(); askQuestion(question); }}>
                    <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. What does CPT 99285 mean?" aria-label="Your question" data-testid="question" />
                    <button className="secondary" disabled={!question.trim()}>Ask</button>
                  </form>
                </div>
              </Section>

              <footer className="actionbar">
                <span className="actionbar-note">The letter is written around placeholders. Your details are added on this device.</span>
                <button className="primary" onClick={draft} disabled={!online} data-testid="draft">{online ? 'Draft my dispute letter' : 'Letter needs a connection'}</button>
              </footer>
            </>
          )}
        </main>
      )}

      {stage === 'letter' && (
        <main className="letter">
          <div className="letter-head">
            <div>
              <h1>Your letter</h1>
              <p className="lede small">The cloud wrote this without knowing who you are. Your device filled in the rest.</p>
            </div>
            <div className="toggle" role="group" aria-label="Letter view">
              <button aria-pressed={mine} onClick={() => setMine(true)} data-testid="view-mine">With my details<WhereBadge where="on_device" /></button>
              <button aria-pressed={!mine} onClick={() => setMine(false)} data-testid="view-cloud">As the cloud wrote it<WhereBadge where="in_cloud" /></button>
            </div>
          </div>
          <article className="sheet" data-testid="letter">
            {letterBusy && !letter && <Spinner label="Writing…" />}
            <LetterBody text={mine ? personal : letter} vault={redacted.vault} mine={mine} />
          </article>
          <footer className="actionbar">
            <span className="actionbar-note">{copied ? `${copied} copied.` : shareUrl ? <>Redacted case link: <a href={shareUrl}>{shareUrl.replace(/^https?:\/\//, '')}</a></> : 'Read it before you send it. You know your situation; the model does not.'}</span>
            <div className="actionbar-btns">
              {knobs?.cloudSave !== false && !shareUrl && <button className="ghost" onClick={share} disabled={letterBusy || !!busy || !online}>Share redacted case</button>}
              {shareUrl && <button className="ghost" onClick={() => copy(shareUrl, 'Link')}>Copy link</button>}
              <button className="secondary" onClick={() => window.print()} disabled={letterBusy}>Print</button>
              <button className="primary" onClick={() => copy(personal, 'Letter')} disabled={letterBusy || !letter}>Copy letter</button>
            </div>
          </footer>
        </main>
      )}

      {ledgerOpen && <Ledger entries={ledger} vaultSize={Object.keys(redacted.vault).length} onClose={() => setLedgerOpen(false)} />}
    </div>
  );
}

function DevicePill({ device, online }: { device: DeviceStatus; online: boolean }) {
  const text = {
    checking: 'Checking this device',
    available: 'On-device model ready',
    downloadable: 'On-device model not downloaded',
    downloading: 'On-device model downloading',
    unavailable: 'No on-device model here',
  }[device];
  return (
    <span className={`pill pill-${device}`} data-testid="device-pill" title={device === 'unavailable' ? 'Rules and your own review do the blacking out. Nothing is sent to find your details.' : undefined}>
      <i aria-hidden="true" />{text}{!online && ' · offline'}
    </span>
  );
}

function PassStatus({ pass }: { pass: Pass }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (pass.state !== 'waking') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [pass.state]);
  if (pass.state === 'idle') return null;
  return (
    <div className={`pass pass-${pass.state}`} data-testid="pass" data-state={pass.state}>
      {pass.state === 'waking' && <><Spinner label="Rules are done. Waking the on-device model" /><span className="muted">{Math.round((Date.now() - pass.since) / 1000)} s · the first run loads the model into memory</span></>}
      {pass.state === 'running' && <><Spinner label={`On-device model is reading piece ${Math.min(pass.done + 1, pass.total)} of ${pass.total}`} /><div className="meter"><i style={{ width: `${(pass.done / pass.total) * 100}%` }} /></div></>}
      {pass.state === 'done' && <><WhereBadge where="on_device" /><span>The on-device model read the whole bill in {ms(pass.ms)}. Nothing was sent.</span></>}
      {pass.state === 'none' && <><WhereBadge where="rules" /><span>{pass.reason}</span></>}
    </div>
  );
}

/** Renders the letter; in "my details" view, restored values are softly underlined so you can see what was filled in locally. */
function LetterBody({ text, vault, mine }: { text: string; vault: Record<string, string>; mine: boolean }) {
  const parts = useMemo(() => {
    const values = mine ? Object.values(vault).filter((v) => v.length > 2).sort((a, b) => b.length - a.length) : [];
    const re = mine
      ? (values.length ? new RegExp(`(${values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g') : null)
      : /(\[[A-Z_]+_\d+\])/g;
    return re ? text.split(re) : [text];
  }, [text, vault, mine]);
  return (
    <pre className="letter-text">
      {parts.map((p, i) => (i % 2 === 1
        ? (mine ? <span key={i} className="filled">{p}</span> : <span key={i} className="bar inline"><span>{p.slice(1, -1).replace(/_/g, ' ')}</span></span>)
        : <span key={i}>{p}</span>))}
    </pre>
  );
}

function SharedView({ id }: { id: string }) {
  const [state, setState] = useState<{ c: SharedCase | null; loaded: boolean }>({ c: null, loaded: false });
  useEffect(() => { loadCase(id).then((c) => setState({ c, loaded: true })).catch(() => setState({ c: null, loaded: true })); }, [id]);
  const c = state.c;
  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="/"><span className="brand-mark" aria-hidden="true" />Blackbar</a>
        <span className="pill pill-shared"><i aria-hidden="true" />Redacted case · read only</span>
      </header>
      <main className="read">
        {!state.loaded && <div className="waiting"><Spinner label="Opening the case…" /></div>}
        {state.loaded && !c && <p className="error">This case link is not valid.</p>}
        {c && (
          <>
            <p className="eyebrow">{c.analysis.documentType} · shared without identity</p>
            <h1>Someone asked you to look at this bill</h1>
            <p className="summary">{c.analysis.summary}</p>
            <Section title="Worth raising">
              <ul className="findings">
                {c.analysis.findings.map((f, i) => (
                  <li key={i} className={`finding sev-${f.severity}`}>
                    <div className="finding-top"><span className="sev">{f.severity}</span><h3>{f.title}</h3></div>
                    <p>{f.detail}</p><p className="ask-line"><b>Ask:</b> {f.ask}</p>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="The bill, as shared"><pre className="bill shared-bill">{c.redacted}</pre></Section>
            {c.letter && <Section title="Draft letter"><article className="sheet"><LetterBody text={c.letter} vault={{}} mine={false} /></article></Section>}
          </>
        )}
      </main>
    </div>
  );
}
