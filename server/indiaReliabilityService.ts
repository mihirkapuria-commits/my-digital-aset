import {
  DailyNewsPackage,
  NewsStory,
  Customer,
  TelegramDeliveryLog,
} from '../src/types';
import {
  getDb,
  saveDb,
  getCustomerById,
} from './db.js';
import {
  INDIA_CATEGORY_IDS,
  getKolkataDateString,
  generateCategoryDailyNews,
  fetchRealSourceArticlesForCategory,
  filterEligibleCandidateArticles,
  getHistoricalDeliveredStories,
  type RawCollectedArticle,
} from './newsService.js';
import {
  getCustomerActiveEntitlements,
} from './entitlementService.js';
import {
  deliverIndiaCategoryNewsToCustomer,
  IndiaDeliveryAttemptResult,
} from './indiaDeliveryService.js';
import {
  atomicReserveOperation,
  atomicCompleteOperation,
  atomicReleaseReservation,
  getOperationStatus,
} from './idempotencyService.js';

// ============================================================================
// SYSTEM B: INDIA RELIABILITY WATCHDOG & RECONCILIATION CONFIGURATION
// ============================================================================
export const INDIA_WATCHDOG_CONFIG = {
  // Morning operating / recovery window in Asia/Kolkata timezone
  recoveryWindowStartHour: 6,
  recoveryWindowStartMinute: 30, // 06:30 IST
  recoveryWindowEndHour: 10,
  recoveryWindowEndMinute: 0,   // 10:00 IST
  watchdogIntervalMinutes: 15,
  targetStoriesPerCategory: 10,
  maxCategoryRecoveryAttempts: 4, // Max recovery attempts for a partial package
  maxCategoryGenerationAttempts: 5, // Max retry attempts for a failed 0-story package
  maxCustomerDeliveryAttempts: 3,  // Max delivery retries per customer per category per day
} as const;

export interface CategoryReconciliationItem {
  categoryId: string;
  categoryName: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'PENDING' | 'IN_PROGRESS' | 'DISABLED';
  actionTaken:
    | 'none_already_successful'
    | 'none_in_progress'
    | 'none_disabled'
    | 'none_max_retries_exhausted'
    | 'generated_missing_package'
    | 'retried_failed_package'
    | 'recovered_partial_package'
    | 'sealed_partial_package'
    | 'retained_partial_no_new_supply';
  storyCount: number;
  previousStoryCount?: number;
  isSealed?: boolean;
  recoveryAttempts?: number;
  failedAttempts?: number;
  error?: string;
}

export interface DeliveryReconciliationItem {
  customerId: string;
  customerName: string;
  categoryId: string;
  status: 'sent' | 'failed' | 'skipped' | 'not_entitled' | 'telegram_not_connected' | 'in_progress';
  actionTaken:
    | 'none_already_sent'
    | 'none_already_in_progress'
    | 'none_max_retries_exhausted'
    | 'none_not_entitled'
    | 'none_not_connected'
    | 'none_category_disabled'
    | 'delivered_pending'
    | 'retried_failed_delivery';
  attemptCount: number;
  telegramMessageId?: string;
  error?: string;
}

export interface IndiaWatchdogReport {
  newsDate: string;
  timestamp: string;
  executedAtHourKolkata: number;
  executedAtMinuteKolkata: number;
  isWithinRecoveryWindow: boolean;
  isCatchUpRun: boolean;
  categories: CategoryReconciliationItem[];
  deliveries: DeliveryReconciliationItem[];
  summary: {
    totalCategoriesEvaluated: number;
    successfulCategories: number;
    partialCategories: number;
    failedCategories: number;
    missingCategoriesRegenerated: number;
    partialCategoriesRecovered: number;
    totalEligibleCustomers: number;
    deliveriesSent: number;
    deliveriesRetried: number;
    deliveriesSkipped: number;
    deliveriesFailed: number;
  };
}

export interface IndiaReliabilityStatus {
  newsDate: string;
  currentTimeKolkata: string;
  isWithinRecoveryWindow: boolean;
  isCatchUpEligible: boolean;
  categories: {
    totalActive: number;
    successfulCount: number;
    partialCount: number;
    failedCount: number;
    missingCount: number;
    sealedCount: number;
  };
  deliveries: {
    totalSent: number;
    totalFailed: number;
    totalSkipped: number;
    totalNotConnected: number;
  };
  lastWatchdogRunAt?: string;
}

