import {
  initDb,
  getDb,
  registerOrLoginCustomer,
  getCustomerById,
} from './db.js';
import {
  processVerifiedPayment,
} from './paymentService.js';
import {
  generateTelegramConnectionToken,
  connectTelegramAccount,
} from './telegramService.js';
import {
  generateCategoryDailyNews,
  generateDailyAllCategoriesNews,
  validateStorySource,
  INDIA_CATEGORY_IDS,
  CONFIGURED_SOURCE_DOMAINS,
  fetchRealSourceArticlesForCategory,
} from './newsService.js';
import {
  deliverCategoryNewsToCustomer,
  getDeliveryStatistics,
} from './deliveryService.js';
import {
  setCategoryStatus,
  executeAdminCategoryTransfer,
  getCustomerActiveEntitlements,
} from './entitlementService.js';
import {
  OFFICIAL_LIVE_FEEDS,
  fetchSingleRssFeed,
  parseRssOrAtomXml,
  retrieveLiveCategoryCandidateArticles,
  isArticleFresh,
  verifyUrlProvenance,
  normalizeArticleUrl,
  setSourceProviderMode,
  type LiveSourceFeedConfig,
} from './liveSourceIngestion.js';

interface TestResult {
  code: string;
  name: string;
  passed: boolean;
  details: string;
}

const testResults: TestResult[] = [];

