/**
 * Core Data Models & Extensible Architecture for mydigitasset.com
 * Supports multi-product digital assets (News, Audiobooks, E-books, Magazines, AI services)
 */

export type ProductType = 
  | 'news_subscription' 
  | 'audiobook' 
  | 'ebook' 
  | 'magazine' 
  | 'ai_service';

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  type: ProductType;
  isActive: boolean;
  trialDays: number;
  basePriceInr: number; // e.g. 252.00
  gstRatePercent: number; // e.g. 18%
  billingPeriod: 'yearly' | 'monthly' | 'quarterly' | 'one_time';
}

export interface Category {
  id: string;
  productId: string; // Links category to a specific product (e.g. news)
  name: string;
  slug: string;
  description?: string;
  isActive: boolean;
  displayOrder: number;
}

export interface NewsArticle {
  id: string;
  productId: string;
  categoryId: string;
  categoryName: string;
  headline: string;
  summary: string;
  date: string; // ISO date or YYYY-MM-DD
  sourceName: string;
  sourceUrl: string;
  createdAt: string;
}

export type SubscriptionStatus = 
  | 'trial'
  | 'active'
  | 'pending_verification'
  | 'expired'
  | 'cancelled';

/**
 * 1. Customer Record (Section 15)
 * Private customer account data
 */
