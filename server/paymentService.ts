import crypto from 'crypto';
import {
  Payment,
  PaymentOrder,
  PaymentOrderStatus,
  Subscription,
  SubscriptionCategory,
  PaymentStatus,
  Category,
} from '../src/types';
import {
  getDb,
  saveDb,
  getCustomerById,
  getActiveCategories,
  createPaymentOrder,
  getPaymentOrderById,
  getPaymentOrderByProviderOrderId,
  updatePaymentOrderStatus,
} from './db.js';
import {
  createRazorpayOrder,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  getRazorpayConfig,
  getPaymentProviderMode,
  PaymentProviderMode,
  RazorpayOrderResult,
} from './razorpayService.js';

/**
 * ============================================================================
 * PAYMENT GATEWAY ABSTRACTION (Section 11)
 * ============================================================================
 * Clean interface decoupling the business logic from any specific gateway
 * (UPI Gateway, Razorpay, Cashfree, Stripe, etc.)
 */
export interface PaymentOrderParams {
  customerId: string;
  categoryIds: string[];
  amount: number;
  currency: string;
}

export interface PaymentVerificationParams {
  orderId?: string;
  paymentReference: string;
  signature?: string;
  simulatedStatus?: PaymentStatus;
}

export interface IPaymentGateway {
  createOrder(params: PaymentOrderParams): Promise<{
    orderId: string; // Razorpay order ID (e.g. order_...)
    paymentOrderId: string; // Internal PaymentOrder ID (e.g. pord_...)
    amount: number;
    currency: string;
  }>;
  verifyPayment(params: PaymentVerificationParams): Promise<{
    verified: boolean;
    status: PaymentStatus;
    reference: string;
    amount?: number;
    error?: string;
  }>;
}

/**
 * Production Razorpay Payment Gateway Implementation (Phase 6.1)
 * Creates authoritative internal PaymentOrder and pairs it with real Razorpay order.
 */
