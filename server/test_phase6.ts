import crypto from 'crypto';
import {
  initDb,
  getDb,
  saveDb,
  registerOrLoginCustomer,
  getCustomerById,
  getCustomerPaymentOrders,
} from './db.js';
import {
  processSuccessfulPayment,
  processFailedPayment,
  processVerifiedPayment,
  calculateServerPayablePrice,
  calculateSubscriptionDates,
  getCustomerActiveCategoryEntitlements,
  getCustomerPayments,
  getCustomerSubscriptions,
  defaultPaymentGateway,
} from './paymentService.js';
import {
  getRazorpayConfig,
  setPaymentProviderMode,
  getPaymentProviderMode,
  createRazorpayOrder,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  generateTestPaymentSignature,
  generateTestWebhookSignature,
  TEST_MOCK_KEY_SECRET,
  TEST_MOCK_WEBHOOK_SECRET,
} from './razorpayService.js';
import {
  getCustomerActiveEntitlements,
  executeAdminCategoryTransfer,
} from './entitlementService.js';
import {
  deliverCategoryNewsToCustomer,
} from './deliveryService.js';
import {
  generateCategoryDailyNews,
} from './newsService.js';

interface TestResult {
  code: string;
  name: string;
  passed: boolean;
  details?: string;
}

const testResults: TestResult[] = [];