export interface Customer {
  customerId: string;
  fullName: string;
  email: string;
  mobileCountryCode: string; // e.g. "+91"
  mobileNumber: string; // e.g. "9876543210"
  customerAuthToken?: string; // Opaque 256-bit session/auth token for endpoint protection
  telegramChatId?: string | null;
  telegramConnected: boolean;
  accountStatus: 'active' | 'inactive' | 'suspended';
  trialStartDate?: string;
  trialEndDate?: string;
  trialStatus?: 'active' | 'expired' | 'converted';
  renewalRequested?: boolean;
  renewalRequestedAt?: string;
  renewalNotes?: string;
  selectedCategoryIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export type PaymentStatus = 'pending' | 'successful' | 'failed' | 'cancelled' | 'refunded';

export type PaymentOrderStatus =
  | 'created'
  | 'checkout_started'
  | 'pending'
  | 'successful'
  | 'failed'
  | 'cancelled'
  | 'expired';

/**
 * 2. Trusted Internal Payment Order Record (Phase 6.1)
 * Created server-side before Razorpay checkout to anchor customer, categories, amount, and gateway order.
 */
export interface PaymentOrder {
  paymentOrderId: string; // e.g. "pord_<hex>"
  customerId: string;
  categoryIds: string[];
  amount: number; // in INR (e.g. 297.36)
  currency: string; // 'INR'
  provider: 'razorpay';
  providerOrderId: string; // Razorpay order_... ID
  status: PaymentOrderStatus;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

/**
 * 2. Payment Record (Section 3 & 15, updated Phase 6.1)
 */
export interface Payment {
  paymentId: string;
  paymentOrderId?: string;
  customerId: string;
  amount: number;
  currency: string;
  paymentStatus: PaymentStatus;
  paymentDate: string;
  gatewayReference: string; // providerPaymentId or reference
  providerOrderId?: string;
  providerPaymentId?: string;
  providerSignature?: string;
  provider?: 'razorpay' | 'manual_upi';
  purchasedCategoryIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 3. Subscription Record (Section 15)
 */
export interface Subscription {
  subscriptionId: string;
  customerId: string;
  startDate: string;
  expiryDate: string;
  bufferStartDate?: string; // adminConfirmedPaymentDate
  bufferEndDate?: string;   // adminConfirmedPaymentDate + 4 days
  paidStartDate?: string;     // adminConfirmedPaymentDate + 5 days
  paidEndDate?: string;       // paidStartDate + 12 months
  status: 'active' | 'expired' | 'suspended' | 'pending';
  paymentId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 4. Subscription Category Entitlement (Section 15)
 */
export interface SubscriptionCategory {
  subscriptionId: string;
  customerId: string;
  categoryId: string;
  categoryName: string;
  entitlementStatus: 'active' | 'inactive' | 'transferred';
  assignedAt: string;
  updatedAt: string;
}

/**
 * 5. Category Transfer Audit Record (Section 12 & 15)
 * Immutable audit trail of every administrative category change
 */
export interface CategoryTransferAudit {
  transferId: string;
  customerId: string;
  subscriptionId: string;
  oldCategoryId: string;
  oldCategoryName: string;
  newCategoryId: string;
  newCategoryName: string;
  adminEmail: string;
  timestamp: string;
  reason: string;
  result: 'SUCCESS' | 'REJECTED';
  rejectionReason?: string;
}

/**
 * 6. Telegram Delivery Log (Section 20 & 21)
 */
export interface TelegramDeliveryLog {
  deliveryId: string;
  customerId: string;
  categoryId: string;
  newsDate: string; // YYYY-MM-DD
  telegramChatId: string;
  attemptedAt: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped' | 'expired' | 'not_entitled' | 'telegram_not_connected';
  telegramMessageId?: string | null;
  error?: string | null;
  timestamp: string;
}

/**
 * 7. Daily News Package (Section 10)
 */
export interface DailyNewsPackage {
  packageId: string;
  newsDate: string; // YYYY-MM-DD (Asia/Kolkata)
  categoryId: string;
  categoryName: string;
  generationStatus: 'pending' | 'success' | 'failed' | 'partial';
  storyCount: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 8. News Story (Section 10)
 */
export interface NewsStory {
  storyId: string;
  packageId: string;
  newsDate: string; // YYYY-MM-DD
  categoryId: string;
  position: number; // 1-10
  headline: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  sentimentType: 'constructive' | 'negative' | 'neutral';
  createdAt: string;
}

/**
 * 9. Telegram Connection Token (Section 4 & 5)
 * Short-lived, single-use cryptographically random token linking Telegram Chat ID to Customer
 */
export interface TelegramConnectionToken {
  tokenId: string;
  token: string;
  customerId: string;
  expiresAt: string;
  used: boolean;
  usedAt?: string;
  createdAt: string;
}

/**
 * 10. Telegram Connection Audit Event (Section 16)
 */
export interface TelegramConnectionAuditEvent {
  eventId: string;
  customerId: string;
  eventType: 'TOKEN_GENERATED' | 'CONNECTED' | 'REJECTED' | 'EXPIRED' | 'DISCONNECTED';
  telegramChatId?: string | null;
  timestamp: string;
  result: 'SUCCESS' | 'REJECTED' | 'FAILED';
  details: string;
}

export interface CustomerSubscription {
  id: string;
  customerId: string;
  productId: string;
  status: SubscriptionStatus;
  trialStartedAt: string;
  trialEndsAt: string;
  subscriptionStartedAt?: string;
  subscriptionEndsAt?: string;
  selectedCategoryIds: string[];
  lastPaymentRef?: string;
}

export interface CustomerProfile {
  id: string;
  email: string;
  phoneNumber?: string;
  name?: string;
  country: string; // Defaults to 'IN'
  createdAt: string;
}

export interface PaymentConfiguration {
  providerType: 'manual_upi' | 'razorpay' | 'cashfree';
  upiId: string;
  beneficiaryName: string;
  phoneNumber: string;
  gstCreditEmail: string;
}

export interface AdSenseConfiguration {
  isEnabled: boolean; // Master toggle (default: false)
  publisherId: string;
  placements: {
    homepageBanner: boolean;
    inFeedSeparator: boolean;
    footerBanner: boolean;
  };
}

export interface AdminSecuritySettings {
  adminEmail: string;
  ipRestrictionsEnabled?: boolean;
  allowedIpAddresses?: string[];
}

export interface GlobalSiteSettings {
  siteTitle: string;
  tagline: string;
  supportEmail: string;
  restrictedCountry: string; // 'IN'
  allowInternational: boolean;
  adsense: AdSenseConfiguration;
  payment: PaymentConfiguration;
  security: AdminSecuritySettings;
}
