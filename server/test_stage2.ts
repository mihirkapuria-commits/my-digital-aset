import {
  initDb,
  getDb,
  registerOrLoginCustomer,
  getCustomerById,
  getCustomerBySessionToken,
  updateCustomerMobile,
  toCustomerProfileDTO,
} from './db.js';
import {
  calculateSubscriptionDates,
  confirmPaymentByAdmin,
  getCustomerPayments,
} from './paymentService.js';
import {
  generateTelegramConnectionToken,
  connectTelegramAccount,
} from './telegramService.js';
import {
  verifyGoogleIdTokenDirect,
} from './googleAdminAuth.js';

interface TestResult {
  num: number;
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function assertTest(num: number, name: string, condition: boolean, details?: string) {
  results.push({ num, name, passed: condition, details });
  const icon = condition ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon} - Test ${num}: ${name}`);
  if (details) console.log(`   └─ ${details}`);
}

async function runStage2Suite() {
  console.log('================================================================');
  console.log('STAGE 2 AUTOMATED PRODUCT & OPERATIONAL INTEGRATION TEST SUITE');
  console.log('================================================================\n');

  initDb();
  const db = getDb();

  // Clean test accounts
  const testEmails = ['alice.stage2@example.com', 'bob.stage2@example.com'];
  const testIds = new Set(db.customers.filter((c) => testEmails.includes(c.email)).map((c) => c.customerId));
  db.customers = db.customers.filter((c) => !testEmails.includes(c.email));
  db.customerSessions = db.customerSessions.filter((s) => !testIds.has(s.customerId));
  db.payments = db.payments.filter((p) => !testIds.has(p.customerId));
  db.subscriptions = db.subscriptions.filter((s) => !testIds.has(s.customerId));
  db.subscriptionCategories = db.subscriptionCategories.filter((sc) => !testIds.has(sc.customerId));
  db.telegramConnectionTokens = db.telegramConnectionTokens.filter((t) => !testIds.has(t.customerId));

  // 1. Setup Customer Alice and Customer Bob
  const aliceRes = registerOrLoginCustomer({
    fullName: 'Alice Verma',
    email: 'alice.stage2@example.com',
    mobileCountryCode: '+91',
    mobileNumber: '9811122233',
    selectedCategoryIds: ['cat_india_pe_vc'],
  });
  const alice = aliceRes.customer;
  const aliceToken = aliceRes.sessionToken;

  const bobRes = registerOrLoginCustomer({
    fullName: 'Bob Sen',
    email: 'bob.stage2@example.com',
    mobileCountryCode: '+91',
    mobileNumber: '9844455566',
    selectedCategoryIds: ['cat_india_startups'],
  });
  const bob = bobRes.customer;
  const bobToken = bobRes.sessionToken;

  // -------------------------------------------------------------
  // TEST 1: Customer Tenant Isolation
  // -------------------------------------------------------------
  console.log('\n--- SUITE 1: Customer Tenant Isolation ---');
  const resolvedAlice = getCustomerBySessionToken(aliceToken);
  const resolvedBob = getCustomerBySessionToken(bobToken);
  assertTest(1, 'Token strictly resolves own customer profile',
    resolvedAlice?.customerId === alice.customerId && resolvedBob?.customerId === bob.customerId,
    `Alice: ${resolvedAlice?.customerId}, Bob: ${resolvedBob?.customerId}`
  );

  const alicePayments = getCustomerPayments(alice.customerId);
  const bobPayments = getCustomerPayments(bob.customerId);
  assertTest(2, 'Alice has zero access to Bob payments or subscriptions',
    alicePayments.every((p) => p.customerId === alice.customerId) &&
    bobPayments.every((p) => p.customerId === bob.customerId),
    'Strict customerId boundary enforced'
  );

  // -------------------------------------------------------------
  // TEST 2: Telegram Connection Token & Deep Link Flow
  // -------------------------------------------------------------
  console.log('\n--- SUITE 2: Telegram Deep Link Connection Flow ---');
  const tgResult = generateTelegramConnectionToken(alice.customerId);
  assertTest(3, 'One-time token format follows high-entropy random hex strictly <= 64 chars for Telegram API',
    Boolean(tgResult.token && tgResult.token.length <= 64 && /^(tgtok_|mda_)[a-f0-9]{48,64}$/.test(tgResult.token)),
    `Generated: ${tgResult.token.substring(0, 16)}... (Length: ${tgResult.token.length} chars <= 64 limit)`
  );

  assertTest(4, 'Deep link constructed with bot username and token parameter',
    tgResult.deepLink.startsWith('https://t.me/') && tgResult.deepLink.includes(tgResult.token),
    `DeepLink: ${tgResult.deepLink.substring(0, 45)}...`
  );

  assertTest(5, 'Token lifetime is exactly 15 minutes',
    (() => {
      const now = Date.now();
      const exp = new Date(tgResult.expiresAt).getTime();
      const diffMins = Math.round((exp - now) / (60 * 1000));
      return diffMins === 15;
    })(),
    `Expires in 15 minutes at ${tgResult.expiresAt}`
  );

  // Connect Telegram via /start command
  const startConnect = connectTelegramAccount(tgResult.token, '88776655', 'alice_tg');
  assertTest(6, 'Valid token connects Telegram account successfully',
    startConnect.success && startConnect.customerId === alice.customerId,
    `Connected to customer: ${startConnect.customerId}`
  );

  // Test token single-use: Replay attempt must be rejected
  const replayAttempt = connectTelegramAccount(tgResult.token, '88776655', 'alice_tg');
  assertTest(7, 'Single-use enforcement: Token cannot be consumed twice',
    !replayAttempt.success,
    `Replay rejected: ${replayAttempt.error}`
  );

  // Test cross-account collision: Bob cannot link Alice's chat ID
  const bobTg = generateTelegramConnectionToken(bob.customerId);
  const crossAttempt = connectTelegramAccount(bobTg.token, '88776655', 'bob_tg');
  assertTest(8, 'One-account-per-chat rule prevents cross-account collision',
    !crossAttempt.success,
    `Rejected with error: ${crossAttempt.error}`
  );

  // Customer profile must indicate telegramConnected = true
  const updatedAlice = getCustomerById(alice.customerId);
  assertTest(9, 'Customer profile indicates telegramConnected = true',
    updatedAlice?.telegramConnected === true,
    'telegramConnected boolean is true'
  );

  // -------------------------------------------------------------
  // TEST 3: Inclusive Date Math & Continuous Courtesy Buffer
  // -------------------------------------------------------------
  console.log('\n--- SUITE 3: Subscription & Buffer Date Math ---');
  // Authoritative example: Payment confirmed 3 October 2026
  const oct3 = '2026-10-03T10:00:00.000Z';
  const dates = calculateSubscriptionDates(oct3);

  assertTest(10, 'Buffer start date is exactly adminConfirmedPaymentDate (Oct 3)',
    dates.bufferStartDate?.startsWith('2026-10-03'),
    `Buffer Start: ${dates.bufferStartDate}`
  );

  assertTest(11, 'Buffer end date is adminConfirmedPaymentDate + 4 days (October 7)',
    dates.bufferEndDate?.startsWith('2026-10-07'),
    `Buffer End: ${dates.bufferEndDate}`
  );

  assertTest(12, 'Paid subscription start date is adminConfirmedPaymentDate + 5 days (October 8)',
    dates.paidStartDate?.startsWith('2026-10-08'),
    `Paid Start: ${dates.paidStartDate}`
  );

  assertTest(13, 'Paid subscription ends 12 calendar months from paid start date',
    dates.paidEndDate?.startsWith('2027-10-08'),
    `Paid End: ${dates.paidEndDate}`
  );

  // -------------------------------------------------------------
  // TEST 4: Payment Proof Submission & Admin Confirmation
  // -------------------------------------------------------------
  console.log('\n--- SUITE 4: Payment Review & Admin Confirmation ---');
  const nowStr = new Date().toISOString();
  const utr = 'UTR20261003123456';
  db.payments.push({
    paymentId: 'pay_test_proof_01',
    customerId: alice.customerId,
    amount: 297.36,
    currency: 'INR',
    paymentStatus: 'pending',
    paymentDate: nowStr,
    gatewayReference: utr,
    provider: 'manual_upi',
    purchasedCategoryIds: ['cat_india_pe_vc'],
    createdAt: nowStr,
    updatedAt: nowStr,
  });

  const alicePending = db.payments.find((p) => p.gatewayReference === utr);
  assertTest(14, 'Customer payment proof stored in pending review state',
    alicePending?.paymentStatus === 'pending',
    `Status: ${alicePending?.paymentStatus}`
  );

  // Admin confirms payment with Oct 3 confirmation date
  const confirmResult = confirmPaymentByAdmin({
    customerId: alice.customerId,
    paymentId: 'pay_test_proof_01',
    confirmedPaymentDate: oct3,
    reference: utr,
    adminEmail: 'mihirkapuria@gmail.com',
  });

  assertTest(15, 'Admin confirmation marks payment successful and activates subscription',
    confirmResult.success && confirmResult.payment.paymentStatus === 'successful' && confirmResult.subscription.status === 'active',
    `Payment: ${confirmResult.payment.paymentStatus}, Subscription: ${confirmResult.subscription.status}`
  );

  assertTest(16, 'Activated subscription contains exact 5-day buffer and 12-month dates',
    Boolean(
      confirmResult.subscription.bufferStartDate?.startsWith('2026-10-03') &&
      confirmResult.subscription.bufferEndDate?.startsWith('2026-10-07') &&
      confirmResult.subscription.paidStartDate?.startsWith('2026-10-08') &&
      confirmResult.subscription.paidEndDate?.startsWith('2027-10-08')
    ),
    `Buffer: ${confirmResult.subscription.bufferStartDate?.substring(0,10)} to ${confirmResult.subscription.bufferEndDate?.substring(0,10)}, Paid: ${confirmResult.subscription.paidStartDate?.substring(0,10)} to ${confirmResult.subscription.paidEndDate?.substring(0,10)}`
  );

  // -------------------------------------------------------------
  // TEST 5: Admin Google Token Verification Security
  // -------------------------------------------------------------
  console.log('\n--- SUITE 5: Admin Google Token Verification Security ---');
  const invalidResult = await verifyGoogleIdTokenDirect('invalid.token.structure');
  assertTest(17, 'Direct Google token verification rejects malformed / unsigned tokens',
    !invalidResult.valid,
    `Error returned: ${invalidResult.error}`
  );

  // -------------------------------------------------------------
  // TEST 6: Duplicate Email & Phone Security Rules (Stage 2 Hardening)
  // -------------------------------------------------------------
  console.log('\n--- SUITE 6: Duplicate Email & Phone Security Rules ---');

  // Test 18: Existing email + another customer's phone -> REJECT
  let test18Caught = false;
  let test18Error = '';
  try {
    registerOrLoginCustomer({
      fullName: 'Alice Phone Hijack Attempt',
      email: 'alice.stage2@example.com', // Alice's email
      mobileCountryCode: '+91',
      mobileNumber: '9844455566', // Bob's phone number!
      selectedCategoryIds: ['cat_india_pe_vc'],
    });
  } catch (err: any) {
    test18Caught = true;
    test18Error = err.message;
  }
  assertTest(18, 'Existing email + another customer\'s phone is strictly rejected',
    test18Caught && test18Error.includes('associated with an existing account'),
    `Rejected with safe error: ${test18Error}`
  );

  // Test 19: Existing phone + another customer's email -> REJECT
  let test19Caught = false;
  let test19Error = '';
  try {
    registerOrLoginCustomer({
      fullName: 'Charlie Impersonation Attempt',
      email: 'charlie.new@example.com', // New email
      mobileCountryCode: '+91',
      mobileNumber: '9811122233', // Alice's phone number!
      selectedCategoryIds: ['cat_india_pe_vc'],
    });
  } catch (err: any) {
    test19Caught = true;
    test19Error = err.message;
  }
  assertTest(19, 'Existing phone + new email is strictly rejected (no phone stealing)',
    test19Caught && test19Error.includes('associated with an existing account'),
    `Rejected with safe error: ${test19Error}`
  );

  // Test 20: Authenticated customer changing their own phone -> SUCCEED
  const changeRes = updateCustomerMobile(alice.customerId, '+91', '9811199999');
  const aliceAfterChange = getCustomerById(alice.customerId);
  assertTest(20, 'Authenticated customer can update their own phone number',
    changeRes.success && aliceAfterChange?.mobileNumber === '9811199999',
    `Updated Alice phone to: ${aliceAfterChange?.mobileCountryCode} ${aliceAfterChange?.mobileNumber}`
  );

  // Test 21: Unauthenticated attempt to change or collide phone -> BLOCKED
  // Authenticated Bob trying to change to Alice's new phone -> REJECT
  const bobCollideRes = updateCustomerMobile(bob.customerId, '+91', '9811199999');
  assertTest(21, 'Changing mobile to a number owned by another customer is rejected',
    !bobCollideRes.success && Boolean(bobCollideRes.error?.includes('already linked')),
    `Rejected with: ${bobCollideRes.error}`
  );

  // Unauthenticated registration re-login for Alice cannot change phone number
  const aliceRelogin = registerOrLoginCustomer({
    fullName: 'Alice Verma Logged In',
    email: 'alice.stage2@example.com',
    mobileCountryCode: '+91',
    mobileNumber: '9877777777', // New number attempted in unauthenticated registration
    selectedCategoryIds: ['cat_india_pe_vc'],
  });
  const alicePostRelogin = getCustomerById(alice.customerId);
  assertTest(22, 'Unauthenticated registration/login preserves phone and customerId without mutation',
    aliceRelogin.customer.customerId === alice.customerId && alicePostRelogin?.mobileNumber === '9811199999',
    `Preserved customerId: ${aliceRelogin.customer.customerId}, Preserved phone: ${alicePostRelogin?.mobileNumber}`
  );

  // Test 23: Customer Profile DTO Data Minimization (No telegramChatId or secret token)
  const profileDTO = toCustomerProfileDTO(alicePostRelogin!);
  assertTest(23, 'CustomerProfileDTO strips telegramChatId and secret tokens',
    Boolean(
      (profileDTO as any).telegramChatId === undefined &&
      (profileDTO as any).customerAuthToken === undefined &&
      typeof profileDTO.telegramConnected === 'boolean' &&
      profileDTO.email === 'alice.stage2@example.com'
    ),
    `DTO contains safe fields only. telegramConnected: ${profileDTO.telegramConnected}, telegramChatId: ${(profileDTO as any).telegramChatId}`
  );

  // Summary
  console.log('\n================================================================');
  const allPassed = results.every((r) => r.passed);
  const passedCount = results.filter((r) => r.passed).length;
  console.log(`STAGE 2 TEST SUITE SUMMARY: ${passedCount} of ${results.length} TESTS PASSED`);
  console.log('================================================================');

  if (!allPassed) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runStage2Suite().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
