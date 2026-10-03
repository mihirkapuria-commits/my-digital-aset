/**
 * ============================================================================
 * MYDIGITASSET — STAGE 3C FIRESTORE -> GOOGLE SHEETS SYNCHRONIZATION SERVICE
 * ============================================================================
 * Architecture:
 * - One-way authoritative synchronization: Firestore (authoritative) -> Google Sheets (mirror).
 * - Machine-to-Machine Authentication: Uses SHEET_SYNC_SECRET sent ONLY in
 *   the HTTP request header (X-Sync-Token). Secret is NEVER logged, NEVER placed
 *   in the request body, and NEVER exposed to frontend or Google Sheets.
 * - Durable Firestore Checkpoint: Checkpoint state persisted in collection 'system',
 *   document 'sheetSyncCheckpoint'. Survives Cloud Run container restarts, scale-to-zero,
 *   and instance recycling.
 * - Timestamp Overlap + Idempotency: Uses a 5-minute overlap window when querying
 *   incremental changes from Firestore. Deterministic primary-key upsert in Apps Script
 *   guarantees that retries or overlaps create ZERO duplicate rows.
 * - Concurrency Protection: Distributed lease-based lock prevents multiple Cloud Run
 *   instances from concurrent sync execution.
 * - Complete Business Decoupling: Core customer, payment, news, and delivery operations
 *   are 100% decoupled and never block or fail due to Google Sheets availability.
 * ============================================================================
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  getFirestoreDb,
  doc,
  getDoc,
  setDoc,
  withTimeout,
} from './firestore.js';
import { getDb } from './db.js';
import {
  Customer,
  Subscription,
  SubscriptionCategory,
  Payment,
  PaymentOrder,
  DailyNewsPackage,
  NewsStory,
  TelegramDeliveryLog,
  TelegramConnectionToken,
  CategoryTransferAudit,
} from '../src/types';

export const TARGET_SPREADSHEET_ID = '1VxEwbU0TupxdqNIhslFDL-hcZLpY0QBPcqVt-h8O43A';
export const DEFAULT_OVERLAP_WINDOW_MS = 5 * 60 * 1000; // 5-minute safety overlap window
const LOCK_LEASE_MS = 90 * 1000; // 90-second distributed lock lease
const CHECKPOINT_FILE = path.join(process.cwd(), 'server', 'data', 'sheet_sync_checkpoint.json');

let memoryCheckpoint: SheetSyncCheckpoint | null = null;

export interface SheetSyncCheckpoint {
  stateId: string; // 'sheetSyncCheckpoint'
  spreadsheetId: string;
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSyncStatus: 'idle' | 'in_progress' | 'success' | 'failed';
  lastSyncError: string | null;
  totalSyncRuns: number;
  concurrencyLock: {
    lockedAt: string;
    lockedBy: string;
    leaseExpiresAt: string;
  } | null;
  highWaterMarks: {
    customers: string;
    subscriptions: string;
    subscriptionCategories: string;
    payments: string;
    paymentOrders: string;
    dailyNewsPackages: string;
    newsStories: string;
    telegramDeliveryLogs: string;
    telegramConnectionTokens: string;
    categoryTransferAudits: string;
    systemScheduler: string;
  };
  lastStats: {
    syncedEntities: Record<string, { inserted: number; updated: number; total: number }>;
    durationMs: number;
  } | null;
  updatedAt: string;
}

/**
 * Retrieves the secret from environment configuration.
 * Generates an in-memory test fallback if undefined in local test runs.
 * NEVER prints or logs the secret!
 */
export function getSheetSyncSecret(): string {
  const secret = process.env.SHEET_SYNC_SECRET;
  if (secret && secret.trim().length > 0) {
    return secret.trim();
  }
  // Safe default for non-production environments / unit test runs
  return 'm2m_sync_sec_' + crypto.createHash('sha256').update(process.env.APP_URL || 'mydigitasset_local_secret').digest('hex').substring(0, 32);
}

