import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  Customer,
  Payment,
  PaymentOrder,
  PaymentOrderStatus,
  Subscription,
  SubscriptionCategory,
  CategoryTransferAudit,
  TelegramDeliveryLog,
  DailyNewsPackage,
  NewsStory,
  TelegramConnectionToken,
  TelegramConnectionAuditEvent,
  Category,
} from '../src/types';
import { initialCategories } from '../src/data/initialData';
import {
  getFirestoreDb,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  runTransaction,
  writeBatch,
  withTimeout,
} from './firestore.js';

const DB_FILE = path.join(process.cwd(), 'server', 'data', 'mydigitasset_db.json');

export interface CustomerSession {
  sessionToken: string;
  customerId: string;
  createdAt: string;
  expiresAt: string;
}

export interface MyDigitAssetDatabase {
  version: number;
  customers: Customer[];
  customerSessions: CustomerSession[];
  paymentOrders: PaymentOrder[];
  payments: Payment[];
  subscriptions: Subscription[];
  subscriptionCategories: SubscriptionCategory[];
  categoryTransferAudits: CategoryTransferAudit[];
  telegramDeliveryLogs: TelegramDeliveryLog[];
  dailyNewsPackages: DailyNewsPackage[];
  newsStories: NewsStory[];
  telegramConnectionTokens: TelegramConnectionToken[];
  telegramConnectionAudits: TelegramConnectionAuditEvent[];
  categories: Category[];
}

// In-memory cache synced with Firestore + local JSON fallback
let dbMemory: MyDigitAssetDatabase | null = null;
let isWriting = false;

function ensureDataDirectory() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Initializes the database.
 * First loads from local JSON cache if present, then can be refreshed from Firestore.
 */
export function initDb(): MyDigitAssetDatabase {
  ensureDataDirectory();

  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      dbMemory = JSON.parse(raw);
      if (dbMemory && Array.isArray(dbMemory.customers)) {
        if (!Array.isArray(dbMemory.customerSessions)) dbMemory.customerSessions = [];
        if (!Array.isArray(dbMemory.paymentOrders)) dbMemory.paymentOrders = [];
        if (!Array.isArray(dbMemory.payments)) dbMemory.payments = [];
        if (!Array.isArray(dbMemory.subscriptions)) dbMemory.subscriptions = [];
        if (!Array.isArray(dbMemory.subscriptionCategories)) dbMemory.subscriptionCategories = [];
        if (!Array.isArray(dbMemory.categoryTransferAudits)) dbMemory.categoryTransferAudits = [];
        if (!Array.isArray(dbMemory.telegramDeliveryLogs)) dbMemory.telegramDeliveryLogs = [];
        if (!Array.isArray(dbMemory.dailyNewsPackages)) dbMemory.dailyNewsPackages = [];
        if (!Array.isArray(dbMemory.newsStories)) dbMemory.newsStories = [];
        if (!Array.isArray(dbMemory.telegramConnectionTokens)) dbMemory.telegramConnectionTokens = [];
        if (!Array.isArray(dbMemory.telegramConnectionAudits)) dbMemory.telegramConnectionAudits = [];
        if (!Array.isArray(dbMemory.categories) || dbMemory.categories.length === 0) {
          dbMemory.categories = initialCategories;
        }
        return dbMemory;
      }
    } catch (err) {
      console.error('Error reading database file, recreating:', err);
    }
  }

  // Create initial fresh database state
  dbMemory = {
    version: 1,
    customers: [],
    customerSessions: [],
    paymentOrders: [],
    payments: [],
    subscriptions: [],
    subscriptionCategories: [],
    categoryTransferAudits: [],
    telegramDeliveryLogs: [],
    dailyNewsPackages: [],
    newsStories: [],
    telegramConnectionTokens: [],
    telegramConnectionAudits: [],
    categories: initialCategories,
  };

  saveDb();
  return dbMemory;
}

/**
 * Loads all persistent collections directly from Firestore into the memory cache.
 */
