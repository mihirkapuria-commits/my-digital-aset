import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { createServer as createViteServer } from 'vite';
import {
  generateGoogleAuthUrl,
  exchangeCodeAndVerifyToken,
  createAdminSession,
  validateAdminSession,
  invalidateAdminSession,
  requireAdminAuth,
  requireSchedulerOrAdminAuth,
  getAuthorizedAdminEmail,
  recordSecurityLog,
  getSecurityLogs,
  getClientIp,
  getOAuthCallbackUrl,
  SESSION_LIFETIME_MS,
  verifyGoogleIdTokenDirect,
} from './server/googleAdminAuth.js';
import { validateUploadFile } from './server/fileUploadSecurity.js';
import {
  DailyNewsPackage,
  NewsStory,
  Payment,
} from './src/types';
import {
  initDb,
  loadDbFromFirestore,
  getDb,
  saveDb,
  validateCustomerRegistration,
  registerOrLoginCustomer,
  getCustomerBySessionToken,
  invalidateCustomerSession,
  updateCustomerMobile,
  getActiveCategories,
  getAdminCustomersList,
  getCustomerById,
  getCustomerPaymentOrders,
  getPaymentOrderById,
  getPaymentOrderByProviderOrderId,
} from './server/db.js';
import {
  calculateServerPayablePrice,
  calculateSubscriptionDates,
  defaultPaymentGateway,
  processVerifiedPayment,
  processSuccessfulPayment,
  processFailedPayment,
  getCustomerPayments,
  getCustomerSubscriptions,
  getAllPaymentsForAdmin,
  getAllSubscriptionsForAdmin,
  confirmPaymentByAdmin,
  evaluateNewsDeliveryEligibility,
} from './server/paymentService.js';
import {
  getPublicRazorpayConfig,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  getPaymentProviderMode,
} from './server/razorpayService.js';
import {
  getCustomerActiveEntitlements,
  executeAdminCategoryTransfer,
  setCategoryStatus,
  createNewCatalogCategory,
  getCategoryTransferAuditLogs,
} from './server/entitlementService.js';
import {
  generateTelegramConnectionToken,
  connectTelegramAccount,
  disconnectTelegramAccount,
  processTelegramWebhookUpdate,
  getTelegramAuditLogs,
  getTelegramBotUsername,
  isTelegramBotConfigured,
  verifyTelegramWebhookSecret,
  sendDay3TrialReminder,
} from './server/telegramService.js';
import {
  generateCategoryDailyNews,
  generateDailyAllCategoriesNews,
  getKolkataDateString,
  INDIA_CATEGORY_IDS,
  OFFICIAL_LIVE_FEEDS,
  getSourceProviderMode,
} from './server/newsService.js';
import {
  deliverCategoryNewsToCustomer,
  deliverDailyBriefingsToAllEligibleCustomers,
  getDeliveryStatistics,
} from './server/deliveryService.js';
import {
  generateIndiaTelegramConnectionToken,
  connectIndiaTelegramAccount,
  disconnectIndiaTelegramAccount,
  processIndiaTelegramWebhookUpdate,
  getIndiaTelegramAuditLogs,
  getIndiaTelegramBotUsername,
  isIndiaTelegramBotConfigured,
  verifyIndiaTelegramWebhookSecret,
  sendIndiaTelegramMessage,
} from './server/indiaTelegramService.js';
import {
  deliverIndiaCategoryNewsToCustomer,
  deliverDailyIndiaBriefingsToAllEligibleCustomers,
  getIndiaDeliveryStatistics,
} from './server/indiaDeliveryService.js';
import {
  SPECIALIST_CATEGORY_IDS,
  generateSpecialistCategoryDailyNews,
  generateDailyAllSpecialistNews,
} from './server/specialistNewsService.js';
import {
  startDailyScheduler,
  getSchedulerStatus,
  triggerManualSchedulerRun,
} from './server/schedulerService.js';
import {
  runIndiaReliabilityWatchdog,
  getIndiaReliabilityStatus,
} from './server/indiaReliabilityService.js';
import {
  getSheetSyncCheckpoint,
  executeFirestoreToSheetSync,
  TARGET_SPREADSHEET_ID,
} from './server/sheetSyncService.js';

// Initialize the core MyDigitAsset persistent database
initDb();
loadDbFromFirestore().catch((err) => {
  console.warn('[Firestore] Startup synchronization notice:', err.message);
});

// Server-side persistent site settings file (non-secret content)
const SETTINGS_FILE = path.join(process.cwd(), 'server', 'data', 'site-settings.json');

function loadPersistedSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading site settings:', err);
  }
  return null;
}