/**
 * Parses current hour and minute in Asia/Kolkata timezone
 */
export function getKolkataTime(date: Date = new Date()): {
  kolkataDate: string;
  hour: number;
  minute: number;
  timeString: string;
} {
  const kolkataDate = getKolkataDateString(date);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const timeString = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { kolkataDate, hour, minute, timeString };
}

/**
 * Checks whether current Asia/Kolkata time is within the recommended morning recovery window (06:30 - 10:00 IST)
 */
export function isWithinIndiaRecoveryWindow(date: Date = new Date()): boolean {
  const { hour, minute } = getKolkataTime(date);
  const currentTotalMinutes = hour * 60 + minute;
  const startTotalMinutes =
    INDIA_WATCHDOG_CONFIG.recoveryWindowStartHour * 60 +
    INDIA_WATCHDOG_CONFIG.recoveryWindowStartMinute; // 390 (06:30)
  const endTotalMinutes =
    INDIA_WATCHDOG_CONFIG.recoveryWindowEndHour * 60 +
    INDIA_WATCHDOG_CONFIG.recoveryWindowEndMinute; // 600 (10:00)

  return currentTotalMinutes >= startTotalMinutes && currentTotalMinutes <= endTotalMinutes;
}

/**
 * Checks whether morning catch-up is needed for System B on today's date.
 * Catch-up is needed if:
 * 1. Current time is after 06:00 IST (e.g. 07:10, 07:30, 08:00, 09:00, 09:30, 10:00).
 * 2. At least one enabled India category does not have a successful/sealed package, OR
 *    at least one customer delivery remains unfulfilled.
 */
export function isIndiaMorningCatchUpEligible(
  referenceDate: Date = new Date(),
  targetDate?: string
): boolean {
  const db = getDb();
  const dateStr = targetDate || getKolkataDateString(referenceDate);
  const { hour } = getKolkataTime(referenceDate);

  // Before 06:00 IST, scheduled morning cycle has not started
  if (hour < 6) return false;

  const activeCats = db.categories.filter(
    (c) => c.isActive && (c.system === 'india' || INDIA_CATEGORY_IDS.includes(c.id as any))
  );

  // Check if any category lacks a successful package
  const hasIncompleteCategories = activeCats.some((cat) => {
    const pkg = db.dailyNewsPackages.find(
      (p) => p.categoryId === cat.id && p.newsDate === dateStr
    );
    if (!pkg) return true;
    if (pkg.generationStatus === 'failed') return true;
    if (pkg.generationStatus === 'partial' && !pkg.isSealed) return true;
    return false;
  });

  return hasIncompleteCategories;
}

export interface ReconcileGenerationOptions {
  forceRecoveryWindow?: boolean; // For deterministic testing of recovery window logic
  customCandidatePool?: Record<string, RawCollectedArticle[]>; // For test mocking of source recovery
  sourceProviderMode?: 'auto' | 'live' | 'mock';
}

/**
 * ============================================================================
 * IMPLEMENTATION PART 2 & 4: CATEGORY GENERATION RECONCILIATION & PARTIAL PROTECTION
 * ============================================================================
 * Inspects all 10 India categories for the given news date:
 * - Case A: Full successful package exists (>= 10 stories) -> Do nothing.
 * - Case B: Partial package exists (< 10 stories) -> Controlled recovery attempt during recovery window.
 *           If more stories available -> upgrade. If not -> do not downgrade.
 *           If recovery window elapsed or max attempts reached -> seal as final.
 * - Case C: Failed package with 0 stories -> retry automatically within bounded limits.
 * - Case D: No package exists -> attempt generation.
 * - Case E: In-progress reservation -> do not interfere.
 * - Case F: Repeatedly failed package -> bounded limit (no infinite loop).
 */
