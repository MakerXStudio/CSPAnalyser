import type Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BrowserContext, Page, Response } from 'playwright';
import type {
  Fixtures,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
  WorkerInfo,
} from 'playwright/test';
import {
  createDatabase,
  createSession,
  getOrInsertPage,
  getPages,
  getViolations,
  insertPermissionsPolicy,
  insertPolicy,
  updateSession,
} from './db/repository.js';
import { startReportServer, type ReportServerResult } from './report-server.js';
import { setupCspInjection, type CapturedPermissionsPolicy } from './csp-injector.js';
import { setupViolationListener } from './violation-listener.js';
import { setupInlineContentObserver } from './inline-content-observer.js';
import { extractInlineHashes } from './inline-content-extractor.js';
import { generatePolicy } from './policy-generator.js';
import { optimizePolicy } from './policy-optimizer.js';
import { formatPolicy } from './policy-formatter.js';
import { parsePermissionsPolicyHeaders } from './permissions-policy.js';
import { extractOrigin } from './utils/url-utils.js';
import type { ExportFormat, Page as StoredPage, StaticProfile, StrictnessLevel } from './types.js';

const DEFAULT_TARGET_URL = 'http://localhost';

export interface PlaywrightCspCaptureOptions {
  /** Target application URL. Used for session metadata and 'self' origin resolution. */
  targetUrl?: string;
  /** Directory for per-worker/per-project artifacts. No artifacts are written unless outputDir or outputFile is set. */
  outputDir?: string;
  /** Artifact basename used with outputDir. Defaults to csp-policy. */
  artifactName?: string;
  /** Exact artifact path. Takes precedence over outputDir/artifactName. */
  outputFile?: string;
  format?: ExportFormat;
  strictness?: StrictnessLevel;
  reportOnly?: boolean;
  includeHashes?: boolean;
  useHashes?: boolean;
  nonce?: boolean;
  strictDynamic?: boolean;
  stripUnsafeEval?: boolean;
  collapseHashThreshold?: number;
  staticSiteMode?: boolean;
  staticProfile?: StaticProfile;
  violationLimit?: number;
  project?: string;
  db?: Database.Database;
  dbPath?: string;
}

export interface PlaywrightCspFinalizeResult {
  sessionId: string;
  pages: StoredPage[];
  violationsFound: number;
  directives: Record<string, string[]>;
  policy: string;
  artifactPath: string | null;
}

export interface PlaywrightCspCapture {
  readonly sessionId: string;
  readonly db: Database.Database;
  attachToPage(page: Page): Promise<void>;
  attachToContext(context: BrowserContext): Promise<void>;
  finalize(): Promise<PlaywrightCspFinalizeResult>;
  writeArtifacts(result?: PlaywrightCspFinalizeResult): Promise<string | null>;
  close(): Promise<void>;
}

export interface PlaywrightCspCaptureDeps {
  createDatabase: typeof createDatabase;
  createSession: typeof createSession;
  updateSession: typeof updateSession;
  getOrInsertPage: typeof getOrInsertPage;
  getPages: typeof getPages;
  getViolations: typeof getViolations;
  insertPermissionsPolicy: typeof insertPermissionsPolicy;
  insertPolicy: typeof insertPolicy;
  startReportServer: typeof startReportServer;
  setupCspInjection: typeof setupCspInjection;
  setupViolationListener: typeof setupViolationListener;
  setupInlineContentObserver: typeof setupInlineContentObserver;
  extractInlineHashes: typeof extractInlineHashes;
  generatePolicy: typeof generatePolicy;
  optimizePolicy: typeof optimizePolicy;
  formatPolicy: typeof formatPolicy;
  parsePermissionsPolicyHeaders: typeof parsePermissionsPolicyHeaders;
  extractOrigin: typeof extractOrigin;
}

interface AttachedPageState {
  page: Page;
  currentPageId: string | null;
  cleanupRoute: (() => Promise<void>) | null;
  onResponse: (response: Response) => void;
  onFrameNavigated: (frame: ReturnType<Page['mainFrame']>) => void;
  onLoad: () => void;
}

interface AttachedContextState {
  context: BrowserContext;
  onPage: (page: Page) => void;
}

