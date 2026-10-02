import {
  initDb,
  getDb,
  registerOrLoginCustomer,
  getCustomerById,
} from './db.js';
import {
  processVerifiedPayment,
  getCustomerActiveCategoryEntitlements,
  getCustomerPayments,
  getCustomerSubscriptions,
  calculateSubscriptionDates,
  isSubscriptionActiveAt,
} from './paymentService.js';

async function runTests() {
  console.log('=== STARTING PHASE 2 AUTOMATED TEST SUITE ===\n');
  initDb();
  const db = getDb();
  db.payments = db.payments.filter((p) => !p.gatewayReference.startsWith('UTR_'));
  const activePayIds = new Set(db.payments.map((p) => p.paymentId));
  db.subscriptions = db.subscriptions.filter((s) => activePayIds.has(s.paymentId));
  const activeSubIds = new Set(db.subscriptions.map((s) => s.subscriptionId));
  db.subscriptionCategories = db.subscriptionCategories.filter((sc) => activeSubIds.has(sc.subscriptionId));

  // 1. Setup Customer A & Customer B
  const custARes = registerOrLoginCustomer({
    fullName: 'Customer Alpha',
    email: 'customer.alpha@example.com',
    mobileCountryCode: '+91',
    mobileNumber: '9111122222',
    selectedCategoryIds: ['cat_india_startups'],
  });
  const customerA = custARes.customer;
  console.log('Registered Customer A:', customerA.customerId, customerA.email);

  const custBRes = registerOrLoginCustomer({
    fullName: 'Customer Beta',
    email: 'customer.beta@example.com',
    mobileCountryCode: '+91',
    mobileNumber: '9333344444',
    selectedCategoryIds: ['cat_india_consumer_fmcg'],
  });
  const customerB = custBRes.customer;
  console.log('Registered Customer B:', customerB.customerId, customerB.email);

  // -------------------------------------------------------------
  // TEST A: Successful Payment & Automatic Activation (Section 2, 4, 5, 6)
  // -------------------------------------------------------------
  console.log('\n--- TEST A: Successful payment & automatic activation ---');
  const payDateA = '2026-09-29T10:00:00.000Z';
  const resultA = processVerifiedPayment({
    customerId: customerA.customerId,
    gatewayReference: 'UTR_TEST_ALPHA_001',
    categoryIds: ['cat_india_startups'],
    paymentStatus: 'successful',
    paymentDate: payDateA,
  });

  console.log('Payment Status:', resultA.payment.paymentStatus);
  console.log('Subscription Status:', resultA.subscription?.status);
  console.log('Subscription Start Date:', resultA.subscription?.startDate);
  console.log('Subscription Expiry Date:', resultA.subscription?.expiryDate);
  console.log('Entitlements count:', resultA.entitlements.length);

  // Assertions for Test A
  if (resultA.payment.paymentStatus !== 'successful') throw new Error('Test A Failed: payment not successful');
  if (resultA.subscription?.status !== 'active') throw new Error('Test A Failed: subscription not active');
  if (resultA.entitlements.length !== 1) throw new Error('Test A Failed: entitlement length !== 1');
  if (!resultA.subscription.startDate.startsWith('2026-09-30')) {
    throw new Error(`Test A Failed: start date should be 30 September 2026, got ${resultA.subscription.startDate}`);
  }
  if (!resultA.subscription.expiryDate.startsWith('2027-09-30')) {
    throw new Error(`Test A Failed: expiry date should be 30 September 2027, got ${resultA.subscription.expiryDate}`);
  }
  console.log('✅ TEST A PASSED: Payment successful, subscription active with exact individual dates, no admin approval required.');

  // -------------------------------------------------------------
  // TEST B: Failed Payment (Section 15 Test B)
  // -------------------------------------------------------------
  console.log('\n--- TEST B: Failed payment ---');
  const resultB = processVerifiedPayment({
    customerId: customerA.customerId,
    gatewayReference: 'UTR_FAILED_TXN_002',
    categoryIds: ['cat_india_banking_fintech'],
    paymentStatus: 'failed',
  });

  console.log('Failed Payment Status:', resultB.payment.paymentStatus);
  console.log('Subscription Created:', resultB.subscription);
  console.log('Entitlements Created:', resultB.entitlements.length);

  if (resultB.payment.paymentStatus !== 'failed') throw new Error('Test B Failed: payment should be failed');
  if (resultB.subscription !== null) throw new Error('Test B Failed: subscription should not be created for failed payment');
  if (resultB.entitlements.length !== 0) throw new Error('Test B Failed: no entitlements should be granted');
  console.log('✅ TEST B PASSED: Failed payment saved, zero subscriptions or entitlements created.');

  // -------------------------------------------------------------
  // TEST C: Payment Idempotency / Duplicate Callbacks (Section 8)
  // -------------------------------------------------------------
  console.log('\n--- TEST C: Duplicate callback / Idempotency ---');
  const dbBefore = getDb();
  const paymentsCountBefore = dbBefore.payments.length;
  const subsCountBefore = dbBefore.subscriptions.length;
  const entCountBefore = dbBefore.subscriptionCategories.length;

  // Process the exact same gateway reference again
  const duplicateResult = processVerifiedPayment({
    customerId: customerA.customerId,
    gatewayReference: 'UTR_TEST_ALPHA_001',
    categoryIds: ['cat_india_startups'],
    paymentStatus: 'successful',
    paymentDate: payDateA,
  });

  const dbAfter = getDb();
  console.log('Duplicate detected flag:', duplicateResult.isDuplicate);
  console.log('Payments count before / after:', paymentsCountBefore, dbAfter.payments.length);
  console.log('Subscriptions count before / after:', subsCountBefore, dbAfter.subscriptions.length);
  console.log('Entitlements count before / after:', entCountBefore, dbAfter.subscriptionCategories.length);

  if (!duplicateResult.isDuplicate) throw new Error('Test C Failed: duplicate flag should be true');
  if (dbAfter.payments.length !== paymentsCountBefore) throw new Error('Test C Failed: duplicate payment created');
  if (dbAfter.subscriptions.length !== subsCountBefore) throw new Error('Test C Failed: duplicate subscription created');
  if (dbAfter.subscriptionCategories.length !== entCountBefore) throw new Error('Test C Failed: duplicate entitlement created');
  console.log('✅ TEST C PASSED: Duplicate callback safely handled without duplicate records.');

  // -------------------------------------------------------------
  // TEST D: Multiple Categories in One Payment (Section 6, 7)
  // -------------------------------------------------------------
  console.log('\n--- TEST D: Multiple categories (e.g. 3 categories) ---');
  const multiCategories = [
    'cat_india_startups',
    'cat_india_banking_fintech',
    'cat_india_re_infra',
  ];

  const resultD = processVerifiedPayment({
    customerId: customerB.customerId,
    gatewayReference: 'UTR_MULTI_CAT_003',
    categoryIds: multiCategories,
    paymentStatus: 'successful',
    paymentDate: '2026-09-29T11:00:00.000Z',
  });

  console.log('Entitlements created for 3 categories:', resultD.entitlements.map((e) => e.categoryName));

  if (resultD.entitlements.length !== 3) throw new Error('Test D Failed: expected 3 category entitlements');
  const entitlementsB = getCustomerActiveCategoryEntitlements(customerB.customerId, new Date('2026-10-01T06:30:00Z'));
  if (entitlementsB.activeCategories.length !== 3) {
    throw new Error(`Test D Failed: expected 3 active categories, found ${entitlementsB.activeCategories.length}`);
  }
  console.log('✅ TEST D PASSED: Multiple categories correctly entitled under a single payment.');

  // -------------------------------------------------------------
  // TEST E: Customer Isolation & Privacy (Section 12)
  // -------------------------------------------------------------
  console.log('\n--- TEST E: Customer isolation & scoping ---');
  const custAPayments = getCustomerPayments(customerA.customerId);
  const custBPayments = getCustomerPayments(customerB.customerId);

  const aHasBPayments = custAPayments.some((p) => p.customerId === customerB.customerId);
  const bHasAPayments = custBPayments.some((p) => p.customerId === customerA.customerId);

  if (aHasBPayments || bHasAPayments) {
    throw new Error('Test E Failed: customer isolation breached in payments lookup');
  }

  const custASubs = getCustomerSubscriptions(customerA.customerId);
  const custBSubs = getCustomerSubscriptions(customerB.customerId);
  const aHasBSubs = custASubs.some((s) => s.subscription.customerId === customerB.customerId);
  const bHasASubs = custBSubs.some((s) => s.subscription.customerId === customerA.customerId);

  if (aHasBSubs || bHasASubs) {
    throw new Error('Test E Failed: customer isolation breached in subscriptions lookup');
  }
  console.log('✅ TEST E PASSED: Complete customer data isolation enforced.');

  // -------------------------------------------------------------
  // TEST F: Subscription Expiry Date Rule (Section 5, 17)
  // -------------------------------------------------------------
  console.log('\n--- TEST F: Subscription expiry protection ---');
  // Date during active year: 15 January 2027
  const duringActiveYear = new Date('2027-01-15T06:30:00Z');
  const activeCheck = isSubscriptionActiveAt(resultA.subscription!, duringActiveYear);
  console.log('Active on 15 Jan 2027:', activeCheck);
  if (!activeCheck) throw new Error('Test F Failed: should be active on 15 Jan 2027');

  // Date on last news delivery day: 30 September 2027 at 6:30 AM IST
  const lastNewsDay = new Date('2027-09-30T06:30:00Z');
  const lastNewsCheck = isSubscriptionActiveAt(resultA.subscription!, lastNewsDay);
  console.log('Active on last news day (30 Sep 2027):', lastNewsCheck);
  if (!lastNewsCheck) throw new Error('Test F Failed: should be active on 30 Sep 2027');

  // Date after expiry: 1 October 2027 at 6:30 AM IST
  const afterExpiryDay = new Date('2027-10-01T06:30:00Z');
  const expiredCheck = isSubscriptionActiveAt(resultA.subscription!, afterExpiryDay);
  console.log('Active on 1 Oct 2027 (after expiry):', expiredCheck);
  if (expiredCheck) throw new Error('Test F Failed: should be EXPIRED on 1 Oct 2027');

  const entitlementsExpired = getCustomerActiveCategoryEntitlements(customerA.customerId, afterExpiryDay);
  console.log('Entitled to news on 1 Oct 2027:', entitlementsExpired.hasActiveSubscription);
  if (entitlementsExpired.hasActiveSubscription) {
    throw new Error('Test F Failed: customer should have 0 active entitlements after expiry date');
  }

  console.log('✅ TEST F PASSED: Expiry date calculation and eligibility cutoff strictly verified.');

  console.log('\n=============================================');
  console.log('ALL PHASE 2 TESTS (A, B, C, D, E, F) PASSED!');
  console.log('=============================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