export async function reconcileIndiaCategoryGeneration(
  newsDate: string = getKolkataDateString(),
  referenceDate: Date = new Date(),
  options: ReconcileGenerationOptions = {}
): Promise<{
  newsDate: string;
  items: CategoryReconciliationItem[];
}> {
  const db = getDb();
  const items: CategoryReconciliationItem[] = [];

  const inRecoveryWindow =
    options.forceRecoveryWindow !== undefined
      ? options.forceRecoveryWindow
      : isWithinIndiaRecoveryWindow(referenceDate);

  const activeIndiaCategories = db.categories.filter(
    (c) => c.system === 'india' || INDIA_CATEGORY_IDS.includes(c.id as any)
  );

  for (const cat of activeIndiaCategories) {
    // ADMIN DISABLE CHECK
    if (!cat.isActive) {
      items.push({
        categoryId: cat.id,
        categoryName: cat.name,
        status: 'DISABLED',
        actionTaken: 'none_disabled',
        storyCount: 0,
      });
      continue;
    }

    const packageKey = `pkg_${newsDate}_${cat.id}`;

    // CASE E: ACTIVE RESERVATION CHECK
    // Do not interfere with an active operation currently in progress by another instance
    try {
      const opStatus = await getOperationStatus(packageKey);
      if (opStatus.status === 'RESERVED') {
        const existingPkg = db.dailyNewsPackages.find(
          (p) => p.categoryId === cat.id && p.newsDate === newsDate
        );
        items.push({
          categoryId: cat.id,
          categoryName: cat.name,
          status: 'IN_PROGRESS',
          actionTaken: 'none_in_progress',
          storyCount: existingPkg?.storyCount || 0,
        });
        continue;
      }
    } catch (_) {}

    const existingPkg = db.dailyNewsPackages.find(
      (p) => p.categoryId === cat.id && p.newsDate === newsDate
    );

    // CASE A: SUCCESSFUL PACKAGE EXISTS (Full 10 stories)
    if (
      existingPkg &&
      existingPkg.generationStatus === 'success' &&
      existingPkg.storyCount >= INDIA_WATCHDOG_CONFIG.targetStoriesPerCategory
    ) {
      items.push({
        categoryId: cat.id,
        categoryName: cat.name,
        status: 'SUCCESS',
        actionTaken: 'none_already_successful',
        storyCount: existingPkg.storyCount,
        recoveryAttempts: existingPkg.recoveryAttempts,
      });
      continue;
    }

    // CASE B: PARTIAL PACKAGE EXISTS (< 10 stories)
    if (
      existingPkg &&
      (existingPkg.generationStatus === 'partial' ||
        (existingPkg.generationStatus === 'success' &&
          existingPkg.storyCount < INDIA_WATCHDOG_CONFIG.targetStoriesPerCategory))
    ) {
      const currentRecoveryAttempts = existingPkg.recoveryAttempts || 0;
      const isSealed = Boolean(existingPkg.isSealed);

      // Check if eligible for recovery attempt
      const isEligibleForRecovery =
        !isSealed &&
        currentRecoveryAttempts < INDIA_WATCHDOG_CONFIG.maxCategoryRecoveryAttempts &&
        inRecoveryWindow;

      if (!isEligibleForRecovery) {
        // If outside recovery window or max attempts reached, seal partial package as final
        if (!isSealed) {
          existingPkg.isSealed = true;
          existingPkg.updatedAt = new Date().toISOString();
          saveDb();
          console.log(
            `[Watchdog Partial Seal] Category '${cat.name}' on ${newsDate}: Sealed partial package (${existingPkg.storyCount} stories) as final for the day.`
          );
        }

        items.push({
          categoryId: cat.id,
          categoryName: cat.name,
          status: 'PARTIAL',
          actionTaken: isSealed ? 'none_already_successful' : 'sealed_partial_package',
          storyCount: existingPkg.storyCount,
          isSealed: true,
          recoveryAttempts: currentRecoveryAttempts,
        });
        continue;
      }

      // Controlled recovery attempt (Part 4)
      console.log(
        `[Watchdog Recovery Attempt] Category '${cat.name}' on ${newsDate}: Attempting recovery for partial package (${existingPkg.storyCount}/10 stories, attempt ${currentRecoveryAttempts + 1})...`
      );

      try {
        const candidatePool = options.customCandidatePool?.[cat.id];
        const recoveryRes = await generateCategoryDailyNews(cat.id, newsDate, {
          allowPartialRecovery: true,
          candidatePool,
          sourceProviderMode: options.sourceProviderMode,
          referenceDate,
        });

        if (recoveryRes.success && recoveryRes.package) {
          const updatedPkg = recoveryRes.package;
          const newStoryCount = updatedPkg.storyCount;

          if (newStoryCount > existingPkg.storyCount) {
            items.push({
              categoryId: cat.id,
              categoryName: cat.name,
              status: updatedPkg.generationStatus === 'success' ? 'SUCCESS' : 'PARTIAL',
              actionTaken: 'recovered_partial_package',
              storyCount: newStoryCount,
              previousStoryCount: existingPkg.storyCount,
              recoveryAttempts: updatedPkg.recoveryAttempts,
            });
          } else {
            items.push({
              categoryId: cat.id,
              categoryName: cat.name,
              status: 'PARTIAL',
              actionTaken: 'retained_partial_no_new_supply',
              storyCount: existingPkg.storyCount,
              recoveryAttempts: updatedPkg.recoveryAttempts || currentRecoveryAttempts + 1,
            });
          }
        } else {
          // Recovery attempt did not produce new stories; keep existing partial package intact
          existingPkg.recoveryAttempts = currentRecoveryAttempts + 1;
          existingPkg.updatedAt = new Date().toISOString();
          saveDb();

          items.push({
            categoryId: cat.id,
            categoryName: cat.name,
            status: 'PARTIAL',
            actionTaken: 'retained_partial_no_new_supply',
            storyCount: existingPkg.storyCount,
            recoveryAttempts: existingPkg.recoveryAttempts,
            error: recoveryRes.error,
          });
        }
      } catch (recErr: any) {
        console.error(`[Watchdog Recovery Error] ${cat.id}:`, recErr.message);
        existingPkg.recoveryAttempts = currentRecoveryAttempts + 1;
        existingPkg.updatedAt = new Date().toISOString();
        saveDb();

        items.push({
          categoryId: cat.id,
          categoryName: cat.name,
          status: 'PARTIAL',
          actionTaken: 'retained_partial_no_new_supply',
          storyCount: existingPkg.storyCount,
          recoveryAttempts: existingPkg.recoveryAttempts,
          error: recErr.message,
        });
      }
      continue;
    }

    // CASE C & F: FAILED PACKAGE WITH ZERO STORIES
    if (existingPkg && existingPkg.generationStatus === 'failed') {
      const failedAttempts = (existingPkg as any).failedAttempts || 1;

      // CASE F: BOUNDED RETRY LIMIT CHECK
      if (failedAttempts >= INDIA_WATCHDOG_CONFIG.maxCategoryGenerationAttempts) {
        console.warn(
          `[Watchdog Bounded Limit] Category '${cat.name}' on ${newsDate}: Max generation retry attempts (${INDIA_WATCHDOG_CONFIG.maxCategoryGenerationAttempts}) exhausted.`
        );
        items.push({
          categoryId: cat.id,
          categoryName: cat.name,
          status: 'FAILED',
          actionTaken: 'none_max_retries_exhausted',
          storyCount: 0,
          failedAttempts,
          error: existingPkg.errorMessage,
        });
        continue;
      }

      // CASE C: RETRY GENERATION
      console.log(
        `[Watchdog Retry Failed Package] Category '${cat.name}' on ${newsDate}: Retrying failed package (attempt ${failedAttempts + 1})...`
      );

      // Release any prior failed idempotency lock to permit clean retry
      await atomicReleaseReservation(packageKey, 'Retrying previously failed package');

      try {
        const candidatePool = options.customCandidatePool?.[cat.id];
        const retryGen = await generateCategoryDailyNews(cat.id, newsDate, {
          candidatePool,
          sourceProviderMode: options.sourceProviderMode,
          referenceDate,
        });

        if (retryGen.success && retryGen.package && retryGen.stories && retryGen.stories.length > 0) {
          items.push({
            categoryId: cat.id,
            categoryName: cat.name,
            status: retryGen.package.generationStatus === 'success' ? 'SUCCESS' : 'PARTIAL',
            actionTaken: 'retried_failed_package',
            storyCount: retryGen.stories.length,
          });
        } else {
          // Failed again; preserve persistent failed state
          const updatedFailed = db.dailyNewsPackages.find(
            (p) => p.categoryId === cat.id && p.newsDate === newsDate
          );
          items.push({
            categoryId: cat.id,
            categoryName: cat.name,
            status: 'FAILED',
            actionTaken: 'none_max_retries_exhausted',
            storyCount: 0,
            failedAttempts: failedAttempts + 1,
            error: retryGen.error || updatedFailed?.errorMessage || 'Generation returned 0 stories',
          });
        }
      } catch (err: any) {
        items.push({
          categoryId: cat.id,
          categoryName: cat.name,
          status: 'FAILED',
          actionTaken: 'none_max_retries_exhausted',
          storyCount: 0,
          failedAttempts: failedAttempts + 1,
          error: err.message || 'Generation error',
        });
      }
      continue;
    }

    // CASE D: NO PACKAGE EXISTS (Incomplete)
    if (!existingPkg) {
      console.log(
        `[Watchdog Missing Package] Category '${cat.name}' on ${newsDate}: No package found. Triggering generation...`
      );

      try {
        const candidatePool = options.customCandidatePool?.[cat.id];
        const genRes = await generateCategoryDailyNews(cat.id, newsDate, {
          candidatePool,
          sourceProviderMode: options.sourceProviderMode,
          referenceDate,
        });

        if (genRes.success && genRes.package && genRes.stories && genRes.stories.length > 0) {
          items.push({
            categoryId: cat.id,
            categoryName: cat.name,
            status: genRes.package.generationStatus === 'success' ? 'SUCCESS' : 'PARTIAL',
            actionTaken: 'generated_missing_package',
            storyCount: genRes.stories.length,
          });
        } else {
          items.push({
            categoryId: cat.id,
            categoryName: cat.name,
            status: 'FAILED',
            actionTaken: 'none_max_retries_exhausted',
            storyCount: 0,
            failedAttempts: 1,
            error: genRes.error || 'Initial generation produced 0 stories',
          });
        }
      } catch (err: any) {
        items.push({
          categoryId: cat.id,
          categoryName: cat.name,
          status: 'FAILED',
          actionTaken: 'none_max_retries_exhausted',
          storyCount: 0,
          failedAttempts: 1,
          error: err.message || 'Generation error',
        });
      }
    }
  }

  return {
    newsDate,
    items,
  };
}

