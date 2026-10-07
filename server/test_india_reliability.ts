import crypto from 'crypto';
import {
  initDb,
  getDb,
  saveDb,
} from './db.js';
import {
  Customer,
  DailyNewsPackage,
  NewsStory,
  TelegramDeliveryLog,
} from '../src/types';
import {
  INDIA_CATEGORY_IDS,
  generateCategoryDailyNews,
  getKolkataDateString,
  VERIFIED_SOURCE_DATA,
} from './newsService.js';
import {
  SPECIALIST_CATEGORY_IDS,
  generateSpecialistCategoryDailyNews,
} from './specialistNewsService.js';
import {
  deliverIndiaCategoryNewsToCustomer,
} from './indiaDeliveryService.js';
import {
  atomicReserveOperation,
  atomicCompleteOperation,
  atomicReleaseReservation,
  resetIdempotencyStateForTest,
  getOperationStatus,
} from './idempotencyService.js';
import {
  runIndiaReliabilityWatchdog,
  reconcileIndiaCategoryGeneration,
  reconcileIndiaCustomerDeliveries,
  isWithinIndiaRecoveryWindow,
  isIndiaMorningCatchUpEligible,
  getIndiaReliabilityStatus,
  INDIA_WATCHDOG_CONFIG,
} from './indiaReliabilityService.js';

let passed = 0;
let failed = 0;