function savePersistedSettings(settings: any) {
  try {
    const dataDir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving site settings:', err);
  }
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Basic security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });

  // Cookie and body parsers with strict size limits
  app.use(cookieParser());
  app.use(
    express.json({
      limit: '2mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // ==========================================
  // PUBLIC API ROUTES
  // ==========================================
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Public endpoint for normal visitors to fetch site configurations
  app.get('/api/site-settings', (req, res) => {
    const custom = loadPersistedSettings();
    res.json({ settings: custom });
  });

  // Public endpoint: Active subscription categories (Section 6, 8)
  app.get('/api/categories', (req, res) => {
    const categories = getActiveCategories();
    res.json({ ok: true, categories });
  });

  // ==========================================
  // CUSTOMER PRIVATE API ROUTES (Section 2, 3, 14, 15)
  // Strict Privacy: Never exposes customer directory or other subscribers
  // ==========================================

  /**
   * Helper: extract customer session/auth token from cookie, Authorization header, or payload
   * Protects endpoints against cross-customer record manipulation.
   */
  function getCustomerSessionToken(req: express.Request): string | null {
    const cookieToken = req.cookies?.customer_session;
    if (cookieToken && typeof cookieToken === 'string') return cookieToken;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7).trim();
    }

    const bodyToken = req.body?.customerAuthToken || req.body?.sessionToken;
    if (bodyToken && typeof bodyToken === 'string') return bodyToken.trim();

    const queryToken = req.query?.customerAuthToken || req.query?.sessionToken;
    if (queryToken && typeof queryToken === 'string') return queryToken.trim();

    return null;
  }

  /**
   * POST /api/customer/register & /api/registerTrial & /api/customer/register-trial
   * Registers a customer account with mandatory name, email, mobile, and selected categories.
   * Returns opaque 256-bit customerAuthToken / sessionToken for client authentication.
   */
  app.post(['/api/customer/register', '/api/registerTrial', '/api/customer/register-trial'], (req, res) => {
    const validation = validateCustomerRegistration(req.body);
    if (!validation.valid || !validation.cleanData) {
      return res.status(400).json({ ok: false, error: validation.error || 'Invalid registration data' });
    }

    try {
      const { customer, sessionToken } = registerOrLoginCustomer(validation.cleanData);

      // Issue 30-day HttpOnly session cookie
      res.cookie('customer_session', sessionToken, {
        httpOnly: true,
        secure: req.secure || process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: '/',
      });

      return res.json({
        ok: true,
        success: true,
        customer,
        customerId: customer.customerId,
        customerAuthToken: sessionToken,
        sessionToken,
      });
    } catch (err: any) {
      console.error('Customer registration error:', err);
      return res.status(500).json({ ok: false, error: 'Could not complete registration. Please try again.' });
    }
  });

  /**
   * POST /api/customer/request-renewal-trial & /api/requestRenewalTrial
   * Customer identity protection: Requires valid customerAuthToken.
   * A customer can only request renewal for their own subscription record.
   * Deduplication prevents conflicting requests.
   */
  app.post(['/api/customer/request-renewal-trial', '/api/requestRenewalTrial'], (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Authentication required. Missing customerAuthToken.' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired customer session.' });
    }

    const { notes } = req.body || {};
    const db = getDb();

    // Check if renewal is already requested
    if (customer.renewalRequested) {
      return res.json({
        ok: true,
        success: true,
        isDuplicate: true,
        message: 'A renewal request is already pending review for your account.',
        requestedAt: customer.renewalRequestedAt,
      });
    }

    const now = new Date().toISOString();
    customer.renewalRequested = true;
    customer.renewalRequestedAt = now;
    if (notes) customer.renewalNotes = String(notes).trim().substring(0, 500);
    customer.updatedAt = now;
    saveDb();

    return res.json({
      ok: true,
      success: true,
      message: 'Renewal request recorded successfully for your account.',
      requestedAt: now,
    });
  });

  /**
   * POST /api/customer/submit-payment-proof & /api/submitPaymentProof
   * Customer identity protection: Requires valid customerAuthToken.
   * A customer can only submit payment proof attached exclusively to their own account.
   * Prevents duplicate reference submissions.
   */
  app.post(['/api/customer/submit-payment-proof', '/api/submitPaymentProof'], (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Authentication required. Missing customerAuthToken.' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired customer session.' });
    }

    const { paymentReference, utrNumber, amount, categoryIds, screenshotUrl } = req.body || {};
    const reference = (paymentReference || utrNumber || '').trim();

    if (!reference || reference.length < 4) {
      return res.status(400).json({ ok: false, error: 'Valid payment reference or UTR number is required.' });
    }

    const db = getDb();
    const now = new Date().toISOString();

    // Deduplication check: check if this customer already submitted this reference
    const existingProof = db.payments.find(
      (p) => p.customerId === customer.customerId && p.gatewayReference.toLowerCase() === reference.toLowerCase()
    );
    if (existingProof) {
      return res.json({
        ok: true,
        success: true,
        isDuplicate: true,
        paymentId: existingProof.paymentId,
        reference: existingProof.gatewayReference,
        status: existingProof.paymentStatus,
        message: 'This payment reference has already been submitted and is currently in review.',
      });
    }

    const paymentRecord: Payment = {
      paymentId: `proof_${crypto.randomBytes(8).toString('hex')}`,
      customerId: customer.customerId,
      amount: typeof amount === 'number' ? amount : 297.36,
      currency: 'INR',
      paymentStatus: 'pending',
      paymentDate: now,
      gatewayReference: reference,
      provider: 'manual_upi',
      purchasedCategoryIds:
        Array.isArray(categoryIds) && categoryIds.length > 0
          ? categoryIds
          : customer.selectedCategoryIds || ['cat_india_startups'],
      createdAt: now,
      updatedAt: now,
    };

    db.payments.push(paymentRecord);
    saveDb();

    return res.json({
      ok: true,
      success: true,
      message: 'Payment proof submitted successfully and queued for admin review.',
      paymentId: paymentRecord.paymentId,
      reference: paymentRecord.gatewayReference,
      status: paymentRecord.paymentStatus,
    });
  });

  /**
   * GET /api/customer/subscription-status & /api/getSubscriptionStatus
   * Safe customer-facing subscription status (Section 12).
   * Exclusively resolves customer from validated customerAuthToken.
   * NEVER returns Telegram Chat IDs, subscriber lists, other customer names, UTRs, or admin notes.
   */
  app.get(['/api/customer/subscription-status', '/api/getSubscriptionStatus'], (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Authentication required. Missing customerAuthToken.' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired customer session.' });
    }

    const db = getDb();
    const activeSub =
      db.subscriptions
        .filter((s) => s.customerId === customer.customerId && s.status === 'active')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;

    const payments = db.payments
      .filter((p) => p.customerId === customer.customerId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const latestPayment = payments[0] || null;

    // Check delivery eligibility using authoritative evaluation
    const eligibility = evaluateNewsDeliveryEligibility(customer.customerId, new Date());

    return res.json({
      ok: true,
      accountStatus: customer.accountStatus,
      trialStatus: customer.trialStatus || 'active',
      trialStartDate: customer.trialStartDate || customer.createdAt,
      trialEndDate: customer.trialEndDate || null,
      telegramConnected: Boolean(customer.telegramConnected),
      indiaTelegramConnected: Boolean(customer.indiaTelegramConnected),
      hasActiveSubscription: Boolean(activeSub),
      deliveryEligible: eligibility.isEligible,
      deliveryPhase: eligibility.phase,
      subscription: activeSub
        ? {
            status: activeSub.status,
            bufferStartDate: activeSub.bufferStartDate || activeSub.startDate,
            bufferEndDate: activeSub.bufferEndDate || null,
            paidStartDate: activeSub.paidStartDate || null,
            paidEndDate: activeSub.paidEndDate || activeSub.expiryDate,
            startDate: activeSub.startDate,
            expiryDate: activeSub.expiryDate,
          }
        : null,
      paymentStatus: latestPayment?.paymentStatus || 'none',
      latestPaymentReference: latestPayment?.gatewayReference || null,
      renewalRequested: Boolean(customer.renewalRequested),
      renewalRequestedAt: customer.renewalRequestedAt || null,
      selectedCategoryIds: customer.selectedCategoryIds || [],
    });
  });

  /**
   * GET /api/customer/me
   * Fetches the currently authenticated customer's own profile.
   * Returns 401 if unauthenticated. Never returns other customers.
   */
  app.get('/api/customer/me', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      res.clearCookie('customer_session', { path: '/' });
      return res.status(401).json({ ok: false, error: 'Session expired or invalid' });
    }

    return res.json({
      ok: true,
      customer: {
        customerId: customer.customerId,
        fullName: customer.fullName,
        email: customer.email,
        mobileCountryCode: customer.mobileCountryCode,
        mobileNumber: customer.mobileNumber,
        telegramConnected: Boolean(customer.telegramConnected),
        indiaTelegramConnected: Boolean(customer.indiaTelegramConnected),
        accountStatus: customer.accountStatus,
        selectedCategoryIds: customer.selectedCategoryIds,
        createdAt: customer.createdAt,
        updatedAt: customer.updatedAt,
      },
    });
  });

  /**
   * PUT /api/customer/mobile
   * Allows customer to update their mobile number (Section 3)
   */
  app.put('/api/customer/mobile', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    const currentCustomer = getCustomerBySessionToken(sessionToken);
    if (!currentCustomer) {
      return res.status(401).json({ ok: false, error: 'Session expired or invalid' });
    }

    const { mobileCountryCode, mobileNumber } = req.body || {};
    const result = updateCustomerMobile(currentCustomer.customerId, mobileCountryCode, mobileNumber);

    if (!result.success || !result.customer) {
      return res.status(400).json({ ok: false, error: result.error || 'Invalid mobile number' });
    }

    return res.json({
      ok: true,
      customer: result.customer,
    });
  });

  /**
   * POST /api/customer/logout
   */
  app.post('/api/customer/logout', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (sessionToken) {
      invalidateCustomerSession(sessionToken);
    }
    res.clearCookie('customer_session', { path: '/' });
    return res.json({ ok: true });
  });

  // ==========================================
  // PAYMENT & SUBSCRIPTION APIS (Phase 2)
  // Automatic Activation, Server-Side Pricing, Idempotency, Strict Privacy
  // ==========================================

  /**
   * GET /api/payment/pricing
   * Authoritative server-side price calculation (Section 9, 10)
   */
  app.get('/api/payment/pricing', (req, res) => {
    const rawCategories = req.query.categories;
    let categoryIds: string[] = [];

    if (typeof rawCategories === 'string') {
      categoryIds = rawCategories.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(rawCategories)) {
      categoryIds = rawCategories.map((s) => String(s).trim()).filter(Boolean);
    }

    const pricing = calculateServerPayablePrice(categoryIds);
    return res.json({ ok: true, pricing });
  });

  /**
   * GET /api/payment/config (Phase 6.1)
   * Public configuration safe to share with browser (Key ID & mode).
   * Never exposes Key Secret or Webhook Secret.
   */
  app.get('/api/payment/config', (req, res) => {
    try {
      const publicConfig = getPublicRazorpayConfig();
      return res.json({
        ok: true,
        provider: 'razorpay',
        keyId: publicConfig.keyId,
        mode: publicConfig.mode,
      });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/payment/create-order
   * Creates an internal trusted PaymentOrder and Razorpay gateway order (Step 2, 3, 4).
   * Validates active categories and computes authoritative price server-side.
   */
  app.post('/api/payment/create-order', async (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Authentication required. Please register or log in first.' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired customer session.' });
    }

    const { categoryIds } = req.body || {};
    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'At least one category must be selected for payment.' });
    }

    try {
      const pricing = calculateServerPayablePrice(categoryIds);
      if (pricing.validCategories.length === 0) {
        return res.status(400).json({ ok: false, error: 'No active valid categories selected.' });
      }

      // Step 2 & Test X: Reject if any requested category is inactive or invalid
      if (pricing.validCategories.length !== categoryIds.length) {
        return res.status(400).json({
          ok: false,
          error: 'One or more selected categories are currently inactive or invalid.',
        });
      }

      const order = await defaultPaymentGateway.createOrder({
        customerId: customer.customerId,
        categoryIds: pricing.validCategories.map((c) => c.id),
        amount: pricing.totalPayable,
        currency: pricing.currency,
      });

      const publicConfig = getPublicRazorpayConfig();

      return res.json({
        ok: true,
        orderId: order.orderId, // Razorpay order ID (e.g. order_...)
        paymentOrderId: order.paymentOrderId, // Internal PaymentOrder ID (pord_...)
        amountPaise: Math.round(pricing.totalPayable * 100),
        amountInr: pricing.totalPayable,
        currency: pricing.currency,
        keyId: publicConfig.keyId,
        mode: publicConfig.mode,
        pricing,
      });
    } catch (err: any) {
      console.error('Order creation error:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Could not create payment order.' });
    }
  });

  /**
   * POST /api/payment/verify-and-activate
   * Path A: Razorpay Checkout browser callback verification (Step 5, 6, 9)
   * Strictly cryptographically verifies HMAC-SHA256 signature using Razorpay Key Secret.
   * NEVER trusts customer-entered UTRs or unverified claims.
   */
  app.post('/api/payment/verify-and-activate', async (req, res) => {
    // 1. Customer authentication
    const sessionToken = getCustomerSessionToken(req);
    let customer = sessionToken ? getCustomerBySessionToken(sessionToken) : null;

    if (!customer && req.body?.customerId) {
      customer = getCustomerById(req.body.customerId);
    }

    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Authentication required.' });
    }

    const {
      paymentOrderId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      paymentReference,
      simulatedStatus,
      paymentDate,
    } = req.body || {};

    const mode = getPaymentProviderMode();

    // Step 5 & Test L: Customer-entered UTR or fake references strictly prohibited in production
    if (paymentReference && String(paymentReference).startsWith('UTR_')) {
      if (mode === 'live') {
        return res.status(400).json({
          ok: false,
          error: 'Customer-entered UTR or transaction proof cannot activate subscriptions in production. Verified Razorpay payment required.',
        });
      }
    }

    const cleanOrderId = (razorpayOrderId || '').trim();
    const cleanPaymentId = (razorpayPaymentId || paymentReference || '').trim();
    const cleanSignature = (razorpaySignature || '').trim();

    try {
      // 2. Production cryptographic signature verification (Step 6)
      if (mode === 'live' || cleanSignature) {
        if (!cleanOrderId || !cleanPaymentId || !cleanSignature) {
          return res.status(400).json({
            ok: false,
            error: 'Missing Razorpay payment parameters (order ID, payment ID, or signature required).',
          });
        }

        const isSignatureValid = verifyRazorpayPaymentSignature({
          orderId: cleanOrderId,
          paymentId: cleanPaymentId,
          signature: cleanSignature,
        });

        if (!isSignatureValid) {
          return res.status(400).json({
            ok: false,
            error: 'Cryptographic signature verification failed. Invalid Razorpay signature.',
          });
        }

        // Single authoritative activation
        const result = processSuccessfulPayment({
          paymentOrderId,
          providerOrderId: cleanOrderId,
          providerPaymentId: cleanPaymentId,
          providerSignature: cleanSignature,
          customerId: customer.customerId,
          source: 'browser_callback',
          paymentDate,
        });

        return res.json({
          ok: true,
          isDuplicate: result.isDuplicate,
          payment: result.payment,
          subscription: result.subscription,
          entitlements: result.entitlements,
        });
      }

      // Simulated failure in test mode
      if (simulatedStatus === 'failed' || simulatedStatus === 'cancelled') {
        const failRes = processFailedPayment({
          paymentOrderId,
          providerOrderId: cleanOrderId || cleanPaymentId,
          providerPaymentId: cleanPaymentId,
          status: simulatedStatus,
          customerId: customer.customerId,
        });
        return res.status(400).json({
          ok: false,
          error: `Payment was ${simulatedStatus}.`,
          payment: failRes.payment,
        });
      }

      // Legacy test mode activation fallback
      const result = processVerifiedPayment({
        customerId: customer.customerId,
        gatewayReference: cleanPaymentId,
        categoryIds: customer.selectedCategoryIds || ['cat_india_startups'],
        paymentStatus: 'successful',
        paymentDate,
      });

      return res.json({
        ok: true,
        isDuplicate: result.isDuplicate,
        payment: result.payment,
        subscription: result.subscription,
        entitlements: result.entitlements,
      });
    } catch (err: any) {
      console.error('Payment processing error:', err);
      return res.status(400).json({ ok: false, error: err.message || 'Payment processing failed.' });
    }
  });

  /**
   * POST /api/payment/razorpay-webhook & /api/webhooks/razorpay
   * Path B: Authoritative server-to-server Razorpay Webhook (Step 7, 8, 9, 10)
   * Receives raw payload, cryptographically verifies HMAC-SHA256 signature with webhook secret.
   * Calls the same single authoritative processSuccessfulPayment function.
   */
  app.post(['/api/payment/razorpay-webhook', '/api/webhooks/razorpay'], (req, res) => {
    const signature = (req.headers['x-razorpay-signature'] as string) || '';
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);

    if (!signature) {
      return res.status(400).json({ ok: false, error: 'Missing x-razorpay-signature header.' });
    }

    // Step 7: Cryptographic HMAC-SHA256 signature verification
    const isVerified = verifyRazorpayWebhookSignature({
      rawBody,
      signature,
    });

    if (!isVerified) {
      console.warn('[Razorpay Webhook] Rejected webhook with invalid signature.');
      return res.status(400).json({ ok: false, error: 'Invalid webhook signature.' });
    }

    const event = req.body;
    const eventType = event?.event;

    if (!eventType || typeof eventType !== 'string') {
      return res.status(400).json({ ok: false, error: 'Malformed Razorpay event payload.' });
    }

    try {
      const eventPayment = event?.payload?.payment?.entity;
      const eventOrder = event?.payload?.order?.entity;
      const providerOrderId = eventPayment?.order_id || eventOrder?.id;
      const providerPaymentId = eventPayment?.id;

      if (eventType === 'order.paid' || eventType === 'payment.captured') {
        if (!providerOrderId || !providerPaymentId) {
          return res.status(400).json({ ok: false, error: 'Missing order_id or payment_id in payment event.' });
        }

        // Amount in paise in Razorpay payload -> convert to INR
        const amountInr = eventPayment?.amount ? Number((eventPayment.amount / 100).toFixed(2)) : undefined;
        const currency = eventPayment?.currency;

        processSuccessfulPayment({
          providerOrderId,
          providerPaymentId,
          amount: amountInr,
          currency,
          source: 'webhook',
        });

        return res.json({ status: 'ok' });
      }

      if (eventType === 'payment.failed') {
        if (providerOrderId || providerPaymentId) {
          processFailedPayment({
            providerOrderId,
            providerPaymentId,
            status: 'failed',
            errorReason: eventPayment?.error_description || 'Payment failed',
          });
        }
        return res.json({ status: 'ok' });
      }

      return res.json({ status: 'ignored' });
    } catch (err: any) {
      console.error('[Razorpay Webhook Error]:', err.message);
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/customer/orders (Phase 6.1)
   * Customer's private payment orders (Step 17: Scoped to customerId)
   */
  app.get('/api/customer/orders', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    const orders = getCustomerPaymentOrders(customer.customerId);
    return res.json({ ok: true, orders });
  });

  /**
   * GET /api/customer/subscriptions
   * Customer's private active subscriptions and entitlements (Section 12)
   */
  app.get('/api/customer/subscriptions', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    const subscriptions = getCustomerSubscriptions(customer.customerId);
    return res.json({ ok: true, subscriptions });
  });

  /**
   * GET /api/customer/payments
   * Customer's private payment history (Section 12)
   */
  app.get('/api/customer/payments', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    const payments = getCustomerPayments(customer.customerId);
    return res.json({ ok: true, payments });
  });

  /**
   * GET /api/customer/entitlements
   * Central authoritative source of paid category entitlement (Section 1 & 10)
   */
  app.get('/api/customer/entitlements', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    const evaluation = getCustomerActiveEntitlements(customer.customerId);
    return res.json({ ok: true, ...evaluation });
  });

  // ==========================================
  // TELEGRAM ACCOUNT CONNECTION APIS (Phase 4)
  // Private 1-to-1 connection, token security, strict privacy
  // ==========================================

  /**
   * POST /api/customer/telegram/token
   * Generates single-use cryptographically secure connection token (Section 4 & 5)
   */
  app.post('/api/customer/telegram/token', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
    }

    try {
      const tokenData = generateTelegramConnectionToken(customer.customerId);
      return res.json({
        ok: true,
        ...tokenData,
        isConfigured: isTelegramBotConfigured(),
      });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Could not generate Telegram token.' });
    }
  });

  /**
   * POST /api/customer/telegram/disconnect
   * Safely disconnects customer's Telegram account (Section 10)
   */
  app.post('/api/customer/telegram/disconnect', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
    }

    const result = disconnectTelegramAccount(customer.customerId);
    if (!result.success) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.json({ ok: true, message: 'Telegram account disconnected successfully.' });
  });

  /**
   * POST /api/customer/telegram/simulate-connect
   * Validates token and connects Telegram (supports sandbox/testing & direct verification)
   */
  app.post('/api/customer/telegram/simulate-connect', (req, res) => {
    const { token, telegramChatId, telegramUsername } = req.body || {};

    if (!token || !telegramChatId) {
      return res.status(400).json({ ok: false, error: 'Token and telegramChatId are required.' });
    }

    const result = connectTelegramAccount(String(token), String(telegramChatId), telegramUsername);
    if (!result.success) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.json({
      ok: true,
      message: 'Telegram successfully connected!',
      customerId: result.customerId,
    });
  });

  /**
   * GET /api/customer/telegram/status
   * Safe status check (never exposes other customers or raw Chat IDs)
   */
  app.get('/api/customer/telegram/status', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    return res.json({
      ok: true,
      telegramConnected: Boolean(customer.telegramConnected),
      isConfigured: isTelegramBotConfigured(),
      botUsername: getTelegramBotUsername(),
    });
  });

  /**
   * POST /api/telegram/webhook
   * Public Telegram Bot API webhook receiver for `/start <token>` (Section 1 & 4 & 12)
   * Verifies X-Telegram-Bot-Api-Secret-Token for production security.
   */
  app.post('/api/telegram/webhook', async (req, res) => {
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
    if (!verifyTelegramWebhookSecret(secretHeader as string | undefined)) {
      return res.status(403).json({ ok: false, error: 'Unauthorized webhook secret token' });
    }

    try {
      const update = req.body;
      const result = await processTelegramWebhookUpdate(update);
      return res.json({ ok: true, handled: result.handled });
    } catch (err: any) {
      console.error('Telegram webhook error:', err);
      return res.json({ ok: false, error: 'Webhook processing error' });
    }
  });

  // ==========================================================================
  // SYSTEM B: NEW INDIA NEWS TELEGRAM BOT ENDPOINTS
  // ==========================================================================

  /**
   * POST /api/customer/telegram-india/token
   * Generates single-use connection token for System B (India News Bot)
   */
  app.post('/api/customer/telegram-india/token', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    try {
      const tokenData = generateIndiaTelegramConnectionToken(customer.customerId);
      return res.json({
        ok: true,
        ...tokenData,
        isConfigured: isIndiaTelegramBotConfigured(),
      });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Token generation failed' });
    }
  });

  /**
   * GET /api/customer/telegram-india/status
   */
  app.get('/api/customer/telegram-india/status', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    return res.json({
      ok: true,
      indiaTelegramConnected: Boolean(customer.indiaTelegramConnected),
      isConfigured: isIndiaTelegramBotConfigured(),
      botUsername: getIndiaTelegramBotUsername(),
    });
  });

  /**
   * POST /api/customer/telegram-india/disconnect
   */
  app.post('/api/customer/telegram-india/disconnect', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    const result = disconnectIndiaTelegramAccount(customer.customerId);
    if (!result.success) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.json({ ok: true, message: 'Disconnected from India News Bot' });
  });

  /**
   * POST /api/telegram-india/webhook
   * Public Webhook for System B India Bot
   */
  app.post('/api/telegram-india/webhook', async (req, res) => {
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
    if (!verifyIndiaTelegramWebhookSecret(secretHeader as string | undefined)) {
      return res.status(403).json({ ok: false, error: 'Unauthorized India webhook secret token' });
    }

    try {
      const update = req.body;
      const result = await processIndiaTelegramWebhookUpdate(update);
      return res.json({ ok: true, handled: result.handled });
    } catch (err: any) {
      console.error('India Telegram webhook error:', err);
      return res.json({ ok: false, error: 'India webhook processing error' });
    }
  });

  /**
   * GET /api/customer/briefings
   * Returns daily executive news packages for categories the authenticated customer is entitled to (Phase 5)
   */
  app.get('/api/customer/briefings', (req, res) => {
    const sessionToken = getCustomerSessionToken(req);
    if (!sessionToken) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const customer = getCustomerBySessionToken(sessionToken);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }

    const targetDate = typeof req.query.date === 'string' ? req.query.date : getKolkataDateString();
    const evaluation = getCustomerActiveEntitlements(customer.customerId, new Date());

    if (!evaluation.isEligible || evaluation.entitledCategories.length === 0) {
      return res.json({
        ok: true,
        newsDate: targetDate,
        entitledCategories: [],
        packages: [],
        stories: [],
      });
    }

    const db = getDb();
    const entitledCatIds = new Set(evaluation.entitledCategories.map((c: any) => c.categoryId));

    const packages = db.dailyNewsPackages.filter(
      (p: DailyNewsPackage) => p.newsDate === targetDate && entitledCatIds.has(p.categoryId) && p.generationStatus === 'success'
    );

    const packageIds = new Set(packages.map((p: DailyNewsPackage) => p.packageId));
    const stories = db.newsStories
      .filter((s: NewsStory) => packageIds.has(s.packageId))
      .sort((a: NewsStory, b: NewsStory) => a.position - b.position);

    return res.json({
      ok: true,
      newsDate: targetDate,
      entitledCategories: evaluation.entitledCategories,
      packages,
      stories,
    });
  });

  // Public client-safe config info (NO secrets exposed)
  app.get('/api/admin/auth-status', (req, res) => {
    res.json({
      authorizedEmail: getAuthorizedAdminEmail(),
      isConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      hasClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
      hasClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    });
  });

  // ==========================================
  // GOOGLE OAUTH 2.0 ENDPOINTS
  // ==========================================

  /**
   * 1. /auth/google/login
   * Initiates Google OAuth 2.0 Authorization Code flow
   */
  app.get('/auth/google/login', (req, res) => {
    const clientIp = getClientIp(req);
    const redirectUri = getOAuthCallbackUrl(req);
    const state = crypto.randomBytes(32).toString('hex');

    // Store state in an HttpOnly cookie for CSRF verification on callback
    res.cookie('oauth_state', state, {
      httpOnly: true,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
      path: '/',
    });

    const { url, error } = generateGoogleAuthUrl(redirectUri, state);
    if (error || !url) {
      recordSecurityLog('GOOGLE_LOGIN_FAILED', clientIp, `Login initiate failed: ${error}`);
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Admin Configuration Notice - mydigitasset.com</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0c0a09; color: #f5f5f4; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              .card { background: #1c1917; border: 1px solid #44403c; border-radius: 16px; padding: 32px; max-width: 520px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
              h1 { color: #f59e0b; font-size: 20px; margin-top: 0; }
              p { font-size: 14px; line-height: 1.6; color: #d6d3d1; }
              code { background: #292524; color: #fbbf24; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
              a { display: inline-block; margin-top: 16px; background: #f59e0b; color: #0c0a09; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Google OAuth Credentials Required</h1>
              <p>Google OAuth 2.0 is the exclusive required Admin authentication method for <strong>mydigitasset.com</strong>.</p>
              <p>Please ensure <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> are set in your server environment variables.</p>
              <a href="/admin">← Return to Admin</a>
            </div>
          </body>
        </html>
      `);
    }

    recordSecurityLog('GOOGLE_LOGIN_INITIATED', clientIp, 'Google OAuth login flow started');
    return res.redirect(url);
  });

  /**
   * 2. /auth/google/callback
   * Exchanges code securely on server, cryptographically validates ID token,
   * verifies exact email match (mihirkapuria@gmail.com), and issues 8-hour HttpOnly session.
   */
  app.get('/auth/google/callback', async (req, res) => {
    const clientIp = getClientIp(req);
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      recordSecurityLog('GOOGLE_LOGIN_FAILED', clientIp, `Google OAuth error query: ${oauthError}`);
      return res.redirect('/admin?error=oauth_cancelled');
    }

    // A. Verify OAuth state against stored cookie (CSRF defense)
    const storedState = req.cookies?.oauth_state;
    res.clearCookie('oauth_state', { path: '/' });

    if (!state || !storedState || state !== storedState) {
      recordSecurityLog(
        'CSRF_VALIDATION_FAILED',
        clientIp,
        'OAuth state mismatch or missing on callback'
      );
      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Security Check Failed - mydigitasset.com</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0c0a09; color: #f5f5f4; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              .card { background: #1c1917; border: 1px solid #ef4444; border-radius: 16px; padding: 32px; max-width: 480px; text-align: center; }
              h1 { color: #ef4444; font-size: 20px; }
              p { font-size: 14px; color: #d6d3d1; line-height: 1.5; }
              a { display: inline-block; margin-top: 16px; background: #ef4444; color: white; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>OAuth State Verification Failed</h1>
              <p>The state verification parameter did not match. This protects against CSRF attacks. Please try logging in again.</p>
              <a href="/auth/google/login">Try Again</a>
            </div>
          </body>
        </html>
      `);
    }

    if (!code || typeof code !== 'string') {
      return res.redirect('/admin?error=missing_code');
    }

    // B. Exchange code and cryptographically verify ID token
    const redirectUri = getOAuthCallbackUrl(req);
    const verification = await exchangeCodeAndVerifyToken(code, redirectUri);

    if (!verification.valid || !verification.email) {
      recordSecurityLog(
        'GOOGLE_LOGIN_FAILED',
        clientIp,
        `Token verification failed: ${verification.error || 'Unknown'}`
      );
      return res.redirect(`/admin?error=${encodeURIComponent(verification.error || 'verification_failed')}`);
    }

    const authenticatedEmail = verification.email.toLowerCase();
    const authorizedEmail = getAuthorizedAdminEmail();

    // C. Strict single-email check: ONLY mihirkapuria@gmail.com
    if (authenticatedEmail !== authorizedEmail) {
      recordSecurityLog(
        'GOOGLE_LOGIN_UNAUTHORIZED_ACCOUNT',
        clientIp,
        `Unauthorized Google account rejected: ${authenticatedEmail}`,
        authenticatedEmail
      );

      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Access Denied - mydigitasset.com Admin</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0c0a09; color: #f5f5f4; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              .card { background: #1c1917; border: 1px solid #ef4444; border-radius: 16px; padding: 32px; max-width: 480px; text-align: center; }
              h1 { color: #ef4444; font-size: 20px; }
              p { font-size: 14px; color: #d6d3d1; line-height: 1.6; }
              .bad-email { font-family: monospace; background: #292524; color: #f87171; padding: 3px 8px; border-radius: 4px; }
              a { display: inline-block; margin-top: 16px; background: #292524; color: #f5f5f4; border: 1px solid #57534e; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; }
              a:hover { background: #44403c; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Access Denied</h1>
              <p>The Google account <span class="bad-email">${authenticatedEmail}</span> is not authorized to access the Admin system of <strong>mydigitasset.com</strong>.</p>
              <p>Only the designated administrator Google account has access.</p>
              <a href="/auth/google/login">Sign in with Authorized Account</a>
            </div>
          </body>
        </html>
      `);
    }

    // D. Create secure 8-hour Admin session
    const { sessionToken, csrfToken } = createAdminSession(
      authenticatedEmail,
      clientIp,
      verification.name,
      verification.picture
    );

    // E. Set secure HttpOnly session cookie (~8 hours)
    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_LIFETIME_MS,
      path: '/',
    });

    // F. Set CSRF cookie (readable by frontend JS for x-csrf-token header)
    res.cookie('admin_csrf', csrfToken, {
      httpOnly: false,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_LIFETIME_MS,
      path: '/',
    });

    recordSecurityLog(
      'GOOGLE_LOGIN_SUCCESS',
      clientIp,
      `Administrator successfully authenticated via Google`,
      authenticatedEmail
    );

    // Redirect authorized admin to /admin
    return res.redirect('/admin');
  });

  /**
   * POST /api/admin/verify-google-token
   * Explicitly validates Google ID token:
   * 1. Valid cryptographic signature against Google public keys
   * 2. Correct OAuth audience (matches server GOOGLE_CLIENT_ID)
   * 3. email === 'mihirkapuria@gmail.com'
   * 4. email_verified === true
   * 5. Token has not expired (exp > now)
   */
  app.post('/api/admin/verify-google-token', async (req, res) => {
    const clientIp = getClientIp(req);
    const { idToken } = req.body || {};

    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing Google ID token.' });
    }

    const verification = await verifyGoogleIdTokenDirect(idToken.trim());
    if (!verification.valid || !verification.email) {
      recordSecurityLog(
        'GOOGLE_LOGIN_FAILED',
        clientIp,
        `Direct token verification failed: ${verification.error || 'Invalid token'}`
      );
      return res.status(401).json({ ok: false, error: verification.error || 'Google ID token verification failed.' });
    }

    const authenticatedEmail = verification.email.toLowerCase();
    const authorizedEmail = getAuthorizedAdminEmail();

    if (authenticatedEmail !== authorizedEmail) {
      recordSecurityLog(
        'GOOGLE_LOGIN_UNAUTHORIZED_ACCOUNT',
        clientIp,
        `Unauthorized Google account rejected: ${authenticatedEmail}`,
        authenticatedEmail
      );
      return res.status(403).json({
        ok: false,
        error: `Access denied. Account ${authenticatedEmail} is not authorized.`,
      });
    }

    const { sessionToken, csrfToken } = createAdminSession(
      authenticatedEmail,
      clientIp,
      verification.name,
      verification.picture
    );

    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_LIFETIME_MS,
      path: '/',
    });

    res.cookie('admin_csrf', csrfToken, {
      httpOnly: false,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_LIFETIME_MS,
      path: '/',
    });

    recordSecurityLog(
      'GOOGLE_LOGIN_SUCCESS',
      clientIp,
      'Administrator successfully authenticated via verified Google ID token',
      authenticatedEmail
    );

    return res.json({
      ok: true,
      email: authenticatedEmail,
      csrfToken,
    });
  });

  /**
   * 3. /auth/google/logout & /api/admin/logout
   */
  const handleLogout = (req: express.Request, res: express.Response) => {
    const clientIp = getClientIp(req);
    const sessionToken = req.cookies?.admin_session;

    if (sessionToken) {
      invalidateAdminSession(sessionToken);
    }

    res.clearCookie('admin_session', { path: '/' });
    res.clearCookie('admin_csrf', { path: '/' });

    recordSecurityLog('ADMIN_LOGOUT', clientIp, 'Administrator logged out');

    if (req.path.startsWith('/auth/')) {
      return res.redirect('/');
    }
    return res.json({ success: true });
  };

  app.get('/auth/google/logout', handleLogout);
  app.post('/api/admin/logout', handleLogout);

  /**
   * 4. /api/admin/session
   * Verifies current session from HttpOnly cookie
   */
  app.get('/api/admin/session', (req, res) => {
    const sessionToken = req.cookies?.admin_session;
    if (!sessionToken) {
      return res.json({ authenticated: false });
    }

    const session = validateAdminSession(sessionToken);
    if (!session) {
      return res.json({ authenticated: false });
    }

    const authorizedEmail = getAuthorizedAdminEmail();
    if (session.email.toLowerCase() !== authorizedEmail) {
      invalidateAdminSession(sessionToken);
      res.clearCookie('admin_session', { path: '/' });
      res.clearCookie('admin_csrf', { path: '/' });
      return res.json({ authenticated: false });
    }

    return res.json({
      authenticated: true,
      csrfToken: session.csrfToken,
      user: {
        email: session.email,
        name: session.name,
        picture: session.picture,
      },
    });
  });

  // ==========================================
  // SENSITIVE ADMIN APIS (Protected by requireAdminAuth)
  // ==========================================

  // Admin Site Settings (GET/POST)
  app.get('/api/admin/settings', requireAdminAuth, (req, res) => {
    const custom = loadPersistedSettings();
    res.json({ settings: custom });
  });

  app.post('/api/admin/settings', requireAdminAuth, (req, res) => {
    const { settings } = req.body || {};
    if (settings) {
      savePersistedSettings(settings);
      const clientIp = getClientIp(req);
      const adminEmail = (req as any).adminSession?.email;
      recordSecurityLog('SETTINGS_UPDATED', clientIp, 'Admin updated global website settings', adminEmail);
      return res.json({ success: true });
    }
    return res.status(400).json({ error: 'Invalid settings payload' });
  });

  // Security Audit Logs
  app.get('/api/admin/logs', requireAdminAuth, (req, res) => {
    res.json({ logs: getSecurityLogs() });
  });

  // Admin-only: Customers list (Section 14: Never exposed to non-admins)
  app.get('/api/admin/customers', requireAdminAuth, (req, res) => {
    const customers = getAdminCustomersList();
    res.json({ ok: true, customers });
  });

  // Admin-only: Payments list (Section 13)
  app.get('/api/admin/payments', requireAdminAuth, (req, res) => {
    const payments = getAllPaymentsForAdmin();
    res.json({ ok: true, payments });
  });

  // Admin-only: Subscriptions with category entitlements (Section 13)
  app.get('/api/admin/subscriptions', requireAdminAuth, (req, res) => {
    const subscriptions = getAllSubscriptionsForAdmin();
    res.json({ ok: true, subscriptions });
  });

  /**
   * POST /api/admin/confirm-payment (Stage 2 Section 14)
   * Admin confirms payment and triggers authoritative date calculation:
   *   bufferStartDate = adminConfirmedPaymentDate
   *   bufferEndDate   = adminConfirmedPaymentDate + 4 days
   *   paidStartDate   = adminConfirmedPaymentDate + 5 days
   *   paidEndDate     = paidStartDate + 12 calendar months
   */
  app.post('/api/admin/confirm-payment', requireAdminAuth, (req, res) => {
    const adminEmail = (req as any).adminSession?.email || getAuthorizedAdminEmail();
    const { customerId, paymentId, confirmedPaymentDate, categoryIds, amount, reference } = req.body || {};

    if (!customerId) {
      return res.status(400).json({ ok: false, error: 'customerId is mandatory for payment confirmation.' });
    }

    try {
      const result = confirmPaymentByAdmin({
        customerId,
        paymentId,
        confirmedPaymentDate,
        categoryIds,
        amount,
        reference,
        adminEmail,
      });

      const clientIp = getClientIp(req);
      recordSecurityLog(
        'SETTINGS_UPDATED',
        clientIp,
        `Admin confirmed payment for customer ${customerId}. Subscription activated with 5-day continuous buffer and 12-month paid period.`,
        adminEmail
      );

      return res.json({
        ok: true,
        success: true,
        payment: result.payment,
        subscription: result.subscription,
        entitlements: result.entitlements,
      });
    } catch (err: any) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/admin/trial/send-day3-reminder (DEPRECATED - Stage 3 Automated Lifecycle)
   * The Day-3 trial payment reminder is 100% automated by the background scheduler.
   * Admins are never required to trigger, approve, or send reminders.
   */
  app.post('/api/admin/trial/send-day3-reminder', requireAdminAuth, (_req, res) => {
    return res.status(410).json({
      ok: false,
      deprecated: true,
      error: 'Manual reminder endpoint removed: Day-3 trial reminders are 100% automated by the background scheduler with persistent idempotency. No admin action is required.',
    });
  });

  /**
   * GET /api/admin/delivery/eligibility/:customerId (Stage 2 Section 15)
   * Admin inspection of news delivery eligibility and active phase.
   */
  app.get('/api/admin/delivery/eligibility/:customerId', requireAdminAuth, (req, res) => {
    const { customerId } = req.params;
    const targetDate = req.query.date ? new Date(String(req.query.date)) : new Date();
    const evaluation = evaluateNewsDeliveryEligibility(customerId, targetDate);
    return res.json({ ok: true, evaluation });
  });

  // ==========================================
  // ADMIN CATEGORY TRANSFERS & AUDIT (Phase 3)
  // Protected strictly by requireAdminAuth
  // ==========================================

  /**
   * POST /api/admin/transfer-category
   * Executes administrative category transfer with validations and immutable audit logging (Section 3, 4, 5, 6, 7, 12)
   */
  app.post('/api/admin/transfer-category', requireAdminAuth, (req, res) => {
    const adminEmail = (req as any).adminSession?.email || getAuthorizedAdminEmail();
    const { customerId, subscriptionId, oldCategoryId, newCategoryId, reason } = req.body || {};

    if (!customerId || !oldCategoryId || !newCategoryId) {
      return res.status(400).json({
        ok: false,
        error: 'customerId, oldCategoryId, and newCategoryId are mandatory.',
      });
    }

    const result = executeAdminCategoryTransfer({
      customerId,
      subscriptionId,
      oldCategoryId,
      newCategoryId,
      adminEmail,
      reason,
    });

    if (!result.success) {
      return res.status(400).json({
        ok: false,
        error: result.error,
        audit: result.audit,
      });
    }

    return res.json({
      ok: true,
      audit: result.audit,
      subscription: result.subscription,
      activeEntitlements: result.activeEntitlements,
    });
  });

  /**
   * GET /api/admin/transfers
   * Retrieves category transfer audit log (Section 12)
   */
  app.get('/api/admin/transfers', requireAdminAuth, (req, res) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
    const audits = getCategoryTransferAuditLogs(customerId);
    return res.json({ ok: true, audits });
  });

  /**
   * PATCH /api/admin/category-status
   * Activates or deactivates a category (Section 8)
   */
  app.patch('/api/admin/category-status', requireAdminAuth, (req, res) => {
    const adminEmail = (req as any).adminSession?.email || getAuthorizedAdminEmail();
    const { categoryId, isActive } = req.body || {};

    if (!categoryId || typeof isActive !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'categoryId and boolean isActive are required.' });
    }

    const result = setCategoryStatus(categoryId, isActive, adminEmail);
    if (!result.success) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.json({ ok: true, category: result.category });
  });

  /**
   * POST /api/admin/categories
   * Creates a brand new category in the catalog (Section 9)
   */
  app.post('/api/admin/categories', requireAdminAuth, (req, res) => {
    const { name, slug, description } = req.body || {};
    const result = createNewCatalogCategory({ name, slug, description });

    if (!result.success) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.json({ ok: true, category: result.category });
  });

  /**
   * GET /api/admin/telegram/audits
   * Retrieves all Telegram connection audit events (Section 16)
   */
  app.get('/api/admin/telegram/audits', requireAdminAuth, (req, res) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
    const audits = getTelegramAuditLogs(customerId);
    return res.json({ ok: true, audits });
  });

  // ==========================================
  // DAILY NEWS GENERATION & TELEGRAM DELIVERY (Phase 5)
  // Protected strictly by requireAdminAuth
  // ==========================================

  /**
   * POST /api/admin/news/generate
   * Generates 100 stories across the 10 India categories (10 stories each)
   */
  app.post('/api/admin/news/generate', requireAdminAuth, async (req, res) => {
    const { categoryId, newsDate } = req.body || {};
    const targetDate = newsDate || getKolkataDateString();

    try {
      if (categoryId) {
        const result = await generateCategoryDailyNews(categoryId, targetDate);
        if (!result.success) {
          return res.status(400).json({ ok: false, error: result.error });
        }
        return res.json({ ok: true, package: result.package, stories: result.stories });
      }

      const batchResult = await generateDailyAllCategoriesNews(targetDate);
      return res.json({ ok: true, ...batchResult });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Generation failed' });
    }
  });

  /**
   * GET /api/admin/news/packages
   */
  app.get('/api/admin/news/packages', requireAdminAuth, (req, res) => {
    const db = getDb();
    const date = typeof req.query.date === 'string' ? req.query.date : getKolkataDateString();
    const packages = db.dailyNewsPackages.filter((p: DailyNewsPackage) => p.newsDate === date);
    return res.json({ ok: true, newsDate: date, packages });
  });

  /**
   * GET /api/admin/news/stories
   */
  app.get('/api/admin/news/stories', requireAdminAuth, (req, res) => {
    const db = getDb();
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined;
    const newsDate = typeof req.query.newsDate === 'string' ? req.query.newsDate : undefined;

    let stories = db.newsStories;
    if (categoryId) stories = stories.filter((s: NewsStory) => s.categoryId === categoryId);
    if (newsDate) stories = stories.filter((s: NewsStory) => s.newsDate === newsDate);

    stories.sort((a: NewsStory, b: NewsStory) => a.position - b.position);
    return res.json({ ok: true, stories });
  });

  /**
   * POST /api/admin/delivery/run
   * Triggers the daily morning delivery run to all eligible Telegram subscribers
   */
  app.post('/api/admin/delivery/run', requireAdminAuth, async (req, res) => {
    const { newsDate } = req.body || {};
    const targetDate = newsDate || getKolkataDateString();

    try {
      const summary = await deliverDailyBriefingsToAllEligibleCustomers(targetDate);
      return res.json({ ok: true, summary });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Delivery run error' });
    }
  });

  /**
   * GET /api/admin/delivery/stats
   */
  app.get('/api/admin/delivery/stats', requireAdminAuth, (req, res) => {
    const newsDate = typeof req.query.newsDate === 'string' ? req.query.newsDate : undefined;
    const stats = getDeliveryStatistics(newsDate);
    return res.json({ ok: true, ...stats });
  });

  // ==========================================================================
  // SYSTEM B: NEW INDIA NEWS ADMIN CONTROLS
  // ==========================================================================

  /**
   * GET /api/admin/india/status
   * Returns complete health, category status, and bot state for System B
   */
  app.get('/api/admin/india/status', requireAdminAuth, (_req, res) => {
    const db = getDb();
    const indiaCats = db.categories.filter(
      (c) => c.system === 'india' || INDIA_CATEGORY_IDS.includes(c.id as any)
    );
    return res.json({
      ok: true,
      system: 'SYSTEM B — NEW INDIA NEWS',
      totalCategories: indiaCats.length,
      activeCategoriesCount: indiaCats.filter((c) => c.isActive).length,
      categories: indiaCats,
      botConfigured: isIndiaTelegramBotConfigured(),
      botUsername: getIndiaTelegramBotUsername(),
    });
  });

  /**
   * POST /api/admin/india/delivery/run
   * Dispatches System B daily briefings via separate India Telegram bot
   */
  app.post('/api/admin/india/delivery/run', requireAdminAuth, async (req, res) => {
    const { newsDate } = req.body || {};
    const targetDate = newsDate || getKolkataDateString();

    try {
      const summary = await deliverDailyIndiaBriefingsToAllEligibleCustomers(targetDate);
      return res.json({ ok: true, summary });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'India delivery run error' });
    }
  });

  /**
   * GET /api/admin/india/delivery/stats
   */
  app.get('/api/admin/india/delivery/stats', requireAdminAuth, (req, res) => {
    const newsDate = typeof req.query.newsDate === 'string' ? req.query.newsDate : undefined;
    const stats = getIndiaDeliveryStatistics(newsDate);
    return res.json({ ok: true, ...stats });
  });

  /**
   * GET /api/admin/india/reliability-status
   * Stage 3 Reliability Hardening: System B health, partial package status, and recovery metrics
   */
  app.get('/api/admin/india/reliability-status', requireAdminAuth, (req, res) => {
    const newsDate = typeof req.query.newsDate === 'string' ? req.query.newsDate : undefined;
    const status = getIndiaReliabilityStatus(newsDate);
    return res.json({ ok: true, status });
  });

  /**
   * POST /api/admin/india/reconcile
   * Triggers the System B watchdog reconciliation loop immediately
   */
  app.post('/api/admin/india/reconcile', requireSchedulerOrAdminAuth, async (req, res) => {
    const { newsDate, forceRecoveryWindow } = req.body || {};
    try {
      const report = await runIndiaReliabilityWatchdog({ newsDate, forceRecoveryWindow });
      return res.json({ ok: true, report });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Reconciliation failed' });
    }
  });

  // ==========================================================================
  // SYSTEM A: SPECIALIST NEWS ADMIN CONTROLS
  // ==========================================================================

  /**
   * GET /api/admin/specialist/status
   */
  app.get('/api/admin/specialist/status', requireAdminAuth, (_req, res) => {
    const db = getDb();
    const specCats = db.categories.filter(
      (c) => c.system === 'specialist' || SPECIALIST_CATEGORY_IDS.includes(c.id as any)
    );
    return res.json({
      ok: true,
      system: 'SYSTEM A — EXISTING SPECIALIST NEWS',
      totalCategories: specCats.length,
      activeCategoriesCount: specCats.filter((c) => c.isActive).length,
      categories: specCats,
      botConfigured: isTelegramBotConfigured(),
      botUsername: getTelegramBotUsername(),
    });
  });

  /**
   * POST /api/admin/specialist/news/generate
   */
  app.post('/api/admin/specialist/news/generate', requireAdminAuth, async (req, res) => {
    const { categoryId, newsDate } = req.body || {};
    const targetDate = newsDate || getKolkataDateString();

    try {
      if (categoryId) {
        const result = await generateSpecialistCategoryDailyNews(categoryId, targetDate);
        if (!result.success) {
          return res.status(400).json({ ok: false, error: result.error });
        }
        return res.json({ ok: true, package: result.package, stories: result.stories });
      }

      const batchResult = await generateDailyAllSpecialistNews(targetDate);
      return res.json({ ok: true, ...batchResult });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Specialist generation error' });
    }
  });

  /**
   * GET /api/admin/scheduler/status
   * Returns current scheduler state, Asia/Kolkata morning window, and last run dates
   */
  app.get('/api/admin/scheduler/status', requireAdminAuth, (req, res) => {
    const status = getSchedulerStatus();
    return res.json({ ok: true, scheduler: status });
  });

  /**
   * POST /api/admin/scheduler/trigger
   * Triggers scheduled execution cycle.
   * Authenticated via Google Cloud Scheduler OIDC Service Account Bearer Token OR Admin Session.
   */
  app.post('/api/admin/scheduler/trigger', requireSchedulerOrAdminAuth, async (req, res) => {
    const { newsDate, action } = req.body || {};
    try {
      const result = await triggerManualSchedulerRun(newsDate, action || 'all');
      return res.json({ ok: true, result });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Trigger error' });
    }
  });

  /**
   * GET /api/admin/sheet-sync/status
   * Stage 3C: Returns current Firestore -> Google Sheet synchronization state and stats.
   * NEVER returns or exposes secrets.
   */
  app.get('/api/admin/sheet-sync/status', requireAdminAuth, async (_req, res) => {
    try {
      const checkpoint = await getSheetSyncCheckpoint();
      return res.json({
        ok: true,
        spreadsheetId: TARGET_SPREADSHEET_ID,
        configured: Boolean(process.env.APPS_SCRIPT_WEBAPP_URL),
        secretConfigured: Boolean(process.env.SHEET_SYNC_SECRET),
        lastSyncStartedAt: checkpoint.lastSyncStartedAt,
        lastSyncCompletedAt: checkpoint.lastSyncCompletedAt,
        lastSyncStatus: checkpoint.lastSyncStatus,
        lastSyncError: checkpoint.lastSyncError,
        totalSyncRuns: checkpoint.totalSyncRuns,
        highWaterMarks: checkpoint.highWaterMarks,
        lastStats: checkpoint.lastStats,
      });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Failed to retrieve sync status' });
    }
  });

  /**
   * POST /api/admin/sheet-sync/trigger
   * Stage 3C: Manually triggers Firestore -> Google Sheet synchronization cycle.
   */
  app.post('/api/admin/sheet-sync/trigger', requireAdminAuth, async (req, res) => {
    const forceFullSync = Boolean(req.body && req.body.forceFullSync);
    try {
      const result = await executeFirestoreToSheetSync({ forceFullSync });
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Failed to execute sheet sync' });
    }
  });

  /**
   * GET /api/admin/sources
   * Returns configured live RSS/Atom feeds and active source provider mode (Phase 5.1)
   */
  app.get('/api/admin/sources', requireAdminAuth, (req, res) => {
    return res.json({
      ok: true,
      providerMode: getSourceProviderMode(),
      sources: OFFICIAL_LIVE_FEEDS,
    });
  });

  // Upload Security Validator
  app.post('/api/admin/upload-validate', requireAdminAuth, (req, res) => {
    const { originalFilename, base64Content, allowedTypes } = req.body || {};
    if (!originalFilename || !base64Content) {
      return res.status(400).json({ error: 'Filename and base64 content are required' });
    }

    try {
      const buffer = Buffer.from(base64Content, 'base64');
      const permitted = Array.isArray(allowedTypes) ? allowedTypes : ['pdf', 'png', 'jpg', 'docx'];
      const result = validateUploadFile(buffer, originalFilename, permitted);

      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ valid: false, error: err.message || 'Validation error' });
    }
  });

  // ==========================================
  // VITE / SPA HANDLING
  // ==========================================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Google OAuth Admin System active. Authorized email: ${getAuthorizedAdminEmail()}`);
    // Start automated daily scheduler (06:00 - 07:00 AM IST)
    startDailyScheduler();
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