export interface ReconcileDeliveryOptions {
  simulateTelegramFailureUntilAttempt?: number;
}

/**
 * ============================================================================
 * IMPLEMENTATION PART 5 & 6: CUSTOMER DELIVERY RECONCILIATION & RETRY SAFETY
 * ============================================================================
 * For every existing successful or partial System B package:
 * Finds all active, entitled, and connected customers.
 * - Case A: Sent exists -> Do nothing.
 * - Case B: Failed exists -> Retry within bounded limits (<= 3 attempts).
 * - Case C: No record exists -> Treat as pending, attempt delivery.
 * - Case D: Category disabled -> Do not deliver.
 * - Case E: Not entitled -> Do not deliver.
 * - Case F: Not connected -> Do not deliver.
 * Recovers customers missed due to Cloud Run restarts, process crashes,
 * temporary Telegram downtime, or partial scheduler runs.
 */
export async function reconcileIndiaCustomerDeliveries(
  newsDate: string = getKolkataDateString(),
  referenceDate?: Date,
  options: ReconcileDeliveryOptions = {}
): Promise<{
  newsDate: string;
  items: DeliveryReconciliationItem[];
}> {
  const db = getDb();
  const items: DeliveryReconciliationItem[] = [];
  const refDate =
    referenceDate || (newsDate ? new Date(`${newsDate}T07:00:00+05:30`) : new Date());

  // Active India categories in catalog
  const activeIndiaCategories = db.categories.filter(
    (c) => c.isActive && (c.system === 'india' || INDIA_CATEGORY_IDS.includes(c.id as any))
  );
  const activeIndiaCatMap = new Map(activeIndiaCategories.map((c) => [c.id, c]));

  // Find all packages for today that are deliverable (success or partial)
  // Packages with 0 stories (failed) are strictly excluded from delivery!
  const deliverablePackages = db.dailyNewsPackages.filter(
    (p) =>
      p.newsDate === newsDate &&
      activeIndiaCatMap.has(p.categoryId) &&
      (p.generationStatus === 'success' || p.generationStatus === 'partial') &&
      p.storyCount > 0
  );

  const activeCustomers = db.customers.filter((c) => c.accountStatus === 'active');

  for (const customer of activeCustomers) {
    const entitlements = getCustomerActiveEntitlements(customer.customerId, refDate);
    const entitledIndiaCats = entitlements.entitledCategories.filter((ec) =>
      activeIndiaCatMap.has(ec.categoryId)
    );

    for (const ec of entitledIndiaCats) {
      const pkg = deliverablePackages.find((p) => p.categoryId === ec.categoryId);

      // If package for this category hasn't generated yet or has 0 stories, skip delivery
      if (!pkg) {
        continue;
      }

      const deliveryId = `del_in_${newsDate}_${customer.customerId}_${ec.categoryId}`;
      const customerLogs = (db.indiaTelegramDeliveryLogs || []).filter(
        (l) =>
          l.customerId === customer.customerId &&
          l.categoryId === ec.categoryId &&
          l.newsDate === newsDate
      );

      // CASE A: SENT EXISTS -> Do nothing
      const successfulLog = customerLogs.find((l) => l.status === 'sent');
      if (successfulLog) {
        items.push({
          customerId: customer.customerId,
          customerName: customer.fullName,
          categoryId: ec.categoryId,
          status: 'sent',
          actionTaken: 'none_already_sent',
          attemptCount: customerLogs.length,
          telegramMessageId: successfulLog.telegramMessageId || undefined,
        });
        continue;
      }

      // Check idempotency store for remote completion
      try {
        const opStatus = await getOperationStatus(deliveryId);
        if (opStatus.status === 'COMPLETED') {
          items.push({
            customerId: customer.customerId,
            customerName: customer.fullName,
            categoryId: ec.categoryId,
            status: 'sent',
            actionTaken: 'none_already_sent',
            attemptCount: customerLogs.length,
          });
          continue;
        }
      } catch (_) {}

      // CASE F: TELEGRAM NOT CONNECTED
      const isTgConnected = Boolean(customer.indiaTelegramConnected || customer.telegramConnected);
      const tgChatId = customer.indiaTelegramChatId || customer.telegramChatId;
      if (!isTgConnected || !tgChatId) {
        items.push({
          customerId: customer.customerId,
          customerName: customer.fullName,
          categoryId: ec.categoryId,
          status: 'telegram_not_connected',
          actionTaken: 'none_not_connected',
          attemptCount: customerLogs.length,
          error: 'Customer Telegram account is not linked.',
        });
        continue;
      }

      // Count prior failed attempts
      const failedLogs = customerLogs.filter((l) => l.status === 'failed');
      const failedCount = failedLogs.length;

      // CASE B: FAILED RETRY BOUNDED LIMIT CHECK
      if (failedCount >= INDIA_WATCHDOG_CONFIG.maxCustomerDeliveryAttempts) {
        console.warn(
          `[Watchdog Delivery Bounded Limit] Customer ${customer.customerId} for ${ec.categoryId}: Max delivery attempts (${INDIA_WATCHDOG_CONFIG.maxCustomerDeliveryAttempts}) reached.`
        );
        items.push({
          customerId: customer.customerId,
          customerName: customer.fullName,
          categoryId: ec.categoryId,
          status: 'failed',
          actionTaken: 'none_max_retries_exhausted',
          attemptCount: failedCount,
          error: failedLogs[failedLogs.length - 1]?.error || 'Max delivery retries exhausted',
        });
        continue;
      }

      // ATTEMPT DELIVERY (Handles Case B retry & Case C missing delivery)
      const isRetry = failedCount > 0;
      console.log(
        `[Watchdog Delivery Dispatch] Customer ${customer.fullName} (${customer.customerId}) for ${ec.categoryId} on ${newsDate} (IsRetry: ${isRetry}, PriorFailures: ${failedCount})...`
      );

      try {
        const deliveryResult = await deliverIndiaCategoryNewsToCustomer({
          customerId: customer.customerId,
          categoryId: ec.categoryId,
          newsDate,
          referenceDate: refDate,
          simulateTelegramFailureUntilAttempt: options.simulateTelegramFailureUntilAttempt,
        });

        items.push({
          customerId: customer.customerId,
          customerName: customer.fullName,
          categoryId: ec.categoryId,
          status: deliveryResult.status as any,
          actionTaken: isRetry ? 'retried_failed_delivery' : 'delivered_pending',
          attemptCount: failedCount + 1,
          error: deliveryResult.error,
        });
      } catch (delErr: any) {
        console.error(
          `[Watchdog Delivery Exception] ${customer.customerId} for ${ec.categoryId}:`,
          delErr.message
        );
        items.push({
          customerId: customer.customerId,
          customerName: customer.fullName,
          categoryId: ec.categoryId,
          status: 'failed',
          actionTaken: isRetry ? 'retried_failed_delivery' : 'delivered_pending',
          attemptCount: failedCount + 1,
          error: delErr.message,
        });
      }
    }
  }

  return {
    newsDate,
    items,
  };
}