function resolveDeps(deps?: Partial<PlaywrightCspCaptureDeps>): PlaywrightCspCaptureDeps {
  return {
    createDatabase: deps?.createDatabase ?? createDatabase,
    createSession: deps?.createSession ?? createSession,
    updateSession: deps?.updateSession ?? updateSession,
    getOrInsertPage: deps?.getOrInsertPage ?? getOrInsertPage,
    getPages: deps?.getPages ?? getPages,
    getViolations: deps?.getViolations ?? getViolations,
    insertPermissionsPolicy: deps?.insertPermissionsPolicy ?? insertPermissionsPolicy,
    insertPolicy: deps?.insertPolicy ?? insertPolicy,
    startReportServer: deps?.startReportServer ?? startReportServer,
    setupCspInjection: deps?.setupCspInjection ?? setupCspInjection,
    setupViolationListener: deps?.setupViolationListener ?? setupViolationListener,
    setupInlineContentObserver: deps?.setupInlineContentObserver ?? setupInlineContentObserver,
    extractInlineHashes: deps?.extractInlineHashes ?? extractInlineHashes,
    generatePolicy: deps?.generatePolicy ?? generatePolicy,
    optimizePolicy: deps?.optimizePolicy ?? optimizePolicy,
    formatPolicy: deps?.formatPolicy ?? formatPolicy,
    parsePermissionsPolicyHeaders:
      deps?.parsePermissionsPolicyHeaders ?? parsePermissionsPolicyHeaders,
    extractOrigin: deps?.extractOrigin ?? extractOrigin,
  };
}

function safeTargetOrigin(targetUrl: string, deps: PlaywrightCspCaptureDeps): string | undefined {
  try {
    return deps.extractOrigin(targetUrl);
  } catch {
    return undefined;
  }
}

function isNavigableUrl(url: string): boolean {
  return url !== '' && !url.startsWith('about:') && !url.startsWith('data:');
}

function isClosedPageCleanupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Target page, context or browser has been closed') ||
    message.includes('Target closed')
  );
}

function artifactPathFor(options: RequiredArtifactOptions): string {
  if (options.outputFile) return resolve(options.outputFile);
  const extension = options.format === 'json' ? 'json' : 'txt';
  return resolve(options.outputDir, `${options.artifactName}.${extension}`);
}

function validateArtifactName(artifactName: string): void {
  if (
    artifactName.length === 0 ||
    artifactName.includes('..') ||
    artifactName.includes('/') ||
    artifactName.includes('\\')
  ) {
    throw new Error(`Invalid CSP artifactName: ${artifactName}`);
  }
}

interface RequiredArtifactOptions {
  outputDir: string;
  outputFile?: string;
  artifactName: string;
  format: ExportFormat;
}

function maybeArtifactOptions(
  options: PlaywrightCspCaptureOptions,
  format: ExportFormat,
): RequiredArtifactOptions | null {
  if (!options.outputDir && !options.outputFile) return null;
  const artifactName = options.artifactName ?? 'csp-policy';
  if (options.outputDir && !options.outputFile) {
    validateArtifactName(artifactName);
  }
  return {
    outputDir: options.outputDir ?? dirname(resolve(options.outputFile ?? 'csp-policy.json')),
    outputFile: options.outputFile,
    artifactName,
    format,
  };
}

function inferWorkerBaseUrl(workerInfo: WorkerInfo): string | undefined {
  const useOptions: unknown = workerInfo.project.use;
  if (typeof useOptions !== 'object' || useOptions === null || !('baseURL' in useOptions)) {
    return undefined;
  }
  const baseURL: unknown = useOptions.baseURL;
  return typeof baseURL === 'string' && baseURL.length > 0 ? baseURL : undefined;
}

