/**
 * Core Data Models & Extensible Architecture for mydigitalasset.com
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
  allowedIpAddresses: string[]; // IPv4 and IPv6 addresses allowed to access /admin
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
