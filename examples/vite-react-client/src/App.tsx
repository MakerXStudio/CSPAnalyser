import { Suspense, lazy, useState } from 'react';

const LazyPanel = lazy(() => import('./lazy-panel'));

const crossOriginBaseUrl = 'http://localhost:4174';

interface ProfileResponse {
  name: string;
  role: string;
}

function parseProfileResponse(value: unknown): ProfileResponse {
  if (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'role' in value &&
    typeof value.role === 'string'
  ) {
    return { name: value.name, role: value.role };
  }

  throw new Error('Unexpected profile response shape');
}

function appendInlineStyle(): void {
  const style = document.createElement('style');
  style.setAttribute('data-csp-scenario', 'dynamic-style');
  style.textContent = `.dynamic-style-target { outline: 4px solid #f97316; outline-offset: 4px; }`;
  document.head.appendChild(style);
}

function appendInlineScript(): void {
  const script = document.createElement('script');
  script.setAttribute('data-csp-scenario', 'dynamic-script');
  script.textContent =
    "window.__cspDynamicInlineScript = 'ran'; document.body.setAttribute('data-dynamic-inline-script', 'ran');";
  document.body.appendChild(script);
}

export function App() {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [crossOriginBeaconSent, setCrossOriginBeaconSent] = useState(false);
  const [dynamicStyle, setDynamicStyle] = useState(false);
  const [dynamicScript, setDynamicScript] = useState(false);
  const [dataImage, setDataImage] = useState(false);
  const [workerMessage, setWorkerMessage] = useState('');
  const [mediaVisible, setMediaVisible] = useState(false);
  const [frameVisible, setFrameVisible] = useState(false);
  const [crossOriginFrameVisible, setCrossOriginFrameVisible] = useState(false);
  const [objectVisible, setObjectVisible] = useState(false);
  const [formSubmitted, setFormSubmitted] = useState(false);
  const [lazyVisible, setLazyVisible] = useState(false);
  const [styleAttributeActive, setStyleAttributeActive] = useState(false);

  async function loadProfile(): Promise<void> {
    const response = await fetch('/api/profile.json');
    const data = parseProfileResponse(await response.json());
    setProfile(data);
  }

  function sendCrossOriginBeacon(): void {
    navigator.sendBeacon(`${crossOriginBaseUrl}/beacon`, 'csp-sample');
    setCrossOriginBeaconSent(true);
  }

  function addDynamicStyle(): void {
    appendInlineStyle();
    setDynamicStyle(true);
  }

  function addInlineScript(): void {
    appendInlineScript();
    setDynamicScript(true);
  }

  function startWorker(): void {
    const worker = new Worker('/workers/demo-worker.js');
    worker.addEventListener('message', (event: MessageEvent<string>) => {
      setWorkerMessage(event.data);
      worker.terminate();
    });
    worker.postMessage('ping');
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="hero-content">
          <div className="badge-group">
            <span className="status-pill">Vite</span>
            <span className="status-pill">React</span>
            <span className="status-pill highlight">Playwright CSP</span>
          </div>
          <h1>CSP scenario sample</h1>
          <p className="hero-desc">
            This app intentionally exercises local resource loads, inline content, dynamic imports,
            workers, forms, frames, and policy-relevant document directives so CSP Analyser can
            snapshot the resulting policy.
          </p>
        </div>
        <div className="hero-decoration">
          <div className="grid-overlay"></div>
        </div>
      </header>

      <div className="layout-grid">
        <div className="main-content">
          <div className="section-header">
            <h2>Execution Scenarios</h2>
            <div className="divider"></div>
          </div>
          <section className="scenario-grid" aria-label="CSP scenarios">
            <article
              className="scenario-card"
              data-testid="style-attr-card"
              style={{ borderColor: styleAttributeActive ? '#f97316' : '#e2e8f0' }}
            >
              <div className="card-header">
                <span className="scenario-id">DOM.01</span>
                <h3>Inline style attributes</h3>
              </div>
              <div className="card-actions">
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => setStyleAttributeActive((active) => !active)}
                >
                  Toggle style attribute
                </button>
              </div>
              <div className="card-result">
                {styleAttributeActive ? (
                  <p className="result-text success" data-testid="style-attr-status">
                    Style attribute changed
                  </p>
                ) : (
                  <p className="result-text empty" data-testid="style-attr-empty">
                    Awaiting execution...
                  </p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">NET.01</span>
                <h3>Same-origin connect source</h3>
              </div>
              <div className="card-actions">
                <button className="btn-primary" type="button" onClick={() => void loadProfile()}>
                  Load API profile
                </button>
              </div>
              <div className="card-result">
                {profile ? (
                  <p className="result-text success" data-testid="profile-result">
                    <span className="data-value">{profile.name}</span> is{' '}
                    <span className="data-value">{profile.role}</span>
                  </p>
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">NET.02</span>
                <h3>Cross-origin connect source</h3>
              </div>
              <div className="card-actions">
                <button className="btn-primary" type="button" onClick={sendCrossOriginBeacon}>
                  Send cross-origin beacon
                </button>
              </div>
              <div className="card-result">
                {crossOriginBeaconSent ? (
                  <p className="result-text success" data-testid="cross-origin-connect-result">
                    Cross-origin beacon attempted
                  </p>
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article
              className={`scenario-card dynamic-style-target ${dynamicStyle ? 'dynamic-style-enabled' : ''}`}
              data-testid="dynamic-style-card"
            >
              <div className="card-header">
                <span className="scenario-id">DOM.02</span>
                <h3>Dynamic style element</h3>
              </div>
              <div className="card-actions">
                <button className="btn-primary" type="button" onClick={addDynamicStyle}>
                  Add dynamic style
                </button>
              </div>
              <div className="card-result">
                {dynamicStyle ? (
                  <p className="result-text success" data-testid="dynamic-style-status">
                    Dynamic style added
                  </p>
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">DOM.03</span>
                <h3>Dynamic inline script</h3>
              </div>
              <div className="card-actions">
                <button className="btn-primary" type="button" onClick={addInlineScript}>
                  Add inline script
                </button>
              </div>
              <div className="card-result">
                {dynamicScript ? (
                  <p className="result-text success" data-testid="dynamic-script-status">
                    Dynamic script added
                  </p>
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">RES.01</span>
                <h3>Images</h3>
              </div>
              <div className="visual-preview">
                <img
                  className="img-thumbnail"
                  src="/assets/pixel.svg"
                  width="48"
                  height="48"
                  alt="Local sample pixel"
                />
              </div>
              <div className="card-actions">
                <button className="btn-primary" type="button" onClick={() => setDataImage(true)}>
                  Load data image
                </button>
              </div>
              <div className="card-result">
                {dataImage ? (
                  <div className="visual-result">
                    <img
                      className="img-thumbnail"
                      data-testid="data-image"
                      alt="Data URI sample"
                      width="48"
                      height="48"
                      src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48' fill='%23f97316'/%3E%3C/svg%3E"
                    />
                  </div>
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">WRK.01</span>
                <h3>Worker</h3>
              </div>
              <div className="card-actions">
                <button className="btn-primary" type="button" onClick={startWorker}>
                  Start worker
                </button>
              </div>
              <div className="card-result">
                {workerMessage ? (
                  <p className="result-text success" data-testid="worker-result">
                    {workerMessage}
                  </p>
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">RES.02</span>
                <h3>Media</h3>
              </div>
              <div className="card-actions">
                <button className="btn-primary" type="button" onClick={() => setMediaVisible(true)}>
                  Load media
                </button>
              </div>
              <div className="card-result">
                {mediaVisible ? (
                  <audio
                    className="audio-player"
                    data-testid="audio-sample"
                    src="/assets/tone.wav"
                    preload="auto"
                    controls
                  />
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">EMB.01</span>
                <h3>Same-origin frame</h3>
              </div>
              <div className="card-actions">
                <button className="btn-primary" type="button" onClick={() => setFrameVisible(true)}>
                  Open frame
                </button>
              </div>
              <div className="card-result">
                {frameVisible ? (
                  <iframe className="preview-frame" title="CSP sample frame" src="/frame.html" />
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">EMB.02</span>
                <h3>Cross-origin frame</h3>
              </div>
              <div className="card-actions">
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => setCrossOriginFrameVisible(true)}
                >
                  Open cross-origin frame
                </button>
              </div>
              <div className="card-result">
                {crossOriginFrameVisible ? (
                  <iframe
                    className="preview-frame"
                    title="Cross-origin CSP sample frame"
                    src={`${crossOriginBaseUrl}/frame.html`}
                  />
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">EMB.03</span>
                <h3>Object</h3>
              </div>
              <div className="card-actions">
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => setObjectVisible(true)}
                >
                  Load object
                </button>
              </div>
              <div className="card-result">
                {objectVisible ? (
                  <object
                    className="object-preview"
                    data="/object.html"
                    title="CSP sample object"
                  />
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">NAV.01</span>
                <h3>Form action</h3>
              </div>
              <div className="card-actions">
                <form
                  className="inline-form"
                  action="/form-target.html"
                  method="post"
                  target="form-result-frame"
                  onSubmit={() => setFormSubmitted(true)}
                >
                  <input type="hidden" name="scenario" value="form-action" />
                  <button className="btn-primary" type="submit">
                    Submit form
                  </button>
                </form>
                <iframe hidden title="Form result" name="form-result-frame" />
              </div>
              <div className="card-result">
                {formSubmitted ? (
                  <p className="result-text success" data-testid="form-status">
                    Form submitted
                  </p>
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>

            <article className="scenario-card">
              <div className="card-header">
                <span className="scenario-id">MOD.01</span>
                <h3>Lazy script chunk</h3>
              </div>
              <div className="card-actions">
                <button className="btn-primary" type="button" onClick={() => setLazyVisible(true)}>
                  Load lazy panel
                </button>
              </div>
              <div className="card-result">
                {lazyVisible ? (
                  <Suspense fallback={<p className="result-text pending">Loading lazy panel...</p>}>
                    <LazyPanel />
                  </Suspense>
                ) : (
                  <p className="result-text empty">Awaiting execution...</p>
                )}
              </div>
            </article>
          </section>
        </div>

        <aside className="sidebar">
          <div className="info-panel">
            <div className="panel-header">
              <svg
                className="icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <h3>Coverage Monitor</h3>
            </div>
            <ul className="output-list" aria-label="Scenario coverage notes">
              <li>
                <strong>Document directives</strong>
                <span>base-uri, form-action, manifest-src</span>
              </li>
              <li>
                <strong>Fetch directives</strong>
                <span>script, style, img, font, same/cross-origin connect and frame, worker</span>
              </li>
              <li>
                <strong>Inline coverage</strong>
                <span>script blocks, event handlers, style blocks, and style attributes</span>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