export function createPlaywrightCspCapture(
  options: PlaywrightCspCaptureOptions = {},
  depsInput?: Partial<PlaywrightCspCaptureDeps>,
): PlaywrightCspCapture {
  const deps = resolveDeps(depsInput);
  const explicitTargetUrl = options.targetUrl != null;
  const targetUrl = options.targetUrl ?? DEFAULT_TARGET_URL;
  const format = options.format ?? 'json';
  const strictness = options.strictness ?? 'moderate';
  const includeHashes = options.includeHashes ?? true;
  const db = options.db ?? deps.createDatabase(options.dbPath ?? ':memory:');
  const ownsDb = options.db == null;
  const session = deps.createSession(db, {
    targetUrl,
    violationLimit: options.violationLimit,
    project: options.project,
  });
  const targetOrigin = explicitTargetUrl ? safeTargetOrigin(targetUrl, deps) : undefined;
  const attachedPages = new WeakMap<Page, AttachedPageState>();
  const pendingPageAttachments = new WeakMap<Page, Promise<void>>();
  const attachedContexts = new WeakMap<BrowserContext, AttachedContextState>();
  const pageStates = new Set<AttachedPageState>();
  const contextStates = new Set<AttachedContextState>();
  const pendingContextAttachments = new WeakMap<BrowserContext, Promise<void>>();
  const contextAttachmentPromises = new Set<Promise<void>>();
  const contextPageAttachments = new Set<Promise<void>>();
  const asyncAttachmentErrors: Error[] = [];
  const loadHashExtractions = new Set<Promise<void>>();
  const loadHashErrors: Error[] = [];
  let reportServerPromise: Promise<ReportServerResult> | null = null;
  let reportServer: ReportServerResult | null = null;
  let finalized: PlaywrightCspFinalizeResult | null = null;
  let closed = false;

  function ensurePageRecord(url: string, statusCode: number | null): StoredPage | null {
    if (!isNavigableUrl(url)) return null;
    return deps.getOrInsertPage(db, session.id, url, statusCode);
  }

  async function ensureReportServer(): Promise<ReportServerResult> {
    if (!reportServerPromise) {
      reportServerPromise = deps
        .startReportServer(db, session.id, { violationLimit: options.violationLimit })
        .then((server) => {
          reportServer = server;
          deps.updateSession(db, session.id, { reportServerPort: server.port });
          return server;
        });
    }
    return reportServerPromise;
  }

  function insertCapturedPermissions(
    captured: CapturedPermissionsPolicy[],
    sourceUrl: string,
    pageId: string | null,
  ): void {
    const headers: Record<string, string> = {};
    for (const item of captured) {
      headers[item.headerName] = item.headerValue;
    }
    const parsed = deps.parsePermissionsPolicyHeaders(headers);
    for (const policy of parsed) {
      deps.insertPermissionsPolicy(db, {
        sessionId: session.id,
        pageId,
        directive: policy.directive,
        allowlist: policy.allowlist,
        headerType: policy.headerType,
        sourceUrl,
      });
    }
  }

  function trackLoadHashExtraction(page: Page, pageId: string): void {
    const extraction = deps
      .extractInlineHashes(page, db, session.id, pageId)
      .then(() => {})
      .catch((error: unknown) => {
        loadHashErrors.push(
          error instanceof Error
            ? error
            : new Error(`Failed to extract inline hashes after page load: ${String(error)}`),
        );
      })
      .finally(() => {
        loadHashExtractions.delete(extraction);
      });
    loadHashExtractions.add(extraction);
  }

  async function attachPageOnce(page: Page): Promise<void> {
    deps.updateSession(db, session.id, { status: 'crawling' });
    const server = await ensureReportServer();
    const initialPage = ensurePageRecord(page.url(), null);
    const state: AttachedPageState = {
      page,
      currentPageId: initialPage?.id ?? null,
      cleanupRoute: null,
      onResponse: (response) => {
        if (response.request().resourceType() !== 'document') return;
        const storedPage = ensurePageRecord(response.url(), response.status());
        state.currentPageId = storedPage?.id ?? state.currentPageId;
      },
      onFrameNavigated: (frame) => {
        if (frame !== page.mainFrame()) return;
        const storedPage = ensurePageRecord(frame.url(), null);
        state.currentPageId = storedPage?.id ?? state.currentPageId;
      },
      onLoad: () => {
        const pageId = state.currentPageId;
        if (!pageId) return;
        trackLoadHashExtraction(page, pageId);
      },
    };

    const resolvePageId = (): string | null => state.currentPageId;
    state.cleanupRoute = await deps.setupCspInjection(
      page,
      server.port,
      server.token,
      (captured, requestUrl) => {
        const storedPage = ensurePageRecord(requestUrl, null);
        insertCapturedPermissions(captured, requestUrl, storedPage?.id ?? resolvePageId());
      },
      targetOrigin,
    );
    await deps.setupViolationListener(page, db, session.id, resolvePageId);
    await deps.setupInlineContentObserver(page, db, session.id, resolvePageId);
    page.on('response', state.onResponse);
    page.on('framenavigated', state.onFrameNavigated);
    page.on('load', state.onLoad);
    attachedPages.set(page, state);
    pageStates.add(state);
  }

  async function attachToPage(page: Page): Promise<void> {
    if (closed) throw new Error('Cannot attach page after Playwright CSP capture is closed');
    if (attachedPages.has(page)) return;
    const pending = pendingPageAttachments.get(page);
    if (pending) {
      await pending;
      return;
    }

    const attachment = attachPageOnce(page).finally(() => {
      pendingPageAttachments.delete(page);
    });
    pendingPageAttachments.set(page, attachment);
    await attachment;
  }

  async function attachContextOnce(context: BrowserContext): Promise<void> {
    for (const existingPage of context.pages()) {
      await attachToPage(existingPage);
    }
    const state: AttachedContextState = {
      context,
      onPage: (page) => {
        const attachment = attachToPage(page)
          .catch((error: unknown) => {
            asyncAttachmentErrors.push(
              error instanceof Error
                ? error
                : new Error(`Failed to attach CSP capture to page: ${String(error)}`),
            );
          })
          .finally(() => {
            contextPageAttachments.delete(attachment);
          });
        contextPageAttachments.add(attachment);
      },
    };
    context.on('page', state.onPage);
    attachedContexts.set(context, state);
    contextStates.add(state);
  }

  async function attachToContext(context: BrowserContext): Promise<void> {
    if (closed) throw new Error('Cannot attach context after Playwright CSP capture is closed');
    if (attachedContexts.has(context)) return;
    const pending = pendingContextAttachments.get(context);
    if (pending) {
      await pending;
      return;
    }

    const attachment = attachContextOnce(context).finally(() => {
      pendingContextAttachments.delete(context);
      contextAttachmentPromises.delete(attachment);
    });
    pendingContextAttachments.set(context, attachment);
    contextAttachmentPromises.add(attachment);
    await attachment;
  }

  async function drainContextAttachments(): Promise<void> {
    while (contextAttachmentPromises.size > 0) {
      await Promise.all([...contextAttachmentPromises]);
    }
  }

  async function drainContextPageAttachments(): Promise<void> {
    while (contextPageAttachments.size > 0) {
      await Promise.all([...contextPageAttachments]);
    }
  }

  async function drainLoadHashExtractions(): Promise<void> {
    while (loadHashExtractions.size > 0) {
      await Promise.all([...loadHashExtractions]);
    }
  }

  async function finalize(): Promise<PlaywrightCspFinalizeResult> {
    if (finalized) return finalized;
    await drainContextAttachments();
    await drainContextPageAttachments();
    if (asyncAttachmentErrors.length > 0) {
      throw new AggregateError(
        asyncAttachmentErrors,
        'One or more Playwright page attachments failed',
      );
    }
    await drainLoadHashExtractions();
    if (loadHashErrors.length > 0) {
      throw new AggregateError(loadHashErrors, 'One or more inline hash extractions failed');
    }
    deps.updateSession(db, session.id, { status: 'analyzing' });
    for (const state of pageStates) {
      if (
        state.currentPageId &&
        (typeof state.page.isClosed !== 'function' || !state.page.isClosed())
      ) {
        await deps.extractInlineHashes(state.page, db, session.id, state.currentPageId);
      }
    }
    const generated = deps.generatePolicy(db, session.id, { strictness, includeHashes });
    const directives = deps.optimizePolicy(generated, targetUrl, {
      useHashes: options.useHashes,
      useNonces: options.nonce,
      useStrictDynamic: options.strictDynamic,
      stripUnsafeEval: options.stripUnsafeEval,
      collapseHashThreshold: options.collapseHashThreshold,
      staticSiteMode: options.staticSiteMode,
      staticProfile: options.staticProfile,
    });
    const policy = deps.formatPolicy(directives, format, options.reportOnly ?? false);
    deps.insertPolicy(db, {
      sessionId: session.id,
      policyHeader: policy,
      directives,
      format,
      isReportOnly: options.reportOnly ?? false,
    });
    const pages = deps.getPages(db, session.id);
    const violationsFound = deps.getViolations(db, session.id).length;
    finalized = {
      sessionId: session.id,
      pages,
      violationsFound,
      directives,
      policy,
      artifactPath: null,
    };
    finalized.artifactPath = await writeArtifacts(finalized);
    deps.updateSession(db, session.id, { status: 'complete' });
    return finalized;
  }

  async function writeArtifacts(result?: PlaywrightCspFinalizeResult): Promise<string | null> {
    const artifactOptions = maybeArtifactOptions(options, format);
    if (!artifactOptions) return null;
    const path = artifactPathFor(artifactOptions);
    mkdirSync(dirname(path), { recursive: true });
    const content =
      result?.policy ??
      deps.formatPolicy(result?.directives ?? {}, format, options.reportOnly ?? false);
    writeFileSync(path, `${content}\n`, 'utf8');
    return path;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await drainContextAttachments();
    await drainContextPageAttachments();
    await drainLoadHashExtractions();
    for (const contextState of contextStates) {
      contextState.context.off('page', contextState.onPage);
      attachedContexts.delete(contextState.context);
    }
    contextStates.clear();
    for (const state of pageStates) {
      state.page.off('response', state.onResponse);
      state.page.off('framenavigated', state.onFrameNavigated);
      state.page.off('load', state.onLoad);
      if (state.cleanupRoute) {
        try {
          await state.cleanupRoute();
        } catch (error: unknown) {
          if (!isClosedPageCleanupError(error)) {
            throw error;
          }
        }
      }
    }
    pageStates.clear();
    if (reportServer) {
      await reportServer.close();
      reportServer = null;
    }
    if (ownsDb) {
      db.close();
    }
  }

  return {
    sessionId: session.id,
    db,
    attachToPage,
    attachToContext,
    finalize,
    writeArtifacts,
    close,
  };
}

