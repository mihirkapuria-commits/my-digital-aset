/**
 * Client Adapter for MyDigitAsset Google Apps Script Backend
 * Enables serverless communication between the GitHub Pages React SPA and Google Sheets / Apps Script.
 */

// Stored in localStorage or Vite env
const SCRIPT_URL_STORAGE_KEY = 'mda_apps_script_url';
const CUSTOMER_SESSION_KEY = 'mda_customer_secret_token';

export interface PublicPaymentConfig {
  configVersion: number;
  pricing: {
    currency: string;
    basePrice: number;
    gstRatePercent: number;
    billingPeriod: string;
  };
  upi: {
    enabled: boolean;
    upiId: string;
    beneficiaryName: string;
    qrCodeEnabled: boolean;
    qrCodeImageUrl: string;
  };
  bankTransfer?: {
    accountHolderName: string;
    bankName: string;
    accountNumber: string; // May be masked e.g. "******4589"
    ifscCode: string;
    accountType: string;
    branchName: string;
  } | null;
  referenceValidation: {
    minLength: number;
    maxLength: number;
    allowedPattern: string;
    customerInstructions: string;
  };
  telegramBotUsername: string;
}

// Fallback configuration if Apps Script URL has not yet been pasted by the admin
export const DEFAULT_PAYMENT_CONFIG: PublicPaymentConfig = {
  configVersion: 1,
  pricing: {
    currency: 'INR',
    basePrice: 252.0,
    gstRatePercent: 18,
    billingPeriod: 'yearly',
  },
  upi: {
    enabled: true,
    upiId: 'mihirkapuria@gmail.com',
    beneficiaryName: 'MyDigitAsset Media',
    qrCodeEnabled: true,
    qrCodeImageUrl: '',
  },
  bankTransfer: null,
  referenceValidation: {
    minLength: 6,
    maxLength: 35,
    allowedPattern: '^[a-zA-Z0-9_-]+$',
    customerInstructions: 'Please enter your 12-digit UPI reference (UTR) or bank transaction ID.',
  },
  telegramBotUsername: 'MyDigitAssetNewsBot',
};

export function getAppsScriptUrl(): string {
  if (typeof window === 'undefined') return '';
  const stored = localStorage.getItem(SCRIPT_URL_STORAGE_KEY);
  if (stored) return stored.trim();
  return (import.meta.env.VITE_APPS_SCRIPT_URL || '').trim();
}

export function setAppsScriptUrl(url: string) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SCRIPT_URL_STORAGE_KEY, url.trim());
}

export function getStoredCustomerSecret(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(CUSTOMER_SESSION_KEY);
}

export function setStoredCustomerSecret(token: string) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CUSTOMER_SESSION_KEY, token);
}

export function clearStoredCustomerSecret() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(CUSTOMER_SESSION_KEY);
}

/**
 * Fetch Public Payment & Banking Configuration
 */
export async function fetchPublicPaymentConfig(): Promise<PublicPaymentConfig> {
  const url = getAppsScriptUrl();
  if (!url) {
    return DEFAULT_PAYMENT_CONFIG;
  }

  try {
    const res = await fetch(`${url}?action=getPublicConfig`, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      return data as PublicPaymentConfig;
    }
    return DEFAULT_PAYMENT_CONFIG;
  } catch (err) {
    console.warn('[AppsScriptClient] Could not fetch live payment config, using fallback:', err);
    return DEFAULT_PAYMENT_CONFIG;
  }
}

/**
 * Register 3-Day Free Trial
 */
export async function registerFreeTrial(params: {
  fullName: string;
  mobileNumber: string;
  mobileCountryCode?: string;
  email?: string;
  categoryId?: string;
  categoryName?: string;
}): Promise<{
  ok: boolean;
  customerId: string;
  customerSecretToken: string;
  subscriptionId: string;
  state: string;
  trialStartDate: string;
  trialEndDate: string;
  telegramDeepLink: string;
  telegramToken: string;
  error?: string;
}> {
  const url = getAppsScriptUrl();
  if (!url) {
    // Local demo / simulated fallback if script URL not yet set
    const mockToken = `csec_${Date.now()}_mock`;
    setStoredCustomerSecret(mockToken);
    return {
      ok: true,
      customerId: `cust_${Date.now()}`,
      customerSecretToken: mockToken,
      subscriptionId: `sub_${Date.now()}`,
      state: 'TRIAL_ACTIVE',
      trialStartDate: new Date().toISOString().split('T')[0],
      trialEndDate: new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0],
      telegramDeepLink: `https://t.me/MyDigitAssetNewsBot?start=tgtok_mock_${Date.now()}`,
      telegramToken: `tgtok_mock_${Date.now()}`,
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      action: 'registerTrial',
      ...params,
    }),
  });

  const data = await res.json();
  if (data.ok && data.customerSecretToken) {
    setStoredCustomerSecret(data.customerSecretToken);
  }
  return data;
}

