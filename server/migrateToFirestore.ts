import fs from 'fs';
import path from 'path';
import {
  getFirestoreDb,
  doc,
  setDoc,
  getDocs,
  collection,
  writeBatch,
} from './firestore.js';
import { MyDigitAssetDatabase } from './db.js';

export interface MigrationSummary {
  success: boolean;
  sourceCounts: Record<string, number>;
  migratedCounts: Record<string, number>;
  verifiedCounts: Record<string, number>;
  errors: string[];
}

export async function runFirestoreMigration(): Promise<MigrationSummary> {
  const dbFile = path.join(process.cwd(), 'server', 'data', 'mydigitasset_db.json');
  const summary: MigrationSummary = {
    success: false,
    sourceCounts: {},
    migratedCounts: {},
    verifiedCounts: {},
    errors: [],
  };

  if (!fs.existsSync(dbFile)) {
    summary.errors.push(`Local database file ${dbFile} not found`);
    return summary;
  }

  const raw = fs.readFileSync(dbFile, 'utf8');
  const localDb: MyDigitAssetDatabase = JSON.parse(raw);
  const firestore = getFirestoreDb();

  console.log('[Migration] Beginning migration of mydigitasset_db.json to Firestore Native Mode...');

  // Helper to migrate in batches of 400 (Firestore max batch limit is 500)
  async function migrateCollection<T extends Record<string, any>>(
    collectionName: string,
    items: T[],
    idGetter: (item: T, index: number) => string
  ) {
    summary.sourceCounts[collectionName] = items ? items.length : 0;
    summary.migratedCounts[collectionName] = 0;

    if (!items || items.length === 0) {
      console.log(`[Migration] ${collectionName}: 0 items to migrate.`);
      return;
    }

    const batchSize = 300;
    for (let i = 0; i < items.length; i += batchSize) {
      const chunk = items.slice(i, i + batchSize);
      const batch = writeBatch(firestore);
      for (let j = 0; j < chunk.length; j++) {
        const item = chunk[j];
        const docId = idGetter(item, i + j);
        const docRef = doc(firestore, collectionName, docId);
        // Sanitize undefined fields to prevent Firestore serialization errors
        const sanitized = JSON.parse(JSON.stringify(item));
        batch.set(docRef, sanitized, { merge: true });
      }
      await batch.commit();
      summary.migratedCounts[collectionName] += chunk.length;
    }

    console.log(
      `[Migration] ${collectionName}: migrated ${summary.migratedCounts[collectionName]}/${summary.sourceCounts[collectionName]} items.`
    );
  }

  try {
    // 1. Customers
    await migrateCollection(
      'customers',
      localDb.customers || [],
      (c) => c.customerId
    );

    // 2. Customer Sessions
    await migrateCollection(
      'customerSessions',
      localDb.customerSessions || [],
      (s) => s.sessionToken
    );

    // 3. Payment Orders
    await migrateCollection(
      'paymentOrders',
      localDb.paymentOrders || [],
      (o) => o.paymentOrderId
    );

    // 4. Payments
    await migrateCollection(
      'payments',
      localDb.payments || [],
      (p) => p.paymentId
    );

    // 5. Subscriptions
    await migrateCollection(
      'subscriptions',
      localDb.subscriptions || [],
      (s) => s.subscriptionId
    );

    // 6. Subscription Categories
    await migrateCollection(
      'subscriptionCategories',
      localDb.subscriptionCategories || [],
      (sc) => `${sc.subscriptionId}_${sc.categoryId}`
    );

    // 7. Category Transfer Audits
    await migrateCollection(
      'categoryTransferAudits',
      localDb.categoryTransferAudits || [],
      (a) => a.transferId
    );

    // 8. Telegram Delivery Logs
    await migrateCollection(
      'telegramDeliveryLogs',
      localDb.telegramDeliveryLogs || [],
      (l) => l.deliveryId
    );

    // 9. Daily News Packages
    await migrateCollection(
      'dailyNewsPackages',
      localDb.dailyNewsPackages || [],
      (p) => p.packageId
    );

    // 10. News Stories
    await migrateCollection(
      'newsStories',
      localDb.newsStories || [],
      (s) => s.storyId
    );

    // 11. Telegram Connection Tokens
    await migrateCollection(
      'telegramConnectionTokens',
      localDb.telegramConnectionTokens || [],
      (t) => t.token
    );

    // 12. Telegram Connection Audits
    await migrateCollection(
      'telegramConnectionAudits',
      localDb.telegramConnectionAudits || [],
      (a) => a.eventId
    );

    // 13. Categories
    await migrateCollection(
      'categories',
      localDb.categories || [],
      (c) => c.id
    );

    // 14. Scheduler Initial State Singleton
    const schedulerStateRef = doc(firestore, 'schedulerState', 'singleton');
    await setDoc(
      schedulerStateRef,
      {
        stateId: 'singleton',
        lastGenerationDate: null,
        lastDeliveryDate: null,
        lastDay3EvaluationDate: null,
        activeLockInstanceId: null,
        lockedUntil: null,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    // 15. Verify migrated counts
    console.log('[Migration] Verifying Firestore document counts against local database...');
    const collectionsToVerify: Array<{ name: string; items: any[]; idGetter: (item: any) => string }> = [
      { name: 'customers', items: localDb.customers || [], idGetter: (c) => c.customerId },
      { name: 'customerSessions', items: localDb.customerSessions || [], idGetter: (s) => s.sessionToken },
      { name: 'paymentOrders', items: localDb.paymentOrders || [], idGetter: (o) => o.paymentOrderId },
      { name: 'payments', items: localDb.payments || [], idGetter: (p) => p.paymentId },
      { name: 'subscriptions', items: localDb.subscriptions || [], idGetter: (s) => s.subscriptionId },
      { name: 'subscriptionCategories', items: localDb.subscriptionCategories || [], idGetter: (sc) => `${sc.subscriptionId}_${sc.categoryId}` },
      { name: 'categoryTransferAudits', items: localDb.categoryTransferAudits || [], idGetter: (a) => a.transferId },
      { name: 'telegramDeliveryLogs', items: localDb.telegramDeliveryLogs || [], idGetter: (l) => l.deliveryId },
      { name: 'dailyNewsPackages', items: localDb.dailyNewsPackages || [], idGetter: (p) => p.packageId },
      { name: 'newsStories', items: localDb.newsStories || [], idGetter: (s) => s.storyId },
      { name: 'telegramConnectionTokens', items: localDb.telegramConnectionTokens || [], idGetter: (t) => t.token },
      { name: 'telegramConnectionAudits', items: localDb.telegramConnectionAudits || [], idGetter: (a) => a.eventId },
      { name: 'categories', items: localDb.categories || [], idGetter: (c) => c.id },
    ];

    for (const coll of collectionsToVerify) {
      const snap = await getDocs(collection(firestore, coll.name));
      summary.verifiedCounts[coll.name] = snap.size;
      const expectedUniqueCount = new Set(coll.items.map(coll.idGetter)).size;
      if (snap.size !== expectedUniqueCount) {
        summary.errors.push(
          `Collection ${coll.name} count mismatch: expected ${expectedUniqueCount}, got ${snap.size}`
        );
      }
    }

    summary.success = summary.errors.length === 0;
    console.log('[Migration] Migration completed successfully:', summary.success);
    return summary;
  } catch (err) {
    console.error('[Migration] Migration error:', err);
    summary.errors.push(err instanceof Error ? err.message : String(err));
    summary.success = false;
    return summary;
  }
}

// Allow direct execution from CLI: npx tsx server/migrateToFirestore.ts
if (process.argv[1] && process.argv[1].endsWith('migrateToFirestore.ts')) {
  runFirestoreMigration()
    .then((result) => {
      console.log('Migration Result:', JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal Migration Error:', err);
      process.exit(1);
    });
}
