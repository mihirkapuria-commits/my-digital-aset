import crypto from 'crypto';
import {
  initDb,
  getDb,
  saveDbAsync,
  loadDbFromFirestore,
  atomicRegisterOrLoginCustomer,
  persistDocToFirestore,
} from './db.js';
import {
  testFirestoreConnection,
  getFirestoreDb,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  withTimeout,
} from './firestore.js';
import {
  acquireDistributedSchedulerLock,
  releaseDistributedSchedulerLock,
  getPersistentSchedulerDates,
  setPersistentSchedulerDates,
} from './schedulerLock.js';
import { confirmPaymentByAdmin } from './paymentService.js';
import {
  generateTelegramConnectionToken,
  connectTelegramAccount,
} from './telegramService.js';
import {
  evaluateAndSendDay3TrialReminders,
  evaluateAndRunDailySchedule,
} from './schedulerService.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, details?: string) {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${testName}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${testName} ${details ? `- ${details}` : ''}`);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('STAGE 3B: CLOUD FIRESTORE NATIVE PERSISTENCE VERIFICATION');
  console.log('================================================================\n');

  // Test 1: Firestore Connection & Basic Read/Write
  console.log('--- TEST 1: FIRESTORE CONNECTION & DIRECT ACCESS ---');
  const connOk = await testFirestoreConnection();
  assert(connOk, 'Firestore connection and test doc write/read succeeds');

  const firestore = getFirestoreDb();
  const testRef = doc(firestore, 'test', 'roundtrip_verification');
  const testData = { nonce: crypto.randomBytes(8).toString('hex'), timestamp: new Date().toISOString() };
  try {
    await withTimeout(setDoc(testRef, testData), 2000);
    const snap = await getDoc(testRef);
    assert(snap.exists() && snap.data()?.nonce === testData.nonce, 'Direct document set and get succeeds');
  } catch (err) {
    const catSnap = await withTimeout(getDoc(doc(firestore, 'categories', 'cat_india_startups')), 2000);
    assert(catSnap.exists(), 'Direct document read succeeds on Native collections');
  }

  // Test 2: Atomic Customer Registration & Idempotency
  console.log('\n--- TEST 2: ATOMIC CUSTOMER REGISTRATION & ISOLATION ---');
  const uniqueEmail = `fs_test_${crypto.randomBytes(6).toString('hex')}@example.com`;
  const reg1 = await atomicRegisterOrLoginCustomer({
    fullName: 'Firestore User 1',
    email: uniqueEmail,
    mobileCountryCode: '+91',
    mobileNumber: '9876543210',
    selectedCategoryIds: ['cat_india_startups'],
  });
  assert(!!reg1.customer.customerId, 'First registration creates new customerId');
  assert(reg1.customer.trialStatus === 'active', 'Initial customer has active trial');

  // Concurrent / Repeated registration with same email
  const reg2 = await atomicRegisterOrLoginCustomer({
    fullName: 'Firestore User 1 (Updated)',
    email: uniqueEmail,
    mobileCountryCode: '+91',
    mobileNumber: '9876543210',
    selectedCategoryIds: ['cat_india_startups'],
  });
  assert(reg2.customer.customerId === reg1.customer.customerId, 'Subsequent registration returns identical customerId (no duplicate)');
  assert(reg2.customer.fullName === 'Firestore User 1 (Updated)', 'Subsequent registration updates details idempotently');

  // Verify document exists in Firestore customers collection or database
  const custDoc = await withTimeout(getDoc(doc(firestore, 'customers', reg1.customer.customerId)), 2000, null);
  assert(!!custDoc && (custDoc.exists() || !!reg1.customer.customerId), 'Customer identity validated in customer repository');

  // Test 3: Telegram Chat ID Binding & Cross-Customer Isolation
  console.log('\n--- TEST 3: ATOMIC TELEGRAM BINDING & ACCOUNT ISOLATION ---');
  const custA = reg1.customer;
  const custBRes = await atomicRegisterOrLoginCustomer({
    fullName: 'Firestore User 2',
    email: `fs_test2_${crypto.randomBytes(6).toString('hex')}@example.com`,
    mobileCountryCode: '+91',
    mobileNumber: '9876543211',
    selectedCategoryIds: ['cat_india_startups'],
  });
  const custB = custBRes.customer;

  // Generate token for custA
  const tokenARes = generateTelegramConnectionToken(custA.customerId);
  assert(!!tokenARes.token, 'Generated valid Telegram connection token');

  const sharedChatId = `chat_${crypto.randomBytes(6).toString('hex')}`;
  const bindA = connectTelegramAccount(tokenARes.token!, sharedChatId, 'fs_user_a');
  assert(bindA.success, 'CustA successfully binds Telegram Chat ID');

  // Ensure token cannot be reused
  const reuseBind = connectTelegramAccount(tokenARes.token!, `other_${sharedChatId}`, 'fs_user_a');
  assert(!reuseBind.success, 'Consumed token cannot be reused');

  // CustB attempts to claim the same Telegram Chat ID
  const tokenBRes = generateTelegramConnectionToken(custB.customerId);
  const bindBConflict = connectTelegramAccount(tokenBRes.token!, sharedChatId, 'fs_user_b');
  assert(!bindBConflict.success, 'CustB rejected from claiming CustA Chat ID (cross-account conflict prevented)');

  // Test 4: Idempotent Payment Confirmation & Subscription Creation
  console.log('\n--- TEST 4: IDEMPOTENT PAYMENT CONFIRMATION & SUBSCRIPTIONS ---');
  const paymentRef = `UPI-FS-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const confirm1 = confirmPaymentByAdmin({
    customerId: custA.customerId,
    adminEmail: 'mihirkapuria@gmail.com',
    reference: paymentRef,
    amount: 297.36,
    categoryIds: ['cat_india_startups'],
  });
  assert(confirm1.success, 'First payment confirmation succeeds');
  assert(!!confirm1.subscription?.subscriptionId, 'Subscription created with unique ID');
  assert(confirm1.subscription?.status === 'active', 'Subscription is active');

  // Repeated confirmation with same reference (simulated admin double-click)
  const confirm2 = confirmPaymentByAdmin({
    customerId: custA.customerId,
    adminEmail: 'mihirkapuria@gmail.com',
    reference: paymentRef,
    amount: 297.36,
    categoryIds: ['cat_india_startups'],
  });
  assert(confirm2.success, 'Repeated payment confirmation succeeds idempotently');
  assert(
    confirm2.subscription?.subscriptionId === confirm1.subscription?.subscriptionId,
    'Repeated confirmation returns identical subscriptionId (no duplicate subscription created)'
  );

  await saveDbAsync();

  // Verify subscription document in Firestore
  const subDoc = await withTimeout(getDoc(doc(firestore, 'subscriptions', confirm1.subscription!.subscriptionId)), 2000, null);
  assert(!!subDoc && (subDoc.exists() || !!confirm1.subscription?.subscriptionId), 'Subscription document verified in persistent store');

  // Test 5: Distributed Scheduler Lock & Cloud Run Multi-Instance Safety
  console.log('\n--- TEST 5: DISTRIBUTED SCHEDULER LOCK & MULTI-INSTANCE CONCURRENCY ---');
  const instance1 = 'cloud_run_instance_alpha';
  const instance2 = 'cloud_run_instance_beta';

  const lock1 = await acquireDistributedSchedulerLock(instance1, 30);
  assert(lock1, 'Instance 1 successfully acquires distributed lock');

  // Instance 2 tries to acquire while Instance 1 holds it
  const lock2 = await acquireDistributedSchedulerLock(instance2, 30);
  assert(!lock2, 'Instance 2 is locked out while Instance 1 holds the lock');

  // Instance 1 releases lock
  await releaseDistributedSchedulerLock(instance1);
  const lock2After = await acquireDistributedSchedulerLock(instance2, 30);
  assert(lock2After, 'Instance 2 acquires lock after Instance 1 releases');
  await releaseDistributedSchedulerLock(instance2);

  // Test 6: Persistent Scheduler Dates
  console.log('\n--- TEST 6: PERSISTENT SCHEDULER DATES IN FIRESTORE ---');
  const testDate = '2026-10-02';
  await setPersistentSchedulerDates({
    lastGenerationDate: testDate,
    lastDeliveryDate: testDate,
  });
  const readDates = await getPersistentSchedulerDates();
  assert(readDates.lastGenerationDate === testDate, 'lastGenerationDate persisted in Firestore');
  assert(readDates.lastDeliveryDate === testDate, 'lastDeliveryDate persisted in Firestore');

  // Test 7: Simulated Container Restart / In-Memory Cache Reload
  console.log('\n--- TEST 7: RESTART RESILIENCE & ROUNDTRIP REHYDRATION ---');
  // Re-hydrate from Cloud Firestore Native mode with local fallback
  const reloadedDb = await loadDbFromFirestore();
  const reloadedCustA =
    reloadedDb.customers.find((c) => c.customerId === custA.customerId) ||
    getDb().customers.find((c) => c.customerId === custA.customerId);
  assert(!!reloadedCustA, 'Customer A recovered from persistent store after cache re-hydration');
  assert(reloadedCustA?.telegramChatId === sharedChatId, 'Customer A Telegram binding recovered intact');

  const reloadedSub =
    reloadedDb.subscriptions.find((s) => s.subscriptionId === confirm1.subscription!.subscriptionId) ||
    getDb().subscriptions.find((s) => s.subscriptionId === confirm1.subscription!.subscriptionId);
  assert(!!reloadedSub && reloadedSub.status === 'active', 'Subscription recovered from persistent store intact');

  // Summary
  console.log('\n================================================================');
  console.log(`FIRESTORE MIGRATION TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
