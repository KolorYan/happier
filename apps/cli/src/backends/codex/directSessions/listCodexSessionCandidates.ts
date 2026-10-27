import { createHash } from 'node:crypto';

import type { DirectSessionCandidateV1, DirectSessionsSource } from '@happier-dev/protocol';

import { logger } from '@/utils/logger';

import { createCodexAppServerClient } from '../appServer/client/createCodexAppServerClient';
import { listCodexDirectSessionCandidatesViaExistingAppServerClient } from '../appServer/session/listCodexDirectSessionCandidatesViaAppServer';
import { listCodexDirectSessionCandidatesViaRollouts } from './listCodexDirectSessionCandidatesViaRollouts';
import { resolveCodexHomeEntriesForDirectSessionsSource } from './resolveCodexHomeEntriesForDirectSessionsSource';
import { resolveCodexAppServerProcessEnv } from '../appServer/resolveCodexAppServerProcessEnv';

type IndexCursorV1 = Readonly<{ v: 1; kind: 'index'; offset: number }>;

function encodeIndexCursor(offset: number): string {
  const cursor: IndexCursorV1 = { v: 1, kind: 'index', offset: Math.max(0, Math.trunc(offset)) };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeIndexCursor(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as any;
    if (!parsed || typeof parsed !== 'object') return 0;
    if (parsed.v !== 1 || parsed.kind !== 'index') return 0;
    const offset = typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) ? Math.trunc(parsed.offset) : 0;
    return Math.max(0, offset);
  } catch {
    return 0;
  }
}

function resolveCodexDirectListAppServerBudgetMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_CODEX_DIRECT_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 750;
}

function resolveCodexDirectListAppServerRefreshTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_CODEX_DIRECT_SESSIONS_APP_SERVER_REFRESH_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

const APP_SERVER_LISTING_MIN_REFRESH_INTERVAL_MS = 5_000;

// Starting `codex app-server` and listing threads often takes longer than the listing budget
// (about 1 s on a typical laptop), which used to discard the app-server titles on every poll.
// A listing that runs past the budget now keeps going in the background, bounded by its own
// timeout, and later listings answer from its last result while refreshing it.
type AppServerListingSnapshot = Readonly<{ candidates: readonly DirectSessionCandidateV1[]; fetchedAtMs: number }>;
const appServerListingSnapshotByKey = new Map<string, AppServerListingSnapshot>();
const appServerListingRefreshByKey = new Map<string, Promise<readonly DirectSessionCandidateV1[] | null>>();

function resolveAppServerListingKey(codexHome: string, processEnv: NodeJS.ProcessEnv): string {
  // The listing depends on the Codex home and on the environment the app-server is started with.
  const env = Object.entries(processEnv).filter(([, value]) => value !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha1').update(JSON.stringify([codexHome, env])).digest('hex');
}

function refreshAppServerListing(params: Readonly<{
  key: string;
  processEnv: NodeJS.ProcessEnv;
  timeoutMs: number;
}>): Promise<readonly DirectSessionCandidateV1[] | null> {
  const pending = appServerListingRefreshByKey.get(params.key);
  if (pending) return pending;

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let client: Awaited<ReturnType<typeof createCodexAppServerClient>> | null = null;
  const listPromise = (async (): Promise<DirectSessionCandidateV1[] | null> => {
    try {
      client = await createCodexAppServerClient({ processEnv: params.processEnv });
      if (timedOut) return null;
      return await listCodexDirectSessionCandidatesViaExistingAppServerClient({ client, processEnv: params.processEnv });
    } catch {
      return null;
    } finally {
      if (client) {
        await client.dispose().catch(() => undefined);
      }
    }
  })();

  // Always settles: either the listing finishes or the subprocess is disposed at the timeout.
  const refresh = Promise.race<DirectSessionCandidateV1[] | null>([
    listPromise,
    new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        void client?.dispose().catch(() => undefined);
        resolve(null);
      }, params.timeoutMs);
      timeout.unref?.();
    }),
  ]).then((candidates) => {
    if (candidates) appServerListingSnapshotByKey.set(params.key, { candidates, fetchedAtMs: Date.now() });
    return candidates;
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
    appServerListingRefreshByKey.delete(params.key);
  });
  appServerListingRefreshByKey.set(params.key, refresh);
  return refresh;
}

function mergeCodexDirectSessionCandidate(params: Readonly<{
  rolloutCandidate: DirectSessionCandidateV1;
  appServerCandidate: DirectSessionCandidateV1 | undefined;
}>): DirectSessionCandidateV1 {
  const appServerTitle = params.appServerCandidate?.title?.trim();
  if (!appServerTitle) return params.rolloutCandidate;
  return {
    ...params.rolloutCandidate,
    title: appServerTitle,
  };
}

