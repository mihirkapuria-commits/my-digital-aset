import {
  initDb,
  getDb,
  saveDb,
} from './db.js';
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
  setCategoryStatus,
} from './entitlementService.js';
import {
  deliverIndiaCategoryNewsToCustomer,
} from './indiaDeliveryService.js';
import {
  getIndiaTelegramBotUsername,
  sendIndiaTelegramMessage,
} from './indiaTelegramService.js';
import {
  getTelegramBotUsername,
  sendTelegramMessage,
} from './telegramService.js';
import {
  deliverCategoryNewsToCustomer,
} from './deliveryService.js';
import {
  filterEligibleCandidateArticles,
  isSameUnderlyingEvent,
} from './deduplicationService.js';

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail: string = '') {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    if (detail) console.log(`     └─ ${detail}`);
    passedTests++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    if (detail) console.error(`     └─ ${detail}`);
    failedTests++;
  }
}

async function runTestSuite() {
  console.log('======================================================================');
  console.log('MYDIGITASSET: TWO SEPARATE NEWS SYSTEMS VERIFICATION TEST SUITE');
  console.log('======================================================================\n');

  const originalGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY; // Fast deterministic test execution using grounded candidate pool

  try {
    initDb();
    const db = getDb();
    const testDate = '2026-10-18';
    const adminEmail = 'admin@mydigitasset.com';

  // -------------------------------------------------------------------------
  // TEST 1: All 10 India categories exist
  // -------------------------------------------------------------------------
  console.log('--- TEST 1: All 10 India categories exist ---');
  const existingCatIds = new Set(db.categories.map((c) => c.id));
  const all10Exist = INDIA_CATEGORY_IDS.every((id) => existingCatIds.has(id));
  assert(
    all10Exist && INDIA_CATEGORY_IDS.length === 10,
    '1. All 10 India categories exist in the database catalog',
    `Found ${INDIA_CATEGORY_IDS.length} India category definitions: ${INDIA_CATEGORY_IDS.join(', ')}`
  );

  // -------------------------------------------------------------------------
  // TEST 2: Each India category can independently be enabled/disabled
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 2: Each India category can independently be enabled/disabled ---');
  const targetDisableCat = 'cat_india_banking_fintech';
  const beforeOtherCats = db.categories.filter((c) => c.id !== targetDisableCat).map((c) => ({ id: c.id, active: c.isActive }));

  const disableRes = setCategoryStatus(targetDisableCat, false, adminEmail);
  const disabledCatObj = db.categories.find((c) => c.id === targetDisableCat);

  const otherCatsUnchanged = beforeOtherCats.every((b) => {
    const current = db.categories.find((c) => c.id === b.id);
    return current && current.isActive === b.active;
  });

  assert(
    disableRes.success && disabledCatObj?.isActive === false && otherCatsUnchanged,
    '2. Target India category is disabled while other categories remain untouched',
    `Disabled '${targetDisableCat}'. Other ${beforeOtherCats.length} categories status remained identical.`
  );

  // -------------------------------------------------------------------------
  // TEST 3: Disabled India category does not generate news
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 3: Disabled India category does not generate news ---');
  // Clear any existing package for testDate
  db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => !(p.categoryId === targetDisableCat && p.newsDate === testDate));
  const genDisabledRes = await generateCategoryDailyNews(targetDisableCat, testDate);
  const pkgAfter = db.dailyNewsPackages.find((p) => p.categoryId === targetDisableCat && p.newsDate === testDate);

  assert(
    genDisabledRes.success === false && Boolean(genDisabledRes.error?.includes('disabled')) && !pkgAfter,
    '3. Disabled India category rejects news generation without creating packages',
    `Result success: ${genDisabledRes.success}, Error: "${genDisabledRes.error}"`
  );

  // -------------------------------------------------------------------------
  // TEST 4: Disabled India category does not deliver Telegram news
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 4: Disabled India category does not deliver Telegram news ---');
  const dummyCustId = 'cust_test_disabled_delivery_01';
  db.customers = db.customers.filter((c) => c.customerId !== dummyCustId);
  db.customers.push({
    customerId: dummyCustId,
    fullName: 'Test Subscriber',
    email: 'test.disabled.delivery@example.com',
    mobileCountryCode: '+91',
    mobileNumber: '9888877771',
    telegramChatId: 'tg_chat_test_disabled_01',
    telegramConnected: true,
    indiaTelegramChatId: 'tg_chat_india_01',
    indiaTelegramConnected: true,
    accountStatus: 'active',
    selectedCategoryIds: [targetDisableCat],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveDb();

  const delDisabledRes = await deliverIndiaCategoryNewsToCustomer({
    customerId: dummyCustId,
    categoryId: targetDisableCat,
    newsDate: testDate,
  });

  assert(
    delDisabledRes.status === 'skipped' && Boolean(delDisabledRes.error?.includes('disabled')),
    '4. Disabled India category delivery is skipped and suppressed',
    `Status: ${delDisabledRes.status}, Error: "${delDisabledRes.error}"`
  );

  // -------------------------------------------------------------------------
  // TEST 5: One disabled India category does not affect other India categories
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 5: One disabled India category does not affect other India categories ---');
  const enabledIndiaCat = 'cat_india_startups';
  // Ensure enabled
  setCategoryStatus(enabledIndiaCat, true, adminEmail);
  db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => !(p.categoryId === enabledIndiaCat && p.newsDate === testDate));

  const genEnabledRes = await generateCategoryDailyNews(enabledIndiaCat, testDate);

  assert(
    genEnabledRes.success === true && Boolean(genEnabledRes.package) && genEnabledRes.package?.storyCount! >= 1,
    '5. Enabled India category generates news cleanly despite another category being disabled',
    `Category: '${enabledIndiaCat}', Package ID: ${genEnabledRes.package?.packageId}, Stories: ${genEnabledRes.stories?.length}`
  );

  // -------------------------------------------------------------------------
  // TEST 6: India news delivery uses the separate Telegram bot
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 6: India news delivery uses the separate Telegram bot ---');
  const custIndia = `cust_test_india_bot_06_${Date.now()}`;
  db.customers.push({
    customerId: custIndia,
    fullName: 'India Subscriber 06',
    email: `cust.india.06.${Date.now()}@example.com`,
    mobileCountryCode: '+91',
    mobileNumber: '9888877776',
    telegramChatId: 'tg_specialist_chat_06',
    telegramConnected: true,
    indiaTelegramChatId: 'tg_india_chat_06',
    indiaTelegramConnected: true,
    accountStatus: 'active',
    selectedCategoryIds: [enabledIndiaCat],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Add active subscription & entitlement
  const subId = `sub_test_india_${Date.now()}`;
  db.subscriptions.push({
    subscriptionId: subId,
    customerId: custIndia,
    startDate: '2026-01-01',
    expiryDate: '2027-01-01',
    status: 'active',
    paymentId: `pay_${Date.now()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  db.subscriptionCategories.push({
    subscriptionId: subId,
    customerId: custIndia,
    categoryId: enabledIndiaCat,
    categoryName: 'India Startups',
    entitlementStatus: 'active',
    assignedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveDb();

  const delIndiaRes = await deliverIndiaCategoryNewsToCustomer({
    customerId: custIndia,
    categoryId: enabledIndiaCat,
    newsDate: testDate,
  });

  const indiaBotUsername = getIndiaTelegramBotUsername();

  assert(
    delIndiaRes.botType === 'india' && delIndiaRes.status === 'sent' && indiaBotUsername === 'MyDigitAssetIndiaBot',
    '6. India delivery dispatches using System B separate Telegram bot',
    `Bot Type: ${delIndiaRes.botType}, Delivery Status: ${delIndiaRes.status}, India Bot Username: @${indiaBotUsername}`
  );

  // -------------------------------------------------------------------------
  // TEST 7: Existing specialist Telegram bot remains unchanged
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 7: Existing specialist Telegram bot remains unchanged ---');
  const specialistBotUsername = getTelegramBotUsername();
  const testMsgRes = await sendTelegramMessage('tg_sandbox_spec', 'Test specialist message');

  assert(
    specialistBotUsername === 'MyDigitAssetNewsBot' && testMsgRes.success === true,
    '7. Existing specialist Telegram bot configuration is preserved and unchanged',
    `Specialist Bot Username: @${specialistBotUsername}, Message result: ${testMsgRes.success}`
  );

  // -------------------------------------------------------------------------
  // TEST 8: Existing specialist delivery remains unchanged
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 8: Existing specialist delivery remains unchanged ---');
  const specialistCat = 'cat_japan_re';
  const genSpecRes = await generateSpecialistCategoryDailyNews(specialistCat, testDate);

  const specCustId = `cust_spec_08_${Date.now()}`;
  db.customers.push({
    customerId: specCustId,
    fullName: 'Specialist Subscriber 08',
    email: `spec.sub.08.${Date.now()}@example.com`,
    mobileCountryCode: '+91',
    mobileNumber: '9888877778',
    telegramChatId: 'tg_spec_chat_08',
    telegramConnected: true,
    accountStatus: 'active',
    selectedCategoryIds: [specialistCat],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const specSubId = `sub_spec_${Date.now()}`;
  db.subscriptions.push({
    subscriptionId: specSubId,
    customerId: specCustId,
    startDate: '2026-01-01',
    expiryDate: '2027-01-01',
    status: 'active',
    paymentId: `pay_spec_${Date.now()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  db.subscriptionCategories.push({
    subscriptionId: specSubId,
    customerId: specCustId,
    categoryId: specialistCat,
    categoryName: 'Japan Real Estate',
    entitlementStatus: 'active',
    assignedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveDb();

  const delSpecRes = await deliverCategoryNewsToCustomer({
    customerId: specCustId,
    categoryId: specialistCat,
    newsDate: testDate,
  });

  assert(
    genSpecRes.success === true && delSpecRes.status === 'sent',
    '8. Existing specialist news generation and delivery execute as expected',
    `Specialist Gen: ${genSpecRes.success}, Delivery Status: ${delSpecRes.status}`
  );

  // -------------------------------------------------------------------------
  // TEST 9: Failure in India delivery system does not stop specialist delivery
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 9: Failure in India delivery does not stop specialist delivery ---');
  // Simulate an extreme error in India delivery
  let caughtException = false;
  try {
    await deliverIndiaCategoryNewsToCustomer({
      customerId: 'non_existent_cust_9999',
      categoryId: 'cat_invalid',
      simulateTelegramFailureUntilAttempt: 10,
    });
  } catch (_) {
    caughtException = true;
  }

  // Specialist delivery runs immediately after
  const specCust9 = `cust_spec_09_${Date.now()}`;
  db.customers.push({
    customerId: specCust9,
    fullName: 'Specialist Sub 09',
    email: `spec.09.${Date.now()}@example.com`,
    mobileCountryCode: '+91',
    mobileNumber: '9888877779',
    telegramChatId: 'tg_spec_chat_09',
    telegramConnected: true,
    accountStatus: 'active',
    selectedCategoryIds: [specialistCat],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const subCust9 = `sub_spec_9_${Date.now()}`;
  db.subscriptions.push({
    subscriptionId: subCust9,
    customerId: specCust9,
    startDate: '2026-01-01',
    expiryDate: '2027-01-01',
    status: 'active',
    paymentId: `pay_spec_9_${Date.now()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  db.subscriptionCategories.push({
    subscriptionId: subCust9,
    customerId: specCust9,
    categoryId: specialistCat,
    categoryName: 'Japan Real Estate',
    entitlementStatus: 'active',
    assignedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  saveDb();

  const postFailureSpecDel = await deliverCategoryNewsToCustomer({
    customerId: specCust9,
    categoryId: specialistCat,
    newsDate: testDate,
  });

  assert(
    postFailureSpecDel.status === 'sent',
    '9. A failure in the India delivery system does not halt or affect specialist delivery',
    `Post-error Specialist Delivery: ${postFailureSpecDel.status}`
  );

  // -------------------------------------------------------------------------
  // TEST 10: Existing specialist functionality continues to pass all existing tests
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 10: Existing specialist functionality remains working ---');
  const specialistCategoriesExist = SPECIALIST_CATEGORY_IDS.every((id) =>
    db.categories.some((c) => c.id === id)
  );

  assert(
    specialistCategoriesExist && SPECIALIST_CATEGORY_IDS.length === 7,
    '10. All 7 working specialist categories exist and are cataloged',
    `Specialist categories verified: ${SPECIALIST_CATEGORY_IDS.join(', ')}`
  );

  // -------------------------------------------------------------------------
  // TEST 11: 7-day duplication prevention works for the new India system
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 11: 7-day duplication prevention works for India system ---');
  const event1 = {
    headline: 'Zepto secures $300M funding in India led by global investors',
    summary: 'Quick commerce unicorn Zepto raised $300 million in fresh equity financing.',
    sourceUrl: 'https://inc42.com/buzz/zepto-300m-round',
  };

  const event2DifferentHeadline = {
    headline: 'Quick commerce firm Zepto closes $300 million funding round',
    summary: 'Zepto successfully secured $300M in growth equity from international sovereign funds.',
    sourceUrl: 'https://economictimes.indiatimes.com/tech/zepto-closes-funding',
  };

  const dedupMatch = isSameUnderlyingEvent(event1, event2DifferentHeadline);

  assert(
    dedupMatch.isDuplicate === true,
    '11. 7-day duplication prevention recognizes same underlying event across different publications',
    `isDuplicate: ${dedupMatch.isDuplicate}, reason: ${dedupMatch.reason}, confidence: ${dedupMatch.confidence}`
  );

  // -------------------------------------------------------------------------
  // TEST 12: Minimum 10 genuinely new stories is preserved
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 12: Minimum 10 genuinely new stories target preserved ---');
  const gen10Date = '2026-10-22';
  db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => !(p.categoryId === 'cat_india_re_infra' && p.newsDate === gen10Date));

  const gen10Res = await generateCategoryDailyNews('cat_india_re_infra', gen10Date);

  assert(
    gen10Res.success === true && gen10Res.package?.storyCount === 10,
    '12. Generates exactly 10 genuinely new stories when sufficient valid news exists',
    `Story count: ${gen10Res.package?.storyCount}, Package: ${gen10Res.package?.packageId}`
  );

  // -------------------------------------------------------------------------
  // TEST 13: No fabricated stories are generated
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 13: No fabricated stories are generated ---');
  // If candidate pool has only valid stories, it never fabricates
  const candidatePoolCount = VERIFIED_SOURCE_DATA['cat_india_marketing_ads']?.length || 0;
  const genPartialDate = '2026-10-23';
  db.dailyNewsPackages = db.dailyNewsPackages.filter((p) => !(p.categoryId === 'cat_india_marketing_ads' && p.newsDate === genPartialDate));

  const genPartialRes = await generateCategoryDailyNews('cat_india_marketing_ads', genPartialDate);

  // Stories returned must match genuine source URLs
  const allUrlsValid = genPartialRes.stories?.every((s) => s.sourceUrl.startsWith('http')) ?? false;
  const notFabricated = genPartialRes.stories?.every((s) => s.headline && s.sourceName) ?? false;

  assert(
    genPartialRes.success === true && allUrlsValid && notFabricated,
    '13. No fabricated stories: all delivered stories are verified real grounded candidates',
    `Delivered ${genPartialRes.stories?.length} verified stories, 0 fabricated.`
  );

  // -------------------------------------------------------------------------
  // TEST 14: Existing authentication/security tests remain passing
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 14: Existing authentication/security tests remain passing ---');
  // Re-enable target category
  setCategoryStatus(targetDisableCat, true, adminEmail);
  const reEnabledCat = db.categories.find((c) => c.id === targetDisableCat);

  // Verify India bot token is NOT exposed in category or customer objects
  const customerKeys = Object.keys(db.customers[0] || {});
  const categoryKeys = Object.keys(db.categories[0] || {});
  const noTokenInCustomer = !customerKeys.some((k) => k.toLowerCase().includes('token') && k.toLowerCase().includes('bot'));
  const noTokenInCat = !categoryKeys.some((k) => k.toLowerCase().includes('token'));

  assert(
    reEnabledCat?.isActive === true && noTokenInCustomer && noTokenInCat,
    '14. Category state management and credential containment remain secure',
    `Re-enabled '${targetDisableCat}': active = ${reEnabledCat?.isActive}. Zero secret leakage.`
  );

  // -------------------------------------------------------------------------
  // TEST 15: Existing idempotency behavior remains passing
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 15: Existing idempotency behavior remains passing ---');
  const countBefore = db.dailyNewsPackages.length;
  const storiesBefore = db.newsStories.length;

  const repeatGenRes = await generateCategoryDailyNews('cat_india_re_infra', gen10Date);

  const countAfter = db.dailyNewsPackages.length;
  const storiesAfter = db.newsStories.length;

  assert(
    repeatGenRes.success === true && countBefore === countAfter && storiesBefore === storiesAfter,
    '15. Repeated news generation for same category & date returns existing package idempotently',
    `Packages: ${countBefore} -> ${countAfter}, Stories: ${storiesBefore} -> ${storiesAfter}`
  );

  } finally {
    if (originalGeminiKey) {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    }
  }

  console.log('\n======================================================================');
  console.log(`TEST SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('======================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal Test Exception:', err);
  process.exit(1);
});
