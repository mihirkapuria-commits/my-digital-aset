import {
  TelegramDeliveryLog,
  NewsStory,
} from '../src/types';
import {
  getDb,
  saveDb,
  getCustomerById,
} from './db.js';
import {
  getCustomerActiveEntitlements,
} from './entitlementService.js';
import {
  sendIndiaTelegramMessage,
} from './indiaTelegramService.js';
import {
  getKolkataDateString,
  formatCategoryNewsTelegramMessage,
} from './newsService.js';
import {
  atomicReserveOperation,
  atomicCompleteOperation,
  atomicReleaseReservation,
  getOperationStatus,
} from './idempotencyService.js';

// ============================================================================
// SYSTEM B: NEW INDIA NEWS TELEGRAM DELIVERY PIPELINE
// ============================================================================
// Completely separate delivery pipeline for the 10 India categories.
// Uses dedicated India Telegram bot.
// Isolated failure handling: a failure in this pipeline never halts System A.

export interface IndiaDeliveryAttemptResult {
  deliveryId: string;
  customerId: string;
  categoryId: string;
  newsDate: string;
  status: TelegramDeliveryLog['status'];
  error?: string;
  botType: 'india';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delivers India category executive briefing to an individual customer
 */
export async function deliverIndiaCategoryNewsToCustomer(params: {
  customerId: string;
  categoryId: string;
  newsDate?: string;
  referenceDate?: Date;
  simulateTelegramFailureUntilAttempt?: number;
}): Promise<IndiaDeliveryAttemptResult> {
  const db = getDb();
  if (!Array.isArray(db.indiaTelegramDeliveryLogs)) {
    db.indiaTelegramDeliveryLogs = [];
  }

  const newsDate = params.newsDate || getKolkataDateString(params.referenceDate || new Date());
  const refDate =
    params.referenceDate || (params.newsDate ? new Date(`${params.newsDate}T07:00:00+05:30`) : new Date());
  const deliveryId = `del_in_${newsDate}_${params.customerId}_${params.categoryId}`;
  const now = new Date().toISOString();

  // Helper to record immutable log in System B logs
  const recordLog = (
    status: TelegramDeliveryLog['status'],
    chatId: string = '',
    error?: string,
    messageId?: string
  ): IndiaDeliveryAttemptResult => {
    const log: TelegramDeliveryLog = {
      deliveryId,
      customerId: params.customerId,
      categoryId: params.categoryId,
      newsDate,
      telegramChatId: chatId,
      attemptedAt: now,
      status,
      telegramMessageId: messageId || null,
      error: error || null,
      timestamp: now,
      system: 'india',
      botType: 'india',
    };

    db.indiaTelegramDeliveryLogs.push(log);
    // Also mirror into main delivery log with system discriminant for unified reporting
    const existingMain = db.telegramDeliveryLogs.find((l) => l.deliveryId === deliveryId);
    if (!existingMain) {
      db.telegramDeliveryLogs.push(log);
    }
    saveDb();

    return {
      deliveryId,
      customerId: params.customerId,
      categoryId: params.categoryId,
      newsDate,
      status,
      error,
      botType: 'india',
    };
  };

  // 1. ADMIN ENABLE / DISABLE CHECK (Requirement: Disabled category does not deliver Telegram news)
  const category = db.categories.find((c) => c.id === params.categoryId);
  if (!category || !category.isActive) {
    return recordLog(
      'skipped',
      '',
      `India category '${params.categoryId}' is currently disabled in admin catalog. Delivery suppressed.`
    );
  }

  // 2. Duplicate Send Protection: Do not deliver twice for same customer + category + newsDate
  const priorSuccessfulDelivery = db.indiaTelegramDeliveryLogs.find(
    (l) =>
      l.customerId === params.customerId &&
      l.categoryId === params.categoryId &&
      l.newsDate === newsDate &&
      l.status === 'sent'
  );

  if (priorSuccessfulDelivery) {
    return {
      deliveryId,
      customerId: params.customerId,
      categoryId: params.categoryId,
      newsDate,
      status: 'skipped',
      error: `Already delivered successfully on ${newsDate} (Message ID: ${priorSuccessfulDelivery.telegramMessageId})`,
      botType: 'india',
    };
  }

  const opStatus = await getOperationStatus(deliveryId);
  if (opStatus.status === 'COMPLETED') {
    return {
      deliveryId,
      customerId: params.customerId,
      categoryId: params.categoryId,
      newsDate,
      status: 'skipped',
      error: 'Already completed by prior delivery operation',
      botType: 'india',
    };
  }

  // 3. Central Entitlement Evaluation
  const customer = getCustomerById(params.customerId);
  if (!customer) {
    return recordLog('skipped', '', `Customer '${params.customerId}' not found.`);
  }

  // Check customer chat ID (prefer indiaTelegramChatId, fallback to telegramChatId if connected)
  const telegramChatId = customer.indiaTelegramChatId || customer.telegramChatId;
  const isTgConnected = Boolean(customer.indiaTelegramConnected || customer.telegramConnected);

  if (!isTgConnected || !telegramChatId) {
    return recordLog(
      'telegram_not_connected',
      '',
      'Telegram not connected for this customer. Subscriber must link their Telegram account.'
    );
  }

  const entitlementEvaluation = getCustomerActiveEntitlements(params.customerId, refDate);
  const isEntitled = entitlementEvaluation.entitledCategories.some(
    (ec) => ec.categoryId === params.categoryId
  );

  if (!isEntitled) {
    const reasons = entitlementEvaluation.ineligibleReasons.join('; ') || 'No active entitlement for this category';
    return recordLog('not_entitled', telegramChatId, reasons);
  }

  // 4. Retrieve Generated Daily News Package for this India Category
  const pkg = db.dailyNewsPackages.find(
    (p) =>
      p.newsDate === newsDate &&
      p.categoryId === params.categoryId &&
      (p.generationStatus === 'success' || p.generationStatus === 'partial')
  );

  if (!pkg) {
    const failedPkg = db.dailyNewsPackages.find(
      (p) => p.categoryId === params.categoryId && p.newsDate === newsDate && p.generationStatus === 'failed'
    );
    const failureReason =
      failedPkg?.errorMessage ||
      `No daily news package generated yet for India category '${params.categoryId}' on ${newsDate}.`;
    return recordLog('failed', telegramChatId, failureReason);
  }

  // 5. Fetch stories for package
  const stories = db.newsStories
    .filter((s) => s.packageId === pkg.packageId)
    .sort((a, b) => a.position - b.position);

  if (stories.length === 0) {
    return recordLog(
      'failed',
      telegramChatId,
      `Package '${pkg.packageId}' contains 0 stories. Empty briefing delivery blocked.`
    );
  }

  // 6. Format Executive Telegram Message
  const messageText = formatCategoryNewsTelegramMessage(pkg.categoryName, newsDate, stories);

  // 7. Atomic check-and-reserve for del_in_<newsDate>_<customerId>_<categoryId>
  const reservation = await atomicReserveOperation(deliveryId, {
    metadata: {
      customerId: params.customerId,
      categoryId: params.categoryId,
      newsDate,
      telegramChatId,
      botType: 'india',
    },
  });

  if (!reservation.reserved) {
    return recordLog(
      'skipped',
      telegramChatId,
      `Delivery operation currently in progress or already completed by another instance (Reason: ${reservation.reason})`
    );
  }

  // 8. Dispatch via SEPARATE India Telegram Bot
  try {
    const sendResult = await sendIndiaTelegramMessage(telegramChatId, messageText, {
      maxRetries: 3,
      simulateFailuresUntilAttempt: params.simulateTelegramFailureUntilAttempt,
    });

    if (sendResult.success) {
      await atomicCompleteOperation(deliveryId, { telegramMessageId: sendResult.telegramMessageId });
      return recordLog('sent', telegramChatId, undefined, sendResult.telegramMessageId);
    } else {
      await atomicReleaseReservation(deliveryId, sendResult.error || 'Failed to dispatch via India bot');
      return recordLog('failed', telegramChatId, sendResult.error || 'Failed to dispatch via India bot');
    }
  } catch (err: any) {
    await atomicReleaseReservation(deliveryId, err.message || 'System B delivery exception');
    return recordLog('failed', telegramChatId, `System B delivery exception: ${err.message || err}`);
  }
}

/**
 * Dispatches daily morning briefings across all active India categories to all eligible customers
 */
export async function deliverDailyIndiaBriefingsToAllEligibleCustomers(
  newsDate?: string,
  referenceDate?: Date,
  options?: { maxRetries?: number; simulateTelegramFailureUntilAttempt?: number }
): Promise<{
  newsDate: string;
  totalCustomersEvaluated: number;
  totalDeliveriesSent: number;
  totalDeliveriesSkipped: number;
  totalDeliveriesFailed: number;
  results: IndiaDeliveryAttemptResult[];
}> {
  const db = getDb();
  const targetDate = newsDate || getKolkataDateString(referenceDate || new Date());
  const refDate =
    referenceDate || (newsDate ? new Date(`${newsDate}T07:00:00+05:30`) : new Date());

  // Active India categories in catalog
  const activeIndiaCategories = db.categories.filter((c) => c.isActive && c.system === 'india');
  const activeIndiaCategoryIds = new Set(activeIndiaCategories.map((c) => c.id));

  const results: IndiaDeliveryAttemptResult[] = [];
  let totalDeliveriesSent = 0;
  let totalDeliveriesSkipped = 0;
  let totalDeliveriesFailed = 0;

  const activeCustomers = db.customers.filter((c) => c.accountStatus === 'active');

  for (const customer of activeCustomers) {
    const entitlements = getCustomerActiveEntitlements(customer.customerId, refDate);
    const eligibleIndiaCats = entitlements.entitledCategories.filter((ec) =>
      activeIndiaCategoryIds.has(ec.categoryId)
    );

    for (const ec of eligibleIndiaCats) {
      try {
        const attempt = await deliverIndiaCategoryNewsToCustomer({
          customerId: customer.customerId,
          categoryId: ec.categoryId,
          newsDate: targetDate,
          referenceDate: refDate,
          simulateTelegramFailureUntilAttempt: options?.simulateTelegramFailureUntilAttempt,
        });

        results.push(attempt);

        if (attempt.status === 'sent') {
          totalDeliveriesSent++;
        } else if (attempt.status === 'skipped') {
          totalDeliveriesSkipped++;
        } else {
          totalDeliveriesFailed++;
        }

        // Rate limit pacing
        await sleep(100);
      } catch (err: any) {
        totalDeliveriesFailed++;
        results.push({
          deliveryId: `del_in_err_${Date.now()}`,
          customerId: customer.customerId,
          categoryId: ec.categoryId,
          newsDate: targetDate,
          status: 'failed',
          error: `Non-fatal delivery error: ${err.message || err}`,
          botType: 'india',
        });
      }
    }
  }

  return {
    newsDate: targetDate,
    totalCustomersEvaluated: activeCustomers.length,
    totalDeliveriesSent,
    totalDeliveriesSkipped,
    totalDeliveriesFailed,
    results,
  };
}

/**
 * Returns India delivery statistics for a specific news date
 */
export function getIndiaDeliveryStatistics(newsDate?: string): {
  newsDate: string;
  totalSent: number;
  totalSkipped: number;
  totalFailed: number;
  totalNotEntitled: number;
  totalTgNotConnected: number;
} {
  const db = getDb();
  const date = newsDate || getKolkataDateString();
  const logs = (db.indiaTelegramDeliveryLogs || []).filter((l) => l.newsDate === date);

  return {
    newsDate: date,
    totalSent: logs.filter((l) => l.status === 'sent').length,
    totalSkipped: logs.filter((l) => l.status === 'skipped').length,
    totalFailed: logs.filter((l) => l.status === 'failed').length,
    totalNotEntitled: logs.filter((l) => l.status === 'not_entitled').length,
    totalTgNotConnected: logs.filter((l) => l.status === 'telegram_not_connected').length,
  };
}
