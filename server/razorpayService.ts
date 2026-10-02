import crypto from 'crypto';

/**
 * ============================================================================
 * PHASE 6.1: RAZORPAY PRODUCTION PAYMENT SERVICE & SIGNATURE VERIFICATION
 * ============================================================================
 * Implements official Razorpay API integration, HMAC-SHA256 signature verification,
 * raw webhook payload authenticity verification, and test/live environment separation.
 */

export type PaymentProviderMode = 'test' | 'live';

export interface RazorpayConfig {
  mode: PaymentProviderMode;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  isSimulatedTest: boolean;
}

export interface CreateOrderParams {
  paymentOrderId: string;
  amountInr: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, string>;
  customFetch?: typeof fetch;
  timeoutMs?: number;
}

export interface RazorpayOrderResult {
  id: string; // Razorpay order_... ID
  amount: number; // in paise
  currency: string;
  status: string;
  receipt?: string;
}

export interface VerifyPaymentParams {
  orderId: string;
  paymentId: string;
  signature: string;
  keySecret?: string;
}

export interface VerifyWebhookParams {
  rawBody: string | Buffer;
  signature: string;
  webhookSecret?: string;
}

/**
 * Global provider mode switch
 */
let currentPaymentMode: PaymentProviderMode =
  (process.env.PAYMENT_PROVIDER_MODE?.toLowerCase() as PaymentProviderMode) || 'test';

export function getPaymentProviderMode(): PaymentProviderMode {
  return currentPaymentMode;
}

export function setPaymentProviderMode(mode: PaymentProviderMode): void {
  currentPaymentMode = mode;
  console.log(`[Payment Engine] Provider mode set to: ${mode.toUpperCase()}`);
}

/**
 * Default mock secrets used exclusively for local deterministic offline testing
 */
export const TEST_MOCK_KEY_ID = 'rzp_test_mydigitasset_mock_001';
export const TEST_MOCK_KEY_SECRET = 'test_mock_secret_key_mydigitasset_61';
export const TEST_MOCK_WEBHOOK_SECRET = 'test_mock_webhook_secret_mydigitasset_61';

/**
 * Retrieves and validates the active Razorpay configuration based on PAYMENT_PROVIDER_MODE
 */
export function getRazorpayConfig(): RazorpayConfig {
  const mode = getPaymentProviderMode();

  if (mode === 'live') {
    const keyId = process.env.RAZORPAY_LIVE_KEY_ID || process.env.RAZORPAY_KEY_ID || '';
    const keySecret = process.env.RAZORPAY_LIVE_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET || '';
    const webhookSecret = process.env.RAZORPAY_LIVE_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET || '';

    // Step 19 & Test AC: Live mode MUST require live credentials starting with 'rzp_live_'
    if (!keyId || !keySecret || !webhookSecret) {
      throw new Error(
        'LIVE PAYMENT CONFIGURATION ERROR: Missing required Razorpay live credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET).'
      );
    }

    if (!keyId.startsWith('rzp_live_')) {
      throw new Error(
        `LIVE PAYMENT CONFIGURATION ERROR: Invalid live Key ID '${keyId}'. Production credentials must start with 'rzp_live_'.`
      );
    }

    return {
      mode: 'live',
      keyId,
      keySecret,
      webhookSecret,
      isSimulatedTest: false,
    };
  }

  // Test mode
  const keyId = process.env.RAZORPAY_TEST_KEY_ID || process.env.RAZORPAY_KEY_ID || '';
  const keySecret = process.env.RAZORPAY_TEST_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET || '';
  const webhookSecret = process.env.RAZORPAY_TEST_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET || '';

  // Test AD: Test mode cannot accidentally use live credentials
  if (keyId.startsWith('rzp_live_')) {
    throw new Error(
      'ENVIRONMENT SAFETY VIOLATION: Test mode cannot be used with production live credentials (rzp_live_...).'
    );
  }

  if (keyId && keySecret && webhookSecret) {
    return {
      mode: 'test',
      keyId,
      keySecret,
      webhookSecret,
      isSimulatedTest: false,
    };
  }

  // Offline deterministic test mode
  return {
    mode: 'test',
    keyId: TEST_MOCK_KEY_ID,
    keySecret: TEST_MOCK_KEY_SECRET,
    webhookSecret: TEST_MOCK_WEBHOOK_SECRET,
    isSimulatedTest: true,
  };
}

