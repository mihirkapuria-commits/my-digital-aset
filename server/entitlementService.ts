import crypto from 'crypto';
import {
  Customer,
  Subscription,
  SubscriptionCategory,
  CategoryTransferAudit,
  Category,
} from '../src/types';
import {
  getDb,
  saveDb,
  getCustomerById,
  getActiveCategories,
} from './db.js';

export interface EntitledCategoryResult {
  categoryId: string;
  categoryName: string;
  subscriptionId: string;
  startDate: string;
  expiryDate: string;
}

export interface CustomerEntitlementEvaluation {
  isEligible: boolean;
  customerId: string;
  customerName: string;
  customerEmail: string;
  accountStatus: string;
  telegramConnected: boolean;
  telegramDeliveryEligible: boolean;
  entitledCategories: EntitledCategoryResult[];
  ineligibleReasons: string[];
}

/**
 * ============================================================================
 * 1. CENTRAL SERVER-SIDE ENTITLEMENT CHECK (Section 10)
 * ============================================================================
 * Single authoritative source of truth for current paid access and daily delivery.
 * Answers: "Is this specific customer entitled to receive this specific category's news today?"
 *
 * Enforces:
 * 1. Customer account exists & active.
 * 2. Subscription exists, active, within individual start and expiry dates.
 * 3. SubscriptionCategory has active entitlement.
 * 4. Category is currently active in the database catalog (Section 8).
 */
export function getCustomerActiveEntitlements(
  customerId: string,
  referenceDate: Date = new Date()
): CustomerEntitlementEvaluation {
  const db = getDb();
  const ineligibleReasons: string[] = [];

  const customer = db.customers.find((c) => c.customerId === customerId);
  if (!customer) {
    return {
      isEligible: false,
      customerId,
      customerName: 'Unknown',
      customerEmail: '',
      accountStatus: 'non_existent',
      telegramConnected: false,
      telegramDeliveryEligible: false,
      entitledCategories: [],
      ineligibleReasons: ['Customer record not found in system.'],
    };
  }

  if (customer.accountStatus !== 'active') {
    ineligibleReasons.push(`Customer account status is ${customer.accountStatus} (must be active).`);
  }

  // Find customer's active subscriptions that are within their individual validity dates
  const activeSubs = db.subscriptions.filter((s) => {
    if (s.customerId !== customerId) return false;
    if (s.status !== 'active') return false;

    const start = new Date(s.startDate);
    const expiry = new Date(s.expiryDate);

    // Business rule: eligible on and after startDate, through expiryDate
    return referenceDate >= start && referenceDate <= expiry;
  });

  if (activeSubs.length === 0) {
    ineligibleReasons.push('No active subscription found within valid dates.');
  }

  const subIds = new Set(activeSubs.map((s) => s.subscriptionId));
  const subMap = new Map(activeSubs.map((s) => [s.subscriptionId, s]));

  // Active categories catalog lookup map
  const activeCatalogCategories = new Map(
    db.categories.filter((c) => c.isActive).map((c) => [c.id, c])
  );

  // Authoritative entitlement records
  const entitledCategories: EntitledCategoryResult[] = [];

  // Filter subscriptionCategories
  const entitlements = db.subscriptionCategories.filter(
    (sc) => sc.customerId === customerId && subIds.has(sc.subscriptionId) && sc.entitlementStatus === 'active'
  );

  for (const ent of entitlements) {
    const categoryObj = activeCatalogCategories.get(ent.categoryId);
    const sub = subMap.get(ent.subscriptionId);

    // Section 8: If category is deactivated in catalog, customer does NOT receive it
    if (!categoryObj) {
      continue;
    }

    if (sub) {
      entitledCategories.push({
        categoryId: ent.categoryId,
        categoryName: categoryObj.name || ent.categoryName,
        subscriptionId: ent.subscriptionId,
        startDate: sub.startDate,
        expiryDate: sub.expiryDate,
      });
    }
  }

  const isEligible = customer.accountStatus === 'active' && entitledCategories.length > 0;
  const telegramDeliveryEligible = isEligible && customer.telegramConnected === true && Boolean(customer.telegramChatId);

  if (!customer.telegramConnected || !customer.telegramChatId) {
    ineligibleReasons.push('Telegram account not connected (mandatory for news delivery).');
  }

  return {
    isEligible,
    customerId: customer.customerId,
    customerName: customer.fullName,
    customerEmail: customer.email,
    accountStatus: customer.accountStatus,
    telegramConnected: Boolean(customer.telegramConnected),
    telegramDeliveryEligible,
    entitledCategories,
    ineligibleReasons,
  };
}

