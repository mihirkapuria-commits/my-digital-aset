import crypto from 'crypto';
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
  sendTelegramMessage,
} from './telegramService.js';
import {
  getKolkataDateString,
  formatCategoryNewsTelegramMessage,
} from './newsService.js';
import {
  atomicReserveOperation,
  atomicCompleteOperation,
  atomicReleaseReservation,
} from './idempotencyService.js';

/**
 * Result of delivering a category news briefing to a customer
 */
export interface DeliveryAttemptResult {
  deliveryId: string;
  customerId: string;
  categoryId: string;
  newsDate: string;
  status: TelegramDeliveryLog['status'];
  error?: string;
}

/**
 * Sleep helper for Telegram API rate limit compliance (Section 28)
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ============================================================================
 * 1. DELIVER CATEGORY NEWS TO INDIVIDUAL CUSTOMER (Section 14, 15, 16, 20, 21)
 * ============================================================================
 * Strictly 1-to-1 private delivery.
 * Evaluates central entitlement engine immediately before dispatch.
 * Enforces all 7 eligibility criteria and duplicate send protection.
 */
export async function deliverCategoryNewsToCustomer(params: {
  customerId: string;
  categoryId: string;
  newsDate?: string;
  referenceDate?: Date;
  simulateTelegramFailureUntilAttempt?: number;
}): Promise<DeliveryAttemptResult> {
  const db = getDb();
  const newsDate = params.newsDate || getKolkataDateString(params.referenceDate || new Date());
  const refDate = params.referenceDate || new Date();
  const deliveryId = `del_${newsDate}_${params.customerId}_${params.categoryId}`;
  const now = new Date().toISOString();

  // Helper to record immutable, append-only delivery log
  const recordLog = (
    status: TelegramDeliveryLog['status'],
    chatId: string = '',
    error?: string,
    messageId?: string
  ): DeliveryAttemptResult => {
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
    };
    db.telegramDeliveryLogs.push(log);
    saveDb();

    return {
      deliveryId,
      customerId: params.customerId,
      categoryId: params.categoryId,
      newsDate,
      status,
      error,
    };
  };

  // Section 20: Delivery Duplicate Protection
  // Do not deliver the same customerId + categoryId + newsDate more than once if already sent
  const existingSuccessfulDelivery = db.telegramDeliveryLogs.find(
    (l) =>
      l.customerId === params.customerId &&
      l.categoryId === params.categoryId &&
      l.newsDate === newsDate &&
      l.status === 'sent'
  );

  if (existingSuccessfulDelivery) {
    return recordLog(
      'skipped',
      existingSuccessfulDelivery.telegramChatId,
      'Delivery already completed for this date.'
    );
  }

  // Section 14 & 15: Central Entitlement Evaluation
  const customer = getCustomerById(params.customerId);
  if (!customer) {
    return recordLog('not_entitled', '', 'Customer not found.');
  }

  const entitlement = getCustomerActiveEntitlements(customer.customerId, refDate);

  // Check 1: Account active
  if (entitlement.accountStatus !== 'active') {
    return recordLog('not_entitled', '', `Customer account status is ${entitlement.accountStatus}.`);
  }

  // Check 2, 3, 4, 5: Category entitlement active within subscription dates
  const isCategoryEntitled = entitlement.entitledCategories.some(
    (c) => c.categoryId === params.categoryId
  );

  if (!isCategoryEntitled) {
    const isExpired = entitlement.ineligibleReasons.some((r) => r.includes('valid dates'));
    return recordLog(
      isExpired ? 'expired' : 'not_entitled',
      customer.telegramChatId || '',
      `Not entitled to category '${params.categoryId}' on ${newsDate}.`
    );
  }

  // Check 6 & 7: Telegram connection and valid chat ID
  if (!customer.telegramConnected || !customer.telegramChatId) {
    return recordLog(
      'telegram_not_connected',
      '',
      'Customer Telegram account is not connected.'
    );
  }

  const destinationChatId = customer.telegramChatId;

  // Retrieve the generated news package for this category and date (both full and partial packages are deliverable)
  const newsPkg = db.dailyNewsPackages.find(
    (p) =>
      p.categoryId === params.categoryId &&
      p.newsDate === newsDate &&
      (p.generationStatus === 'success' || p.generationStatus === 'partial')
  );

  if (!newsPkg) {
    const failedPkg = db.dailyNewsPackages.find(
      (p) => p.categoryId === params.categoryId && p.newsDate === newsDate && p.generationStatus === 'failed'
    );
    const failureReason =
      failedPkg?.errorMessage ||
      `News package for category '${params.categoryId}' on ${newsDate} has not been generated yet.`;
    console.error(
      `[DELIVERY_FAILURE] Customer ${params.customerId} for category ${params.categoryId}: ${failureReason}`
    );
    return recordLog('failed', destinationChatId, failureReason);
  }

  const stories = db.newsStories
    .filter((s) => s.packageId === newsPkg.packageId)
    .sort((a, b) => a.position - b.position);

  if (stories.length === 0) {
    console.error(
      `[GENUINE_NO_USABLE_NEWS_FAILURE] Package '${newsPkg.packageId}' contains 0 stories. Empty briefing delivery blocked.`
    );
    return recordLog(
      'failed',
      destinationChatId,
      `No news stories found in package '${newsPkg.packageId}'.`
    );
  }

  // Format executive Telegram message (Section 18)
  const messageText = formatCategoryNewsTelegramMessage(
    newsPkg.categoryName,
    newsDate,
    stories
  );

  // Atomic check-and-reserve for del_<newsDate>_<customerId>_<categoryId>
  // Prevents concurrent scheduler executions from duplicate sends
  const reservation = await atomicReserveOperation(deliveryId, {
    metadata: {
      customerId: params.customerId,
      categoryId: params.categoryId,
      newsDate,
      telegramChatId: destinationChatId,
    },
  });

  if (!reservation.reserved) {
    return recordLog(
      'skipped',
      destinationChatId,
      'Delivery already in progress or completed by another instance.'
    );
  }

  // Section 16 & 28: Dispatch message to individual Telegram Chat ID with rate limiting and backoff
  const sendRes = await sendTelegramMessage(destinationChatId, messageText, {
    maxRetries: 3,
    simulateFailuresUntilAttempt: params.simulateTelegramFailureUntilAttempt,
  });

  if (!sendRes.success) {
    await atomicReleaseReservation(deliveryId, sendRes.error);
    console.error(
      `[DELIVERY_FAILURE] Telegram dispatch failed for customer ${params.customerId}, chat ${destinationChatId}: ${sendRes.error}`
    );
    return recordLog('failed', destinationChatId, sendRes.error || 'Failed to dispatch message via Telegram API.');
  }

  await atomicCompleteOperation(deliveryId, { telegramMessageId: sendRes.telegramMessageId });
  return recordLog('sent', destinationChatId, undefined, sendRes.telegramMessageId);
}