export interface IndiaWatchdogOptions {
  newsDate?: string;
  referenceDate?: Date;
  forceRecoveryWindow?: boolean;
  customCandidatePool?: Record<string, RawCollectedArticle[]>;
  sourceProviderMode?: 'auto' | 'live' | 'mock';
  simulateTelegramFailureUntilAttempt?: number;
}

/**
 * ============================================================================
 * IMPLEMENTATION PART 1 & 7: MASTER INDIA RELIABILITY WATCHDOG / RECONCILER
 * ============================================================================
 * Safe to run repeatedly (idempotent, atomic).
 * Orchestrates category generation reconciliation and customer delivery reconciliation.
 * Tolerates concurrent execution via distributed atomic operations.
 * Isolates System B failures completely from System A.
 */
export async function runIndiaReliabilityWatchdog(
  options: IndiaWatchdogOptions = {}
): Promise<IndiaWatchdogReport> {
  const refDate =
    options.referenceDate ||
    (options.newsDate ? new Date(`${options.newsDate}T07:00:00+05:30`) : new Date());
  const { kolkataDate, hour, minute } = getKolkataTime(refDate);
  const targetNewsDate = options.newsDate || kolkataDate;
  const inRecoveryWindow =
    options.forceRecoveryWindow !== undefined
      ? options.forceRecoveryWindow
      : isWithinIndiaRecoveryWindow(refDate);

  const isCatchUp = isIndiaMorningCatchUpEligible(refDate, targetNewsDate);

  // Concurrency Guard: Atomic Watchdog Cycle Lease for this time slot
  // Allows repeatable runs across distinct ticks while protecting simultaneous race conditions
  const slotMinutes = Math.floor(minute / INDIA_WATCHDOG_CONFIG.watchdogIntervalMinutes) * INDIA_WATCHDOG_CONFIG.watchdogIntervalMinutes;
  const watchdogSlotKey = `watchdog_in_${targetNewsDate}_${String(hour).padStart(2, '0')}_${String(slotMinutes).padStart(2, '0')}`;

  console.log(
    `[India Reliability Watchdog] Executing watchdog cycle for ${targetNewsDate} at ${hour}:${String(minute).padStart(2, '0')} IST (InRecoveryWindow: ${inRecoveryWindow}, IsCatchUp: ${isCatchUp})...`
  );

  let categoryItems: CategoryReconciliationItem[] = [];
  let deliveryItems: DeliveryReconciliationItem[] = [];

  // PHASE 1: CATEGORY GENERATION RECONCILIATION
  try {
    const genResult = await reconcileIndiaCategoryGeneration(targetNewsDate, refDate, {
      forceRecoveryWindow: options.forceRecoveryWindow,
      customCandidatePool: options.customCandidatePool,
      sourceProviderMode: options.sourceProviderMode,
    });
    categoryItems = genResult.items;
  } catch (genErr: any) {
    console.error('[India Watchdog Generation Reconciliation Error]:', genErr);
  }

  // PHASE 2: CUSTOMER DELIVERY RECONCILIATION
  try {
    const delResult = await reconcileIndiaCustomerDeliveries(targetNewsDate, refDate, {
      simulateTelegramFailureUntilAttempt: options.simulateTelegramFailureUntilAttempt,
    });
    deliveryItems = delResult.items;
  } catch (delErr: any) {
    console.error('[India Watchdog Delivery Reconciliation Error]:', delErr);
  }

  // Summarize results
  const successfulCategories = categoryItems.filter((i) => i.status === 'SUCCESS').length;
  const partialCategories = categoryItems.filter((i) => i.status === 'PARTIAL').length;
  const failedCategories = categoryItems.filter((i) => i.status === 'FAILED').length;
  const missingCategoriesRegenerated = categoryItems.filter(
    (i) => i.actionTaken === 'generated_missing_package'
  ).length;
  const partialCategoriesRecovered = categoryItems.filter(
    (i) => i.actionTaken === 'recovered_partial_package'
  ).length;

  const deliveriesSent = deliveryItems.filter(
    (i) => i.status === 'sent' && (i.actionTaken === 'delivered_pending' || i.actionTaken === 'retried_failed_delivery')
  ).length;
  const deliveriesRetried = deliveryItems.filter(
    (i) => i.actionTaken === 'retried_failed_delivery'
  ).length;
  const deliveriesSkipped = deliveryItems.filter((i) => i.status === 'skipped').length;
  const deliveriesFailed = deliveryItems.filter((i) => i.status === 'failed').length;

  const report: IndiaWatchdogReport = {
    newsDate: targetNewsDate,
    timestamp: new Date().toISOString(),
    executedAtHourKolkata: hour,
    executedAtMinuteKolkata: minute,
    isWithinRecoveryWindow: inRecoveryWindow,
    isCatchUpRun: isCatchUp,
    categories: categoryItems,
    deliveries: deliveryItems,
    summary: {
      totalCategoriesEvaluated: categoryItems.length,
      successfulCategories,
      partialCategories,
      failedCategories,
      missingCategoriesRegenerated,
      partialCategoriesRecovered,
      totalEligibleCustomers: new Set(deliveryItems.map((d) => d.customerId)).size,
      deliveriesSent,
      deliveriesRetried,
      deliveriesSkipped,
      deliveriesFailed,
    },
  };

  return report;
}