/**
 * ============================================================================
 * 2. ADMIN CATEGORY TRANSFER ENGINE (Section 3, 4, 5, 6, 7, 12)
 * ============================================================================
 * Allows an authorized admin to transfer an entitlement from one category to another.
 *
 * Rules:
 * - Deactivates old entitlement (status = 'transferred')
 * - Creates new entitlement (status = 'active')
 * - Does NOT change subscription start or expiry date
 * - Does NOT charge or create payments
 * - Records an immutable audit log
 * - Multiple transfers permitted and logged
 */
export interface TransferCategoryParams {
  customerId: string;
  subscriptionId?: string;
  oldCategoryId: string;
  newCategoryId: string;
  adminEmail: string;
  reason?: string;
}

export interface TransferCategoryResult {
  success: boolean;
  audit: CategoryTransferAudit;
  activeEntitlements?: SubscriptionCategory[];
  subscription?: Subscription;
  error?: string;
}

export function executeAdminCategoryTransfer(params: TransferCategoryParams): TransferCategoryResult {
  const db = getDb();
  const now = new Date().toISOString();
  const transferId = `xfer_${crypto.randomBytes(8).toString('hex')}`;
  const cleanReason = (params.reason || 'Administrative category transfer').trim();

  // Helper to record audit and return rejection
  const rejectTransfer = (errorMsg: string, oldCatName: string = '', newCatName: string = ''): TransferCategoryResult => {
    const auditRecord: CategoryTransferAudit = {
      transferId,
      customerId: params.customerId,
      subscriptionId: params.subscriptionId || 'none',
      oldCategoryId: params.oldCategoryId,
      oldCategoryName: oldCatName || params.oldCategoryId,
      newCategoryId: params.newCategoryId,
      newCategoryName: newCatName || params.newCategoryId,
      adminEmail: params.adminEmail || 'admin',
      timestamp: now,
      reason: cleanReason,
      result: 'REJECTED',
      rejectionReason: errorMsg,
    };
    db.categoryTransferAudits.push(auditRecord);
    saveDb();

    return {
      success: false,
      error: errorMsg,
      audit: auditRecord,
    };
  };

  // 1. Validate Customer
  const customer = db.customers.find((c) => c.customerId === params.customerId);
  if (!customer) {
    return rejectTransfer(`Customer with ID ${params.customerId} does not exist.`);
  }

  // 2. Validate Subscription
  let subscription: Subscription | undefined;
  if (params.subscriptionId) {
    subscription = db.subscriptions.find(
      (s) => s.subscriptionId === params.subscriptionId && s.customerId === params.customerId
    );
  } else {
    // If no subscriptionId specified, find customer's active subscription
    subscription = db.subscriptions.find(
      (s) => s.customerId === params.customerId && s.status === 'active'
    );
  }

  if (!subscription) {
    return rejectTransfer(`Active subscription not found for customer ${params.customerId}.`);
  }

  if (subscription.status !== 'active') {
    return rejectTransfer(`Subscription ${subscription.subscriptionId} is not active (status: ${subscription.status}).`);
  }

  // 3. Validate Old Category Entitlement
  const oldEntitlement = db.subscriptionCategories.find(
    (sc) =>
      sc.subscriptionId === subscription!.subscriptionId &&
      sc.categoryId === params.oldCategoryId &&
      sc.entitlementStatus === 'active'
  );

  if (!oldEntitlement) {
    return rejectTransfer(
      `Active entitlement for old category '${params.oldCategoryId}' not found on subscription ${subscription.subscriptionId}.`
    );
  }

  // 4. Validate New Category Existence and Active Status (Section 6 & 8)
  const newCat = db.categories.find((c) => c.id === params.newCategoryId);
  if (!newCat) {
    return rejectTransfer(
      `New category '${params.newCategoryId}' does not exist in catalog.`,
      oldEntitlement.categoryName
    );
  }

  if (!newCat.isActive) {
    return rejectTransfer(
      `New category '${newCat.name}' is currently inactive and cannot be assigned.`,
      oldEntitlement.categoryName,
      newCat.name
    );
  }

  // 5. Prevent Duplicate Entitlement (Section 6: new category not already active in same subscription)
  const duplicateEntitlement = db.subscriptionCategories.find(
    (sc) =>
      sc.subscriptionId === subscription!.subscriptionId &&
      sc.categoryId === params.newCategoryId &&
      sc.entitlementStatus === 'active'
  );

  if (duplicateEntitlement) {
    return rejectTransfer(
      `Customer is already actively entitled to category '${newCat.name}' on this subscription.`,
      oldEntitlement.categoryName,
      newCat.name
    );
  }

  // 6. EXECUTE TRANSFER ATOMICALLY
  // Mark old entitlement transferred
  oldEntitlement.entitlementStatus = 'transferred';
  oldEntitlement.updatedAt = now;

  // Create new entitlement with active status
  const newEntitlement: SubscriptionCategory = {
    subscriptionId: subscription.subscriptionId,
    customerId: customer.customerId,
    categoryId: newCat.id,
    categoryName: newCat.name,
    entitlementStatus: 'active',
    assignedAt: now,
    updatedAt: now,
  };
  db.subscriptionCategories.push(newEntitlement);

  // Preserve subscription dates & payment untouched (Section 3, 7)
  subscription.updatedAt = now;

  // Create immutable audit record (Section 12)
  const auditRecord: CategoryTransferAudit = {
    transferId,
    customerId: customer.customerId,
    subscriptionId: subscription.subscriptionId,
    oldCategoryId: oldEntitlement.categoryId,
    oldCategoryName: oldEntitlement.categoryName,
    newCategoryId: newCat.id,
    newCategoryName: newCat.name,
    adminEmail: params.adminEmail,
    timestamp: now,
    reason: cleanReason,
    result: 'SUCCESS',
  };
  db.categoryTransferAudits.push(auditRecord);

  saveDb();

  // Fetch updated active entitlements for return
  const currentActiveEntitlements = db.subscriptionCategories.filter(
    (sc) => sc.subscriptionId === subscription!.subscriptionId && sc.entitlementStatus === 'active'
  );

  return {
    success: true,
    audit: auditRecord,
    subscription,
    activeEntitlements: currentActiveEntitlements,
  };
}