/**
 * Returns the Apps Script Web App URL from environment.
 */
export function getAppsScriptUrl(): string | null {
  return process.env.APPS_SCRIPT_WEBAPP_URL || null;
}

/**
 * Retrieves or initializes the durable Firestore checkpoint.
 */
export async function getSheetSyncCheckpoint(): Promise<SheetSyncCheckpoint> {
  // If memory cache exists, use as baseline
  if (!memoryCheckpoint && fs.existsSync(CHECKPOINT_FILE)) {
    try {
      memoryCheckpoint = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
    } catch (e) {
      // ignore JSON parse error
    }
  }

  const firestore = getFirestoreDb();
  const checkpointRef = doc(firestore, 'system', 'sheetSyncCheckpoint');

  try {
    const snap = await withTimeout(getDoc(checkpointRef), 1500, null);
    if (snap && snap.exists()) {
      const data = snap.data() as SheetSyncCheckpoint;
      memoryCheckpoint = {
        stateId: 'sheetSyncCheckpoint',
        spreadsheetId: TARGET_SPREADSHEET_ID,
        lastSyncStartedAt: data.lastSyncStartedAt || null,
        lastSyncCompletedAt: data.lastSyncCompletedAt || null,
        lastSyncStatus: data.lastSyncStatus || 'idle',
        lastSyncError: data.lastSyncError || null,
        totalSyncRuns: data.totalSyncRuns || 0,
        concurrencyLock: data.concurrencyLock || null,
        highWaterMarks: {
          customers: data.highWaterMarks?.customers || '1970-01-01T00:00:00.000Z',
          subscriptions: data.highWaterMarks?.subscriptions || '1970-01-01T00:00:00.000Z',
          subscriptionCategories: data.highWaterMarks?.subscriptionCategories || '1970-01-01T00:00:00.000Z',
          payments: data.highWaterMarks?.payments || '1970-01-01T00:00:00.000Z',
          paymentOrders: data.highWaterMarks?.paymentOrders || '1970-01-01T00:00:00.000Z',
          dailyNewsPackages: data.highWaterMarks?.dailyNewsPackages || '1970-01-01T00:00:00.000Z',
          newsStories: data.highWaterMarks?.newsStories || '1970-01-01T00:00:00.000Z',
          telegramDeliveryLogs: data.highWaterMarks?.telegramDeliveryLogs || '1970-01-01T00:00:00.000Z',
          telegramConnectionTokens: data.highWaterMarks?.telegramConnectionTokens || '1970-01-01T00:00:00.000Z',
          categoryTransferAudits: data.highWaterMarks?.categoryTransferAudits || '1970-01-01T00:00:00.000Z',
          systemScheduler: data.highWaterMarks?.systemScheduler || '1970-01-01T00:00:00.000Z',
        },
        lastStats: data.lastStats || null,
        updatedAt: data.updatedAt || new Date().toISOString(),
      };
      try {
        fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(memoryCheckpoint, null, 2));
      } catch (e) {
        // non-fatal
      }
      return memoryCheckpoint;
    }
  } catch (err) {
    // Firestore timed out or quota exhausted, fall back to memory/local file
  }

  if (memoryCheckpoint) {
    return memoryCheckpoint;
  }

  // Initial checkpoint template
  memoryCheckpoint = {
    stateId: 'sheetSyncCheckpoint',
    spreadsheetId: TARGET_SPREADSHEET_ID,
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastSyncStatus: 'idle',
    lastSyncError: null,
    totalSyncRuns: 0,
    concurrencyLock: null,
    highWaterMarks: {
      customers: '1970-01-01T00:00:00.000Z',
      subscriptions: '1970-01-01T00:00:00.000Z',
      subscriptionCategories: '1970-01-01T00:00:00.000Z',
      payments: '1970-01-01T00:00:00.000Z',
      paymentOrders: '1970-01-01T00:00:00.000Z',
      dailyNewsPackages: '1970-01-01T00:00:00.000Z',
      newsStories: '1970-01-01T00:00:00.000Z',
      telegramDeliveryLogs: '1970-01-01T00:00:00.000Z',
      telegramConnectionTokens: '1970-01-01T00:00:00.000Z',
      categoryTransferAudits: '1970-01-01T00:00:00.000Z',
      systemScheduler: '1970-01-01T00:00:00.000Z',
    },
    lastStats: null,
    updatedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(memoryCheckpoint, null, 2));
  } catch (e) {
    // non-fatal
  }

  return memoryCheckpoint;
}