/**
 * ============================================================================
 * 2. DAILY BATCH DELIVERY ENGINE (Section 13, 14, 16, 28)
 * ============================================================================
 * Runs during the 6:00 AM - 7:00 AM IST morning delivery window.
 * Iterates through all active categories and delivers to entitled customers individually.
 */
export async function deliverDailyBriefingsToAllEligibleCustomers(
  newsDate: string = getKolkataDateString(),
  referenceDate: Date = new Date()
): Promise<{
  newsDate: string;
  totalSubscribersEvaluated: number;
  totalDeliveriesSent: number;
  totalDeliveriesSkipped: number;
  totalDeliveriesFailed: number;
  totalIneligible: number;
  results: DeliveryAttemptResult[];
}> {
  const db = getDb();
  const results: DeliveryAttemptResult[] = [];
  let totalDeliveriesSent = 0;
  let totalDeliveriesSkipped = 0;
  let totalDeliveriesFailed = 0;
  let totalIneligible = 0;

  // Find all active customers
  const activeCustomers = db.customers.filter((c) => c.accountStatus === 'active');

  for (const customer of activeCustomers) {
    // Evaluate active category entitlements for customer on referenceDate
    const evaluation = getCustomerActiveEntitlements(customer.customerId, referenceDate);

    if (!evaluation.isEligible || evaluation.entitledCategories.length === 0) {
      totalIneligible++;
      continue;
    }

    if (!customer.telegramConnected || !customer.telegramChatId) {
      // Record skipped log for each entitled category due to telegram not connected
      for (const entCat of evaluation.entitledCategories) {
        const res = await deliverCategoryNewsToCustomer({
          customerId: customer.customerId,
          categoryId: entCat.categoryId,
          newsDate,
          referenceDate,
        });
        results.push(res);
      }
      continue;
    }

    // Deliver each entitled category individually (Section 16 & 19)
    for (const entCat of evaluation.entitledCategories) {
      const res = await deliverCategoryNewsToCustomer({
        customerId: customer.customerId,
        categoryId: entCat.categoryId,
        newsDate,
        referenceDate,
      });

      results.push(res);

      if (res.status === 'sent') totalDeliveriesSent++;
      else if (res.status === 'skipped') totalDeliveriesSkipped++;
      else if (res.status === 'failed') totalDeliveriesFailed++;

      // Section 28 & Requirement 4: Rate limit pacing backed by sequential queue
      await sleep(100);
    }
  }

  return {
    newsDate,
    totalSubscribersEvaluated: activeCustomers.length,
    totalDeliveriesSent,
    totalDeliveriesSkipped,
    totalDeliveriesFailed,
    totalIneligible,
    results,
  };
}

/**
 * Returns delivery statistics and logs for admin reporting (Section 23)
 */
export function getDeliveryStatistics(newsDate?: string): {
  totalLogged: number;
  sent: number;
  failed: number;
  skipped: number;
  notEntitled: number;
  telegramNotConnected: number;
  logs: TelegramDeliveryLog[];
} {
  const db = getDb();
  let logs = db.telegramDeliveryLogs;
  if (newsDate) {
    logs = logs.filter((l) => l.newsDate === newsDate);
  }

  return {
    totalLogged: logs.length,
    sent: logs.filter((l) => l.status === 'sent').length,
    failed: logs.filter((l) => l.status === 'failed').length,
    skipped: logs.filter((l) => l.status === 'skipped').length,
    notEntitled: logs.filter((l) => l.status === 'not_entitled' || l.status === 'expired').length,
    telegramNotConnected: logs.filter((l) => l.status === 'telegram_not_connected').length,
    logs: [...logs].sort((a, b) => new Date(b.attemptedAt).getTime() - new Date(a.attemptedAt).getTime()),
  };
}