/**
 * ============================================================================
 * 3. CATEGORY CATALOG LIFECYCLE (Section 8, 9)
 * ============================================================================
 */

/**
 * Sets category active/inactive status (Section 8)
 * Deactivating automatically suppresses daily delivery without altering customer records.
 */
export function setCategoryStatus(
  categoryId: string,
  isActive: boolean,
  adminEmail: string
): { success: boolean; category?: Category; error?: string } {
  const db = getDb();
  const category = db.categories.find((c) => c.id === categoryId);
  if (!category) {
    return { success: false, error: `Category '${categoryId}' not found.` };
  }

  category.isActive = isActive;
  saveDb();

  return { success: true, category };
}

/**
 * Creates a brand new category in the catalog (Section 9)
 * Existing customers DO NOT automatically receive it.
 */
export function createNewCatalogCategory(params: {
  id?: string;
  name: string;
  slug?: string;
  description?: string;
  productId?: string;
}): { success: boolean; category?: Category; error?: string } {
  const db = getDb();
  const name = (params.name || '').trim();
  if (!name || name.length < 2) {
    return { success: false, error: 'Category name is required (minimum 2 characters).' };
  }

  const slug = params.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const id = params.id || `cat_${slug.replace(/-/g, '_')}`;

  if (db.categories.some((c) => c.id === id || c.slug === slug)) {
    return { success: false, error: `Category with ID or slug '${slug}' already exists.` };
  }

  const newCategory: Category = {
    id,
    productId: params.productId || 'prod_news_daily',
    name,
    slug,
    description: params.description || '',
    isActive: true,
    displayOrder: db.categories.length + 1,
  };

  db.categories.push(newCategory);
  saveDb();

  return { success: true, category: newCategory };
}

/**
 * Admin: Get all transfer audit logs (Section 12)
 */
export function getCategoryTransferAuditLogs(customerId?: string): CategoryTransferAudit[] {
  const db = getDb();
  if (customerId) {
    return db.categoryTransferAudits
      .filter((a) => a.customerId === customerId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }
  return [...db.categoryTransferAudits].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}