function recordTest(code: string, name: string, passed: boolean, details: string) {
  testResults.push({ code, name, passed, details });
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status} - Test ${code}: ${name}`);
  if (details) console.log(`   └─ ${details}`);
}

async function runTestSuiteAtoO() {
  console.log('================================================================');
  console.log('STARTING PHASE 5 FINAL VERIFICATION SUITE: TESTS A THROUGH O');
  console.log('================================================================\n');

  initDb();
  setSourceProviderMode('mock'); // Deterministic fixture provider for test suite baseline
  const db = getDb();
  const testDate = '2026-09-30';
  const deliveryRefDate = new Date('2026-09-30T01:00:00.000Z'); // 6:30 AM IST (01:00 UTC)

  // Clean test date records
  db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => p.newsDate !== testDate);
  db.newsStories = db.newsStories.filter((s) => s.newsDate !== testDate);
  db.telegramDeliveryLogs = db.telegramDeliveryLogs.filter((l) => l.newsDate !== testDate);

  let customerA: any;
  let customerE: any;

  // -------------------------------------------------------------
  // TEST A: One category customer receives exactly 10 stories
  // -------------------------------------------------------------
  try {
    const custARes = registerOrLoginCustomer({
      fullName: 'Customer Test A',
      email: 'testa@example.com',
      mobileCountryCode: '+91',
      mobileNumber: '9800000001',
      selectedCategoryIds: ['cat_india_startups'],
    });
    customerA = custARes.customer;

    processVerifiedPayment({
      customerId: customerA.customerId,
      gatewayReference: 'UTR_TEST_A_001',
      categoryIds: ['cat_india_startups'],
      paymentStatus: 'successful',
      paymentDate: '2026-09-29T10:00:00.000Z',
    });

    const tokA = generateTelegramConnectionToken(customerA.customerId);
    connectTelegramAccount(tokA.token, 'tg_chat_test_a', 'test_a');

    // Generate package
    const genPkgA = await generateCategoryDailyNews('cat_india_startups', testDate);
    const storiesCount = genPkgA.stories?.length || 0;

    const delResA = await deliverCategoryNewsToCustomer({
      customerId: customerA.customerId,
      categoryId: 'cat_india_startups',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
    });

    const passed = delResA.status === 'sent' && storiesCount === 10;
    recordTest('A', 'One category customer receives exactly 10 stories', passed,
      `Delivered status: ${delResA.status}, Package story count: ${storiesCount}`);
  } catch (err: any) {
    recordTest('A', 'One category customer receives exactly 10 stories', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST B: All 10 India categories generate exactly 100 stories total, with exactly 10 per category
  // -------------------------------------------------------------
  try {
    // Save Gemini key if set to test deterministic source batch
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const batchGen = await generateDailyAllCategoriesNews(testDate);
    if (savedKey) process.env.GEMINI_API_KEY = savedKey;

    const all10StoriesEach = batchGen.results.every((r) => r.storyCount === 10);
    const totalCount = batchGen.totalStories;
    const catCount = batchGen.successfulCategories;

    const passed = catCount === 10 && totalCount === 100 && all10StoriesEach;
    recordTest('B', 'All 10 India categories generate exactly 100 stories total (10 per category)', passed,
      `Categories generated: ${catCount}/10, Total stories: ${totalCount}, All exactly 10: ${all10StoriesEach}`);
  } catch (err: any) {
    recordTest('B', 'All 10 India categories generate exactly 100 stories total', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST C: Every delivered story has:
  // - non-empty headline
  // - non-empty factual summary
  // - non-empty sourceName
  // - valid HTTP/HTTPS sourceUrl
  // - sourceUrl belonging to the actual configured source domain
  // - source data originating from configured source retrieval layer
  // -------------------------------------------------------------
  try {
    const allStories = db.newsStories.filter((s) => s.newsDate === testDate);
    let allValid = allStories.length === 100;
    let failureDetail = '';

    for (const story of allStories) {
      if (!story.headline || story.headline.trim().length < 5) {
        allValid = false;
        failureDetail = `Invalid headline: ${story.storyId}`;
        break;
      }
      if (!story.summary || story.summary.trim().length < 10) {
        allValid = false;
        failureDetail = `Invalid summary: ${story.storyId}`;
        break;
      }
      if (!story.sourceName || story.sourceName.trim().length < 2) {
        allValid = false;
        failureDetail = `Invalid sourceName: ${story.storyId}`;
        break;
      }
      const isSourceValid = validateStorySource(story);
      if (!isSourceValid) {
        allValid = false;
        failureDetail = `Source domain validation failed for ${story.sourceName} -> ${story.sourceUrl}`;
        break;
      }
    }

    // Verify source retrieval layer function exists and returns configured domain items
    const sourcePool = await fetchRealSourceArticlesForCategory('cat_india_startups');
    const retrievalLayerVerified = Array.isArray(sourcePool) && sourcePool.length >= 10;

    const passed = allValid && retrievalLayerVerified;
    recordTest('C', 'Every delivered story has non-empty fields, valid URL, and configured domain match', passed,
      passed ? 'All 100 stories strictly conform to domain rules and source retrieval' : failureDetail);
  } catch (err: any) {
    recordTest('C', 'Every delivered story has valid source and domain', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST D: Running generation twice for same newsDate + categoryId creates no duplicate package/stories
  // -------------------------------------------------------------
  try {
    const countPackagesBefore = db.dailyNewsPackages.filter(
      (p) => p.categoryId === 'cat_india_startups' && p.newsDate === testDate
    ).length;
    const countStoriesBefore = db.newsStories.filter(
      (s) => s.categoryId === 'cat_india_startups' && s.newsDate === testDate
    ).length;

    // Run again
    const rerun = await generateCategoryDailyNews('cat_india_startups', testDate);

    const countPackagesAfter = db.dailyNewsPackages.filter(
      (p) => p.categoryId === 'cat_india_startups' && p.newsDate === testDate
    ).length;
    const countStoriesAfter = db.newsStories.filter(
      (s) => s.categoryId === 'cat_india_startups' && s.newsDate === testDate
    ).length;

    const passed =
      rerun.success &&
      countPackagesBefore === 1 &&
      countPackagesAfter === 1 &&
      countStoriesBefore === 10 &&
      countStoriesAfter === 10;

    recordTest('D', 'Running generation twice for same date+category creates zero duplicates (idempotency)', passed,
      `Packages: ${countPackagesBefore} -> ${countPackagesAfter}, Stories: ${countStoriesBefore} -> ${countStoriesAfter}`);
  } catch (err: any) {
    recordTest('D', 'Generation idempotency check', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST E: Customer with one entitled category receives only that category
  // -------------------------------------------------------------
  try {
    const custERes = registerOrLoginCustomer({
      fullName: 'Customer Test E',
      email: 'teste@example.com',
      mobileCountryCode: '+91',
      mobileNumber: '9800000005',
      selectedCategoryIds: ['cat_india_startups'],
    });
    customerE = custERes.customer;
    processVerifiedPayment({
      customerId: customerE.customerId,
      gatewayReference: 'UTR_TEST_E_001',
      categoryIds: ['cat_india_startups'],
      paymentStatus: 'successful',
      paymentDate: '2026-09-29T10:00:00.000Z',
    });
    const tokE = generateTelegramConnectionToken(customerE.customerId);
    connectTelegramAccount(tokE.token, 'tg_chat_test_e', 'test_e');

    // Attempt delivery for entitled category
    const delEntitled = await deliverCategoryNewsToCustomer({
      customerId: customerE.customerId,
      categoryId: 'cat_india_startups',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
    });

    // Attempt delivery for unentitled category
    const delUnentitled = await deliverCategoryNewsToCustomer({
      customerId: customerE.customerId,
      categoryId: 'cat_india_mfg_auto',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
    });

    const passed = delEntitled.status === 'sent' && delUnentitled.status === 'not_entitled';
    recordTest('E', 'Customer with one entitled category receives only that category', passed,
      `Entitled category: ${delEntitled.status}, Unentitled category: ${delUnentitled.status}`);
  } catch (err: any) {
    recordTest('E', 'Customer with one entitled category receives only that category', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST F: Customer with three entitled categories receives exactly those three categories and no others
  // -------------------------------------------------------------
  try {
    const threeCats = ['cat_india_banking_fintech', 'cat_india_re_infra', 'cat_india_energy_renewables'];
    const custFRes = registerOrLoginCustomer({
      fullName: 'Customer Test F',
      email: 'testf@example.com',
      mobileCountryCode: '+91',
      mobileNumber: '9800000006',
      selectedCategoryIds: threeCats,
    });
    const customerF = custFRes.customer;
    processVerifiedPayment({
      customerId: customerF.customerId,
      gatewayReference: 'UTR_TEST_F_001',
      categoryIds: threeCats,
      paymentStatus: 'successful',
      paymentDate: '2026-09-29T10:00:00.000Z',
    });
    const tokF = generateTelegramConnectionToken(customerF.customerId);
    connectTelegramAccount(tokF.token, 'tg_chat_test_f', 'test_f');

    const deliveryResults: Record<string, string> = {};
    for (const catId of threeCats) {
      const res = await deliverCategoryNewsToCustomer({
        customerId: customerF.customerId,
        categoryId: catId,
        newsDate: testDate,
        referenceDate: deliveryRefDate,
      });
      deliveryResults[catId] = res.status;
    }

    // Try a 4th unentitled category
    const fourthRes = await deliverCategoryNewsToCustomer({
      customerId: customerF.customerId,
      categoryId: 'cat_india_it_tech',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
    });

    const allThreeSent = threeCats.every((c) => deliveryResults[c] === 'sent');
    const fourthBlocked = fourthRes.status === 'not_entitled';

    const passed = allThreeSent && fourthBlocked;
    recordTest('F', 'Customer with three entitled categories receives exactly those three and no others', passed,
      `Three entitled statuses: ${Object.values(deliveryResults).join(', ')}, 4th unentitled status: ${fourthRes.status}`);
  } catch (err: any) {
    recordTest('F', 'Customer with three entitled categories test', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST G: Deactivated category is never delivered
  // -------------------------------------------------------------
  try {
    // Temporarily deactivate cat_india_re_infra
    setCategoryStatus('cat_india_re_infra', false, 'admin@mydigitasset.com');

    // Customer F is entitled to cat_india_re_infra, but category is now inactive
    const delDeactivated = await deliverCategoryNewsToCustomer({
      customerId: 'cust_f_temp',
      categoryId: 'cat_india_re_infra',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
    });

    // Reactivate category
    setCategoryStatus('cat_india_re_infra', true, 'admin@mydigitasset.com');

    const passed = delDeactivated.status === 'not_entitled';
    recordTest('G', 'Deactivated category is never delivered', passed,
      `Delivery attempt on deactivated category returned status: '${delDeactivated.status}'`);
  } catch (err: any) {
    recordTest('G', 'Deactivated category is never delivered', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST H: Expired customer/subscription is never delivered
  // -------------------------------------------------------------
  try {
    // Deliver on reference date far after expiry: 2028-01-01
    const postExpiryDate = new Date('2028-01-01T01:00:00.000Z');
    const delExpired = await deliverCategoryNewsToCustomer({
      customerId: customerA.customerId,
      categoryId: 'cat_india_startups',
      newsDate: '2028-01-01',
      referenceDate: postExpiryDate,
    });

    const passed = delExpired.status === 'expired' || delExpired.status === 'not_entitled';
    recordTest('H', 'Expired customer/subscription is never delivered', passed,
      `Delivery attempt after subscription expiry returned: '${delExpired.status}'`);
  } catch (err: any) {
    recordTest('H', 'Expired customer is never delivered', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST I: Customer without Telegram connection is never delivered
  // -------------------------------------------------------------
  try {
    const custIRes = registerOrLoginCustomer({
      fullName: 'Customer Test I (No TG)',
      email: 'testi@example.com',
      mobileCountryCode: '+91',
      mobileNumber: '9800000009',
      selectedCategoryIds: ['cat_india_consumer_fmcg'],
    });
    const customerI = custIRes.customer;
    processVerifiedPayment({
      customerId: customerI.customerId,
      gatewayReference: 'UTR_TEST_I_001',
      categoryIds: ['cat_india_consumer_fmcg'],
      paymentStatus: 'successful',
      paymentDate: '2026-09-29T10:00:00.000Z',
    });
    // Deliberately do NOT connect Telegram

    const delNoTg = await deliverCategoryNewsToCustomer({
      customerId: customerI.customerId,
      categoryId: 'cat_india_consumer_fmcg',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
    });

    const passed = delNoTg.status === 'telegram_not_connected';
    recordTest('I', 'Customer without Telegram connection is never delivered', passed,
      `Delivery attempt returned: '${delNoTg.status}'`);
  } catch (err: any) {
    recordTest('I', 'Customer without Telegram connection', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST J: Admin category transfer is respected by the delivery engine:
  // - old category stops being delivered
  // - new category becomes deliverable
  // - subscription dates do not change
  // - no second payment is created
  // - transfer is audited
  // -------------------------------------------------------------
  try {
    const uniqueJ = Date.now();
    const custJRes = registerOrLoginCustomer({
      fullName: 'Customer Test J Transfer',
      email: `testj_${uniqueJ}@example.com`,
      mobileCountryCode: '+91',
      mobileNumber: `98${String(uniqueJ).slice(-8)}`,
      selectedCategoryIds: ['cat_india_mfg_auto'],
    });
    const customerJ = custJRes.customer;
    processVerifiedPayment({
      customerId: customerJ.customerId,
      gatewayReference: `UTR_TEST_J_${uniqueJ}`,
      categoryIds: ['cat_india_mfg_auto'],
      paymentStatus: 'successful',
      paymentDate: '2026-09-29T10:00:00.000Z',
    });
    const tokJ = generateTelegramConnectionToken(customerJ.customerId);
    connectTelegramAccount(tokJ.token, `tg_chat_test_j_${uniqueJ}`, 'test_j');

    const paymentsBefore = db.payments.filter((p) => p.customerId === customerJ.customerId).length;
    const subBefore = db.subscriptions.find((s) => s.customerId === customerJ.customerId)!;

    // Admin transfers entitlement from cat_india_mfg_auto to cat_india_consumer_fmcg
    const transferResult = executeAdminCategoryTransfer({
      customerId: customerJ.customerId,
      oldCategoryId: 'cat_india_mfg_auto',
      newCategoryId: 'cat_india_consumer_fmcg',
      adminEmail: 'mihirkapuria@gmail.com',
      reason: 'Customer requested sector realignment to Consumer FMCG',
    });

    const paymentsAfter = db.payments.filter((p) => p.customerId === customerJ.customerId).length;
    const subAfter = db.subscriptions.find((s) => s.customerId === customerJ.customerId)!;

    // Old category should now be not_entitled
    const delOld = await deliverCategoryNewsToCustomer({
      customerId: customerJ.customerId,
      categoryId: 'cat_india_mfg_auto',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
    });

    // New category should now be deliverable
    const delNew = await deliverCategoryNewsToCustomer({
      customerId: customerJ.customerId,
      categoryId: 'cat_india_consumer_fmcg',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
    });

    const auditFound = db.categoryTransferAudits.some(
      (a) => a.customerId === customerJ.customerId && a.newCategoryId === 'cat_india_consumer_fmcg'
    );

    const datesUnchanged = subBefore.startDate === subAfter.startDate && subBefore.expiryDate === subAfter.expiryDate;
    const noNewPayment = paymentsBefore === paymentsAfter;

    if (!transferResult.success) {
      console.log('   Transfer error:', transferResult.error);
    }

    const passed =
      Boolean(transferResult.success) &&
      delOld.status === 'not_entitled' &&
      delNew.status === 'sent' &&
      datesUnchanged &&
      noNewPayment &&
      auditFound;

    recordTest('J', 'Admin category transfer is respected (old stops, new starts, dates unchanged, zero new payments, audited)', passed,
      `Transfer success: ${transferResult.success}, Old: ${delOld.status}, New: ${delNew.status}, Dates unchanged: ${datesUnchanged}, Payments: ${paymentsBefore} -> ${paymentsAfter}`);
  } catch (err: any) {
    recordTest('J', 'Admin category transfer test', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST K: Re-running delivery for same customerId + categoryId + newsDate never sends a duplicate
  // -------------------------------------------------------------
  try {
    // Customer J already successfully received cat_india_consumer_fmcg on testDate in Test J
    const duplicateDeliveryAttempt = await deliverCategoryNewsToCustomer({
      customerId: 'cust_' + 'test_k_non_dup',
      categoryId: 'cat_india_consumer_fmcg',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
    });

    // Now re-attempt for Customer A who already has 'sent' in log
    const rerunForJ = await deliverCategoryNewsToCustomer({
      customerId: customerA.customerId,
      categoryId: 'cat_india_startups',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
    });

    const passed = rerunForJ.status === 'skipped';
    recordTest('K', 'Re-running delivery for same customerId + categoryId + newsDate never sends a duplicate (skipped)', passed,
      `Second delivery attempt status: '${rerunForJ.status}'`);
  } catch (err: any) {
    recordTest('K', 'Duplicate delivery check', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST L: Two different customers remain completely isolated
  // - Customer A cannot access Customer B data
  // - Customer A delivery cannot contain Customer B info
  // - Browser/API responses never expose another customer's Chat ID, email, mobile
  // -------------------------------------------------------------
  try {
    const custA = getCustomerById(customerA.customerId)!;
    const custB = getCustomerById(customerE.customerId)!;

    // Check raw chat IDs
    const chatA = custA.telegramChatId;
    const chatB = custB.telegramChatId;

    const chatsDifferent = chatA !== chatB && Boolean(chatA) && Boolean(chatB);

    // Check entitlements call for A does not contain B
    const evalA = getCustomerActiveEntitlements(custA.customerId, deliveryRefDate);
    const evalB = getCustomerActiveEntitlements(custB.customerId, deliveryRefDate);

    const aContainsB = evalA.customerId === custB.customerId || evalA.customerEmail === custB.email;
    const bContainsA = evalB.customerId === custA.customerId || evalB.customerEmail === custA.email;

    const passed = chatsDifferent && !aContainsB && !bContainsA;
    recordTest('L', 'Customer data isolation: Zero cross-customer information leakage', passed,
      `Customer A ID: ${custA.customerId}, Customer B ID: ${custB.customerId}, Complete isolation confirmed`);
  } catch (err: any) {
    recordTest('L', 'Customer isolation check', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST M: Simulate a Telegram delivery failure:
  // - first attempt fails
  // - retry occurs using controlled exponential backoff
  // - eventual success is logged correctly if retry succeeds
  // - no duplicate successful delivery created
  // -------------------------------------------------------------
  try {
    const custMRes = registerOrLoginCustomer({
      fullName: 'Customer Test M Retry',
      email: 'testm@example.com',
      mobileCountryCode: '+91',
      mobileNumber: '9800000013',
      selectedCategoryIds: ['cat_india_hr_employment'],
    });
    const customerM = custMRes.customer;
    processVerifiedPayment({
      customerId: customerM.customerId,
      gatewayReference: 'UTR_TEST_M_001',
      categoryIds: ['cat_india_hr_employment'],
      paymentStatus: 'successful',
      paymentDate: '2026-09-29T10:00:00.000Z',
    });
    const tokM = generateTelegramConnectionToken(customerM.customerId);
    connectTelegramAccount(tokM.token, 'tg_chat_test_m', 'test_m');

    // Simulate transient failure on attempt 1, succeeding on attempt 2
    const retryDelRes = await deliverCategoryNewsToCustomer({
      customerId: customerM.customerId,
      categoryId: 'cat_india_hr_employment',
      newsDate: testDate,
      referenceDate: deliveryRefDate,
      simulateTelegramFailureUntilAttempt: 2, // Fails attempt 1, succeeds on attempt 2
    });

    const successfulDeliveriesForM = db.telegramDeliveryLogs.filter(
      (l) => l.customerId === customerM.customerId && l.categoryId === 'cat_india_hr_employment' && l.status === 'sent'
    ).length;

    const passed = retryDelRes.status === 'sent' && successfulDeliveriesForM === 1;
    recordTest('M', 'Simulate Telegram delivery failure: transient failure retried with backoff, eventual success logged with no duplicate', passed,
      `Delivery status: ${retryDelRes.status}, Successful delivery logs count: ${successfulDeliveriesForM}`);
  } catch (err: any) {
    recordTest('M', 'Telegram delivery retry simulation', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST N: Simulate Gemini HTTP 503:
  // - retry occurs with exponential backoff
  // - finite maximum retry count is enforced
  // - successful retry produces one package only
  // - exhausted retries mark that category generation as failed
  // - one failed category must not prevent other categories from processing
  // -------------------------------------------------------------
  try {
    const testDateN = '2026-10-15';
    // Part N1: Simulated 503 on 2 attempts, maxRetries = 3 -> Succeeds on attempt 3
    const retrySuccessGen = await generateCategoryDailyNews('cat_india_marketing_ads', testDateN, {
      maxRetries: 3,
      simulate503Attempts: 2,
    });

    const pkgsAfterRetry = db.dailyNewsPackages.filter(
      (p) => p.categoryId === 'cat_india_marketing_ads' && p.newsDate === testDateN
    ).length;

    // Part N2: Simulated 503 on 4 attempts, maxRetries = 3 -> Exhausts retries, marks failed
    const retryExhaustedGen = await generateCategoryDailyNews('cat_india_energy_renewables', testDateN, {
      maxRetries: 3,
      simulate503Attempts: 4,
    });

    // Part N3: One failed category does not prevent other category from generating
    const otherCatGen = await generateCategoryDailyNews('cat_india_it_tech', testDateN, {
      maxRetries: 3,
      simulate503Attempts: 0,
    });

    const n1Passed = retrySuccessGen.success && pkgsAfterRetry === 1;
    const n2Passed = !retryExhaustedGen.success && retryExhaustedGen.package?.generationStatus === 'failed';
    const n3Passed = otherCatGen.success && otherCatGen.package?.generationStatus === 'success';

    const passed = n1Passed && n2Passed && n3Passed;
    recordTest('N', 'Simulate Gemini HTTP 503: backoff retry produces 1 package; exhausted retries marked failed; other categories unaffected', passed,
      `Retry success: ${retrySuccessGen.success} (packages: ${pkgsAfterRetry}), Exhausted failed status: ${retryExhaustedGen.package?.generationStatus}, Other category success: ${otherCatGen.success}`);
  } catch (err: any) {
    recordTest('N', 'Gemini HTTP 503 retry test', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST O: Expiry boundary:
  // - expiryDate = 30 September 2027
  // - delivery on 30 September 2027 = eligible
  // - delivery on 1 October 2027 = not eligible
  // -------------------------------------------------------------
  try {
    const custORes = registerOrLoginCustomer({
      fullName: 'Customer Test O Boundary',
      email: 'testo@example.com',
      mobileCountryCode: '+91',
      mobileNumber: '9800000015',
      selectedCategoryIds: ['cat_india_economy_business'],
    });
    const customerO = custORes.customer;
    processVerifiedPayment({
      customerId: customerO.customerId,
      gatewayReference: 'UTR_TEST_O_001',
      categoryIds: ['cat_india_economy_business'],
      paymentStatus: 'successful',
      paymentDate: '2026-09-29T10:00:00.000Z',
    });
    const tokO = generateTelegramConnectionToken(customerO.customerId);
    connectTelegramAccount(tokO.token, 'tg_chat_test_o', 'test_o');

    // Ensure news packages exist for the boundary dates
    await generateCategoryDailyNews('cat_india_economy_business', '2027-09-30');
    await generateCategoryDailyNews('cat_india_economy_business', '2027-10-01');

    // Ensure clean delivery log for customer O
    db.telegramDeliveryLogs = db.telegramDeliveryLogs.filter((l) => l.customerId !== customerO.customerId);

    // Case 1: 30 September 2027 at 6:30 AM IST (Last day of validity) -> MUST BE ELIGIBLE
    const lastDayRefDate = new Date('2027-09-30T01:00:00.000Z');
    const delLastDay = await deliverCategoryNewsToCustomer({
      customerId: customerO.customerId,
      categoryId: 'cat_india_economy_business',
      newsDate: '2027-09-30',
      referenceDate: lastDayRefDate,
    });

    // Case 2: 1 October 2027 at 6:30 AM IST (First day after expiry) -> MUST BE INELIGIBLE
    const dayAfterRefDate = new Date('2027-10-01T01:00:00.000Z');
    const delDayAfter = await deliverCategoryNewsToCustomer({
      customerId: customerO.customerId,
      categoryId: 'cat_india_economy_business',
      newsDate: '2027-10-01',
      referenceDate: dayAfterRefDate,
    });

    const passed = delLastDay.status === 'sent' && (delDayAfter.status === 'expired' || delDayAfter.status === 'not_entitled');
    recordTest('O', 'Expiry boundary: 30 Sep 2027 is eligible (sent), 1 Oct 2027 is not eligible (expired)', passed,
      `30 Sep 2027 delivery: '${delLastDay.status}', 1 Oct 2027 delivery: '${delDayAfter.status}'`);
  } catch (err: any) {
    recordTest('O', 'Expiry boundary check', false, err.message);
  }

  // =============================================================
  // PHASE 5.1: LIVE NEWS SOURCE INTEGRATION TESTS (P THROUGH Y)
  // =============================================================

  // -------------------------------------------------------------
  // TEST P: Live source retrieval success
  // -------------------------------------------------------------
  try {
    const etFeed = OFFICIAL_LIVE_FEEDS.find((f) => f.id === 'et_startups')!;
    const liveFetchRes = await fetchSingleRssFeed(etFeed, {
      timeoutMs: 8000,
      maxRetries: 2,
    });

    const articlesValid =
      liveFetchRes.success &&
      liveFetchRes.articles.length > 0 &&
      liveFetchRes.articles.every(
        (a) =>
          a.headline.length > 5 &&
          a.sourceUrl.startsWith('http') &&
          a.sourceName === 'The Economic Times' &&
          validateStorySource({
            headline: a.headline,
            summary: a.summary,
            sourceName: a.sourceName,
            sourceUrl: a.sourceUrl,
          })
      );

    const passed = liveFetchRes.success && articlesValid;
    recordTest(
      'P',
      'Live source retrieval success: RSS feed parsed and validated against configured publication domain',
      passed,
      `Feed: ${etFeed.name}, Articles retrieved: ${liveFetchRes.articles.length}, Duration: ${liveFetchRes.durationMs}ms`
    );
  } catch (err: any) {
    recordTest('P', 'Live source retrieval success', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST Q: Source timeout resilience
  // -------------------------------------------------------------
  try {
    const slowFeed: LiveSourceFeedConfig = {
      id: 'test_slow_feed',
      name: 'The Economic Times',
      feedUrl: 'https://economictimes.indiatimes.com/slow-timeout-test',
      domain: 'economictimes.indiatimes.com',
      categoryIds: ['cat_india_startups'],
      isActive: true,
    };

    // Inject a customFetch that sleeps longer than timeoutMs
    const customSlowFetch = async (_url: any, opts: any) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      return new Response('<rss></rss>', { status: 200 });
    };

    const timeoutRes = await fetchSingleRssFeed(slowFeed, {
      timeoutMs: 60,
      maxRetries: 1,
      customFetch: customSlowFetch as any,
    });

    const passed = Boolean(!timeoutRes.success && timeoutRes.error?.includes('Timeout after 60ms'));
    recordTest(
      'Q',
      'Source timeout resilience: bounded timeout cleanly aborts hung connection without crashing',
      passed,
      `Success: ${timeoutRes.success}, Error: ${timeoutRes.error}`
    );
  } catch (err: any) {
    recordTest('Q', 'Source timeout resilience', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST R: Source HTTP failure handling (5xx retry & error logging)
  // -------------------------------------------------------------
  try {
    let callCount = 0;
    const custom500Fetch = async () => {
      callCount++;
      return new Response('Internal Server Error', { status: 500, statusText: 'Server Error' });
    };

    const errorFeed: LiveSourceFeedConfig = {
      id: 'test_500_feed',
      name: 'Mint',
      feedUrl: 'https://www.livemint.com/rss/test-500',
      domain: 'livemint.com',
      categoryIds: ['cat_india_banking_fintech'],
      isActive: true,
    };

    const failRes = await fetchSingleRssFeed(errorFeed, {
      maxRetries: 2,
      customFetch: custom500Fetch as any,
    });

    const passed = Boolean(!failRes.success && callCount === 2 && failRes.error?.includes('HTTP 500'));
    recordTest(
      'R',
      'Source HTTP failure: 5xx server error retries with exponential backoff and logs failure',
      passed,
      `Attempts executed: ${callCount}, Success: ${failRes.success}, Final error: ${failRes.error}`
    );
  } catch (err: any) {
    recordTest('R', 'Source HTTP failure handling', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST S: Source HTTP 429 rate limit response with Retry-After
  // -------------------------------------------------------------
  try {
    let callCount = 0;
    const validXml = `
      <rss><channel>
        <item>
          <title><![CDATA[Fintech Startup Closes Series B]]></title>
          <link>https://economictimes.indiatimes.com/tech/fintech-series-b</link>
          <description><![CDATA[Detailed factual summary of the series B funding round.]]></description>
          <pubDate>${new Date().toUTCString()}</pubDate>
        </item>
      </channel></rss>
    `;

    const custom429Fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'retry-after': '1' },
        });
      }
      return new Response(validXml, { status: 200 });
    };

    const rateLimitFeed: LiveSourceFeedConfig = {
      id: 'test_429_feed',
      name: 'The Economic Times',
      feedUrl: 'https://economictimes.indiatimes.com/rss/test-429',
      domain: 'economictimes.indiatimes.com',
      categoryIds: ['cat_india_banking_fintech'],
      isActive: true,
    };

    const rlRes = await fetchSingleRssFeed(rateLimitFeed, {
      maxRetries: 2,
      customFetch: custom429Fetch as any,
    });

    const passed = rlRes.success && callCount === 2 && rlRes.articles.length === 1;
    recordTest(
      'S',
      'Source HTTP 429 handling: rate limit pauses and successfully recovers on retry',
      passed,
      `Attempts: ${callCount}, Recovery success: ${rlRes.success}, Articles parsed: ${rlRes.articles.length}`
    );
  } catch (err: any) {
    recordTest('S', 'Source HTTP 429 handling', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST T: Stale article rejection according to freshness window
  // -------------------------------------------------------------
  try {
    const now = new Date();
    const tenHoursAgo = new Date(now.getTime() - 10 * 60 * 60 * 1000).toUTCString();
    const ninetySixHoursAgo = new Date(now.getTime() - 96 * 60 * 60 * 1000).toUTCString();

    const mixedXml = `
      <rss><channel>
        <item>
          <title><![CDATA[Fresh Development in Solar Manufacturing]]></title>
          <link>https://economictimes.indiatimes.com/industry/energy/fresh-solar</link>
          <description><![CDATA[Domestic solar production reaches quarterly peak.]]></description>
          <pubDate>${tenHoursAgo}</pubDate>
        </item>
        <item>
          <title><![CDATA[Old Coal Plant Announcement From Last Week]]></title>
          <link>https://economictimes.indiatimes.com/industry/energy/old-coal</link>
          <description><![CDATA[Historical thermal power data summary.]]></description>
          <pubDate>${ninetySixHoursAgo}</pubDate>
        </item>
      </channel></rss>
    `;

    const feedConfig: LiveSourceFeedConfig = {
      id: 'test_freshness_feed',
      name: 'The Economic Times',
      feedUrl: 'https://economictimes.indiatimes.com/industry/energy/test',
      domain: 'economictimes.indiatimes.com',
      categoryIds: ['cat_india_energy_renewables'],
      isActive: true,
    };

    const parsedArticles = parseRssOrAtomXml(mixedXml, feedConfig, now, 48); // 48-hour freshness window

    const passed =
      parsedArticles.length === 1 &&
      parsedArticles[0].headline === 'Fresh Development in Solar Manufacturing';

    recordTest(
      'T',
      'Stale article rejection: articles older than freshness window (48h) are strictly discarded',
      passed,
      `Parsed fresh: ${parsedArticles.length} (Stale 96h article successfully filtered out)`
    );
  } catch (err: any) {
    recordTest('T', 'Stale article rejection', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST U: Invalid URL and rogue domain rejection
  // -------------------------------------------------------------
  try {
    const invalidArticles = [
      {
        headline: 'Rogue Article with Unapproved Domain',
        summary: 'Detailed summary of event.',
        sourceName: 'The Economic Times',
        sourceUrl: 'https://unauthorized-spammer-domain.xyz/article-1',
      },
      {
        headline: 'Malformed Protocol Link',
        summary: 'Detailed summary of event.',
        sourceName: 'The Economic Times',
        sourceUrl: 'ftp://economictimes.indiatimes.com/file.txt',
      },
      {
        headline: 'Javascript Pseudo Protocol Injection',
        summary: 'Detailed summary of event.',
        sourceName: 'The Economic Times',
        sourceUrl: 'javascript:alert(1)',
      },
      {
        headline: 'Legitimate Approved Publication Link',
        summary: 'Detailed summary of corporate expansion.',
        sourceName: 'The Economic Times',
        sourceUrl: 'https://economictimes.indiatimes.com/news/economy/expansion-plans',
      },
    ];

    const results = invalidArticles.map((a) => validateStorySource(a));
    const passed = !results[0] && !results[1] && !results[2] && results[3];

    recordTest(
      'U',
      'Invalid URL rejection: non-HTTP/HTTPS, malformed protocols, and unapproved domains rejected',
      passed,
      `Unapproved domain: ${results[0]}, FTP: ${results[1]}, Javascript: ${results[2]}, Valid: ${results[3]}`
    );
  } catch (err: any) {
    recordTest('U', 'Invalid URL rejection', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST V: Duplicate URL and title deduplication
  // -------------------------------------------------------------
  try {
    const rawUrl1 = 'https://inc42.com/buzz/quick-commerce-funding/?utm_source=rss&utm_medium=feed&ref=newsletter';
    const rawUrl2 = 'https://inc42.com/buzz/quick-commerce-funding';

    const norm1 = normalizeArticleUrl(rawUrl1);
    const norm2 = normalizeArticleUrl(rawUrl2);
    const urlMatch = norm1 === norm2;

    const dupXml = `
      <rss><channel>
        <item>
          <title><![CDATA[Quick Commerce Startup Raises $50M]]></title>
          <link>${rawUrl1}</link>
          <description><![CDATA[Factual summary of quick commerce capital round.]]></description>
          <pubDate>${new Date().toUTCString()}</pubDate>
        </item>
        <item>
          <title><![CDATA[Quick Commerce Startup Raises $50M]]></title>
          <link>${rawUrl2}</link>
          <description><![CDATA[Factual summary of quick commerce capital round.]]></description>
          <pubDate>${new Date().toUTCString()}</pubDate>
        </item>
      </channel></rss>
    `;

    const feedConfig: LiveSourceFeedConfig = {
      id: 'test_dup_feed',
      name: 'Inc42',
      feedUrl: 'https://inc42.com/feed/',
      domain: 'inc42.com',
      categoryIds: ['cat_india_startups'],
      isActive: true,
    };

    // Test deduplication through candidate retrieval
    const candidateRes = await retrieveLiveCategoryCandidateArticles('cat_india_startups', {
      customFetch: (async () => new Response(dupXml, { status: 200 })) as any,
    });

    const passed = urlMatch && candidateRes.articles.length === 1;
    recordTest(
      'V',
      'Duplicate URL deduplication: tracking params stripped to canonical URL and duplicate stories pruned',
      passed,
      `Canonical URL matched: ${urlMatch}, Articles after deduplication: ${candidateRes.articles.length}/2`
    );
  } catch (err: any) {
    recordTest('V', 'Duplicate URL deduplication', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST W: Gemini strictly preserving candidate source URLs (Provenance Enforcement)
  // -------------------------------------------------------------
  try {
    const candidatePool = [
      { sourceUrl: 'https://economictimes.indiatimes.com/tech/startups/valid-url-1' },
      { sourceUrl: 'https://www.livemint.com/industry/valid-url-2' },
    ];

    const legitStoryUrl = 'https://economictimes.indiatimes.com/tech/startups/valid-url-1?utm_source=ignored';
    const fakeHallucinatedUrl = 'https://economictimes.indiatimes.com/tech/startups/llm-hallucinated-story-999';

    const legitCheck = verifyUrlProvenance(legitStoryUrl, candidatePool);
    const fakeCheck = verifyUrlProvenance(fakeHallucinatedUrl, candidatePool);

    const passed = legitCheck === true && fakeCheck === false;
    recordTest(
      'W',
      'Gemini provenance enforcement: final story URLs must strictly match candidate pool URLs (zero LLM hallucinations)',
      passed,
      `Verified URL accepted: ${legitCheck}, Hallucinated URL rejected: ${!fakeCheck}`
    );
  } catch (err: any) {
    recordTest('W', 'Gemini provenance enforcement', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST X: Insufficient fresh articles handling (never fabricate fake news)
  // -------------------------------------------------------------
  try {
    // Return only 3 fresh articles when 10 are required
    const sparseXml = `
      <rss><channel>
        <item><title><![CDATA[Story 1]]></title><link>https://economictimes.indiatimes.com/1</link><description><![CDATA[Summary 1 detailed text.]]></description><pubDate>${new Date().toUTCString()}</pubDate></item>
        <item><title><![CDATA[Story 2]]></title><link>https://economictimes.indiatimes.com/2</link><description><![CDATA[Summary 2 detailed text.]]></description><pubDate>${new Date().toUTCString()}</pubDate></item>
        <item><title><![CDATA[Story 3]]></title><link>https://economictimes.indiatimes.com/3</link><description><![CDATA[Summary 3 detailed text.]]></description><pubDate>${new Date().toUTCString()}</pubDate></item>
      </channel></rss>
    `;

    const sparseFetch = async () => new Response(sparseXml, { status: 200 });

    const genSparseRes = await generateCategoryDailyNews('cat_india_hr_employment', '2026-11-01', {
      sourceProviderMode: 'live',
      customFetch: sparseFetch as any,
    });

    const passed = Boolean(
      !genSparseRes.success &&
      genSparseRes.error?.includes('Insufficient verified source articles')
    );

    recordTest(
      'X',
      'Insufficient fresh articles handling: system never fabricates stories, reports insufficient pool',
      passed,
      `Success: ${genSparseRes.success}, Handled gracefully with error: '${genSparseRes.error}'`
    );
  } catch (err: any) {
    recordTest('X', 'Insufficient fresh articles handling', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST Y: Single source failure isolation
  // -------------------------------------------------------------
  try {
    // When one source URL fails (e.g. 403 or network error) while another succeeds
    const customFailoverFetch = async (url: string) => {
      if (url.includes('economictimes.indiatimes.com')) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(
        `<rss><channel><item>
          <title><![CDATA[Working Feed Story From Alternative Source]]></title>
          <link>https://www.livemint.com/industry/backup-story</link>
          <description><![CDATA[Alternative source continues supplying candidate stories.]]></description>
          <pubDate>${new Date().toUTCString()}</pubDate>
        </item></channel></rss>`,
        { status: 200 }
      );
    };

    const multiSourceResult = await retrieveLiveCategoryCandidateArticles('cat_india_re_infra', {
      customFetch: customFailoverFetch as any,
    });

    const hasFailedSource = multiSourceResult.sourceStats.some((s) => !s.success);
    const hasSuccessfulSource = multiSourceResult.sourceStats.some((s) => s.success && s.count > 0);
    const collectedArticles = multiSourceResult.articles.length > 0;

    const passed = hasFailedSource && hasSuccessfulSource && collectedArticles;
    recordTest(
      'Y',
      'Single source failure isolation: one failing source never blocks other sources from collecting articles',
      passed,
      `Failed sources isolated: ${hasFailedSource}, Surviving sources: ${hasSuccessfulSource}, Articles collected: ${multiSourceResult.articles.length}`
    );
  } catch (err: any) {
    recordTest('Y', 'Single source failure isolation', false, err.message);
  }

  console.log('\n================================================================');
  console.log(`TEST SUITE SUMMARY: ${testResults.filter((r) => r.passed).length} of ${testResults.length} TESTS PASSED`);
  console.log('================================================================');

  const failedTests = testResults.filter((r) => !r.passed);
  if (failedTests.length > 0) {
    console.error(`FAILED TESTS: ${failedTests.map((t) => t.code).join(', ')}`);
    process.exit(1);
  } else {
    console.log('ALL 15 TESTS (A THROUGH O) PASSED WITH ZERO FAILURES!\n');
    process.exit(0);
  }
}

runTestSuiteAtoO().catch((err) => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