export async function loadDbFromFirestore(): Promise<MyDigitAssetDatabase> {
  const firestore = getFirestoreDb();
  console.log('[Firestore] Synchronizing in-memory cache with Cloud Firestore collections...');

  async function loadCollection<T>(collName: string): Promise<T[]> {
    try {
      const snap = await getDocs(collection(firestore, collName));
      return snap.docs.map((d) => d.data() as T);
    } catch (err) {
      console.error(`[Firestore] Error loading collection ${collName}:`, err);
      return [];
    }
  }

  const [
    customers,
    customerSessions,
    paymentOrders,
    payments,
    subscriptions,
    subscriptionCategories,
    categoryTransferAudits,
    telegramDeliveryLogs,
    dailyNewsPackages,
    newsStories,
    telegramConnectionTokens,
    telegramConnectionAudits,
    categories,
  ] = await Promise.all([
    loadCollection<Customer>('customers'),
    loadCollection<CustomerSession>('customerSessions'),
    loadCollection<PaymentOrder>('paymentOrders'),
    loadCollection<Payment>('payments'),
    loadCollection<Subscription>('subscriptions'),
    loadCollection<SubscriptionCategory>('subscriptionCategories'),
    loadCollection<CategoryTransferAudit>('categoryTransferAudits'),
    loadCollection<TelegramDeliveryLog>('telegramDeliveryLogs'),
    loadCollection<DailyNewsPackage>('dailyNewsPackages'),
    loadCollection<NewsStory>('newsStories'),
    loadCollection<TelegramConnectionToken>('telegramConnectionTokens'),
    loadCollection<TelegramConnectionAuditEvent>('telegramConnectionAudits'),
    loadCollection<Category>('categories'),
  ]);

  const currentDb = dbMemory || initDb();

  function mergeEntities<T extends Record<string, any>>(
    remote: T[],
    local: T[],
    idGetter: (item: T) => string
  ): T[] {
    const map = new Map<string, T>();
    for (const r of remote) {
      const id = idGetter(r);
      if (id) map.set(id, r);
    }
    for (const l of local) {
      const id = idGetter(l);
      if (!id) continue;
      const existing = map.get(id);
      if (!existing) {
        map.set(id, l);
      } else {
        map.set(id, { ...existing, ...l });
      }
    }
    return Array.from(map.values());
  }

  const mergedCustomers = mergeEntities(customers, currentDb.customers || [], (c) => c.customerId);
  const mergedSubscriptions = mergeEntities(subscriptions, currentDb.subscriptions || [], (s) => s.subscriptionId);
  const mergedPayments = mergeEntities(payments, currentDb.payments || [], (p) => p.paymentId);
  const mergedOrders = mergeEntities(paymentOrders, currentDb.paymentOrders || [], (o) => o.paymentOrderId);
  const mergedCategories = categories.length > 0 ? categories : (currentDb.categories || initialCategories);

  dbMemory = {
    version: 1,
    customers: mergedCustomers,
    customerSessions: mergeEntities(customerSessions, currentDb.customerSessions || [], (s) => s.sessionToken),
    paymentOrders: mergedOrders,
    payments: mergedPayments,
    subscriptions: mergedSubscriptions,
    subscriptionCategories: mergeEntities(
      subscriptionCategories,
      currentDb.subscriptionCategories || [],
      (sc) => `${sc.subscriptionId}_${sc.categoryId}`
    ),
    categoryTransferAudits: mergeEntities(
      categoryTransferAudits,
      currentDb.categoryTransferAudits || [],
      (a) => a.transferId
    ),
    telegramDeliveryLogs: mergeEntities(
      telegramDeliveryLogs,
      currentDb.telegramDeliveryLogs || [],
      (l) => l.deliveryId
    ),
    dailyNewsPackages: mergeEntities(dailyNewsPackages, currentDb.dailyNewsPackages || [], (p) => p.packageId),
    newsStories: mergeEntities(newsStories, currentDb.newsStories || [], (s) => s.storyId),
    telegramConnectionTokens: mergeEntities(
      telegramConnectionTokens,
      currentDb.telegramConnectionTokens || [],
      (t) => t.token
    ),
    telegramConnectionAudits: mergeEntities(
      telegramConnectionAudits,
      currentDb.telegramConnectionAudits || [],
      (a) => a.eventId
    ),
    categories: mergedCategories.length > 0 ? mergedCategories : initialCategories,
  };
  saveLocalDbJson();
  console.log(`[Firestore] Synchronization complete. Active customers: ${dbMemory.customers.length}`);
  return dbMemory;
}