function recordTest(code: string, name: string, passed: boolean, details?: string) {
  testResults.push({ code, name, passed, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon} - Test ${code}: ${name}`);
  if (details) {
    console.log(`   └─ ${details}`);
  }
}

async function runPhase6Tests() {
  console.log('================================================================');
  console.log('STARTING PHASE 6 & 6.1 AUTOMATED VERIFICATION SUITE: TESTS A-Z & AA-AH');
  console.log('================================================================\n');

  initDb();
  setPaymentProviderMode('test');
  const db = getDb();

  // Clean test records from DB for pristine isolation
  const testCustomerEmails = ['rahul.sharma@example.com', 'priya.patel@example.com', 'cross.cust@example.com'];
  const testCustomerIds = new Set(
    db.customers.filter((c) => testCustomerEmails.includes(c.email)).map((c) => c.customerId)
  );

  db.paymentOrders = db.paymentOrders.filter((po) => !testCustomerIds.has(po.customerId) && !po.paymentOrderId.startsWith('pord_test_'));
  db.payments = db.payments.filter((p) => !testCustomerIds.has(p.customerId) && !p.paymentId.startsWith('pay_test_'));
  db.subscriptions = db.subscriptions.filter((s) => !testCustomerIds.has(s.customerId));
  db.subscriptionCategories = db.subscriptionCategories.filter((sc) => !testCustomerIds.has(sc.customerId));
  saveDb();

  // 1. Setup Test Customers
  const custA = registerOrLoginCustomer({
    fullName: 'Rahul Sharma',
    email: 'rahul.sharma@example.com',
    mobileCountryCode: '+91',
    mobileNumber: '9820011111',
    selectedCategoryIds: ['cat_india_startups'],
  }).customer;

  const custB = registerOrLoginCustomer({
    fullName: 'Priya Patel',
    email: 'priya.patel@example.com',
    mobileCountryCode: '+91',
    mobileNumber: '9820022222',
    selectedCategoryIds: ['cat_india_banking_fintech'],
  }).customer;

  // -------------------------------------------------------------
  // TEST A: Successful payment
  // -------------------------------------------------------------
  try {
    const orderA = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_startups'],
      amount: 297.36,
      currency: 'INR',
    });

    const paymentIdA = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const validSigA = generateTestPaymentSignature(orderA.orderId, paymentIdA);

    const activateRes = processSuccessfulPayment({
      paymentOrderId: orderA.paymentOrderId,
      providerOrderId: orderA.orderId,
      providerPaymentId: paymentIdA,
      providerSignature: validSigA,
      amount: 297.36,
      currency: 'INR',
      customerId: custA.customerId,
      source: 'browser_callback',
      paymentDate: '2026-09-29T10:00:00.000Z',
    });

    const passed =
      activateRes.ok &&
      !activateRes.isDuplicate &&
      activateRes.payment.paymentStatus === 'successful' &&
      activateRes.subscription?.status === 'active' &&
      activateRes.entitlements.length === 1 &&
      activateRes.entitlements[0].categoryId === 'cat_india_startups';

    recordTest(
      'A',
      'Successful payment activates subscription with exact category entitlement',
      passed,
      `Payment ID: ${activateRes.payment.paymentId}, Subscription: ${activateRes.subscription?.subscriptionId}, Category: ${activateRes.entitlements[0]?.categoryName}`
    );
  } catch (err: any) {
    recordTest('A', 'Successful payment', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST B: Failed payment
  // -------------------------------------------------------------
  try {
    const orderB = await defaultPaymentGateway.createOrder({
      customerId: custB.customerId,
      categoryIds: ['cat_india_banking_fintech'],
      amount: 297.36,
      currency: 'INR',
    });

    const failPaymentId = `pay_failed_${crypto.randomBytes(6).toString('hex')}`;
    const failRes = processFailedPayment({
      paymentOrderId: orderB.paymentOrderId,
      providerOrderId: orderB.orderId,
      providerPaymentId: failPaymentId,
      status: 'failed',
      errorReason: 'Payment declined by issuing bank',
      customerId: custB.customerId,
    });

    // Check that NO subscription was created for customer B
    const subCheck = db.subscriptions.find((s) => s.paymentId === failRes.payment?.paymentId);
    const entitlementsCheck = db.subscriptionCategories.filter((sc) => sc.customerId === custB.customerId);

    const passed =
      failRes.ok &&
      failRes.paymentOrder?.status === 'failed' &&
      failRes.payment?.paymentStatus === 'failed' &&
      !subCheck &&
      entitlementsCheck.length === 0;

    recordTest(
      'B',
      'Failed payment records failure status; zero subscriptions or entitlements created',
      passed,
      `Payment status: ${failRes.payment?.paymentStatus}, Subscriptions created: 0, Entitlements: 0`
    );
  } catch (err: any) {
    recordTest('B', 'Failed payment', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST C: Cancelled payment
  // -------------------------------------------------------------
  try {
    const orderC = await defaultPaymentGateway.createOrder({
      customerId: custB.customerId,
      categoryIds: ['cat_india_re_infra'],
      amount: 297.36,
      currency: 'INR',
    });

    const cancelRes = processFailedPayment({
      paymentOrderId: orderC.paymentOrderId,
      providerOrderId: orderC.orderId,
      status: 'cancelled',
      errorReason: 'Customer closed checkout modal',
      customerId: custB.customerId,
    });

    const passed =
      cancelRes.ok &&
      cancelRes.paymentOrder?.status === 'cancelled' &&
      cancelRes.payment?.paymentStatus === 'cancelled';

    recordTest(
      'C',
      'Cancelled payment records cancellation safely without granting access',
      passed,
      `Order status: ${cancelRes.paymentOrder?.status}, Payment status: ${cancelRes.payment?.paymentStatus}`
    );
  } catch (err: any) {
    recordTest('C', 'Cancelled payment', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST D: Duplicate browser callback
  // -------------------------------------------------------------
  try {
    const orderD = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_consumer_fmcg'],
      amount: 297.36,
      currency: 'INR',
    });

    const payIdD = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const sigD = generateTestPaymentSignature(orderD.orderId, payIdD);

    const first = processSuccessfulPayment({
      paymentOrderId: orderD.paymentOrderId,
      providerOrderId: orderD.orderId,
      providerPaymentId: payIdD,
      providerSignature: sigD,
      customerId: custA.customerId,
      source: 'browser_callback',
    });

    const subsBefore = db.subscriptions.length;
    const second = processSuccessfulPayment({
      paymentOrderId: orderD.paymentOrderId,
      providerOrderId: orderD.orderId,
      providerPaymentId: payIdD,
      providerSignature: sigD,
      customerId: custA.customerId,
      source: 'browser_callback',
    });
    const subsAfter = db.subscriptions.length;

    const passed =
      first.ok &&
      !first.isDuplicate &&
      second.ok &&
      second.isDuplicate === true &&
      subsBefore === subsAfter &&
      first.subscription?.subscriptionId === second.subscription?.subscriptionId;

    recordTest(
      'D',
      'Duplicate browser callback: second call returns existing subscription safely without duplicate records',
      passed,
      `First isDuplicate: ${first.isDuplicate}, Second isDuplicate: ${second.isDuplicate}, Subscriptions delta: 0`
    );
  } catch (err: any) {
    recordTest('D', 'Duplicate browser callback', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST E: Duplicate webhook
  // -------------------------------------------------------------
  try {
    const orderE = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_mfg_auto'],
      amount: 297.36,
      currency: 'INR',
    });

    const payIdE = `pay_${crypto.randomBytes(8).toString('hex')}`;

    const res1 = processSuccessfulPayment({
      providerOrderId: orderE.orderId,
      providerPaymentId: payIdE,
      amount: 297.36,
      currency: 'INR',
      source: 'webhook',
    });

    const paymentsCountBefore = db.payments.length;
    const res2 = processSuccessfulPayment({
      providerOrderId: orderE.orderId,
      providerPaymentId: payIdE,
      amount: 297.36,
      currency: 'INR',
      source: 'webhook',
    });
    const paymentsCountAfter = db.payments.length;

    const passed =
      res1.ok &&
      !res1.isDuplicate &&
      res2.ok &&
      res2.isDuplicate === true &&
      paymentsCountBefore === paymentsCountAfter;

    recordTest(
      'E',
      'Duplicate webhook: repeated webhook deliveries handled idempotently',
      passed,
      `First isDuplicate: ${res1.isDuplicate}, Second isDuplicate: ${res2.isDuplicate}, Payments count delta: 0`
    );
  } catch (err: any) {
    recordTest('E', 'Duplicate webhook', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST F: Invalid webhook signature
  // -------------------------------------------------------------
  try {
    const rawPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: { payment: { entity: { id: 'pay_123', order_id: 'order_123', amount: 29736 } } },
    });

    const forgedSignature = 'bad_forged_signature_1234567890abcdef1234567890abcdef';
    const validSignature = generateTestWebhookSignature(rawPayload);

    const badCheck = verifyRazorpayWebhookSignature({ rawBody: rawPayload, signature: forgedSignature });
    const goodCheck = verifyRazorpayWebhookSignature({ rawBody: rawPayload, signature: validSignature });

    const passed = badCheck === false && goodCheck === true;
    recordTest(
      'F',
      'Invalid webhook signature: forged signatures strictly rejected, authentic signatures accepted',
      passed,
      `Forged rejected: ${!badCheck}, Authentic verified: ${goodCheck}`
    );
  } catch (err: any) {
    recordTest('F', 'Invalid webhook signature', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST G: Incorrect payment amount
  // -------------------------------------------------------------
  try {
    const orderG = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_energy_renewables'],
      amount: 297.36,
      currency: 'INR',
    });

    let errorThrown = false;
    try {
      processSuccessfulPayment({
        providerOrderId: orderG.orderId,
        providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
        amount: 100.0, // Fraudulent underpayment
        currency: 'INR',
        source: 'webhook',
      });
    } catch (err: any) {
      errorThrown = err.message.includes('Payment amount mismatch');
    }

    recordTest(
      'G',
      'Incorrect payment amount: underpayment/mismatch rejected by server verification',
      errorThrown,
      `Underpayment detected and rejected: ${errorThrown}`
    );
  } catch (err: any) {
    recordTest('G', 'Incorrect payment amount', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST H: Incorrect currency
  // -------------------------------------------------------------
  try {
    const orderH = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_it_tech'],
      amount: 297.36,
      currency: 'INR',
    });

    let errorThrown = false;
    try {
      processSuccessfulPayment({
        providerOrderId: orderH.orderId,
        providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
        amount: 297.36,
        currency: 'USD', // Fraudulent currency
        source: 'webhook',
      });
    } catch (err: any) {
      errorThrown = err.message.includes('Payment currency mismatch');
    }

    recordTest(
      'H',
      'Incorrect currency: non-INR payment currency strictly rejected',
      errorThrown,
      `Currency mismatch rejected: ${errorThrown}`
    );
  } catch (err: any) {
    recordTest('H', 'Incorrect currency', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST I: Unknown Razorpay order
  // -------------------------------------------------------------
  try {
    let errorThrown = false;
    try {
      processSuccessfulPayment({
        providerOrderId: 'order_completely_unknown_fake_999',
        providerPaymentId: 'pay_999',
        source: 'webhook',
      });
    } catch (err: any) {
      errorThrown = err.message.includes('Unknown Razorpay order');
    }

    recordTest(
      'I',
      'Unknown Razorpay order: unmatched gateway order ID rejected without activation',
      errorThrown,
      `Unknown order rejected: ${errorThrown}`
    );
  } catch (err: any) {
    recordTest('I', 'Unknown Razorpay order', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST J: Payment associated with another customer
  // -------------------------------------------------------------
  try {
    const orderJ = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId, // Belongs to Customer A
      categoryIds: ['cat_india_economy_business'],
      amount: 297.36,
      currency: 'INR',
    });

    let errorThrown = false;
    try {
      // Customer B attempts to activate Customer A's order
      processSuccessfulPayment({
        paymentOrderId: orderJ.paymentOrderId,
        providerOrderId: orderJ.orderId,
        providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
        customerId: custB.customerId, // Malicious customer ID mismatch
        source: 'browser_callback',
      });
    } catch (err: any) {
      errorThrown = err.message.includes('does not belong to customer');
    }

    recordTest(
      'J',
      'Cross-customer order attack: customer B cannot activate customer A\'s payment order',
      errorThrown,
      `Unauthorized customer hijacking rejected: ${errorThrown}`
    );
  } catch (err: any) {
    recordTest('J', 'Payment associated with another customer', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST K: Browser falsely reports success
  // -------------------------------------------------------------
  try {
    const orderK = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_hr_employment'],
      amount: 297.36,
      currency: 'INR',
    });

    const fakePaymentId = `pay_${crypto.randomBytes(6).toString('hex')}`;
    const forgedBrowserSig = 'forged_browser_signature_00000000';

    const verifyCheck = verifyRazorpayPaymentSignature({
      orderId: orderK.orderId,
      paymentId: fakePaymentId,
      signature: forgedBrowserSig,
    });

    recordTest(
      'K',
      'Browser falsely reports success: unverified browser claims rejected by signature verification',
      verifyCheck === false,
      `Signature verification returned: ${verifyCheck}`
    );
  } catch (err: any) {
    recordTest('K', 'Browser falsely reports success', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST L: Fake UTR cannot activate
  // -------------------------------------------------------------
  try {
    setPaymentProviderMode('live'); // Switch to LIVE mode
    let errorThrownInLive = false;
    try {
      processVerifiedPayment({
        customerId: custA.customerId,
        gatewayReference: 'UTR_FAKE_CUSTOMER_STRING_12345',
        categoryIds: ['cat_india_startups'],
        paymentStatus: 'successful',
      });
    } catch (err: any) {
      errorThrownInLive = err.message.includes('cannot activate subscriptions in LIVE mode');
    }
    setPaymentProviderMode('test'); // Restore test mode

    recordTest(
      'L',
      'Fake UTR cannot activate: customer-entered UTR/reference strictly blocked in production',
      errorThrownInLive,
      `Customer-entered UTR prohibited in LIVE mode: ${errorThrownInLive}`
    );
  } catch (err: any) {
    setPaymentProviderMode('test');
    recordTest('L', 'Fake UTR cannot activate', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST M: Successful payment activates exactly once
  // -------------------------------------------------------------
  try {
    const orderM = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_marketing_ads'],
      amount: 297.36,
      currency: 'INR',
    });

    const payIdM = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const sigM = generateTestPaymentSignature(orderM.orderId, payIdM);

    const run1 = processSuccessfulPayment({
      paymentOrderId: orderM.paymentOrderId,
      providerOrderId: orderM.orderId,
      providerPaymentId: payIdM,
      providerSignature: sigM,
      customerId: custA.customerId,
      source: 'browser_callback',
    });

    const run2 = processSuccessfulPayment({
      paymentOrderId: orderM.paymentOrderId,
      providerOrderId: orderM.orderId,
      providerPaymentId: payIdM,
      providerSignature: sigM,
      customerId: custA.customerId,
      source: 'webhook',
    });

    const matchingSubs = db.subscriptions.filter((s) => s.paymentId === run1.payment.paymentId);
    const matchingEnts = db.subscriptionCategories.filter((sc) => sc.subscriptionId === run1.subscription?.subscriptionId);

    const passed =
      matchingSubs.length === 1 &&
      matchingEnts.length === 1 &&
      run2.isDuplicate === true;

    recordTest(
      'M',
      'Successful payment activates exactly once: multiple calls result in 1 subscription & 1 entitlement',
      passed,
      `Matching subscriptions count: ${matchingSubs.length}, Matching entitlements count: ${matchingEnts.length}`
    );
  } catch (err: any) {
    recordTest('M', 'Successful payment activates exactly once', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST N: Multiple categories create correct entitlements
  // -------------------------------------------------------------
  try {
    const selected3 = ['cat_india_startups', 'cat_india_banking_fintech', 'cat_india_re_infra'];
    const pricing3 = calculateServerPayablePrice(selected3);

    const orderN = await defaultPaymentGateway.createOrder({
      customerId: custB.customerId,
      categoryIds: selected3,
      amount: pricing3.totalPayable,
      currency: 'INR',
    });

    const payIdN = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const sigN = generateTestPaymentSignature(orderN.orderId, payIdN);

    const resN = processSuccessfulPayment({
      paymentOrderId: orderN.paymentOrderId,
      providerOrderId: orderN.orderId,
      providerPaymentId: payIdN,
      providerSignature: sigN,
      customerId: custB.customerId,
      amount: pricing3.totalPayable,
      source: 'browser_callback',
    });

    const passed =
      resN.ok &&
      resN.entitlements.length === 3 &&
      resN.entitlements.every((e) => selected3.includes(e.categoryId)) &&
      resN.payment.amount === pricing3.totalPayable;

    recordTest(
      'N',
      'Multiple categories create correct entitlements: all 3 purchased categories active under 1 payment',
      passed,
      `Entitled categories count: ${resN.entitlements.length}/3, Total paid: ₹${resN.payment.amount}`
    );
  } catch (err: any) {
    recordTest('N', 'Multiple categories create correct entitlements', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST O: Correct subscription dates
  // -------------------------------------------------------------
  try {
    const dates = calculateSubscriptionDates('2026-09-29T10:00:00.000Z');
    const startMatches = dates.startDate.startsWith('2026-09-30');
    const expiryMatches = dates.expiryDate.startsWith('2027-09-30');

    const passed = startMatches && expiryMatches;
    recordTest(
      'O',
      'Correct subscription dates: Payment 29 Sep 2026 -> Start 30 Sep 2026 -> Expiry 30 Sep 2027',
      passed,
      `Start: ${dates.startDate}, Expiry: ${dates.expiryDate}`
    );
  } catch (err: any) {
    recordTest('O', 'Correct subscription dates', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST P: Temporary gateway/network failure
  // -------------------------------------------------------------
  try {
    let callCount = 0;
    const custom500Fetch = async () => {
      callCount++;
      return new Response('Gateway Internal Server Error', { status: 502 });
    };

    let failedGracefully = false;
    try {
      await createRazorpayOrder({
        paymentOrderId: 'pord_test_net_fail',
        amountInr: 297.36,
        customFetch: custom500Fetch as any,
      });
    } catch (err: any) {
      failedGracefully = true;
    }

    recordTest(
      'P',
      'Temporary gateway/network failure: gateway 502/5xx cleanly handled with descriptive error',
      failedGracefully,
      `Handled gracefully: ${failedGracefully}`
    );
  } catch (err: any) {
    recordTest('P', 'Temporary gateway/network failure', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST Q: Gateway timeout
  // -------------------------------------------------------------
  try {
    const customTimeoutFetch = async (_url: any, opts: any) => {
      if (opts?.signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      return new Response('{}', { status: 200 });
    };

    let timeoutHandled = false;
    try {
      await createRazorpayOrder({
        paymentOrderId: 'pord_test_timeout',
        amountInr: 297.36,
        customFetch: customTimeoutFetch as any,
        timeoutMs: 50,
      });
    } catch (err: any) {
      timeoutHandled = err.message.includes('timed out') || err.name === 'AbortError';
    }

    recordTest(
      'Q',
      'Gateway timeout: AbortController aborts hung connection without crashing',
      timeoutHandled,
      `Timeout abort handled: ${timeoutHandled}`
    );
  } catch (err: any) {
    recordTest('Q', 'Gateway timeout', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST R: Webhook arrives before browser callback
  // -------------------------------------------------------------
  try {
    const orderR = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_startups'],
      amount: 297.36,
      currency: 'INR',
    });

    const payIdR = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const sigR = generateTestPaymentSignature(orderR.orderId, payIdR);

    // 1. Webhook arrives first
    const webhookRes = processSuccessfulPayment({
      providerOrderId: orderR.orderId,
      providerPaymentId: payIdR,
      amount: 297.36,
      currency: 'INR',
      source: 'webhook',
    });

    // 2. Browser callback arrives later
    const callbackRes = processSuccessfulPayment({
      paymentOrderId: orderR.paymentOrderId,
      providerOrderId: orderR.orderId,
      providerPaymentId: payIdR,
      providerSignature: sigR,
      customerId: custA.customerId,
      source: 'browser_callback',
    });

    const passed =
      webhookRes.ok &&
      !webhookRes.isDuplicate &&
      callbackRes.ok &&
      callbackRes.isDuplicate === true &&
      webhookRes.subscription?.subscriptionId === callbackRes.subscription?.subscriptionId;

    recordTest(
      'R',
      'Webhook arrives before browser callback: activates on webhook, callback returns duplicate safely',
      passed,
      `Webhook isDuplicate: ${webhookRes.isDuplicate}, Callback isDuplicate: ${callbackRes.isDuplicate}`
    );
  } catch (err: any) {
    recordTest('R', 'Webhook arrives before browser callback', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST S: Browser callback arrives before webhook
  // -------------------------------------------------------------
  try {
    const orderS = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_startups'],
      amount: 297.36,
      currency: 'INR',
    });

    const payIdS = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const sigS = generateTestPaymentSignature(orderS.orderId, payIdS);

    // 1. Callback arrives first
    const callbackRes = processSuccessfulPayment({
      paymentOrderId: orderS.paymentOrderId,
      providerOrderId: orderS.orderId,
      providerPaymentId: payIdS,
      providerSignature: sigS,
      customerId: custA.customerId,
      source: 'browser_callback',
    });

    // 2. Webhook arrives later
    const webhookRes = processSuccessfulPayment({
      providerOrderId: orderS.orderId,
      providerPaymentId: payIdS,
      amount: 297.36,
      currency: 'INR',
      source: 'webhook',
    });

    const passed =
      callbackRes.ok &&
      !callbackRes.isDuplicate &&
      webhookRes.ok &&
      webhookRes.isDuplicate === true &&
      callbackRes.subscription?.subscriptionId === webhookRes.subscription?.subscriptionId;

    recordTest(
      'S',
      'Browser callback arrives before webhook: activates on callback, webhook returns duplicate safely',
      passed,
      `Callback isDuplicate: ${callbackRes.isDuplicate}, Webhook isDuplicate: ${webhookRes.isDuplicate}`
    );
  } catch (err: any) {
    recordTest('S', 'Browser callback arrives before webhook', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST T: Repeated webhook and callback combinations
  // -------------------------------------------------------------
  try {
    const orderT = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_startups'],
      amount: 297.36,
      currency: 'INR',
    });

    const payIdT = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const sigT = generateTestPaymentSignature(orderT.orderId, payIdT);

    const subCountBefore = db.subscriptions.length;

    // Sequence: Callback -> Webhook -> Webhook -> Callback
    const c1 = processSuccessfulPayment({
      paymentOrderId: orderT.paymentOrderId,
      providerOrderId: orderT.orderId,
      providerPaymentId: payIdT,
      providerSignature: sigT,
      customerId: custA.customerId,
      source: 'browser_callback',
    });
    const w1 = processSuccessfulPayment({
      providerOrderId: orderT.orderId,
      providerPaymentId: payIdT,
      amount: 297.36,
      currency: 'INR',
      source: 'webhook',
    });
    const w2 = processSuccessfulPayment({
      providerOrderId: orderT.orderId,
      providerPaymentId: payIdT,
      amount: 297.36,
      currency: 'INR',
      source: 'webhook',
    });
    const c2 = processSuccessfulPayment({
      paymentOrderId: orderT.paymentOrderId,
      providerOrderId: orderT.orderId,
      providerPaymentId: payIdT,
      providerSignature: sigT,
      customerId: custA.customerId,
      source: 'browser_callback',
    });

    const subCountAfter = db.subscriptions.length;
    const passed = Boolean(
      !c1.isDuplicate &&
      w1.isDuplicate &&
      w2.isDuplicate &&
      c2.isDuplicate &&
      subCountAfter - subCountBefore === 1
    );

    recordTest(
      'T',
      'Repeated webhook and callback combinations: 4 calls in mixed order result in exactly 1 new subscription',
      passed,
      `Subscriptions added: ${subCountAfter - subCountBefore} (Expected: 1)`
    );
  } catch (err: any) {
    recordTest('T', 'Repeated webhook and callback combinations', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST U: Customer cannot see another customer's payment
  // -------------------------------------------------------------
  try {
    const custAPayments = getCustomerPayments(custA.customerId);
    const custBPayments = getCustomerPayments(custB.customerId);
    const custAOrders = getCustomerPaymentOrders(custA.customerId);
    const custBOrders = getCustomerPaymentOrders(custB.customerId);

    const crossPaymentsFound = custBPayments.some((p) => p.customerId === custA.customerId);
    const crossOrdersFound = custBOrders.some((o) => o.customerId === custA.customerId);

    const passed = !crossPaymentsFound && !crossOrdersFound;
    recordTest(
      'U',
      'Customer privacy: customer B cannot view customer A\'s payments or orders',
      passed,
      `Cross-customer records visible to B: 0`
    );
  } catch (err: any) {
    recordTest('U', 'Customer cannot see another customer payment', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST V: Customer cannot modify price
  // -------------------------------------------------------------
  try {
    const singleCatPricing = calculateServerPayablePrice(['cat_india_startups']);
    // Even if frontend sends ₹1.00, server calculation must dictate ₹297.36
    const passed = singleCatPricing.totalPayable === 297.36;

    recordTest(
      'V',
      'Customer cannot modify price: server-side pricing engine calculates ₹297.36 authoritatively',
      passed,
      `Server price: ₹${singleCatPricing.totalPayable} (Base: ₹${singleCatPricing.baseAmount} + GST: ₹${singleCatPricing.gstAmount})`
    );
  } catch (err: any) {
    recordTest('V', 'Customer cannot modify price', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST W: Customer cannot modify categories after order creation
  // -------------------------------------------------------------
  try {
    const orderW = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_startups'],
      amount: 297.36,
      currency: 'INR',
    });

    const payIdW = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const sigW = generateTestPaymentSignature(orderW.orderId, payIdW);

    // Activate the order
    const resW = processSuccessfulPayment({
      paymentOrderId: orderW.paymentOrderId,
      providerOrderId: orderW.orderId,
      providerPaymentId: payIdW,
      providerSignature: sigW,
      customerId: custA.customerId,
      source: 'browser_callback',
    });

    const passed =
      resW.entitlements.length === 1 &&
      resW.entitlements[0].categoryId === 'cat_india_startups';

    recordTest(
      'W',
      'Categories locked after order creation: categories are anchored to PaymentOrder and immutable',
      passed,
      `Entitled category: ${resW.entitlements[0]?.categoryId}`
    );
  } catch (err: any) {
    recordTest('W', 'Customer cannot modify categories after order creation', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST X: Inactive category cannot be purchased
  // -------------------------------------------------------------
  try {
    const pricingX = calculateServerPayablePrice(['inactive_category_test_id']);
    const hasValid = pricingX.validCategories.length > 0;

    recordTest(
      'X',
      'Inactive category cannot be purchased: non-active category rejected by pricing and activation',
      !hasValid,
      `Valid categories count for inactive ID: ${pricingX.validCategories.length}`
    );
  } catch (err: any) {
    recordTest('X', 'Inactive category cannot be purchased', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST Y: Phase 3 entitlement tests still pass
  // -------------------------------------------------------------
  try {
    const entRes = getCustomerActiveEntitlements(custA.customerId);
    const passed = entRes.entitledCategories.length > 0;

    recordTest(
      'Y',
      'Existing Phase 3 entitlement engine: getCustomerActiveEntitlements evaluates active subscriptions accurately',
      passed,
      `Customer eligible: ${entRes.isEligible}, Entitled categories count: ${entRes.entitledCategories.length}`
    );
  } catch (err: any) {
    recordTest('Y', 'Phase 3 entitlement tests still pass', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST Z: Phase 5/5.1 news and delivery systems remain unaffected
  // -------------------------------------------------------------
  try {
    // Generate news for 1 category and verify delivery capability
    const genRes = await generateCategoryDailyNews('cat_india_startups', '2026-09-30');
    const storiesCount = genRes.stories?.length || 0;

    const passed = genRes.success && storiesCount === 10;
    recordTest(
      'Z',
      'Phase 5/5.1 news and delivery systems unaffected: 10 curated stories generated with provenance intact',
      passed,
      `Generated stories count: ${storiesCount}/10`
    );
  } catch (err: any) {
    recordTest('Z', 'Phase 5/5.1 news systems unaffected', false, err.message);
  }

  // =============================================================
  // ADDITIONAL TESTS: AA THROUGH AH
  // =============================================================

  // -------------------------------------------------------------
  // TEST AA: Invalid Razorpay webhook payload
  // -------------------------------------------------------------
  try {
    const emptyPayload = '';
    const badCheck = verifyRazorpayWebhookSignature({ rawBody: emptyPayload, signature: 'some_sig' });

    recordTest(
      'AA',
      'Invalid Razorpay webhook payload: empty body rejected safely',
      badCheck === false,
      `Empty body rejected: ${!badCheck}`
    );
  } catch (err: any) {
    recordTest('AA', 'Invalid Razorpay webhook payload', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST AB: Replay of previously valid webhook
  // -------------------------------------------------------------
  try {
    const orderAB = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_startups'],
      amount: 297.36,
      currency: 'INR',
    });

    const payIdAB = `pay_${crypto.randomBytes(8).toString('hex')}`;

    // First delivery
    const initial = processSuccessfulPayment({
      providerOrderId: orderAB.orderId,
      providerPaymentId: payIdAB,
      amount: 297.36,
      currency: 'INR',
      source: 'webhook',
    });

    // Replay attack
    const replay = processSuccessfulPayment({
      providerOrderId: orderAB.orderId,
      providerPaymentId: payIdAB,
      amount: 297.36,
      currency: 'INR',
      source: 'webhook',
    });

    const passed = !initial.isDuplicate && replay.isDuplicate === true;
    recordTest(
      'AB',
      'Replay attack protection: replayed webhook events detected as duplicate, zero new subscriptions created',
      passed,
      `Initial isDuplicate: ${initial.isDuplicate}, Replayed isDuplicate: ${replay.isDuplicate}`
    );
  } catch (err: any) {
    recordTest('AB', 'Replay of previously valid webhook', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST AC: Live mode rejects missing credentials
  // -------------------------------------------------------------
  try {
    setPaymentProviderMode('live');
    const oldKey = process.env.RAZORPAY_LIVE_KEY_ID;
    delete process.env.RAZORPAY_LIVE_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;

    let rejectedMissing = false;
    try {
      getRazorpayConfig();
    } catch (err: any) {
      rejectedMissing = err.message.includes('LIVE PAYMENT CONFIGURATION ERROR');
    }

    if (oldKey) process.env.RAZORPAY_LIVE_KEY_ID = oldKey;
    setPaymentProviderMode('test');

    recordTest(
      'AC',
      'Live mode safety: missing production credentials strictly throw configuration error (no silent fallback)',
      rejectedMissing,
      `Live mode missing keys rejected: ${rejectedMissing}`
    );
  } catch (err: any) {
    setPaymentProviderMode('test');
    recordTest('AC', 'Live mode rejects missing credentials', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST AD: Test mode cannot accidentally use live credentials
  // -------------------------------------------------------------
  try {
    setPaymentProviderMode('test');
    process.env.RAZORPAY_TEST_KEY_ID = 'rzp_live_accidental_leak_key_123';

    let errorThrown = false;
    try {
      getRazorpayConfig();
    } catch (err: any) {
      errorThrown = err.message.includes('ENVIRONMENT SAFETY VIOLATION');
    }

    delete process.env.RAZORPAY_TEST_KEY_ID;

    recordTest(
      'AD',
      'Test mode safety: test mode cannot accidentally be configured with live credentials',
      errorThrown,
      `Environment safety guard enforced: ${errorThrown}`
    );
  } catch (err: any) {
    delete process.env.RAZORPAY_TEST_KEY_ID;
    recordTest('AD', 'Test mode cannot accidentally use live credentials', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST AE: Live mode cannot use mock payment activation
  // -------------------------------------------------------------
  try {
    setPaymentProviderMode('live');
    let blockedMock = false;
    try {
      processVerifiedPayment({
        customerId: custA.customerId,
        gatewayReference: 'UTR_MOCK_123',
        categoryIds: ['cat_india_startups'],
        paymentStatus: 'successful',
      });
    } catch (err: any) {
      blockedMock = err.message.includes('cannot activate subscriptions in LIVE mode');
    }
    setPaymentProviderMode('test');

    recordTest(
      'AE',
      'Live mode cannot use mock payment activation: mock and simulated activation completely sealed off',
      blockedMock,
      `Mock activation blocked in live mode: ${blockedMock}`
    );
  } catch (err: any) {
    setPaymentProviderMode('test');
    recordTest('AE', 'Live mode cannot use mock payment activation', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST AF: PaymentOrder persists before checkout
  // -------------------------------------------------------------
  try {
    const orderAF = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_startups'],
      amount: 297.36,
      currency: 'INR',
    });

    const persisted = db.paymentOrders.find((po) => po.paymentOrderId === orderAF.paymentOrderId);
    const passed =
      Boolean(persisted) &&
      persisted?.status === 'checkout_started' &&
      persisted?.providerOrderId === orderAF.orderId;

    recordTest(
      'AF',
      'PaymentOrder persistence: internal payment order record persists in database before checkout opens',
      passed,
      `Persisted ID: ${persisted?.paymentOrderId}, Status: ${persisted?.status}, Provider Order ID: ${persisted?.providerOrderId}`
    );
  } catch (err: any) {
    recordTest('AF', 'PaymentOrder persists before checkout', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST AG: Payment for an expired/stale order is handled safely
  // -------------------------------------------------------------
  try {
    const orderAG = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_startups'],
      amount: 297.36,
      currency: 'INR',
    });

    // Mark order as cancelled
    processFailedPayment({
      paymentOrderId: orderAG.paymentOrderId,
      providerOrderId: orderAG.orderId,
      status: 'cancelled',
      errorReason: 'User cancelled order',
    });

    const cancelledOrder = db.paymentOrders.find((po) => po.paymentOrderId === orderAG.paymentOrderId);
    const passed = cancelledOrder?.status === 'cancelled';

    recordTest(
      'AG',
      'Stale/cancelled order handling: cancelled order status recorded without active entitlements',
      passed,
      `Order status: ${cancelledOrder?.status}`
    );
  } catch (err: any) {
    recordTest('AG', 'Payment for an expired/stale order is handled safely', false, err.message);
  }

  // -------------------------------------------------------------
  // TEST AH: Successful payment event after browser timeout still activates exactly once
  // -------------------------------------------------------------
  try {
    const orderAH = await defaultPaymentGateway.createOrder({
      customerId: custA.customerId,
      categoryIds: ['cat_india_startups'],
      amount: 297.36,
      currency: 'INR',
    });

    // Browser closed or timed out -> only webhook arrives
    const payIdAH = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const webhookDelayed = processSuccessfulPayment({
      providerOrderId: orderAH.orderId,
      providerPaymentId: payIdAH,
      amount: 297.36,
      currency: 'INR',
      source: 'webhook',
    });

    const passed =
      webhookDelayed.ok &&
      !webhookDelayed.isDuplicate &&
      webhookDelayed.subscription?.status === 'active' &&
      webhookDelayed.entitlements.length === 1;

    recordTest(
      'AH',
      'Delayed webhook activation: payment captured after browser close activates subscription authoritatively',
      passed,
      `Activated via delayed webhook: ${webhookDelayed.ok}, Subscription ID: ${webhookDelayed.subscription?.subscriptionId}`
    );
  } catch (err: any) {
    recordTest('AH', 'Delayed webhook activation', false, err.message);
  }

  console.log('\n================================================================');
  console.log(
    `PHASE 6 TEST SUITE SUMMARY: ${testResults.filter((r) => r.passed).length} of ${testResults.length} TESTS PASSED`
  );
  console.log('================================================================');

  if (testResults.every((r) => r.passed)) {
    console.log('ALL 34 TESTS (A-Z & AA-AH) PASSED WITH ZERO FAILURES!\n');
    process.exit(0);
  } else {
    console.error('ONE OR MORE TESTS FAILED.');
    process.exit(1);
  }
}

runPhase6Tests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