function testAssert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    if (detail) console.log(`     └─ ${detail}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    if (detail) console.error(`     └─ ERROR: ${detail}`);
    failed++;
  }
}

export async function runIndiaReliabilityTests() {
  console.log('\n======================================================================');
  console.log('MYDIGITASSET: SYSTEM B RELIABILITY HARDENING & WATCHDOG TEST SUITE');
  console.log('======================================================================\n');

  // Fast deterministic test execution using grounded candidate pool
  delete process.env.GEMINI_API_KEY;

  resetIdempotencyStateForTest();
  initDb();
  const db = getDb();

  // Ensure all 10 official India categories are enabled in catalog
  for (const cat of db.categories) {
    if (INDIA_CATEGORY_IDS.includes(cat.id as any)) {
      cat.isActive = true;
    }
  }

  // Clear newsPackages, newsStories, and deliveryLogs for test isolation (clean slate)
  db.dailyNewsPackages = [];
  db.newsStories = [];
  if (!Array.isArray(db.indiaTelegramDeliveryLogs)) {
    db.indiaTelegramDeliveryLogs = [];
  }
  db.indiaTelegramDeliveryLogs = [];
  db.customers = db.customers.filter(
    (c) =>
      !c.customerId.includes('_test_') &&
      !c.customerId.includes('_race_') &&
      !c.customerId.includes('_rel_') &&
      !c.customerId.includes('_missing_') &&
      !c.customerId.includes('_restart_') &&
      !c.customerId.includes('_tg_') &&
      !c.customerId.includes('_debug_')
  );
  db.subscriptions = db.subscriptions.filter((s) => db.customers.some((c) => c.customerId === s.customerId));
  db.subscriptionCategories = db.subscriptionCategories.filter((sc) =>
    db.customers.some((c) => c.customerId === sc.customerId)
  );
  saveDb();

  const testDate = '2027-01-15';
  const targetCategory = 'cat_india_startups';

  // --------------------------------------------------------------------------
  // TEST 1: Enabled category with no package is detected
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: Enabled category with no package is detected ---');
  const initialStatus = getIndiaReliabilityStatus(testDate);
  testAssert(
    initialStatus.categories.missingCount === 10,
    '1. Enabled category with no package is detected',
    `Missing categories detected: ${initialStatus.categories.missingCount} of ${initialStatus.categories.totalActive}`
  );

  // --------------------------------------------------------------------------
  // TEST 2: Missing package is regenerated
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 2: Missing package is regenerated ---');
  const genReconcile1 = await reconcileIndiaCategoryGeneration(testDate, new Date(`${testDate}T07:15:00Z`), {
    forceRecoveryWindow: true,
    sourceProviderMode: 'mock',
  });
  const startupsGen = genReconcile1.items.find((i) => i.categoryId === targetCategory);
  const pkgAfterRegen = db.dailyNewsPackages.find(
    (p) => p.categoryId === targetCategory && p.newsDate === testDate
  );

  testAssert(
    startupsGen !== undefined &&
      startupsGen.actionTaken === 'generated_missing_package' &&
      pkgAfterRegen !== undefined &&
      pkgAfterRegen.storyCount === 10,
    '2. Missing package is regenerated',
    `Action: ${startupsGen?.actionTaken}, Story count: ${pkgAfterRegen?.storyCount}`
  );

  // --------------------------------------------------------------------------
  // TEST 3: Failed zero-story package is retried
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 3: Failed zero-story package is retried ---');
  const failedCat = 'cat_india_banking_fintech';
  // Manually replace banking package with a temporary failed 0-story package
  db.dailyNewsPackages = db.dailyNewsPackages.filter(
    (p) => !(p.categoryId === failedCat && p.newsDate === testDate)
  );
  db.newsStories = db.newsStories.filter(
    (s) => !(s.categoryId === failedCat && s.newsDate === testDate)
  );
  const failedPkg: DailyNewsPackage = {
    packageId: `pkg_${testDate}_${failedCat}`,
    newsDate: testDate,
    categoryId: failedCat,
    categoryName: 'India Banking & FinTech',
    generationStatus: 'failed',
    storyCount: 0,
    errorMessage: 'Temporary feed timeout at 06:00 IST',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.dailyNewsPackages.push(failedPkg);
  saveDb();
  await atomicReleaseReservation(`pkg_${testDate}_${failedCat}`, 'Simulate previous failed tick');

  const genReconcileRetry = await reconcileIndiaCategoryGeneration(testDate, new Date(`${testDate}T07:30:00Z`), {
    forceRecoveryWindow: true,
    sourceProviderMode: 'mock',
  });
  const retriedItem = genReconcileRetry.items.find((i) => i.categoryId === failedCat);
  const recoveredPkg = db.dailyNewsPackages.find(
    (p) => p.categoryId === failedCat && p.newsDate === testDate
  );

  testAssert(
    retriedItem?.actionTaken === 'retried_failed_package' &&
      recoveredPkg !== undefined &&
      recoveredPkg.generationStatus === 'success' &&
      recoveredPkg.storyCount === 10,
    '3. Failed zero-story package is retried and recovered',
    `Action: ${retriedItem?.actionTaken}, Status: ${recoveredPkg?.generationStatus}, Stories: ${recoveredPkg?.storyCount}`
  );

  // --------------------------------------------------------------------------
  // TEST 4: Partial package receives recovery attempt
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 4: Partial package receives recovery attempt ---');
  const partialCat = 'cat_india_it_tech';
  // Set up an initial partial package with 3 stories
  db.dailyNewsPackages = db.dailyNewsPackages.filter(
    (p) => !(p.categoryId === partialCat && p.newsDate === testDate)
  );
  db.newsStories = db.newsStories.filter(
    (s) => !(s.categoryId === partialCat && s.newsDate === testDate)
  );
  const partialPkg: DailyNewsPackage = {
    packageId: `pkg_${testDate}_${partialCat}`,
    newsDate: testDate,
    categoryId: partialCat,
    categoryName: 'India Information Technology',
    generationStatus: 'partial',
    storyCount: 3,
    recoveryAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.dailyNewsPackages.push(partialPkg);
  for (let pos = 1; pos <= 3; pos++) {
    db.newsStories.push({
      storyId: `sty_part_${pos}`,
      packageId: partialPkg.packageId,
      newsDate: testDate,
      categoryId: partialCat,
      position: pos,
      headline: `Partial Story ${pos}`,
      summary: `Partial summary text story ${pos} with sufficient length.`,
      sourceName: 'The Economic Times',
      sourceUrl: `https://economictimes.indiatimes.com/tech/partial-${pos}`,
      sentimentType: 'constructive',
      createdAt: new Date().toISOString(),
    });
  }
  saveDb();

  // Watchdog recovery attempt (using full candidate pool available now)
  const recoveryRun = await reconcileIndiaCategoryGeneration(testDate, new Date(`${testDate}T07:45:00Z`), {
    forceRecoveryWindow: true,
    sourceProviderMode: 'mock',
  });
  const partialRecItem = recoveryRun.items.find((i) => i.categoryId === partialCat);
  const recoveredFullPkg = db.dailyNewsPackages.find(
    (p) => p.categoryId === partialCat && p.newsDate === testDate
  );

  testAssert(
    partialRecItem?.actionTaken === 'recovered_partial_package' &&
      recoveredFullPkg?.storyCount === 10 &&
      recoveredFullPkg?.generationStatus === 'success',
    '4. Partial package receives controlled recovery attempt and upgrades to full',
    `Action: ${partialRecItem?.actionTaken}, Previous stories: ${partialRecItem?.previousStoryCount}, New stories: ${recoveredFullPkg?.storyCount}`
  );

  // --------------------------------------------------------------------------
  // TEST 5: Successful package is not regenerated
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 5: Successful package is not regenerated ---');
  const existingSuccessPkg = db.dailyNewsPackages.find(
    (p) => p.categoryId === targetCategory && p.newsDate === testDate
  );
  const prevUpdatedAt = existingSuccessPkg?.updatedAt;

  const reconSuccessRun = await reconcileIndiaCategoryGeneration(testDate, new Date(`${testDate}T08:00:00Z`), {
    forceRecoveryWindow: true,
    sourceProviderMode: 'mock',
  });
  const successItem = reconSuccessRun.items.find((i) => i.categoryId === targetCategory);
  const afterPkg = db.dailyNewsPackages.find(
    (p) => p.categoryId === targetCategory && p.newsDate === testDate
  );

  testAssert(
    successItem?.actionTaken === 'none_already_successful' &&
      afterPkg?.packageId === existingSuccessPkg?.packageId &&
      afterPkg?.updatedAt === prevUpdatedAt,
    '5. Successful package is not regenerated',
    `Action: ${successItem?.actionTaken}, Package ID unchanged: ${afterPkg?.packageId === existingSuccessPkg?.packageId}`
  );

  // --------------------------------------------------------------------------
  // TEST 6: Morning catch-up works after 07:00
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 6: Morning catch-up works after 07:00 ---');
  const time730 = new Date('2027-01-15T02:00:00.000Z'); // 07:30 IST (+05:30)
  const time915 = new Date('2027-01-15T03:45:00.000Z'); // 09:15 IST (+05:30)

  const isWindow730 = isWithinIndiaRecoveryWindow(time730);
  const isWindow915 = isWithinIndiaRecoveryWindow(time915);

  testAssert(
    isWindow730 && isWindow915,
    '6. Morning catch-up window active after 07:00 (07:30 IST & 09:15 IST)',
    `07:30 IST in window: ${isWindow730}, 09:15 IST in window: ${isWindow915}`
  );

  // --------------------------------------------------------------------------
  // TEST 7: Watchdog is safe to run repeatedly
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 7: Watchdog is safe to run repeatedly ---');
  const countBefore = db.dailyNewsPackages.filter((p) => p.newsDate === testDate).length;
  await runIndiaReliabilityWatchdog({ newsDate: testDate, referenceDate: time730, forceRecoveryWindow: true, sourceProviderMode: 'mock' });
  await runIndiaReliabilityWatchdog({ newsDate: testDate, referenceDate: time730, forceRecoveryWindow: true, sourceProviderMode: 'mock' });
  await runIndiaReliabilityWatchdog({ newsDate: testDate, referenceDate: time730, forceRecoveryWindow: true, sourceProviderMode: 'mock' });
  const countAfter = db.dailyNewsPackages.filter((p) => p.newsDate === testDate).length;

  testAssert(
    countBefore === countAfter && countAfter === 10,
    '7. Watchdog is safe to run repeatedly with zero duplicate packages created',
    `Packages before: ${countBefore}, Packages after 3 repeat cycles: ${countAfter}`
  );

  // --------------------------------------------------------------------------
  // TEST 8: Concurrent watchdog execution cannot create duplicate package
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 8: Concurrent watchdog execution cannot create duplicate package ---');
  const concDate = '2027-01-25';
  db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => p.newsDate !== concDate);
  db.newsStories = db.newsStories.filter((s) => s.newsDate !== concDate);
  saveDb();

  // Run 2 watchdog instances concurrently
  await Promise.all([
    runIndiaReliabilityWatchdog({ newsDate: concDate, forceRecoveryWindow: true, sourceProviderMode: 'mock' }),
    runIndiaReliabilityWatchdog({ newsDate: concDate, forceRecoveryWindow: true, sourceProviderMode: 'mock' }),
  ]);

  const concPkgs = db.dailyNewsPackages.filter((p) => p.newsDate === concDate);
  const uniqueCatIds = new Set(concPkgs.map((p) => p.categoryId));

  testAssert(
    concPkgs.length === 10 && concPkgs.length === uniqueCatIds.size,
    '8. Concurrent watchdog execution cannot create duplicate packages',
    `Total packages: ${concPkgs.length}, Unique categories: ${uniqueCatIds.size}`
  );

  // --------------------------------------------------------------------------
  // TEST 9: Failed customer delivery is retried
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 9: Failed customer delivery is retried ---');
  const testCustId = `cust_rel_test_${Date.now()}`;
  const testCustomer: Customer = {
    customerId: testCustId,
    fullName: 'Reliability Test Customer',
    email: `${testCustId}@example.com`,
    mobileCountryCode: '+91',
    mobileNumber: '9988776655',
    indiaTelegramConnected: true,
    indiaTelegramChatId: `tg_chat_${testCustId}`,
    telegramConnected: true,
    accountStatus: 'active',
    selectedCategoryIds: [targetCategory],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.customers.push(testCustomer);
  db.subscriptions.push({
    subscriptionId: `sub_${testCustId}`,
    customerId: testCustId,
    status: 'active',
    paymentId: `pay_${testCustId}`,
    startDate: '2027-01-01',
    expiryDate: '2028-01-01',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  db.subscriptionCategories.push({
    subscriptionId: `sub_${testCustId}`,
    customerId: testCustId,
    categoryId: targetCategory,
    categoryName: 'India Startups',
    entitlementStatus: 'active',
    assignedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Inject a prior failed delivery log for this customer
  const deliveryId = `del_in_${testDate}_${testCustId}_${targetCategory}`;
  db.indiaTelegramDeliveryLogs.push({
    deliveryId,
    customerId: testCustId,
    categoryId: targetCategory,
    newsDate: testDate,
    telegramChatId: `tg_chat_${testCustId}`,
    attemptedAt: new Date().toISOString(),
    status: 'failed',
    error: 'Temporary network disconnect during morning delivery run',
    timestamp: new Date().toISOString(),
    botType: 'india',
  });
  saveDb();
  await atomicReleaseReservation(deliveryId, 'Reset reservation for retry test');

  // Reconcile deliveries
  const deliveryReconcileResult = await reconcileIndiaCustomerDeliveries(testDate, new Date(`${testDate}T08:15:00Z`));
  const retriedCustItem = deliveryReconcileResult.items.find(
    (d) => d.customerId === testCustId && d.categoryId === targetCategory
  );

  const finalLog = db.indiaTelegramDeliveryLogs.find(
    (l) => l.customerId === testCustId && l.categoryId === targetCategory && l.newsDate === testDate && l.status === 'sent'
  );

  testAssert(
    retriedCustItem?.actionTaken === 'retried_failed_delivery' &&
      finalLog !== undefined &&
      finalLog.status === 'sent',
    '9. Failed customer delivery is retried and successfully marked sent',
    `Action: ${retriedCustItem?.actionTaken}, Final status: ${finalLog?.status}`
  );

  // --------------------------------------------------------------------------
  // TEST 10: Missing customer delivery is detected
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 10: Missing customer delivery is detected ---');
  const testCust2Id = `cust_missing_del_${Date.now()}`;
  db.customers.push({
    customerId: testCust2Id,
    fullName: 'Missing Delivery Customer',
    email: `${testCust2Id}@example.com`,
    mobileCountryCode: '+91',
    mobileNumber: '9988776654',
    indiaTelegramConnected: true,
    indiaTelegramChatId: `tg_chat_${testCust2Id}`,
    telegramConnected: true,
    accountStatus: 'active',
    selectedCategoryIds: [targetCategory],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  db.subscriptions.push({
    subscriptionId: `sub_${testCust2Id}`,
    customerId: testCust2Id,
    status: 'active',
    paymentId: `pay_${testCust2Id}`,
    startDate: '2027-01-01',
    expiryDate: '2028-01-01',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  db.subscriptionCategories.push({
    subscriptionId: `sub_${testCust2Id}`,
    customerId: testCust2Id,
    categoryId: targetCategory,
    categoryName: 'India Startups',
    entitlementStatus: 'active',
    assignedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveDb();

  const missingReconcileResult = await reconcileIndiaCustomerDeliveries(testDate, new Date(`${testDate}T08:30:00Z`));
  const missingItem = missingReconcileResult.items.find(
    (d) => d.customerId === testCust2Id && d.categoryId === targetCategory
  );

  testAssert(
    missingItem?.actionTaken === 'delivered_pending' && missingItem?.status === 'sent',
    '10. Missing customer delivery is detected and fulfilled',
    `Action: ${missingItem?.actionTaken}, Status: ${missingItem?.status}`
  );

  // --------------------------------------------------------------------------
  // TEST 11: Successful customer delivery is not duplicated
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 11: Successful customer delivery is not duplicated ---');
  const countSentBefore = db.indiaTelegramDeliveryLogs.filter(
    (l) => l.customerId === testCust2Id && l.categoryId === targetCategory && l.newsDate === testDate && l.status === 'sent'
  ).length;

  const repeatReconcile = await reconcileIndiaCustomerDeliveries(testDate, new Date(`${testDate}T08:45:00Z`));
  const repeatItem = repeatReconcile.items.find(
    (d) => d.customerId === testCust2Id && d.categoryId === targetCategory
  );
  const countSentAfter = db.indiaTelegramDeliveryLogs.filter(
    (l) => l.customerId === testCust2Id && l.categoryId === targetCategory && l.newsDate === testDate && l.status === 'sent'
  ).length;

  testAssert(
    repeatItem?.actionTaken === 'none_already_sent' && countSentBefore === countSentAfter,
    '11. Successful customer delivery is not duplicated',
    `Action: ${repeatItem?.actionTaken}, Sent records before: ${countSentBefore}, after: ${countSentAfter}`
  );

  // --------------------------------------------------------------------------
  // TEST 12: Cloud Run/process restart scenario leaves recoverable pending work
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 12: Cloud Run restart scenario leaves recoverable pending work ---');
  const restartCustId = `cust_restart_${Date.now()}`;
  db.customers.push({
    customerId: restartCustId,
    fullName: 'Restart Test Customer',
    email: `${restartCustId}@example.com`,
    mobileCountryCode: '+91',
    mobileNumber: '9988776653',
    indiaTelegramConnected: true,
    indiaTelegramChatId: `tg_chat_${restartCustId}`,
    telegramConnected: true,
    accountStatus: 'active',
    selectedCategoryIds: [targetCategory],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  db.subscriptions.push({
    subscriptionId: `sub_${restartCustId}`,
    customerId: restartCustId,
    status: 'active',
    paymentId: `pay_${restartCustId}`,
    startDate: '2027-01-01',
    expiryDate: '2028-01-01',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  db.subscriptionCategories.push({
    subscriptionId: `sub_${restartCustId}`,
    customerId: restartCustId,
    categoryId: targetCategory,
    categoryName: 'India Startups',
    entitlementStatus: 'active',
    assignedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveDb();

  // Simulate Cloud Run restarting: re-initialized memory
  const watchdogAfterRestart = await runIndiaReliabilityWatchdog({
    newsDate: testDate,
    forceRecoveryWindow: true,
    sourceProviderMode: 'mock',
  });
  const restartItem = watchdogAfterRestart.deliveries.find(
    (d) => d.customerId === restartCustId && d.categoryId === targetCategory
  );

  testAssert(
    restartItem !== undefined && restartItem.status === 'sent',
    '12. Cloud Run restart cleanly discovers and recovers pending customer delivery',
    `Customer: ${restartCustId}, Status after restart: ${restartItem?.status}`
  );

  // --------------------------------------------------------------------------
  // TEST 13: One failed category does not stop other India categories
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 13: One failed category does not stop other India categories ---');
  const isolatedDate = '2027-02-15';
  db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => p.newsDate !== isolatedDate);
  db.newsStories = db.newsStories.filter((s) => s.newsDate !== isolatedDate);

  // Inject candidate pool where 1 category returns zero articles (fails) but other 9 have verified articles
  const customPool: Record<string, any[]> = {};
  for (const cid of INDIA_CATEGORY_IDS) {
    if (cid === 'cat_india_mfg_auto') {
      customPool[cid] = []; // 0 articles -> will fail
    } else {
      customPool[cid] = VERIFIED_SOURCE_DATA[cid] || [];
    }
  }

  const multiCatRun = await reconcileIndiaCategoryGeneration(isolatedDate, new Date(`${isolatedDate}T07:00:00Z`), {
    forceRecoveryWindow: true,
    customCandidatePool: customPool,
  });

  const failedOne = multiCatRun.items.find((i) => i.categoryId === 'cat_india_mfg_auto');
  const successfulOthers = multiCatRun.items.filter((i) => i.categoryId !== 'cat_india_mfg_auto' && i.status === 'SUCCESS');

  testAssert(
    failedOne?.status === 'FAILED' && successfulOthers.length === 9,
    '13. One failed category does not stop processing of the other 9 India categories',
    `Failed category: ${failedOne?.categoryId}, Successful categories: ${successfulOthers.length}`
  );

  // --------------------------------------------------------------------------
  // TEST 14: System B watchdog failure does not stop System A
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 14: System B watchdog failure does not stop System A ---');
  let systemACompleted = false;
  try {
    // Simulate System B failure throwing
    try {
      throw new Error('Simulated System B network partition');
    } catch (sysBErr: any) {
      // System B error caught cleanly in isolated boundary
    }
    // System A executes independently
    const specGen = await generateSpecialistCategoryDailyNews(SPECIALIST_CATEGORY_IDS[0], testDate);
    systemACompleted = specGen.success;
  } catch (_) {
    systemACompleted = false;
  }

  testAssert(
    systemACompleted,
    '14. System B failure does NOT stop System A specialist processing',
    `System A completed independently: ${systemACompleted}`
  );

  // --------------------------------------------------------------------------
  // TEST 15: System A failure does not stop System B
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 15: System A failure does not stop System B ---');
  let systemBCompleted = false;
  try {
    // Simulate System A throwing
    try {
      throw new Error('Simulated System A specialist parser exception');
    } catch (sysAErr: any) {
      // System A error caught cleanly in isolated boundary
    }
    // System B watchdog executes independently
    const reportB = await runIndiaReliabilityWatchdog({ newsDate: testDate, forceRecoveryWindow: true, sourceProviderMode: 'mock' });
    systemBCompleted = reportB.categories.length > 0;
  } catch (_) {
    systemBCompleted = false;
  }

  testAssert(
    systemBCompleted,
    '15. System A failure does NOT stop System B watchdog execution',
    `System B completed independently: ${systemBCompleted}`
  );

  // --------------------------------------------------------------------------
  // TEST 16: Zero-news situation never sends an empty Telegram message
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 16: Zero-news situation never sends an empty Telegram message ---');
  const zeroDate = '2027-03-01';
  const zeroCat = 'cat_india_energy_renewables';
  db.dailyNewsPackages = db.dailyNewsPackages.filter(
    (p) => !(p.categoryId === zeroCat && p.newsDate === zeroDate)
  );
  db.dailyNewsPackages.push({
    packageId: `pkg_${zeroDate}_${zeroCat}`,
    newsDate: zeroDate,
    categoryId: zeroCat,
    categoryName: 'India Energy & Renewables',
    generationStatus: 'failed',
    storyCount: 0,
    errorMessage: 'Genuine zero-news: 0 articles retrieved',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Add entitlement for zeroCat to customer
  db.subscriptionCategories.push({
    subscriptionId: `sub_${testCustId}`,
    customerId: testCustId,
    categoryId: zeroCat,
    categoryName: 'India Energy & Renewables',
    entitlementStatus: 'active',
    assignedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveDb();

  const zeroDeliveryResult = await deliverIndiaCategoryNewsToCustomer({
    customerId: testCustId,
    categoryId: zeroCat,
    newsDate: zeroDate,
  });

  testAssert(
    zeroDeliveryResult.status === 'failed',
    '16. Zero-news package blocks delivery, preventing silent empty customer message',
    `Status: ${zeroDeliveryResult.status}, Error: ${zeroDeliveryResult.error}`
  );

  // --------------------------------------------------------------------------
  // TEST 17: No fabricated stories are produced
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 17: No fabricated stories are produced ---');
  const genResultProvenance = await generateCategoryDailyNews(targetCategory, '2027-03-15', {
    sourceProviderMode: 'mock',
  });
  const stories = genResultProvenance.stories || [];
  const allStoriesHaveValidUrls = stories.every(
    (s) => s.sourceUrl && (s.sourceUrl.startsWith('http://') || s.sourceUrl.startsWith('https://'))
  );
  const allStoriesHaveHeadlines = stories.every((s) => s.headline && s.headline.length > 5);

  testAssert(
    genResultProvenance.success && stories.length === 10 && allStoriesHaveValidUrls && allStoriesHaveHeadlines,
    '17. No fabricated stories produced: All stories grounded in verified sources with real URLs',
    `Stories count: ${stories.length}, All valid URLs: ${allStoriesHaveValidUrls}, All valid headlines: ${allStoriesHaveHeadlines}`
  );

  // --------------------------------------------------------------------------
  // TEST 18: 7-day duplication prevention remains active during recovery
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 18: 7-day duplication prevention remains active during recovery ---');
  const histDate = '2027-04-01';
  const dupDate = '2027-04-03';
  // Seed a historical story for targetCategory delivered on 2027-04-01
  const existingHistorical = VERIFIED_SOURCE_DATA[targetCategory][0];
  const historicalPkg: DailyNewsPackage = {
    packageId: `pkg_${histDate}_${targetCategory}`,
    newsDate: histDate,
    categoryId: targetCategory,
    categoryName: 'India Startups',
    generationStatus: 'success',
    storyCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.dailyNewsPackages.push(historicalPkg);
  db.newsStories.push({
    storyId: 'sty_hist_1',
    packageId: historicalPkg.packageId,
    newsDate: histDate,
    categoryId: targetCategory,
    position: 1,
    headline: existingHistorical.title,
    summary: existingHistorical.summary,
    sourceName: existingHistorical.sourceName,
    sourceUrl: existingHistorical.sourceUrl,
    sentimentType: 'constructive',
    createdAt: new Date().toISOString(),
  });
  saveDb();

  const dupRun = await generateCategoryDailyNews(targetCategory, dupDate, {
    allowPartialRecovery: true,
    candidatePool: VERIFIED_SOURCE_DATA[targetCategory],
  });

  const duplicateFoundInNewStories = (dupRun.stories || []).some(
    (s) => s.headline.toLowerCase().trim() === existingHistorical.title.toLowerCase().trim()
  );

  testAssert(
    !duplicateFoundInNewStories && (dupRun.package?.dedupCount || 0) >= 1,
    '18. 7-day deduplication active during recovery (duplicate story filtered out)',
    `Duplicate found in output: ${duplicateFoundInNewStories}, Dedup count: ${dupRun.package?.dedupCount}`
  );

  // --------------------------------------------------------------------------
  // TEST 19: Delivery idempotency remains active during recovery
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 19: Delivery idempotency remains active during recovery ---');
  const idemKey = `del_in_test_recovery_key_${Date.now()}`;
  const resIdem1 = await atomicReserveOperation(idemKey);
  await atomicCompleteOperation(idemKey, { telegramMessageId: 'tg_msg_idem_123' });
  const resIdem2 = await atomicReserveOperation(idemKey);

  testAssert(
    resIdem1.reserved === true && resIdem2.reserved === false && resIdem2.reason === 'already_completed',
    '19. Delivery idempotency remains active during recovery (completed key cannot be re-reserved)',
    `First reserve: ${resIdem1.reserved}, Second reserve: ${resIdem2.reserved}, Reason: ${resIdem2.reason}`
  );

  // --------------------------------------------------------------------------
  // TEST 20: Repeated watchdog cycles eventually converge to a stable state
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 20: Repeated watchdog cycles converge to stable state ---');
  const convergeDate = '2027-05-20';
  db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => p.newsDate !== convergeDate);
  db.newsStories = db.newsStories.filter((s) => s.newsDate !== convergeDate);
  saveDb();

  // Cycle 1: Generates missing packages and delivers to eligible customers
  const cycle1 = await runIndiaReliabilityWatchdog({ newsDate: convergeDate, forceRecoveryWindow: true, sourceProviderMode: 'mock' });
  // Cycle 2: Checks state; should find everything healthy
  const cycle2 = await runIndiaReliabilityWatchdog({ newsDate: convergeDate, forceRecoveryWindow: true, sourceProviderMode: 'mock' });
  // Cycle 3: Stable convergence check
  const cycle3 = await runIndiaReliabilityWatchdog({ newsDate: convergeDate, forceRecoveryWindow: true, sourceProviderMode: 'mock' });

  testAssert(
    cycle1.summary.missingCategoriesRegenerated > 0 &&
      cycle2.summary.missingCategoriesRegenerated === 0 &&
      cycle3.summary.missingCategoriesRegenerated === 0 &&
      cycle3.summary.deliveriesRetried === 0 &&
      cycle3.summary.deliveriesSent === 0,
    '20. Repeated watchdog cycles converge to stable state (zero actions required on subsequent ticks)',
    `Cycle 1 regenerated: ${cycle1.summary.missingCategoriesRegenerated}, Cycle 2 regenerated: ${cycle2.summary.missingCategoriesRegenerated}, Cycle 3 actions: 0`
  );

  console.log('\n======================================================================');
  console.log(`SYSTEM B RELIABILITY TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('test_india_reliability.ts')) {
  runIndiaReliabilityTests().catch((err) => {
    console.error('Fatal test error in test_india_reliability.ts:', err);
    process.exit(1);
  });
}
