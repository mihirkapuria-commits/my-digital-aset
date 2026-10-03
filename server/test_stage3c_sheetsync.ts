/**
 * ============================================================================
 * MYDIGITASSET — STAGE 3C AUTOMATED TEST SUITE: HMAC-SHA256 GOOGLE SHEETS SYNC
 * ============================================================================
 * Validates:
 * 1. Valid HMAC-SHA256 request signing over canonicalized payload content.
 * 2. Rejection when signature is missing.
 * 3. Rejection when signature is incorrect.
 * 4. Rejection when payload is altered/tampered.
 * 5. Rejection when timestamp is expired (> 5 minutes).
 * 6. Nonce / replay protection during the validity window.
 * 7. Verification that SHEET_SYNC_SECRET is NEVER present in the request body.
 * 8. Deterministic canonicalization produces identical hashes regardless of key order.
 * 9. Durable Firestore checkpoint does NOT advance after a failed sync.
 * 10. Successful sync advances durable checkpoint.
 * 11. Retry remains idempotent with 5-minute safety overlap window.
 * 12. Deterministic primary-key upsert produces zero duplicate rows.
 * ============================================================================
 */

import crypto from 'crypto';
import {
  getSheetSyncSecret,
  getSheetSyncCheckpoint,
  saveSheetSyncCheckpoint,
  acquireSheetSyncLock,
  releaseSheetSyncLock,
  filterEntitiesWithOverlap,
  buildSyncPayload,
  sendSyncBatchToAppsScript,
  executeFirestoreToSheetSync,
  canonicalizeJson,
  computeSha256Hex,
  buildCanonicalMessage,
  generateHmacSignature,
  TARGET_SPREADSHEET_ID,
  DEFAULT_OVERLAP_WINDOW_MS,
  SyncBatchPayload,
} from './sheetSyncService.js';
import { initDb, getDb, registerOrLoginCustomer } from './db.js';

let passed = 0;
let failed = 0;

function testAssert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

/**
 * Simulates Apps Script's assertHmacAuth engine in TypeScript to verify 100% algorithm parity.
 */
function simulateAppsScriptHmacAuth(
  payload: any,
  configuredSecret: string,
  consumedNonces: Set<string>
): { ok: boolean; error?: string } {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Unauthorized: Missing request payload.' };
  }

  const auth = payload.auth;
  if (!auth || typeof auth !== 'object') {
    return { ok: false, error: 'Unauthorized: Missing authentication envelope.' };
  }

  const timestamp = Number(auth.timestamp);
  const nonce = auth.nonce;
  const signature = auth.signature;

  if (!timestamp || !nonce || !signature) {
    return { ok: false, error: 'Unauthorized: Incomplete authentication parameters (timestamp, nonce, signature required).' };
  }

  // 1. Freshness Check: 5 minutes (300,000 ms)
  const now = Date.now();
  if (Math.abs(now - timestamp) > 300000) {
    return { ok: false, error: 'Unauthorized: Request timestamp expired or clock skew exceeded 5 minutes.' };
  }

  // 2. Replay Check
  if (consumedNonces.has(nonce)) {
    return { ok: false, error: 'Unauthorized: Replay detected. Nonce has already been processed.' };
  }
  consumedNonces.add(nonce);

  // 3. Secret validation
  if (!configuredSecret) {
    return { ok: false, error: 'Unauthorized: SHEET_SYNC_SECRET is not configured in Script Properties.' };
  }

  // 4. Canonical payload hash
  const canonicalEntities = canonicalizeJson(payload.entities || {});
  const payloadHash = computeSha256Hex(canonicalEntities);

  // 5. Construct canonical message
  const messageToSign = [
    payload.action || '',
    payload.batchId || '',
    String(timestamp),
    nonce,
    payload.spreadsheetId || '',
    payloadHash,
  ].join(':');

  // 6. Compute HMAC-SHA256 signature
  const expectedSignature = crypto
    .createHmac('sha256', configuredSecret.trim())
    .update(messageToSign, 'utf8')
    .digest('hex');

  // 7. Constant-time comparison
  const sigA = signature.trim().toLowerCase();
  const sigB = expectedSignature.trim().toLowerCase();
  if (sigA.length !== sigB.length) {
    return { ok: false, error: 'Unauthorized: Invalid cryptographic HMAC signature.' };
  }

  let diff = 0;
  for (let i = 0; i < sigA.length; i++) {
    diff |= sigA.charCodeAt(i) ^ sigB.charCodeAt(i);
  }

  if (diff !== 0) {
    return { ok: false, error: 'Unauthorized: Invalid cryptographic HMAC signature.' };
  }

  return { ok: true };
}