/**
 * Public configuration safe to expose to browser client
 */
export function getPublicRazorpayConfig(): { mode: PaymentProviderMode; keyId: string } {
  const config = getRazorpayConfig();
  return {
    mode: config.mode,
    keyId: config.keyId,
  };
}

/**
 * Creates a Razorpay order according to official API standards (amounts in paise).
 */
export async function createRazorpayOrder(params: CreateOrderParams): Promise<RazorpayOrderResult> {
  const config = getRazorpayConfig();
  const fetchFn = params.customFetch || fetch;

  const amountPaise = Math.round(params.amountInr * 100);
  const currency = params.currency || 'INR';
  const receipt = params.receipt || `rcpt_${params.paymentOrderId.substring(0, 30)}`;

  if (amountPaise <= 0) {
    throw new Error('Invalid order amount: Amount must be greater than zero.');
  }

  // If live mode or test mode with real configured API credentials, or customFetch provided for testing
  if (!config.isSimulatedTest || params.customFetch) {
    const authHeader = 'Basic ' + Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');
    const controller = new AbortController();
    const timeoutDuration = params.timeoutMs || 8000;
    const timeout = setTimeout(() => controller.abort(), timeoutDuration);

    try {
      const response = await fetchFn('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency,
          receipt,
          notes: params.notes || {},
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Razorpay API order creation failed (HTTP ${response.status}): ${errorBody}`);
      }

      const data = (await response.json()) as any;
      return {
        id: data.id,
        amount: data.amount,
        currency: data.currency,
        status: data.status || 'created',
        receipt: data.receipt,
      };
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error(`Razorpay API request timed out after ${timeoutDuration}ms.`);
      }
      throw err;
    }
  }

  // Simulated test mode (offline deterministic test suite)
  const simulatedId = `order_${crypto.randomBytes(10).toString('hex')}`;
  return {
    id: simulatedId,
    amount: amountPaise,
    currency,
    status: 'created',
    receipt,
  };
}

/**
 * Verifies Razorpay checkout browser callback signature using HMAC-SHA256
 * Algorithm: HMAC-SHA256(order_id + '|' + payment_id, secret) === signature
 */
export function verifyRazorpayPaymentSignature(params: VerifyPaymentParams): boolean {
  if (!params.orderId || !params.paymentId || !params.signature) {
    return false;
  }

  const config = getRazorpayConfig();
  const secret = params.keySecret || config.keySecret;
  const payload = `${params.orderId}|${params.paymentId}`;

  try {
    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const actualBuffer = Buffer.from(params.signature, 'utf8');

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  } catch (err) {
    console.error('[Razorpay Signature Error]:', err);
    return false;
  }
}

/**
 * Verifies Razorpay webhook raw payload signature using HMAC-SHA256
 * Algorithm: HMAC-SHA256(raw_body, webhook_secret) === x-razorpay-signature
 */
export function verifyRazorpayWebhookSignature(params: VerifyWebhookParams): boolean {
  if (!params.rawBody || !params.signature) {
    return false;
  }

  const config = getRazorpayConfig();
  const secret = params.webhookSecret || config.webhookSecret;

  try {
    const rawBuffer = Buffer.isBuffer(params.rawBody)
      ? params.rawBody
      : Buffer.from(params.rawBody, 'utf8');

    const expectedSignature = crypto.createHmac('sha256', secret).update(rawBuffer).digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const actualBuffer = Buffer.from(params.signature, 'utf8');

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  } catch (err) {
    console.error('[Razorpay Webhook Signature Error]:', err);
    return false;
  }
}

/**
 * Helper to generate valid signatures in tests
 */
export function generateTestPaymentSignature(orderId: string, paymentId: string, secret?: string): string {
  const s = secret || getRazorpayConfig().keySecret;
  return crypto.createHmac('sha256', s).update(`${orderId}|${paymentId}`).digest('hex');
}

export function generateTestWebhookSignature(rawBody: string | Buffer, secret?: string): string {
  const s = secret || getRazorpayConfig().webhookSecret;
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  return crypto.createHmac('sha256', s).update(buf).digest('hex');
}