export interface CspTestFixtures {
  cspCapture: PlaywrightCspCapture;
}

export interface CspWorkerFixtures {
  _cspWorkerCapture: PlaywrightCspCapture;
}

type CspFixtureDefinitions = Fixtures<
  CspTestFixtures,
  CspWorkerFixtures,
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;

export function createCspFixtureDefinitions(
  options: PlaywrightCspCaptureOptions = {},
  createCapture: typeof createPlaywrightCspCapture = createPlaywrightCspCapture,
): CspFixtureDefinitions {
  return {
    _cspWorkerCapture: [
      async ({ browserName: _browserName }, use, workerInfo) => {
        const projectName = options.project ?? workerInfo.project.name;
        const artifactName =
          options.artifactName ??
          `csp-policy-${projectName.replace(/[^a-z0-9_-]+/gi, '-')}-${workerInfo.workerIndex}`;
        const outputDir = options.outputDir ?? join(workerInfo.project.outputDir, 'csp-analyser');
        const capture = createCapture({
          ...options,
          targetUrl: options.targetUrl ?? inferWorkerBaseUrl(workerInfo) ?? DEFAULT_TARGET_URL,
          outputDir,
          artifactName,
          project: projectName,
        });
        await use(capture);
        try {
          await capture.finalize();
        } finally {
          await capture.close();
        }
      },
      { scope: 'worker', auto: true },
    ],
    cspCapture: async ({ _cspWorkerCapture }, use) => {
      await use(_cspWorkerCapture);
    },
    context: async ({ context, cspCapture }, use) => {
      await cspCapture.attachToContext(context);
      await use(context);
    },
    page: async ({ page, cspCapture }, use) => {
      await cspCapture.attachToPage(page);
      await use(page);
    },
  };
}

export function createCspTest(
  base: TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  >,
  options: PlaywrightCspCaptureOptions = {},
): TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & CspTestFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & CspWorkerFixtures
> {
  return base.extend<CspTestFixtures, CspWorkerFixtures>(createCspFixtureDefinitions(options));
}