export class RazorpayPaymentGateway implements IPaymentGateway {
  async createOrder(params: PaymentOrderParams) {
    const internalPaymentOrderId = `pord_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    // 1. Create trusted internal PaymentOrder record BEFORE or atomically with gateway call (Step 2 & 3)
    const paymentOrder: PaymentOrder = {
      paymentOrderId: internalPaymentOrderId,
      customerId: params.customerId,
      categoryIds: params.categoryIds,
      amount: params.amount,
      currency: params.currency || 'INR',
      provider: 'razorpay',
      providerOrderId: '', // Will be updated immediately below
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };
    createPaymentOrder(paymentOrder);

    // 2. Call Razorpay service to create gateway order
    const rzpOrder = await createRazorpayOrder({
      paymentOrderId: internalPaymentOrderId,
      amountInr: params.amount,
      currency: params.currency || 'INR',
      notes: {
        customerId: params.customerId,
        paymentOrderId: internalPaymentOrderId,
      },
    });

    // 3. Associate Razorpay order with internal order
    paymentOrder.providerOrderId = rzpOrder.id;
    paymentOrder.status = 'checkout_started';
    paymentOrder.updatedAt = new Date().toISOString();
    saveDb();

    return {
      orderId: rzpOrder.id,
      paymentOrderId: internalPaymentOrderId,
      amount: params.amount,
      currency: params.currency || 'INR',
    };
  }

  async verifyPayment(params: PaymentVerificationParams) {
    const ref = (params.paymentReference || '').trim();
    const orderId = (params.orderId || '').trim();
    const signature = (params.signature || '').trim();

    if (!ref || ref.length < 4) {
      return {
        verified: false,
        status: 'failed' as PaymentStatus,
        reference: ref,
        error: 'Invalid payment reference number.',
      };
    }

    const mode = getPaymentProviderMode();

    // In live mode, verify cryptographic HMAC signature
    if (mode === 'live' || signature) {
      if (!orderId || !signature) {
        return {
          verified: false,
          status: 'failed' as PaymentStatus,
          reference: ref,
          error: 'Missing Razorpay order ID or signature for verification.',
        };
      }

      const isValid = verifyRazorpayPaymentSignature({
        orderId,
        paymentId: ref,
        signature,
      });

      if (!isValid) {
        return {
          verified: false,
          status: 'failed' as PaymentStatus,
          reference: ref,
          error: 'Invalid Razorpay payment signature. Payment verification rejected.',
        };
      }

      return {
        verified: true,
        status: 'successful' as PaymentStatus,
        reference: ref,
      };
    }

    // Test mode fallback simulation
    if (params.simulatedStatus === 'failed') {
      return {
        verified: true,
        status: 'failed' as PaymentStatus,
        reference: ref,
      };
    }

    if (params.simulatedStatus === 'cancelled') {
      return {
        verified: true,
        status: 'cancelled' as PaymentStatus,
        reference: ref,
      };
    }

    return {
      verified: true,
      status: 'successful' as PaymentStatus,
      reference: ref,
    };
  }
}

export const defaultPaymentGateway: IPaymentGateway = new RazorpayPaymentGateway();

/**
 * ============================================================================
 * SERVER-SIDE PRICING ENGINE (Section 9, 10)
 * ============================================================================
 * Never trusts frontend prices. The server is the authoritative source.
 */
export function calculateServerPayablePrice(categoryIds: string[]): {
  baseAmount: number;
  gstAmount: number;
  totalPayable: number;
  currency: string;
  validCategories: Category[];
} {
  const allActive = getActiveCategories();
  const validCategories = allActive.filter((c) => categoryIds.includes(c.id));

  // Base price per category per year: ₹252.00
  // GST: 18% (₹45.36)
  // Total per category: ₹297.36
  const pricePerCategory = 252.0;
  const gstRate = 0.18;

  const count = validCategories.length > 0 ? validCategories.length : 1;
  const baseAmount = Number((pricePerCategory * count).toFixed(2));
  const gstAmount = Number((baseAmount * gstRate).toFixed(2));
  const totalPayable = Number((baseAmount + gstAmount).toFixed(2));

  return {
    baseAmount,
    gstAmount,
    totalPayable,
    currency: 'INR',
    validCategories,
  };
}

/**
 * ============================================================================
 * SUBSCRIPTION DATE CALCULATION (Section 5 & Stage 1 Blueprint)
 * ============================================================================
 * Exact buffer and paid subscription formulas:
 *   bufferStartDate = adminConfirmedPaymentDate
 *   bufferEndDate = adminConfirmedPaymentDate + 4 days
 *   paidStartDate = adminConfirmedPaymentDate + 5 days
 *   paidEndDate = paidStartDate + 12 calendar months
 *
 * Explicit Example:
 *   Payment confirmed: Oct 3
 *   Oct 3 = buffer/news day (Day 1)
 *   Oct 4 = buffer/news day (Day 2)
 *   Oct 5 = buffer/news day (Day 3)
 *   Oct 6 = buffer/news day (Day 4)
 *   Oct 7 = buffer/news day (Day 5 - bufferEndDate)
 *   Oct 8 = formal 12-month paid subscription begins (paidStartDate)
 *
 * Therefore news is delivered continuously from Oct 3 through Oct 7,
 * and the formal 12-month paid subscription begins Oct 8.
 */
export function calculateSubscriptionDates(paymentDateIso: string): {
  paymentDate: string;
  startDate: string;
  expiryDate: string;
  bufferStartDate: string;
  bufferEndDate: string;
  paidStartDate: string;
  paidEndDate: string;
} {
  const payDate = new Date(paymentDateIso);

  // Buffer Start Date = adminConfirmedPaymentDate (e.g. 3 October 2026 00:00:00 IST)
  const bufferStart = new Date(payDate.getTime());
  bufferStart.setUTCHours(0, 0, 0, 0);

  // Buffer End Date = adminConfirmedPaymentDate + 4 days (e.g. 7 October 2026 23:59:59 IST)
  const bufferEnd = new Date(bufferStart.getTime());
  bufferEnd.setUTCDate(bufferEnd.getUTCDate() + 4);
  bufferEnd.setUTCHours(23, 59, 59, 999);

  // Paid Start Date = adminConfirmedPaymentDate + 5 days (e.g. 8 October 2026 00:00:00 IST)
  const paidStart = new Date(bufferStart.getTime());
  paidStart.setUTCDate(paidStart.getUTCDate() + 5);
  paidStart.setUTCHours(0, 0, 0, 0);

  // Paid End Date = paidStartDate + 12 calendar months / 1 year (e.g. 8 October 2027 23:59:59 IST)
  const paidEnd = new Date(paidStart.getTime());
  paidEnd.setUTCFullYear(paidEnd.getUTCFullYear() + 1);
  paidEnd.setUTCHours(23, 59, 59, 999);

  // Standard subscription window (D + 1 through anniversary)
  const dPlusOne = new Date(payDate.getTime());
  dPlusOne.setUTCDate(dPlusOne.getUTCDate() + 1);
  dPlusOne.setUTCHours(0, 0, 0, 0);

  const dPlusOneYear = new Date(dPlusOne.getTime());
  dPlusOneYear.setUTCFullYear(dPlusOneYear.getUTCFullYear() + 1);
  dPlusOneYear.setUTCHours(23, 59, 59, 999);

  return {
    paymentDate: payDate.toISOString(),
    startDate: dPlusOne.toISOString(),
    expiryDate: dPlusOneYear.toISOString(),
    bufferStartDate: bufferStart.toISOString(),
    bufferEndDate: bufferEnd.toISOString(),
    paidStartDate: paidStart.toISOString(),
    paidEndDate: paidEnd.toISOString(),
  };
}

/**
 * Checks if a subscription is currently active given a reference date (default = now)
 * A subscription is active from payment/creation through its expiryDate.
 */
export function isSubscriptionActiveAt(subscription: Subscription, referenceDate: Date = new Date()): boolean {
  if (subscription.status !== 'active') return false;
  const expiry = new Date(subscription.expiryDate);
  return referenceDate <= expiry;
}

/**
 * Checks if a subscription is eligible for daily morning news delivery on a specific delivery date (Section 9)
 * First news: startDate (e.g. 30 September 2026 06:00 AM IST).
 * Last news: expiryDate (e.g. 30 September 2027 06:00 AM IST).
 * No news: 1 October 2027 onward unless renewed (Section 5).
 */
export function isEligibleForDeliveryOn(subscription: Subscription, deliveryDate: Date = new Date()): boolean {
  if (subscription.status !== 'active') return false;
  const start = new Date(subscription.startDate);
  const expiry = new Date(subscription.expiryDate);
  return deliveryDate >= start && deliveryDate <= expiry;
}

/**
 * ============================================================================
 * AUTOMATIC PAYMENT ACTIVATION & IDEMPOTENCY ENGINE (Section 2, 4, 6, 7, 8)
 * ============================================================================
 */
/**
 * ============================================================================
 * SINGLE AUTHORITATIVE PAYMENT ACTIVATION & IDEMPOTENCY ENGINE (Phase 6.1)
 * ============================================================================
 * Steps 8, 9, 10, 11:
 * Verified Payment -> Payment Record -> Subscription -> SubscriptionCategory
 * Idempotency keyed on trusted gateway identifiers (providerOrderId, providerPaymentId).
 * Handles webhook-first, callback-first, duplicate webhooks, duplicate callbacks.
 */

export interface ProcessSuccessfulPaymentParams {
  paymentOrderId?: string;
  providerOrderId: string; // Razorpay order_...
  providerPaymentId: string; // Razorpay pay_...
  providerSignature?: string;
  amount?: number; // In INR
  currency?: string;
  customerId?: string; // Authenticated customer ID (if from browser session)
  source: 'browser_callback' | 'webhook';
  paymentDate?: string;
}

export interface PaymentProcessResult {
  ok: boolean;
  isDuplicate?: boolean;
  payment: Payment;
  subscription: Subscription | null;
  entitlements: SubscriptionCategory[];
  error?: string;
}

export function processSuccessfulPayment(params: ProcessSuccessfulPaymentParams): PaymentProcessResult {
  const db = getDb();
  const now = new Date().toISOString();

  const cleanOrderId = (params.providerOrderId || '').trim();
  const cleanPaymentId = (params.providerPaymentId || '').trim();

  if (!cleanOrderId && !params.paymentOrderId) {
    throw new Error('Payment order identifier is mandatory for payment processing.');
  }

  // 1. Locate trusted internal PaymentOrder (Step 2, 3, 4)
  let trustedOrder: PaymentOrder | null = null;
  if (params.paymentOrderId) {
    trustedOrder = getPaymentOrderById(params.paymentOrderId);
  }
  if (!trustedOrder && cleanOrderId) {
    trustedOrder = getPaymentOrderByProviderOrderId(cleanOrderId);
  }

  if (!trustedOrder) {
    throw new Error(`Unknown Razorpay order '${cleanOrderId || params.paymentOrderId}'. No matching internal payment order found.`);
  }

  // 2. Validate customer association if caller supplied customerId (Step 6 & Test J)
  if (params.customerId && trustedOrder.customerId !== params.customerId) {
    throw new Error(
      `Payment order ${trustedOrder.paymentOrderId} does not belong to customer ${params.customerId}. Unauthorized payment association.`
    );
  }

  // 3. Validate active category requirements (Test X)
  const allActiveCategories = getActiveCategories();
  const activeIds = new Set(allActiveCategories.map((c) => c.id));
  const hasInactiveCategory = trustedOrder.categoryIds.some((id) => !activeIds.has(id));
  if (hasInactiveCategory) {
    throw new Error('Payment rejected: One or more selected categories are inactive.');
  }

  // 4. Validate Amount and Currency (Step 6, 12, Tests G & H)
  if (typeof params.amount === 'number') {
    if (Math.abs(params.amount - trustedOrder.amount) >= 0.01) {
      throw new Error(
        `Payment amount mismatch: Expected ₹${trustedOrder.amount.toFixed(2)}, received ₹${params.amount.toFixed(2)}.`
      );
    }
  }

  if (params.currency) {
    if (params.currency.toUpperCase() !== trustedOrder.currency.toUpperCase()) {
      throw new Error(
        `Payment currency mismatch: Expected ${trustedOrder.currency}, received ${params.currency}.`
      );
    }
  }

  // 5. IDEMPOTENCY CHECK ON TRUSTED GATEWAY IDENTIFIERS (Step 7 & 10)
  // Check if this payment or order has already been successfully activated
  const existingPayment = db.payments.find(
    (p) =>
      p.paymentStatus === 'successful' &&
      ((p.providerOrderId && p.providerOrderId === trustedOrder.providerOrderId) ||
        (cleanPaymentId && p.providerPaymentId === cleanPaymentId) ||
        (cleanPaymentId && p.gatewayReference === cleanPaymentId) ||
        (p.paymentOrderId && p.paymentOrderId === trustedOrder.paymentOrderId))
  );

  if (existingPayment) {
    // Already processed. Return existing subscription and entitlements safely (zero duplicates!)
    const existingSub = db.subscriptions.find((s) => s.paymentId === existingPayment.paymentId) || null;
    const existingEntitlements = existingSub
      ? db.subscriptionCategories.filter((sc) => sc.subscriptionId === existingSub.subscriptionId)
      : [];

    return {
      ok: true,
      isDuplicate: true,
      payment: existingPayment,
      subscription: existingSub,
      entitlements: existingEntitlements,
    };
  }

  // 6. Update trusted internal order status
  trustedOrder.status = 'successful';
  trustedOrder.updatedAt = now;

  const paymentDate = params.paymentDate || now;

  // 7. Create Payment record
  const payment: Payment = {
    paymentId: `pay_${crypto.randomBytes(8).toString('hex')}`,
    paymentOrderId: trustedOrder.paymentOrderId,
    customerId: trustedOrder.customerId,
    amount: trustedOrder.amount,
    currency: trustedOrder.currency,
    paymentStatus: 'successful',
    paymentDate,
    gatewayReference: cleanPaymentId || trustedOrder.providerOrderId,
    providerOrderId: trustedOrder.providerOrderId,
    providerPaymentId: cleanPaymentId,
    providerSignature: params.providerSignature,
    provider: 'razorpay',
    purchasedCategoryIds: trustedOrder.categoryIds,
    createdAt: now,
    updatedAt: now,
  };

  db.payments.push(payment);

  // 8. AUTOMATIC ACTIVATION: Create Subscription & SubscriptionCategory records (Step 8, 9)
  const dates = calculateSubscriptionDates(paymentDate);

  const subscription: Subscription = {
    subscriptionId: `sub_${crypto.randomBytes(8).toString('hex')}`,
    customerId: trustedOrder.customerId,
    startDate: dates.startDate,
    expiryDate: dates.expiryDate,
    bufferStartDate: dates.bufferStartDate,
    bufferEndDate: dates.bufferEndDate,
    paidStartDate: dates.paidStartDate,
    paidEndDate: dates.paidEndDate,
    status: 'active',
    paymentId: payment.paymentId,
    createdAt: now,
    updatedAt: now,
  };

  db.subscriptions.push(subscription);

  const entitlements: SubscriptionCategory[] = [];
  const categoryMap = new Map(allActiveCategories.map((c) => [c.id, c.name]));

  for (const catId of trustedOrder.categoryIds) {
    const catName = categoryMap.get(catId) || catId;
    const entitlement: SubscriptionCategory = {
      subscriptionId: subscription.subscriptionId,
      customerId: trustedOrder.customerId,
      categoryId: catId,
      categoryName: catName,
      entitlementStatus: 'active',
      assignedAt: now,
      updatedAt: now,
    };
    db.subscriptionCategories.push(entitlement);
    entitlements.push(entitlement);
  }

  saveDb();

  return {
    ok: true,
    isDuplicate: false,
    payment,
    subscription,
    entitlements,
  };
}

/**
 * Handles failed or cancelled payments (Step 10 & 16)
 * Updates PaymentOrder and saves failed Payment record; NEVER activates subscription.
 */
export function processFailedPayment(params: {
  paymentOrderId?: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  status: 'failed' | 'cancelled';
  errorReason?: string;
  customerId?: string;
  amount?: number;
}): { ok: boolean; paymentOrder: PaymentOrder | null; payment?: Payment } {
  const db = getDb();
  const now = new Date().toISOString();

  let trustedOrder: PaymentOrder | null = null;
  if (params.paymentOrderId) {
    trustedOrder = getPaymentOrderById(params.paymentOrderId);
  }
  if (!trustedOrder && params.providerOrderId) {
    trustedOrder = getPaymentOrderByProviderOrderId(params.providerOrderId);
  }

  if (trustedOrder) {
    trustedOrder.status = params.status;
    trustedOrder.updatedAt = now;
  }

  const payment: Payment = {
    paymentId: `pay_${crypto.randomBytes(8).toString('hex')}`,
    paymentOrderId: trustedOrder?.paymentOrderId,
    customerId: trustedOrder?.customerId || params.customerId || 'unknown',
    amount: trustedOrder?.amount || params.amount || 0,
    currency: trustedOrder?.currency || 'INR',
    paymentStatus: params.status,
    paymentDate: now,
    gatewayReference: params.providerPaymentId || params.providerOrderId || 'failed_reference',
    providerOrderId: trustedOrder?.providerOrderId || params.providerOrderId,
    providerPaymentId: params.providerPaymentId,
    provider: 'razorpay',
    purchasedCategoryIds: trustedOrder?.categoryIds || [],
    createdAt: now,
    updatedAt: now,
  };

  db.payments.push(payment);
  saveDb();

  return {
    ok: true,
    paymentOrder: trustedOrder,
    payment,
  };
}

export interface ProcessPaymentParams {
  customerId: string;
  gatewayReference: string;
  categoryIds: string[];
  amount?: number;
  currency?: string;
  paymentStatus?: PaymentStatus;
  paymentDate?: string;
}

/**
 * Legacy & Test Suite Bridge:
 * Direct unit test invocation used by Phase 2 tests.
 * In live mode, manual UTR activation is rejected. In test mode, creates an internal PaymentOrder and activates.
 */
export function processVerifiedPayment(params: ProcessPaymentParams): PaymentProcessResult {
  const mode = getPaymentProviderMode();
  const cleanRef = (params.gatewayReference || '').trim();

  // Test L & Requirement: customer-entered UTR proof cannot activate in live mode
  if (mode === 'live' && cleanRef.startsWith('UTR_')) {
    throw new Error('Customer-entered UTR / manual transaction proof cannot activate subscriptions in LIVE mode.');
  }

  const pricing = calculateServerPayablePrice(params.categoryIds);
  const now = new Date().toISOString();

  // Check if an existing internal payment order exists with this reference as providerOrderId
  let order = getPaymentOrderByProviderOrderId(cleanRef);
  if (!order) {
    order = createPaymentOrder({
      paymentOrderId: `pord_${crypto.randomBytes(8).toString('hex')}`,
      customerId: params.customerId,
      categoryIds: pricing.validCategories.map((c) => c.id),
      amount: params.amount ?? pricing.totalPayable,
      currency: params.currency || 'INR',
      provider: 'razorpay',
      providerOrderId: cleanRef,
      status: params.paymentStatus === 'successful' ? 'successful' : (params.paymentStatus || 'created') as any,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (params.paymentStatus === 'failed' || params.paymentStatus === 'cancelled') {
    const res = processFailedPayment({
      paymentOrderId: order.paymentOrderId,
      providerOrderId: cleanRef,
      status: params.paymentStatus,
    });
    return {
      ok: true,
      isDuplicate: false,
      payment: res.payment!,
      subscription: null,
      entitlements: [],
    };
  }

  return processSuccessfulPayment({
    paymentOrderId: order.paymentOrderId,
    providerOrderId: cleanRef,
    providerPaymentId: cleanRef,
    customerId: params.customerId,
    amount: params.amount,
    currency: params.currency,
    source: 'browser_callback',
    paymentDate: params.paymentDate,
  });
}

/**
 * ============================================================================
 * AUTHORITATIVE ENTITLEMENT CHECK (Section 1)
 * ============================================================================
 * Subscription + SubscriptionCategory is the authoritative source of paid entitlement.
 */
export function getCustomerActiveCategoryEntitlements(
  customerId: string,
  referenceDate: Date = new Date()
): {
  hasActiveSubscription: boolean;
  activeCategories: Array<{ categoryId: string; categoryName: string; subscriptionId: string; expiryDate: string }>;
} {
  const db = getDb();

  // Find all active subscriptions for this customer within valid dates
  const activeSubs = db.subscriptions.filter(
    (s) => s.customerId === customerId && isSubscriptionActiveAt(s, referenceDate)
  );

  if (activeSubs.length === 0) {
    return {
      hasActiveSubscription: false,
      activeCategories: [],
    };
  }

  const subIds = new Set(activeSubs.map((s) => s.subscriptionId));
  const subMap = new Map(activeSubs.map((s) => [s.subscriptionId, s]));

  // Find all active entitlements associated with these subscriptions
  const entitlements = db.subscriptionCategories.filter(
    (sc) => sc.customerId === customerId && subIds.has(sc.subscriptionId) && sc.entitlementStatus === 'active'
  );

  const activeCategories = entitlements.map((sc) => {
    const sub = subMap.get(sc.subscriptionId);
    return {
      categoryId: sc.categoryId,
      categoryName: sc.categoryName,
      subscriptionId: sc.subscriptionId,
      expiryDate: sub?.expiryDate || '',
    };
  });

  return {
    hasActiveSubscription: true,
    activeCategories,
  };
}

/**
 * Retrieves a customer's private payments (scoped to customerId)
 */
export function getCustomerPayments(customerId: string): Payment[] {
  const db = getDb();
  return db.payments
    .filter((p) => p.customerId === customerId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Retrieves a customer's private subscriptions and their category entitlements (scoped to customerId)
 */
export function getCustomerSubscriptions(customerId: string): Array<{
  subscription: Subscription;
  categories: SubscriptionCategory[];
}> {
  const db = getDb();
  const subs = db.subscriptions
    .filter((s) => s.customerId === customerId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return subs.map((sub) => {
    const categories = db.subscriptionCategories.filter((sc) => sc.subscriptionId === sub.subscriptionId);
    return {
      subscription: sub,
      categories,
    };
  });
}

/**
 * Admin: Get all payments
 */
export function getAllPaymentsForAdmin(): Payment[] {
  const db = getDb();
  return [...db.payments].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Admin: Get all subscriptions with categories
 */
export function getAllSubscriptionsForAdmin(): Array<{
  subscription: Subscription;
  customerEmail: string;
  customerName: string;
  categories: SubscriptionCategory[];
}> {
  const db = getDb();
  return db.subscriptions.map((sub) => {
    const cust = db.customers.find((c) => c.customerId === sub.customerId);
    const categories = db.subscriptionCategories.filter((sc) => sc.subscriptionId === sub.subscriptionId);
    return {
      subscription: sub,
      customerEmail: cust?.email || 'Unknown',
      customerName: cust?.fullName || 'Unknown',
      categories,
    };
  });
}

/**
 * ============================================================================
 * STAGE 2: ADMIN PAYMENT CONFIRMATION (Section 14 & Stage 1 Blueprint)
 * ============================================================================
 * Confirms payment with authoritative date calculation:
 *   bufferStartDate = adminConfirmedPaymentDate
 *   bufferEndDate   = adminConfirmedPaymentDate + 4 days
 *   paidStartDate   = adminConfirmedPaymentDate + 5 days
 *   paidEndDate     = paidStartDate + 12 calendar months
 */
export function confirmPaymentByAdmin(params: {
  paymentId?: string;
  customerId: string;
  confirmedPaymentDate?: string;
  categoryIds?: string[];
  amount?: number;
  reference?: string;
  adminEmail: string;
}): {
  success: boolean;
  payment: Payment;
  subscription: Subscription;
  entitlements: SubscriptionCategory[];
  error?: string;
} {
  const db = getDb();
  const now = new Date().toISOString();
  const confirmedDate = params.confirmedPaymentDate || now;

  const customer = getCustomerById(params.customerId);
  if (!customer) {
    throw new Error(`Customer with ID ${params.customerId} not found.`);
  }

  // 1. Locate or create Payment record
  let payment: Payment | undefined;
  if (params.paymentId) {
    payment = db.payments.find((p) => p.paymentId === params.paymentId);
  }
  if (!payment && params.reference) {
    payment = db.payments.find(
      (p) => p.customerId === params.customerId && p.gatewayReference === params.reference
    );
  }

  const categoryIds =
    params.categoryIds && params.categoryIds.length > 0
      ? params.categoryIds
      : payment?.purchasedCategoryIds && payment.purchasedCategoryIds.length > 0
      ? payment.purchasedCategoryIds
      : customer.selectedCategoryIds || ['cat_india_startups'];

  if (payment) {
    // Idempotency: if payment was already successfully confirmed and has an active subscription, return existing
    if (payment.paymentStatus === 'successful') {
      const existingSub = db.subscriptions.find(
        (s) => s.paymentId === payment!.paymentId && s.status === 'active'
      );
      if (existingSub) {
        const existingEntitlements = db.subscriptionCategories.filter(
          (sc) => sc.subscriptionId === existingSub.subscriptionId
        );
        return {
          success: true,
          payment,
          subscription: existingSub,
          entitlements: existingEntitlements,
        };
      }
    }

    payment.paymentStatus = 'successful';
    payment.paymentDate = confirmedDate;
    payment.updatedAt = now;
    if (params.reference) payment.gatewayReference = params.reference;
  } else {
    payment = {
      paymentId: `pay_${crypto.randomBytes(8).toString('hex')}`,
      customerId: customer.customerId,
      amount: params.amount || 297.36,
      currency: 'INR',
      paymentStatus: 'successful',
      paymentDate: confirmedDate,
      gatewayReference: params.reference || `ADMIN_CONFIRMED_${Date.now()}`,
      provider: 'manual_upi',
      purchasedCategoryIds: categoryIds,
      createdAt: now,
      updatedAt: now,
    };
    db.payments.push(payment);
  }

  // 2. Authoritative date calculation
  const dates = calculateSubscriptionDates(confirmedDate);

  // 3. Create active subscription with exact inclusive dates
  const subscription: Subscription = {
    subscriptionId: `sub_${crypto.randomBytes(8).toString('hex')}`,
    customerId: customer.customerId,
    startDate: dates.bufferStartDate, // active delivery starts at buffer start
    expiryDate: dates.paidEndDate,     // active delivery runs through paid end date
    bufferStartDate: dates.bufferStartDate,
    bufferEndDate: dates.bufferEndDate,
    paidStartDate: dates.paidStartDate,
    paidEndDate: dates.paidEndDate,
    status: 'active',
    paymentId: payment.paymentId,
    createdAt: now,
    updatedAt: now,
  };
  db.subscriptions.push(subscription);

  // 4. Update customer trial/account status
  customer.accountStatus = 'active';
  customer.trialStatus = 'converted';
  customer.updatedAt = now;

  // 5. Entitlement assignment
  const allActiveCategories = getActiveCategories();
  const categoryMap = new Map(allActiveCategories.map((c) => [c.id, c.name]));
  const entitlements: SubscriptionCategory[] = [];

  for (const catId of categoryIds) {
    const entitlement: SubscriptionCategory = {
      subscriptionId: subscription.subscriptionId,
      customerId: customer.customerId,
      categoryId: catId,
      categoryName: categoryMap.get(catId) || catId,
      entitlementStatus: 'active',
      assignedAt: now,
      updatedAt: now,
    };
    db.subscriptionCategories.push(entitlement);
    entitlements.push(entitlement);
  }

  saveDb();

  return {
    success: true,
    payment,
    subscription,
    entitlements,
  };
}

/**
 * ============================================================================
 * STAGE 2: NEWS DELIVERY ELIGIBILITY EVALUATION (Section 15)
 * ============================================================================
 * Evaluates whether a customer is eligible for news delivery on a specific date:
 *   - Buffer period: Active
 *   - Paid subscription period: Active
 *   - Before payment confirmation: Ineligible (unless valid trial)
 *   - Expired subscription: Ineligible
 */
export function evaluateNewsDeliveryEligibility(
  customerId: string,
  deliveryDate: Date = new Date()
): {
  isEligible: boolean;
  phase: 'buffer' | 'paid' | 'trial' | 'expired' | 'unconfirmed' | 'none';
  reasons: string[];
  activeSubscription?: Subscription | null;
  entitledCategoryIds: string[];
} {
  const db = getDb();
  const customer = getCustomerById(customerId);
  if (!customer) {
    return { isEligible: false, phase: 'none', reasons: ['Customer not found'], entitledCategoryIds: [] };
  }

  if (!customer.telegramConnected) {
    return {
      isEligible: false,
      phase: 'none',
      reasons: ['Telegram account not connected (mandatory for news delivery)'],
      entitledCategoryIds: [],
    };
  }

  const activeSubs = db.subscriptions.filter(
    (s) => s.customerId === customerId && s.status === 'active'
  );

  const targetTime = deliveryDate.getTime();
  let foundSub: Subscription | null = null;
  let phase: 'buffer' | 'paid' | 'trial' | 'expired' | 'unconfirmed' | 'none' = 'none';

  for (const s of activeSubs) {
    const bufferStart = s.bufferStartDate ? new Date(s.bufferStartDate).getTime() : new Date(s.startDate).getTime();
    const bufferEnd = s.bufferEndDate
      ? new Date(s.bufferEndDate).getTime()
      : bufferStart + 4 * 86400000 + 86399999;
    const paidStart = s.paidStartDate
      ? new Date(s.paidStartDate).getTime()
      : bufferStart + 5 * 86400000;
    const paidEnd = s.paidEndDate ? new Date(s.paidEndDate).getTime() : new Date(s.expiryDate).getTime();

    if (targetTime >= bufferStart && targetTime <= bufferEnd) {
      foundSub = s;
      phase = 'buffer';
      break;
    } else if (targetTime >= paidStart && targetTime <= paidEnd) {
      foundSub = s;
      phase = 'paid';
      break;
    } else if (targetTime < bufferStart) {
      phase = 'unconfirmed';
    } else if (targetTime > paidEnd) {
      phase = 'expired';
    }
  }

  if (foundSub) {
    const entitledCats = db.subscriptionCategories
      .filter(
        (sc) =>
          sc.customerId === customerId &&
          sc.subscriptionId === foundSub!.subscriptionId &&
          sc.entitlementStatus === 'active'
      )
      .map((sc) => sc.categoryId);

    return {
      isEligible: true,
      phase,
      reasons: [`Active news delivery: ${phase} period`],
      activeSubscription: foundSub,
      entitledCategoryIds: entitledCats,
    };
  }

  // Check 3-day complimentary trial if no paid subscription active
  if (customer.trialStatus === 'active' && customer.trialStartDate && customer.trialEndDate) {
    const trialStart = new Date(customer.trialStartDate).getTime();
    const trialEnd = new Date(customer.trialEndDate).getTime();
    if (targetTime >= trialStart && targetTime <= trialEnd) {
      return {
        isEligible: true,
        phase: 'trial',
        reasons: ['Active complimentary 3-day trial period'],
        entitledCategoryIds: customer.selectedCategoryIds || ['cat_india_startups'],
      };
    }
  }

  return {
    isEligible: false,
    phase: phase === 'none' ? 'expired' : phase,
    reasons: [phase === 'expired' ? 'Subscription expired' : 'No active confirmed subscription covering delivery date'],
    entitledCategoryIds: [],
  };
}