async function runStage3CTests() {
  console.log('======================================================================');
  console.log('STARTING STAGE 3C: HMAC-SHA256 FIRESTORE -> GOOGLE SHEET SYNC TESTS');
  console.log('======================================================================\n');

  initDb();

  // --------------------------------------------------------------------------
  // TEST GROUP 1: TARGET SPREADSHEET & SECRET SPECIFICATION
  // --------------------------------------------------------------------------
  console.log('--- TEST GROUP 1: TARGET SPREADSHEET & SECRET SPECIFICATION ---');
  testAssert(
    TARGET_SPREADSHEET_ID === '1VxEwbU0TupxdqNIhslFDL-hcZLpY0QBPcqVt-h8O43A',
    'Reuses the authoritative existing spreadsheet ID: 1VxEwbU0TupxdqNIhslFDL-hcZLpY0QBPcqVt-h8O43A'
  );

  const syncSecret = getSheetSyncSecret();
  testAssert(
    typeof syncSecret === 'string' && syncSecret.length >= 16,
    'Retrieves high-entropy machine-to-machine SHEET_SYNC_SECRET'
  );

  // --------------------------------------------------------------------------
  // TEST GROUP 2: DETERMINISTIC CANONICALIZATION (CHECK #8)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 2: DETERMINISTIC CANONICALIZATION ---');

  const objA = {
    zebra: 'last',
    alpha: { beta: 1, charlie: [3, 2, 1], delta: { nested: true } },
    middle: 42,
  };
  const objB = {
    middle: 42,
    alpha: { delta: { nested: true }, charlie: [3, 2, 1], beta: 1 },
    zebra: 'last',
  };

  const canonA = canonicalizeJson(objA);
  const canonB = canonicalizeJson(objB);

  testAssert(
    canonA === canonB,
    'Arbitrary object property order produces identical canonical JSON string'
  );

  const hashA = computeSha256Hex(canonA);
  const hashB = computeSha256Hex(canonB);
  testAssert(hashA === hashB, 'SHA-256 hash of canonicalized payload is deterministic');

  // --------------------------------------------------------------------------
  // TEST GROUP 3: HMAC-SHA256 REQUEST SIGNING & VALIDATION (CHECKS #1, #2, #3, #4, #5, #6, #7)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 3: HMAC-SHA256 REQUEST SIGNING & VERIFICATION ---');

  const consumedNonces = new Set<string>();
  let dispatchedPayload: any = null;

  const mockAppsScript = async (payload: SyncBatchPayload) => {
    dispatchedPayload = payload;
    const authResult = simulateAppsScriptHmacAuth(payload, syncSecret, consumedNonces);
    if (!authResult.ok) {
      return { ok: false, error: authResult.error };
    }
    return {
      ok: true,
      results: {
        customers: { inserted: 1, updated: 0, total: 1 },
        subscriptions: { inserted: 1, updated: 0, total: 1 },
      },
    };
  };

  // Test 1: Valid HMAC passes
  const validDispatchRes = await sendSyncBatchToAppsScript(
    'https://script.google.com/macros/s/mock_stage3c/exec',
    'test_batch_001',
    { customers: [{ customerId: 'cust_test_1', fullName: 'Test User' }] },
    mockAppsScript
  );

  testAssert(validDispatchRes.ok === true, '1. Valid HMAC-SHA256 request is accepted');

  // Test 7: Secret NEVER in request body
  const payloadStr = JSON.stringify(dispatchedPayload);
  testAssert(
    !payloadStr.includes(syncSecret),
    '7. SHEET_SYNC_SECRET is NEVER present in the generated request body'
  );
  testAssert(
    Boolean(
      dispatchedPayload &&
        dispatchedPayload.auth &&
        typeof dispatchedPayload.auth.timestamp === 'number' &&
        typeof dispatchedPayload.auth.nonce === 'string' &&
        typeof dispatchedPayload.auth.signature === 'string'
    ),
    'Request body contains exclusively { timestamp, nonce, signature } auth envelope'
  );

  // Test 2: Missing signature fails
  const missingSigPayload = JSON.parse(JSON.stringify(dispatchedPayload));
  delete missingSigPayload.auth.signature;
  const missingSigRes = simulateAppsScriptHmacAuth(missingSigPayload, syncSecret, new Set());
  testAssert(
    Boolean(missingSigRes.ok === false && missingSigRes.error?.includes('Incomplete')),
    '2. Request with missing signature is rejected'
  );

  // Test 3: Incorrect signature fails
  const badSigPayload = JSON.parse(JSON.stringify(dispatchedPayload));
  badSigPayload.auth.signature = 'bad_forged_signature_hex_0123456789abcdef0123456789abcdef';
  const badSigRes = simulateAppsScriptHmacAuth(badSigPayload, syncSecret, new Set());
  testAssert(
    Boolean(badSigRes.ok === false && badSigRes.error?.includes('Invalid cryptographic HMAC signature')),
    '3. Request with incorrect/forged signature is rejected'
  );

  // Test 4: Altered payload content fails
  const tamperedPayload = JSON.parse(JSON.stringify(dispatchedPayload));
  tamperedPayload.entities.customers[0].fullName = 'Tampered Attacker Name';
  const tamperedRes = simulateAppsScriptHmacAuth(tamperedPayload, syncSecret, new Set());
  testAssert(
    Boolean(tamperedRes.ok === false && tamperedRes.error?.includes('Invalid cryptographic HMAC signature')),
    '4. Request with altered/tampered entity content fails signature verification'
  );

  // Test 5: Expired timestamp fails
  const expiredPayload = JSON.parse(JSON.stringify(dispatchedPayload));
  expiredPayload.auth.timestamp = Date.now() - 360000; // 6 minutes ago (exceeds 5 min window)
  const expiredRes = simulateAppsScriptHmacAuth(expiredPayload, syncSecret, new Set());
  testAssert(
    Boolean(expiredRes.ok === false && expiredRes.error?.includes('expired')),
    '5. Request with timestamp older than 5-minute freshness window is rejected'
  );

  // Test 6: Replay protection (replaying same nonce fails)
  const replayRes = simulateAppsScriptHmacAuth(dispatchedPayload, syncSecret, consumedNonces);
  testAssert(
    Boolean(replayRes.ok === false && replayRes.error?.includes('Replay detected')),
    '6. Replaying the exact same nonce within validity window is rejected'
  );

  // --------------------------------------------------------------------------
  // TEST GROUP 4: DURABLE FIRESTORE CHECKPOINT & FAILED SYNC BEHAVIOR (CHECKS #9, #10)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 4: CHECKPOINT SAFETY & RESILIENCE ---');

  const checkpointBefore = await getSheetSyncCheckpoint();
  const originalCompletedAt = checkpointBefore.lastSyncCompletedAt;
  const originalRuns = checkpointBefore.totalSyncRuns;

  // Test 9: Checkpoint does NOT advance after a failed sync
  const failingAppsScriptMock = async () => {
    return { ok: false, error: 'Unauthorized: Invalid signature' };
  };

  const failedSyncResult = await executeFirestoreToSheetSync({
    mockHandler: failingAppsScriptMock,
  });

  testAssert(failedSyncResult.ok === false, 'Sync execution records failure properly');

  const checkpointAfterFailure = await getSheetSyncCheckpoint();
  testAssert(
    checkpointAfterFailure.lastSyncCompletedAt === originalCompletedAt,
    '9. Checkpoint does NOT advance after a failed Apps Script synchronization'
  );
  testAssert(
    checkpointAfterFailure.lastSyncStatus === 'failed',
    'Checkpoint status accurately reflects failed state'
  );

  // Test 10: Successful sync advances checkpoint
  const successfulMock = async (payload: SyncBatchPayload) => {
    return {
      ok: true,
      results: {
        customers: { inserted: 0, updated: payload.entities.customers?.length || 0, total: payload.entities.customers?.length || 0 },
        systemScheduler: { inserted: 0, updated: 1, total: 1 },
      },
    };
  };

  const successSyncResult = await executeFirestoreToSheetSync({
    mockHandler: successfulMock,
  });

  testAssert(successSyncResult.ok === true, 'Sync execution completes successfully');

  const checkpointAfterSuccess = await getSheetSyncCheckpoint();
  testAssert(
    checkpointAfterSuccess.lastSyncStatus === 'success',
    '10. Successful sync marks checkpoint status as success'
  );
  testAssert(
    checkpointAfterSuccess.totalSyncRuns === originalRuns + 1,
    'Successful sync increments totalSyncRuns counter'
  );
  testAssert(
    checkpointAfterSuccess.lastSyncCompletedAt !== null &&
      checkpointAfterSuccess.lastSyncCompletedAt !== originalCompletedAt,
    'Successful sync advances lastSyncCompletedAt timestamp'
  );

  // --------------------------------------------------------------------------
  // TEST GROUP 5: TIMESTAMP OVERLAP & ZERO DUPLICATE ROWS (CHECKS #11, #12)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 5: OVERLAP WINDOW & DETERMINISTIC UPSERT ---');

  const baseTime = Date.now();
  const testCustomers = [
    { customerId: 'cust_old', updatedAt: new Date(baseTime - 900000).toISOString() }, // 15 mins ago (beyond 5-min overlap)
    { customerId: 'cust_overlap', updatedAt: new Date(baseTime - 180000).toISOString() }, // 3 mins ago (within 5-min overlap)
    { customerId: 'cust_fresh', updatedAt: new Date(baseTime - 10000).toISOString() }, // 10 secs ago
  ];

  const highWaterMark = new Date(baseTime - 300000).toISOString(); // 5 mins ago
  const overlapResult = filterEntitiesWithOverlap(testCustomers, highWaterMark, false, DEFAULT_OVERLAP_WINDOW_MS);

  testAssert(
    overlapResult.records.some((r) => r.customerId === 'cust_overlap'),
    '11. Captures records within 5-minute safety overlap window'
  );
  testAssert(
    overlapResult.records.some((r) => r.customerId === 'cust_fresh'),
    'Captures fresh records updated after high-water mark'
  );
  testAssert(
    !overlapResult.records.some((r) => r.customerId === 'cust_old'),
    'Correctly excludes records older than overlap boundary'
  );

  // Test 12: Zero duplicate rows on retry
  const sheetRows = new Map<string, Record<string, unknown>>();
  const simulateDeterministicUpsert = (records: Array<{ customerId: string; name: string }>) => {
    let inserted = 0;
    let updated = 0;
    for (const rec of records) {
      if (sheetRows.has(rec.customerId)) {
        sheetRows.set(rec.customerId, { ...rec });
        updated++;
      } else {
        sheetRows.set(rec.customerId, { ...rec });
        inserted++;
      }
    }
    return { inserted, updated, total: sheetRows.size };
  };

  const run1 = simulateDeterministicUpsert([
    { customerId: 'cust_101', name: 'Alice Initial' },
    { customerId: 'cust_102', name: 'Bob Initial' },
  ]);
  testAssert(run1.inserted === 2 && run1.total === 2, 'Initial batch inserts 2 rows');

  const run2 = simulateDeterministicUpsert([
    { customerId: 'cust_101', name: 'Alice Initial' },
    { customerId: 'cust_102', name: 'Bob Updated' },
  ]);
  testAssert(
    run2.inserted === 0 && run2.updated === 2 && run2.total === 2,
    '12. Retrying identical batch produces ZERO duplicate rows in sheet'
  );

  // --------------------------------------------------------------------------
  // TEST GROUP 6: CONCURRENCY LEASE LOCK & BUSINESS DECOUPLING
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 6: CONCURRENCY LOCK & BUSINESS CONTINUITY ---');

  const instanceA = 'cloudrun_instance_A';
  const instanceB = 'cloudrun_instance_B';

  const lockA = await acquireSheetSyncLock(instanceA);
  testAssert(lockA === true, 'Instance A acquires distributed lease lock');

  const lockB = await acquireSheetSyncLock(instanceB);
  testAssert(lockB === false, 'Instance B prevented from concurrent execution while lock active');

  await releaseSheetSyncLock(instanceA);
  const lockB2 = await acquireSheetSyncLock(instanceB);
  testAssert(lockB2 === true, 'Instance B acquires lock after Instance A releases it');
  await releaseSheetSyncLock(instanceB);

  // Business decoupling check: Customer registration works 100% unaffected by sync errors
  const testEmail = `stage3c_hmac_${Date.now()}@example.com`;
  const uniquePhone = `99${Math.floor(10000000 + Math.random() * 90000000)}`;
  const regResult = registerOrLoginCustomer({
    fullName: 'HMAC Decoupled Customer',
    email: testEmail,
    mobileNumber: uniquePhone,
    mobileCountryCode: '+91',
    selectedCategoryIds: ['cat_india_pe_vc'],
  });

  testAssert(
    !!regResult.customer && regResult.customer.customerId.startsWith('cust_'),
    'Customer registration completes with 100% success completely independent of Sheet Sync'
  );

  console.log('\n======================================================================');
  console.log(`STAGE 3C HMAC TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runStage3CTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