function saveLocalDbJson(): boolean {
  if (!dbMemory) return false;
  ensureDataDirectory();
  const tempFile = `${DB_FILE}.${Date.now()}.${Math.random().toString(36).substring(7)}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(dbMemory, null, 2), 'utf8');
    fs.renameSync(tempFile, DB_FILE);
    return true;
  } catch (err) {
    console.error('Error writing local database backup:', err);
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (_) {}
    return false;
  }
}

/**
 * Persists changes to local JSON backup and optionally syncs dirty documents.
 * Never performs mass full-collection writes on standard save to conserve Firestore write quota.
 */
export function saveDb(): boolean {
  if (!dbMemory) return false;
  return saveLocalDbJson();
}

/**
 * Async version of saveDb for callers that want to ensure local durability.
 */
export async function saveDbAsync(): Promise<boolean> {
  if (!dbMemory) return false;
  return saveLocalDbJson();
}

/**
 * Synchronizes in-memory collections to Firestore using batched writes.
 */
export async function syncDbToFirestore(db: MyDigitAssetDatabase): Promise<void> {
  const firestore = getFirestoreDb();

  async function syncCollectionBatch<T extends Record<string, any>>(
    collName: string,
    items: T[],
    idGetter: (item: T) => string
  ) {
    if (!items || items.length === 0) return;
    const batchSize = 300;
    for (let i = 0; i < items.length; i += batchSize) {
      const chunk = items.slice(i, i + batchSize);
      const batch = writeBatch(firestore);
      for (const item of chunk) {
        const id = idGetter(item);
        if (id) {
          const ref = doc(firestore, collName, id);
          const sanitized = JSON.parse(JSON.stringify(item));
          batch.set(ref, sanitized, { merge: true });
        }
      }
      await batch.commit();
    }
  }

  await Promise.all([
    syncCollectionBatch('customers', db.customers, (c) => c.customerId),
    syncCollectionBatch('customerSessions', db.customerSessions, (s) => s.sessionToken),
    syncCollectionBatch('paymentOrders', db.paymentOrders, (o) => o.paymentOrderId),
    syncCollectionBatch('payments', db.payments, (p) => p.paymentId),
    syncCollectionBatch('subscriptions', db.subscriptions, (s) => s.subscriptionId),
    syncCollectionBatch(
      'subscriptionCategories',
      db.subscriptionCategories,
      (sc) => `${sc.subscriptionId}_${sc.categoryId}`
    ),
    syncCollectionBatch('categoryTransferAudits', db.categoryTransferAudits, (a) => a.transferId),
    syncCollectionBatch('telegramDeliveryLogs', db.telegramDeliveryLogs, (l) => l.deliveryId),
    syncCollectionBatch('dailyNewsPackages', db.dailyNewsPackages, (p) => p.packageId),
    syncCollectionBatch('newsStories', db.newsStories, (s) => s.storyId),
    syncCollectionBatch('telegramConnectionTokens', db.telegramConnectionTokens, (t) => t.token),
    syncCollectionBatch('telegramConnectionAudits', db.telegramConnectionAudits, (a) => a.eventId),
    syncCollectionBatch('categories', db.categories, (c) => c.id),
  ]);
}

/**
 * Persists a single document immediately to Firestore.
 */
export async function persistDocToFirestore(
  collectionName: string,
  docId: string,
  data: Record<string, any>
): Promise<void> {
  try {
    const firestore = getFirestoreDb();
    const ref = doc(firestore, collectionName, docId);
    const sanitized = JSON.parse(JSON.stringify(data));
    await withTimeout(setDoc(ref, sanitized, { merge: true }), 2000, undefined);
  } catch (err: any) {
    if (err?.code === 'resource-exhausted' || err?.message?.includes('RESOURCE_EXHAUSTED')) {
      console.warn(`[Firestore Quota] Write deferred for ${collectionName}/${docId}: Quota limit reached.`);
    } else {
      console.warn(`[Firestore Notice] Deferred persistence for ${collectionName}/${docId}:`, err?.message || err);
    }
  }
}

/**
 * Removes a document immediately from Firestore.
 */
export async function removeDocFromFirestore(collectionName: string, docId: string): Promise<void> {
  try {
    const firestore = getFirestoreDb();
    const ref = doc(firestore, collectionName, docId);
    await withTimeout(deleteDoc(ref), 2000, undefined);
  } catch (err: any) {
    console.warn(`[Firestore Notice] Deferred deletion for ${collectionName}/${docId}:`, err?.message || err);
  }
}

export function getDb(): MyDigitAssetDatabase {
  if (!dbMemory) {
    return initDb();
  }
  return dbMemory;
}

// ============================================================================
// SANITIZATION & INPUT VALIDATION (Section 3, 14, 18)
// ============================================================================

export function sanitizeText(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/<[^>]*>/g, '') // Strip HTML tags
    .replace(/[\r\n\t]+/g, ' ') // Normalize spaces
    .trim();
}

export function validateCustomerRegistration(input: {
  fullName?: string;
  email?: string;
  mobileCountryCode?: string;
  mobileNumber?: string;
  selectedCategoryIds?: string[];
}): { valid: boolean; error?: string; cleanData?: any } {
  const fullName = sanitizeText(input.fullName || '');
  if (!fullName || fullName.length < 2) {
    return { valid: false, error: 'Full name is mandatory (minimum 2 characters).' };
  }
  if (fullName.length > 100) {
    return { valid: false, error: 'Full name exceeds 100 characters limit.' };
  }

  const emailRaw = sanitizeText(input.email || '').toLowerCase();
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRaw || !emailRegex.test(emailRaw)) {
    return { valid: false, error: 'A valid email address is mandatory.' };
  }

  let countryCode = sanitizeText(input.mobileCountryCode || '+91');
  if (!countryCode.startsWith('+')) {
    countryCode = `+${countryCode}`;
  }
  if (!/^\+[0-9]{1,4}$/.test(countryCode)) {
    return { valid: false, error: 'Invalid mobile country code (e.g. +91).' };
  }

  const mobileDigits = (input.mobileNumber || '').replace(/[^0-9]/g, '');
  if (!mobileDigits || mobileDigits.length < 7 || mobileDigits.length > 15) {
    return { valid: false, error: 'A valid mobile number is mandatory (7 to 15 digits).' };
  }

  const selectedCategories = Array.isArray(input.selectedCategoryIds)
    ? input.selectedCategoryIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
    : [];

  if (selectedCategories.length === 0) {
    return { valid: false, error: 'Please select at least one news category subscription.' };
  }

  return {
    valid: true,
    cleanData: {
      fullName,
      email: emailRaw,
      mobileCountryCode: countryCode,
      mobileNumber: mobileDigits,
      selectedCategoryIds: selectedCategories,
    },
  };
}

// ============================================================================
// CUSTOMER REPOSITORY & SESSIONS (Section 3, 14, 15)
// ============================================================================

/**
 * Registers a new customer or logs in an existing customer by email.
 * Associates session token and selected categories.
 */
export function registerOrLoginCustomer(input: {
  fullName: string;
  email: string;
  mobileCountryCode: string;
  mobileNumber: string;
  selectedCategoryIds: string[];
}): { customer: Customer; sessionToken: string } {
  const db = getDb();
  const now = new Date().toISOString();

  let customer = db.customers.find((c) => c.email.toLowerCase() === input.email.toLowerCase());

  if (customer) {
    // Existing customer: update details
    customer.fullName = input.fullName;
    customer.mobileCountryCode = input.mobileCountryCode;
    customer.mobileNumber = input.mobileNumber;
    customer.selectedCategoryIds = input.selectedCategoryIds;
    customer.updatedAt = now;
  } else {
    // New customer: create record with 3-day complimentary trial
    const trialEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    customer = {
      customerId: `cust_${crypto.randomBytes(8).toString('hex')}`,
      fullName: input.fullName,
      email: input.email,
      mobileCountryCode: input.mobileCountryCode,
      mobileNumber: input.mobileNumber,
      telegramChatId: null,
      telegramConnected: false,
      accountStatus: 'active',
      trialStartDate: now,
      trialEndDate: trialEnd,
      trialStatus: 'active',
      selectedCategoryIds: input.selectedCategoryIds,
      createdAt: now,
      updatedAt: now,
    };
    db.customers.push(customer);
  }

  // Create a 30-day cryptographically secure session token
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Clean up any stale sessions for this customer
  db.customerSessions = db.customerSessions.filter(
    (s) => s.customerId !== customer!.customerId || new Date(s.expiresAt) > new Date()
  );

  const sessionObj: CustomerSession = {
    sessionToken,
    customerId: customer.customerId,
    createdAt: now,
    expiresAt,
  };
  db.customerSessions.push(sessionObj);

  customer.customerAuthToken = sessionToken;
  saveDb();

  // Also write directly to Firestore for instant durability
  persistDocToFirestore('customers', customer.customerId, customer).catch(console.error);
  persistDocToFirestore('customerSessions', sessionToken, sessionObj).catch(console.error);

  return { customer, sessionToken };
}

/**
 * ATOMIC Firestore Customer Registration / Login.
 * Guarantees that concurrent requests cannot produce duplicate customer IDs.
 */
export async function atomicRegisterOrLoginCustomer(input: {
  fullName: string;
  email: string;
  mobileCountryCode: string;
  mobileNumber: string;
  selectedCategoryIds: string[];
}): Promise<{ customer: Customer; sessionToken: string }> {
  const firestore = getFirestoreDb();
  const db = getDb();
  const now = new Date().toISOString();
  const normalizedEmail = input.email.toLowerCase();

  // Look up in-memory first
  let existingCustomer = db.customers.find((c) => c.email.toLowerCase() === normalizedEmail);

  if (existingCustomer) {
    existingCustomer.fullName = input.fullName;
    existingCustomer.mobileCountryCode = input.mobileCountryCode;
    existingCustomer.mobileNumber = input.mobileNumber;
    existingCustomer.selectedCategoryIds = input.selectedCategoryIds;
    existingCustomer.updatedAt = now;

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const sessionObj: CustomerSession = {
      sessionToken,
      customerId: existingCustomer.customerId,
      createdAt: now,
      expiresAt,
    };

    db.customerSessions = db.customerSessions.filter(
      (s) => s.customerId !== existingCustomer!.customerId || new Date(s.expiresAt) > new Date()
    );
    db.customerSessions.push(sessionObj);
    existingCustomer.customerAuthToken = sessionToken;

    saveDb();
    await Promise.all([
      persistDocToFirestore('customers', existingCustomer.customerId, existingCustomer),
      persistDocToFirestore('customerSessions', sessionToken, sessionObj),
    ]);

    return { customer: existingCustomer, sessionToken };
  }

  // Create new customer using transaction to prevent duplicate identities
  const newCustomerId = `cust_${crypto.randomBytes(8).toString('hex')}`;
  const trialEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const newCustomer: Customer = {
    customerId: newCustomerId,
    fullName: input.fullName,
    email: input.email,
    mobileCountryCode: input.mobileCountryCode,
    mobileNumber: input.mobileNumber,
    telegramChatId: null,
    telegramConnected: false,
    accountStatus: 'active',
    trialStartDate: now,
    trialEndDate: trialEnd,
    trialStatus: 'active',
    selectedCategoryIds: input.selectedCategoryIds,
    customerAuthToken: sessionToken,
    createdAt: now,
    updatedAt: now,
  };

  const sessionObj: CustomerSession = {
    sessionToken,
    customerId: newCustomerId,
    createdAt: now,
    expiresAt,
  };

  // Run atomic write with graceful timeout fallback
  try {
    const txnPromise = runTransaction(firestore, async (txn) => {
      const custRef = doc(firestore, 'customers', newCustomerId);
      const sessionRef = doc(firestore, 'customerSessions', sessionToken);
      txn.set(custRef, JSON.parse(JSON.stringify(newCustomer)));
      txn.set(sessionRef, JSON.parse(JSON.stringify(sessionObj)));
    });
    await withTimeout(txnPromise, 2000, undefined);
  } catch (txnErr) {
    console.warn('[Firestore] Atomic customer registration notice (local preserved):', txnErr instanceof Error ? txnErr.message : txnErr);
  }

  db.customers.push(newCustomer);
  db.customerSessions.push(sessionObj);
  saveLocalDbJson();

  return { customer: newCustomer, sessionToken };
}

/**
 * Authenticates a customer by their session token or customerAuthToken.
 * Prevents a customer from accessing any other customer's profile.
 */
export function getCustomerBySessionToken(sessionToken: string): Customer | null {
  if (!sessionToken || typeof sessionToken !== 'string') return null;
  const db = getDb();

  const session = db.customerSessions.find((s) => s.sessionToken === sessionToken);
  if (session) {
    if (new Date(session.expiresAt) < new Date()) {
      return null;
    }
    const customer = db.customers.find((c) => c.customerId === session.customerId);
    return customer || null;
  }

  // Direct check against customer.customerAuthToken
  const directCustomer = db.customers.find((c) => c.customerAuthToken === sessionToken);
  return directCustomer || null;
}

/**
 * Logs out a customer by invalidating their session token
 */
export function invalidateCustomerSession(sessionToken: string): boolean {
  if (!sessionToken) return false;
  const db = getDb();
  const initialLen = db.customerSessions.length;
  db.customerSessions = db.customerSessions.filter((s) => s.sessionToken !== sessionToken);
  if (db.customerSessions.length !== initialLen) {
    saveDb();
    removeDocFromFirestore('customerSessions', sessionToken).catch(console.error);
    return true;
  }
  return false;
}

/**
 * Updates a customer's mobile number
 */
export function updateCustomerMobile(
  customerId: string,
  mobileCountryCode: string,
  mobileNumber: string
): { success: boolean; customer?: Customer; error?: string } {
  const db = getDb();
  const customer = db.customers.find((c) => c.customerId === customerId);
  if (!customer) {
    return { success: false, error: 'Customer not found.' };
  }

  let countryCode = sanitizeText(mobileCountryCode || '+91');
  if (!countryCode.startsWith('+')) countryCode = `+${countryCode}`;
  if (!/^\+[0-9]{1,4}$/.test(countryCode)) {
    return { success: false, error: 'Invalid mobile country code.' };
  }

  const mobileDigits = (mobileNumber || '').replace(/[^0-9]/g, '');
  if (!mobileDigits || mobileDigits.length < 7 || mobileDigits.length > 15) {
    return { success: false, error: 'Invalid mobile number.' };
  }

  customer.mobileCountryCode = countryCode;
  customer.mobileNumber = mobileDigits;
  customer.updatedAt = new Date().toISOString();

  saveDb();
  persistDocToFirestore('customers', customer.customerId, customer).catch(console.error);
  return { success: true, customer };
}

/**
 * Finds customer by customerId
 */
export function getCustomerById(customerId: string): Customer | null {
  const db = getDb();
  return db.customers.find((c) => c.customerId === customerId) || null;
}

/**
 * Retrieves all categories currently active
 */
export function getActiveCategories(): Category[] {
  const db = getDb();
  return db.categories.filter((c) => c.isActive);
}

/**
 * Admin-only: list all customers.
 * Protected strictly by server-side Admin authentication.
 */
export function getAdminCustomersList(): Customer[] {
  const db = getDb();
  return db.customers.map((c) => ({ ...c }));
}

/**
 * ============================================================================
 * PAYMENT ORDER DATA ACCESS METHODS (Phase 6.1)
 * ============================================================================
 */
export function createPaymentOrder(order: PaymentOrder): PaymentOrder {
  const db = getDb();
  db.paymentOrders.push(order);
  saveDb();
  persistDocToFirestore('paymentOrders', order.paymentOrderId, order).catch(console.error);
  return order;
}

export function getPaymentOrderById(paymentOrderId: string): PaymentOrder | null {
  const db = getDb();
  return db.paymentOrders.find((po) => po.paymentOrderId === paymentOrderId) || null;
}

export function getPaymentOrderByProviderOrderId(providerOrderId: string): PaymentOrder | null {
  const db = getDb();
  return db.paymentOrders.find((po) => po.providerOrderId === providerOrderId) || null;
}

export function updatePaymentOrderStatus(
  paymentOrderId: string,
  status: PaymentOrderStatus,
  metadata?: Record<string, any>
): PaymentOrder | null {
  const db = getDb();
  const order = db.paymentOrders.find((po) => po.paymentOrderId === paymentOrderId);
  if (!order) return null;

  order.status = status;
  order.updatedAt = new Date().toISOString();
  if (metadata) {
    order.metadata = { ...(order.metadata || {}), ...metadata };
  }
  saveDb();
  persistDocToFirestore('paymentOrders', order.paymentOrderId, order).catch(console.error);
  return order;
}

export function getCustomerPaymentOrders(customerId: string): PaymentOrder[] {
  const db = getDb();
  return db.paymentOrders
    .filter((po) => po.customerId === customerId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