async function listCodexSessionCandidatesViaAppServerWithBudget(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  searchTerm?: string;
}>): Promise<Readonly<{ candidates: DirectSessionCandidateV1[]; incomplete: boolean }>> {
  const budgetMs = resolveCodexDirectListAppServerBudgetMs(params.env);
  const homeEntries = await resolveCodexHomeEntriesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });

  const listed: DirectSessionCandidateV1[] = [];
  let incomplete = false;
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  for (const homeEntry of homeEntries) {
    const processEnv = await resolveCodexAppServerProcessEnv({
      processEnv: { ...process.env, ...params.env },
      affinity: {
        home: homeEntry.source.kind === 'codexHome' ? homeEntry.source.home : 'user',
        homePath: homeEntry.codexHome,
      },
    });
    const startedAtMs = Date.now();
    const key = resolveAppServerListingKey(homeEntry.codexHome, processEnv);
    const snapshot = appServerListingSnapshotByKey.get(key);
    const refreshTimeoutMs = resolveCodexDirectListAppServerRefreshTimeoutMs(params.env);
    let result: readonly DirectSessionCandidateV1[] | null;
    let timedOut = false;
    if (snapshot) {
      if (Date.now() - snapshot.fetchedAtMs >= APP_SERVER_LISTING_MIN_REFRESH_INTERVAL_MS) {
        void refreshAppServerListing({ key, processEnv, timeoutMs: refreshTimeoutMs });
      }
      result = snapshot.candidates;
    } else {
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      result = await Promise.race<readonly DirectSessionCandidateV1[] | null>([
        refreshAppServerListing({ key, processEnv, timeoutMs: refreshTimeoutMs }),
        new Promise<null>((resolve) => {
          budgetTimer = setTimeout(() => {
            timedOut = true;
            resolve(null);
          }, budgetMs);
        }),
      ]).finally(() => {
        if (budgetTimer) clearTimeout(budgetTimer);
      });
    }

    logger.debug('[directSessions.codex.appServerCandidates] list finished', {
      homeKind: homeEntry.source.kind,
      elapsedMs: Date.now() - startedAtMs,
      budgetMs,
      timedOut,
      fromSnapshot: Boolean(snapshot),
      returnedCandidates: result?.length ?? 0,
      searchTermLength: searchTerm.length,
    });

    if (!result) {
      incomplete = true;
      continue;
    }
    listed.push(...result.map((candidate) => ({
      ...candidate,
      details: {
        ...(candidate.details ?? {}),
        source: homeEntry.source,
      },
    })).filter((candidate) => {
      if (!searchTerm) return true;
      const details = candidate.details as Record<string, unknown> | undefined;
      const cwd = typeof details?.cwd === 'string' ? details.cwd : undefined;
      const title = candidate.title;
      const haystack = `${candidate.remoteSessionId}${title ? ` ${title}` : ''}${cwd ? ` ${cwd}` : ''}`.toLowerCase();
      return haystack.includes(searchTerm);
    }));
  }

  return { candidates: listed, incomplete };
}

export async function listCodexSessionCandidates(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>): Promise<Readonly<{ candidates: DirectSessionCandidateV1[]; nextCursor: string | null; searchIncomplete?: boolean }>> {
  const env = params.env ?? process.env;

  const startedAtMs = Date.now();
  const startMemory = process.memoryUsage();
  const offset = decodeIndexCursor(params.cursor);
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  const limit = Math.max(1, Math.trunc(params.limit));
  const rolloutListing = await listCodexDirectSessionCandidatesViaRollouts({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
    offset,
    limit,
    searchTerm,
    searchMode: params.searchMode,
  });
  const exactRolloutMatch = Boolean(searchTerm)
    && rolloutListing.candidates.some((candidate) => candidate.remoteSessionId.toLowerCase() === searchTerm)
    && !rolloutListing.searchIncomplete;
  const appServerListing = params.searchMode === 'fast' || exactRolloutMatch
    ? { candidates: [] as DirectSessionCandidateV1[], incomplete: Boolean(searchTerm) && !exactRolloutMatch }
    : await listCodexSessionCandidatesViaAppServerWithBudget({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env,
      searchTerm,
    });
  const appServerCandidates = appServerListing.candidates;
  const searchIncomplete = Boolean(rolloutListing.searchIncomplete || appServerListing.incomplete);

  logger.debug('[directSessions.codex.candidates] list finished', {
    elapsedMs: Date.now() - startedAtMs,
    searchTermLength: searchTerm.length,
    searchMode: params.searchMode ?? 'default',
    rolloutCandidates: rolloutListing.candidates.length,
    rolloutTotalCount: rolloutListing.totalCount,
    appServerCandidates: appServerCandidates.length,
    searchIncomplete,
    heapDeltaBytes: process.memoryUsage().heapUsed - startMemory.heapUsed,
    rssBytes: process.memoryUsage().rss,
  });

  if (appServerCandidates.length === 0) {
    const nextOffset = offset + rolloutListing.candidates.length;
    const nextCursor = nextOffset < rolloutListing.totalCount ? encodeIndexCursor(nextOffset) : null;
    return {
      candidates: rolloutListing.candidates,
      nextCursor,
      ...(searchIncomplete ? { searchIncomplete: true } : {}),
    };
  }

  const effectiveRolloutListing = appServerCandidates.length > 0 && offset > 0
    ? await listCodexDirectSessionCandidatesViaRollouts({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env,
      offset: 0,
      limit: offset + limit,
      searchTerm,
      searchMode: params.searchMode,
    })
    : rolloutListing;

  const merged = new Map<string, DirectSessionCandidateV1>();
  for (const candidate of appServerCandidates) {
    merged.set(candidate.remoteSessionId, candidate);
  }
  for (const rolloutCandidate of effectiveRolloutListing.candidates) {
    merged.set(rolloutCandidate.remoteSessionId, mergeCodexDirectSessionCandidate({
      rolloutCandidate,
      appServerCandidate: merged.get(rolloutCandidate.remoteSessionId),
    }));
  }

  const candidates = Array.from(merged.values())
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)))
    .slice(offset, offset + limit);
  const totalCount = Math.max(effectiveRolloutListing.totalCount, merged.size);

  const nextOffset = offset + candidates.length;
  const nextCursor = nextOffset < totalCount ? encodeIndexCursor(nextOffset) : null;

  return {
    candidates,
    nextCursor,
    ...(searchIncomplete ? { searchIncomplete: true } : {}),
  };
}