/**
 * Returns current reliability status for System B administration and monitoring
 */
export function getIndiaReliabilityStatus(
  newsDate: string = getKolkataDateString(),
  referenceDate: Date = new Date()
): IndiaReliabilityStatus {
  const db = getDb();
  const { hour, minute, timeString } = getKolkataTime(referenceDate);

  const activeIndiaCategories = db.categories.filter(
    (c) => c.isActive && (c.system === 'india' || INDIA_CATEGORY_IDS.includes(c.id as any))
  );

  const packages = db.dailyNewsPackages.filter(
    (p) => p.newsDate === newsDate && activeIndiaCategories.some((c) => c.id === p.categoryId)
  );

  const successfulCount = packages.filter(
    (p) => p.generationStatus === 'success' && p.storyCount >= INDIA_WATCHDOG_CONFIG.targetStoriesPerCategory
  ).length;
  const partialCount = packages.filter(
    (p) => p.generationStatus === 'partial' || (p.generationStatus === 'success' && p.storyCount < INDIA_WATCHDOG_CONFIG.targetStoriesPerCategory)
  ).length;
  const failedCount = packages.filter((p) => p.generationStatus === 'failed').length;
  const sealedCount = packages.filter((p) => Boolean(p.isSealed)).length;
  const missingCount = Math.max(0, activeIndiaCategories.length - packages.length);

  const deliveryLogs = (db.indiaTelegramDeliveryLogs || []).filter(
    (l) => l.newsDate === newsDate
  );

  return {
    newsDate,
    currentTimeKolkata: timeString,
    isWithinRecoveryWindow: isWithinIndiaRecoveryWindow(referenceDate),
    isCatchUpEligible: isIndiaMorningCatchUpEligible(referenceDate, newsDate),
    categories: {
      totalActive: activeIndiaCategories.length,
      successfulCount,
      partialCount,
      failedCount,
      missingCount,
      sealedCount,
    },
    deliveries: {
      totalSent: deliveryLogs.filter((l) => l.status === 'sent').length,
      totalFailed: deliveryLogs.filter((l) => l.status === 'failed').length,
      totalSkipped: deliveryLogs.filter((l) => l.status === 'skipped').length,
      totalNotConnected: deliveryLogs.filter((l) => l.status === 'telegram_not_connected').length,
    },
  };
}