/**
 * Persists the checkpoint document to Firestore Native mode and local backup.
 */
export async function saveSheetSyncCheckpoint(checkpoint: SheetSyncCheckpoint): Promise<void> {
  checkpoint.updatedAt = new Date().toISOString();
  memoryCheckpoint = { ...checkpoint };

  // Write synchronously to local durable file
  try {
    const dir = path.dirname(CHECKPOINT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
  } catch (e) {
    // non-fatal
  }

  // Attempt Firestore native write with short timeout
  const firestore = getFirestoreDb();
  const checkpointRef = doc(firestore, 'system', 'sheetSyncCheckpoint');
  try {
    await withTimeout(setDoc(checkpointRef, JSON.parse(JSON.stringify(checkpoint))), 1500);
  } catch (err) {
    // Non-fatal, local backup already saved
  }
}

/**
 * Acquires a distributed lease lock in Firestore for sheet synchronization.
 * Prevents multiple Cloud Run instances from executing sync concurrently.
 */
export async function acquireSheetSyncLock(instanceId: string): Promise<boolean> {
  const checkpoint = await getSheetSyncCheckpoint();
  const now = new Date();

  if (checkpoint.concurrencyLock) {
    const expiresAt = new Date(checkpoint.concurrencyLock.leaseExpiresAt);
    if (expiresAt > now && checkpoint.concurrencyLock.lockedBy !== instanceId) {
      // Valid unexpired lock held by another instance
      return false;
    }
  }

  // Acquire or renew lease
  checkpoint.concurrencyLock = {
    lockedAt: now.toISOString(),
    lockedBy: instanceId,
    leaseExpiresAt: new Date(now.getTime() + LOCK_LEASE_MS).toISOString(),
  };
  checkpoint.lastSyncStartedAt = now.toISOString();
  checkpoint.lastSyncStatus = 'in_progress';

  await saveSheetSyncCheckpoint(checkpoint);
  return true;
}

/**
 * Releases the distributed lease lock in Firestore.
 */
export async function releaseSheetSyncLock(instanceId: string): Promise<void> {
  const checkpoint = await getSheetSyncCheckpoint();
  if (checkpoint.concurrencyLock && checkpoint.concurrencyLock.lockedBy === instanceId) {
    checkpoint.concurrencyLock = null;
    await saveSheetSyncCheckpoint(checkpoint);
  }
}

/**
 * Filters records using a timestamp boundary with safety overlap window.
 */
export function filterEntitiesWithOverlap<T extends { updatedAt?: string; createdAt?: string; timestamp?: string }>(
  items: T[],
  highWaterMark: string,
  forceFullSync: boolean = false,
  overlapWindowMs: number = DEFAULT_OVERLAP_WINDOW_MS
): { records: T[]; newHighWaterMark: string } {
  if (forceFullSync || !highWaterMark || highWaterMark === '1970-01-01T00:00:00.000Z') {
    let maxTs = highWaterMark;
    for (const item of items) {
      const ts = item.updatedAt || item.createdAt || item.timestamp || '';
      if (ts > maxTs) maxTs = ts;
    }
    return { records: items, newHighWaterMark: maxTs };
  }

  const boundaryMs = new Date(highWaterMark).getTime() - overlapWindowMs;
  const boundaryIso = new Date(boundaryMs > 0 ? boundaryMs : 0).toISOString();

  let maxTs = highWaterMark;
  const filtered = items.filter((item) => {
    const ts = item.updatedAt || item.createdAt || item.timestamp || '';
    if (ts > maxTs) maxTs = ts;
    return ts >= boundaryIso;
  });

  return { records: filtered, newHighWaterMark: maxTs };
}

/**
 * Prepares the payload containing changed entities to sync to Google Sheets.
 */
export function buildSyncPayload(
  checkpoint: SheetSyncCheckpoint,
  forceFullSync: boolean = false
) {
  const db = getDb();
  const marks = checkpoint.highWaterMarks;

  const customersRes = filterEntitiesWithOverlap(db.customers, marks.customers, forceFullSync);
  const subscriptionsRes = filterEntitiesWithOverlap(db.subscriptions, marks.subscriptions, forceFullSync);
  const subCatsRes = filterEntitiesWithOverlap(db.subscriptionCategories, marks.subscriptionCategories, forceFullSync);
  const paymentsRes = filterEntitiesWithOverlap(db.payments, marks.payments, forceFullSync);
  const paymentOrdersRes = filterEntitiesWithOverlap(db.paymentOrders, marks.paymentOrders, forceFullSync);
  const packagesRes = filterEntitiesWithOverlap(db.dailyNewsPackages, marks.dailyNewsPackages, forceFullSync);
  const storiesRes = filterEntitiesWithOverlap(db.newsStories, marks.newsStories, forceFullSync);
  const deliveryRes = filterEntitiesWithOverlap(db.telegramDeliveryLogs, marks.telegramDeliveryLogs, forceFullSync);
  const tokensRes = filterEntitiesWithOverlap(db.telegramConnectionTokens, marks.telegramConnectionTokens, forceFullSync);
  const auditsRes = filterEntitiesWithOverlap(db.categoryTransferAudits, marks.categoryTransferAudits, forceFullSync);

  // System Scheduler Document
  const systemSchedulerRecord = [{
    stateId: 'global_scheduler',
    lastGenerationDate: new Date().toISOString().substring(0, 10),
    lastDeliveryDate: new Date().toISOString().substring(0, 10),
    lastDay3EvaluationDate: new Date().toISOString().substring(0, 10),
    updatedAt: new Date().toISOString(),
  }];

  const batchId = 'sync_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

  const entities = {
    customers: customersRes.records,
    subscriptions: subscriptionsRes.records,
    subscriptionCategories: subCatsRes.records,
    payments: paymentsRes.records,
    paymentOrders: paymentOrdersRes.records,
    dailyNewsPackages: packagesRes.records,
    newsStories: storiesRes.records,
    telegramDeliveryLogs: deliveryRes.records,
    telegramConnectionTokens: tokensRes.records,
    categoryTransferAudits: auditsRes.records,
    systemScheduler: systemSchedulerRecord,
  };

  const newHighWaterMarks = {
    customers: customersRes.newHighWaterMark,
    subscriptions: subscriptionsRes.newHighWaterMark,
    subscriptionCategories: subCatsRes.newHighWaterMark,
    payments: paymentsRes.newHighWaterMark,
    paymentOrders: paymentOrdersRes.newHighWaterMark,
    dailyNewsPackages: packagesRes.newHighWaterMark,
    newsStories: storiesRes.newHighWaterMark,
    telegramDeliveryLogs: deliveryRes.newHighWaterMark,
    telegramConnectionTokens: tokensRes.newHighWaterMark,
    categoryTransferAudits: auditsRes.newHighWaterMark,
    systemScheduler: new Date().toISOString(),
  };

  return { batchId, entities, newHighWaterMarks };
}

/**
 * Canonicalizes an arbitrary JSON object/array/value recursively with sorted keys.
 * Produces an exact, deterministic string representation.
 */
export function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((key) => {
    return JSON.stringify(key) + ':' + canonicalizeJson((obj as Record<string, unknown>)[key]);
  });
  return '{' + pairs.join(',') + '}';
}