/**
 * Generate fresh single-use Telegram connection token
 */
export async function generateTelegramToken(secretToken: string): Promise<{
  ok: boolean;
  token?: string;
  deepLink?: string;
  botUsername?: string;
  error?: string;
}> {
  const url = getAppsScriptUrl();
  if (!url) {
    return {
      ok: true,
      token: `tgtok_mock_${Date.now()}`,
      deepLink: `https://t.me/MyDigitAssetNewsBot?start=tgtok_mock_${Date.now()}`,
      botUsername: 'MyDigitAssetNewsBot',
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      action: 'generateTelegramToken',
      customerSecretToken: secretToken,
    }),
  });

  return res.json();
}

/**
 * Submit Payment Proof (UTR)
 */
export async function submitPaymentProof(params: {
  customerSecretToken: string;
  utrReference: string;
  customerReportedPaymentDate?: string;
  paymentMethod?: 'UPI' | 'BANK_TRANSFER';
}): Promise<{ ok: boolean; paymentId?: string; state?: string; message?: string; error?: string }> {
  const url = getAppsScriptUrl();
  if (!url) {
    return {
      ok: true,
      paymentId: `pay_mock_${Date.now()}`,
      state: 'PAYMENT_SUBMITTED',
      message: 'Payment reference submitted (Demo mode).',
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      action: 'submitPaymentProof',
      ...params,
    }),
  });

  return res.json();
}

/**
 * Get authorized customer status
 */
export async function getCustomerStatus(secretToken: string): Promise<{
  ok: boolean;
  fullName?: string;
  telegramConnected?: boolean;
  state?: string;
  trialStartDate?: string;
  trialEndDate?: string;
  adminConfirmedPaymentDate?: string;
  bufferStartDate?: string;
  bufferEndDate?: string;
  paidStartDate?: string;
  paidExpiryDate?: string;
  categories?: Array<{ id: string; name: string }>;
  error?: string;
}> {
  const url = getAppsScriptUrl();
  if (!url) {
    return {
      ok: true,
      fullName: 'Subscriber',
      telegramConnected: false,
      state: 'TRIAL_ACTIVE',
    };
  }

  const res = await fetch(`${url}?action=getCustomerStatus&token=${encodeURIComponent(secretToken)}`, {
    method: 'GET',
  });

  return res.json();
}

/**
 * Request Renewal Trial (Anti-abuse protected)
 */
export async function requestRenewalTrial(secretToken: string): Promise<{
  ok: boolean;
  subscriptionId?: string;
  state?: string;
  trialStartDate?: string;
  trialEndDate?: string;
  message?: string;
  error?: string;
}> {
  const url = getAppsScriptUrl();
  if (!url) {
    return { ok: true, state: 'RENEWAL_TRIAL_ACTIVE' };
  }

  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      action: 'requestRenewalTrial',
      customerSecretToken: secretToken,
    }),
  });

  return res.json();
}

/**
 * Admin: Get complete dashboard data
 */
export async function adminGetDashboardData(idToken: string): Promise<any> {
  const url = getAppsScriptUrl();
  if (!url) throw new Error('Google Apps Script URL is not configured.');

  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      action: 'adminGetDashboardData',
      idToken,
    }),
  });

  return res.json();
}

/**
 * Admin: Verify & activate payment
 */
export async function adminVerifyPayment(params: {
  idToken: string;
  paymentId: string;
  adminConfirmedPaymentDate: string;
  notes?: string;
}): Promise<any> {
  const url = getAppsScriptUrl();
  if (!url) throw new Error('Google Apps Script URL is not configured.');

  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      action: 'adminVerifyPayment',
      ...params,
    }),
  });

  return res.json();
}

/**
 * Admin: Update payment & banking configuration
 */
export async function adminUpdatePaymentConfig(params: {
  idToken: string;
  newConfig: any;
  changeSummary: string;
}): Promise<any> {
  const url = getAppsScriptUrl();
  if (!url) throw new Error('Google Apps Script URL is not configured.');

  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({
      action: 'adminUpdatePaymentConfig',
      ...params,
    }),
  });

  return res.json();
}