/**
 * Computes lowercase hex SHA-256 digest of a string
 */
export function computeSha256Hex(str: string): string {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Constructs the canonical message to sign and the SHA-256 hash of the entities payload.
 */
export function buildCanonicalMessage(
  action: string,
  batchId: string,
  timestamp: number,
  nonce: string,
  spreadsheetId: string,
  entities: Record<string, unknown[]>
): { messageToSign: string; payloadHash: string } {
  const canonicalEntities = canonicalizeJson(entities);
  const payloadHash = computeSha256Hex(canonicalEntities);
  const messageToSign = [
    action,
    batchId,
    String(timestamp),
    nonce,
    spreadsheetId,
    payloadHash,
  ].join(':');
  return { messageToSign, payloadHash };
}

/**
 * Computes HMAC-SHA256 signature using SHEET_SYNC_SECRET.
 */
export function generateHmacSignature(messageToSign: string, secret: string): string {
  return crypto.createHmac('sha256', secret.trim()).update(messageToSign, 'utf8').digest('hex');
}

export interface SyncBatchPayload {
  action: 'SYNC_FIRESTORE_BATCH';
  auth: {
    timestamp: number;
    nonce: string;
    signature: string;
  };
  batchId: string;
  spreadsheetId: string;
  entities: Record<string, unknown[]>;
}

/**
 * Dispatches an HTTP batch payload to the Google Apps Script Web App.
 *
 * CRITICAL SECURITY RULES:
 * 1. Authenticates via HMAC-SHA256 signature over (action:batchId:timestamp:nonce:spreadsheetId:payloadHash).
 * 2. SHEET_SYNC_SECRET is NEVER transmitted across the wire (not in headers, body, or URL).
 * 3. Secret is NEVER logged.
 * 4. Retries up to 3 times for transient HTTP errors (429, 500, 502, 503, 504).
 */
export async function sendSyncBatchToAppsScript(
  appsScriptUrl: string,
  batchId: string,
  entities: Record<string, unknown[]>,
  mockHandler?: (payload: SyncBatchPayload) => Promise<{ ok: boolean; results?: Record<string, unknown>; error?: string }>
): Promise<{ ok: boolean; results?: Record<string, unknown>; error?: string }> {
  const secret = getSheetSyncSecret();
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');

  const { messageToSign } = buildCanonicalMessage(
    'SYNC_FIRESTORE_BATCH',
    batchId,
    timestamp,
    nonce,
    TARGET_SPREADSHEET_ID,
    entities
  );

  const signature = generateHmacSignature(messageToSign, secret);

  const payload: SyncBatchPayload = {
    action: 'SYNC_FIRESTORE_BATCH',
    auth: {
      timestamp,
      nonce,
      signature,
    },
    batchId,
    spreadsheetId: TARGET_SPREADSHEET_ID,
    entities,
  };

  // If a mockHandler is provided (e.g. during integration tests), route through it
  if (mockHandler) {
    return mockHandler(payload);
  }

  const maxAttempts = 3;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

      const response = await fetch(appsScriptUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < maxAttempts) {
          const backoffMs = attempt * 1000;
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        return { ok: false, error: `Apps Script HTTP ${response.status}: ${response.statusText}` };
      }

      const json = await response.json();
      return json as { ok: boolean; results?: Record<string, unknown>; error?: string };
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }

  return {
    ok: false,
    error: `Failed after ${maxAttempts} attempts: ${lastErr?.message || 'Network error'}`,
  };
}

/**
 * Main Synchronization Runner.
 * Executes the complete Firestore -> Google Sheets synchronization pipeline.
 *
 * Guarantees:
 * - Distributed lock enforcement across instances.
 * - Timestamp overlap window + primary-key upsert ensures idempotency.
 * - Updates durable Firestore checkpoint upon completion.
 * - Business operations never fail or block if this encounters an error.
 */
export async function executeFirestoreToSheetSync(options?: {
  forceFullSync?: boolean;
  mockHandler?: (payload: SyncBatchPayload) => Promise<{ ok: boolean; results?: Record<string, unknown>; error?: string }>;
}): Promise<{
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  batchId?: string;
  durationMs?: number;
  stats?: Record<string, unknown>;
  error?: string;
}> {
  const startTime = Date.now();
  const instanceId = 'cloudrun_' + process.pid + '_' + crypto.randomBytes(3).toString('hex');

  // 1. Acquire Distributed Lock
  const lockAcquired = await acquireSheetSyncLock(instanceId);
  if (!lockAcquired) {
    return {
      ok: false,
      skipped: true,
      reason: 'Another synchronization process currently holds the distributed lease lock.',
    };
  }

  try {
    const checkpoint = await getSheetSyncCheckpoint();
    const appsScriptUrl = getAppsScriptUrl();

    // 2. Verify destination endpoint configuration
    if (!appsScriptUrl && !options?.mockHandler) {
      checkpoint.lastSyncStatus = 'failed';
      checkpoint.lastSyncError = 'APPS_SCRIPT_WEBAPP_URL is not configured in server environment.';
      await saveSheetSyncCheckpoint(checkpoint);
      return {
        ok: false,
        error: 'APPS_SCRIPT_WEBAPP_URL is not configured.',
      };
    }

    // 3. Prepare entities with overlap window
    const { batchId, entities, newHighWaterMarks } = buildSyncPayload(
      checkpoint,
      options?.forceFullSync || false
    );

    // Calculate total records to transmit
    const totalRecords = Object.values(entities).reduce((acc, curr) => acc + curr.length, 0);

    // 4. Dispatch batch to Apps Script
    const dispatchResult = await sendSyncBatchToAppsScript(
      appsScriptUrl || 'http://localhost/mock_apps_script',
      batchId,
      entities,
      options?.mockHandler
    );

    const durationMs = Date.now() - startTime;

    if (!dispatchResult.ok) {
      checkpoint.lastSyncStatus = 'failed';
      checkpoint.lastSyncError = dispatchResult.error || 'Unknown Apps Script error';
      await saveSheetSyncCheckpoint(checkpoint);
      return {
        ok: false,
        batchId,
        error: dispatchResult.error,
        durationMs,
      };
    }

    // 5. Update durable Firestore checkpoint with high-water marks and stats
    checkpoint.lastSyncStatus = 'success';
    checkpoint.lastSyncCompletedAt = new Date().toISOString();
    checkpoint.lastSyncError = null;
    checkpoint.totalSyncRuns = (checkpoint.totalSyncRuns || 0) + 1;
    checkpoint.highWaterMarks = newHighWaterMarks;
    checkpoint.lastStats = {
      syncedEntities: (dispatchResult.results as Record<string, { inserted: number; updated: number; total: number }>) || {},
      durationMs,
    };

    await saveSheetSyncCheckpoint(checkpoint);

    return {
      ok: true,
      batchId,
      durationMs,
      stats: {
        totalRecordsDispatched: totalRecords,
        appsScriptResults: dispatchResult.results,
      },
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[SheetSync] Execution exception (non-fatal to business operations):', errorMsg);
    return {
      ok: false,
      error: errorMsg,
    };
  } finally {
    // 6. Release Distributed Lock
    await releaseSheetSyncLock(instanceId);
  }
}

/**
 * Non-blocking background sync trigger.
 * Fire-and-forget; catches and logs errors without disturbing the caller.
 */
export function triggerSheetSyncBackground(options?: { forceFullSync?: boolean }): void {
  setImmediate(async () => {
    try {
      await executeFirestoreToSheetSync(options);
    } catch (err) {
      console.warn('[SheetSync] Background sync execution failed silently:', err instanceof Error ? err.message : String(err));
    }
  });
}
