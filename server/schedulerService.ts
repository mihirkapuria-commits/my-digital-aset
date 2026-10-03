import {
  generateDailyAllCategoriesNews,
  getKolkataDateString,
} from './newsService.js';
import {
  deliverDailyBriefingsToAllEligibleCustomers,
  getDeliveryStatistics,
} from './deliveryService.js';
import {
  sendDay3TrialReminder,
} from './telegramService.js';
import { getDb } from './db.js';
import { Customer } from '../src/types';
import {
  acquireDistributedSchedulerLock,
  releaseDistributedSchedulerLock,
  getPersistentSchedulerDates,
  setPersistentSchedulerDates,
} from './schedulerLock.js';

const instanceId = process.env.K_REVISION || process.env.HOSTNAME || `runner_${Math.random().toString(36).substring(7)}`;

export interface SchedulerState {
  isActive: boolean;
  timezone: string; // 'Asia/Kolkata'
  generationWindowStart: string; // '06:00' IST
  deliveryWindowStart: string; // '06:15' IST
  windowEnd: string; // '07:00' IST
  lastGenerationDate: string | null;
  lastDeliveryDate: string | null;
  lastCheckedAt: string | null;
  isRunning: boolean;
}

let schedulerInterval: NodeJS.Timeout | null = null;

const state: SchedulerState = {
  isActive: true,
  timezone: 'Asia/Kolkata',
  generationWindowStart: '06:00',
  deliveryWindowStart: '06:15',
  windowEnd: '07:00',
  lastGenerationDate: null,
  lastDeliveryDate: null,
  lastCheckedAt: null,
  isRunning: false,
};

/**
 * Returns current hour and minute in Asia/Kolkata timezone
 */
export function getKolkataTimeComponents(date: Date = new Date()): {
  kolkataDate: string;
  hour: number;
  minute: number;
  timeString: string;
} {
  const dateStr = getKolkataDateString(date);

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

  return { kolkataDate: dateStr, hour, minute, timeString };
}

/**
 * Determines whether a customer's free trial has reached Day 3 or later.
 * Supports date-based comparison in Asia/Kolkata and elapsed hours.
 */
export function isCustomerAtDay3OrLater(customer: Customer, referenceDate: Date = new Date()): boolean {
  if (!customer.trialStartDate) return false;
  const startDate = new Date(customer.trialStartDate);
  const refTime = referenceDate.getTime();
  const startTime = startDate.getTime();

  // Elapsed days
  const elapsedDays = (refTime - startTime) / (24 * 60 * 60 * 1000);

  // Calendar day difference in Asia/Kolkata
  const startKolkata = getKolkataDateString(startDate);
  const refKolkata = getKolkataDateString(referenceDate);
  const [sy, sm, sd] = startKolkata.split('-').map(Number);
  const [ry, rm, rd] = refKolkata.split('-').map(Number);
  const startUtc = Date.UTC(sy, sm - 1, sd);
  const refUtc = Date.UTC(ry, rm - 1, rd);
  const calendarDiffDays = Math.floor((refUtc - startUtc) / (24 * 60 * 60 * 1000));

  // Eligible on Day 3: elapsed >= 2.0 days (48 hours) OR calendarDiffDays >= 2
  return elapsedDays >= 2.0 || calendarDiffDays >= 2;
}

/**
 * ============================================================================
 * 1. AUTOMATED DAY-3 TRIAL REMINDERS (100% Automatic - Zero Admin Required)
 * ============================================================================
 * Evaluates all customers reaching Day 3 of complimentary trial.
 * Enforces:
 * 1. Customer still on free trial.
 * 2. No active or paid subscription exists.
 * 3. Telegram connected.
 * 4. Persistent reminder idempotency (never send twice).
 * 5. Bounded Telegram retry on network drop; only successful dispatches are marked.
 */
export async function evaluateAndSendDay3TrialReminders(
  referenceDate: Date = new Date(),
  options?: { maxRetries?: number; simulateTelegramFailureUntilAttempt?: number }
): Promise<{
  totalEvaluated: number;
  totalEligible: number;
  totalSent: number;
  totalSkipped: number;
  totalFailed: number;
  results: Array<{
    customerId: string;
    customerName: string;
    status: 'sent' | 'skipped' | 'failed' | 'not_eligible';
    reason?: string;
    telegramMessageId?: string;
  }>;
}> {
  const db = getDb();
  const results: Array<{
    customerId: string;
    customerName: string;
    status: 'sent' | 'skipped' | 'failed' | 'not_eligible';
    reason?: string;
    telegramMessageId?: string;
  }> = [];

  let totalSent = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalEligible = 0;

  const activeCustomers = db.customers.filter((c) => c.accountStatus === 'active');

  for (const customer of activeCustomers) {
    // 1. Check if customer has converted to paid
    if (customer.trialStatus === 'converted') {
      results.push({
        customerId: customer.customerId,
        customerName: customer.fullName,
        status: 'skipped',
        reason: 'Customer has already received confirmed paid entitlement.',
      });
      totalSkipped++;
      continue;
    }

    // 2. Check if customer is on complimentary trial
    const isTrial = customer.trialStatus === 'active';
    if (!isTrial || !customer.trialStartDate) {
      continue;
    }

    // 3. Check if customer already has a paid or confirmed subscription
    const hasPaid = db.subscriptions.some(
      (s) => s.customerId === customer.customerId && s.status === 'active'
    );
    if (hasPaid) {
      results.push({
        customerId: customer.customerId,
        customerName: customer.fullName,
        status: 'skipped',
        reason: 'Customer has already received confirmed paid entitlement.',
      });
      totalSkipped++;
      continue;
    }

    // 3. Check if customer's trial has reached Day 3
    const atDay3 = isCustomerAtDay3OrLater(customer, referenceDate);
    if (!atDay3) {
      continue; // Not yet at Day 3
    }

    totalEligible++;

    // 4. Check if Telegram is connected (Test F)
    if (!customer.telegramConnected || !customer.telegramChatId) {
      results.push({
        customerId: customer.customerId,
        customerName: customer.fullName,
        status: 'skipped',
        reason: 'Customer has not connected Telegram account.',
      });
      totalSkipped++;
      continue;
    }

    // 5. Persistent reminder idempotency: check if DAY3_REMINDER_SENT was already successfully recorded
    const alreadySent = db.telegramConnectionAudits.some(
      (a) =>
        a.customerId === customer.customerId &&
        (a.eventType as string) === 'DAY3_REMINDER_SENT' &&
        a.result === 'SUCCESS'
    );
    if (alreadySent) {
      results.push({
        customerId: customer.customerId,
        customerName: customer.fullName,
        status: 'skipped',
        reason: 'Day-3 reminder already sent previously.',
      });
      totalSkipped++;
      continue;
    }

    // 6. Send Day-3 payment reminder through Telegram
    const sendRes = await sendDay3TrialReminder(customer.customerId, {
      maxRetries: options?.maxRetries ?? 3,
      simulateFailuresUntilAttempt: options?.simulateTelegramFailureUntilAttempt,
    });

    if (sendRes.success && !sendRes.skipped) {
      totalSent++;
      results.push({
        customerId: customer.customerId,
        customerName: customer.fullName,
        status: 'sent',
        telegramMessageId: sendRes.telegramMessageId,
      });
    } else if (sendRes.skipped) {
      totalSkipped++;
      results.push({
        customerId: customer.customerId,
        customerName: customer.fullName,
        status: 'skipped',
        reason: sendRes.reason,
      });
    } else {
      totalFailed++;
      results.push({
        customerId: customer.customerId,
        customerName: customer.fullName,
        status: 'failed',
        reason: sendRes.reason,
      });
    }
  }

  return {
    totalEvaluated: activeCustomers.length,
    totalEligible,
    totalSent,
    totalSkipped,
    totalFailed,
    results,
  };
}

/**
 * ============================================================================
 * 2. MASTER SCHEDULE EVALUATION (Executed automatically on periodic interval)
 * ============================================================================
 * Evaluates:
 * 1. Day-3 trial reminders (Continuous & persistent)
 * 2. Morning news package generation (06:00 AM IST)
 * 3. Morning private Telegram delivery (06:15 AM IST)
 */
export async function evaluateAndRunDailySchedule(
  now: Date = new Date(),
  options?: { maxRetries?: number; simulateTelegramFailureUntilAttempt?: number }
): Promise<{
  actionTaken: 'none' | 'generated_news' | 'delivered_news' | 'reminders_sent' | 'both' | 'all';
  details: string;
  reminderResults?: any;
}> {
  if (state.isRunning) {
    return { actionTaken: 'none', details: 'Scheduler run currently in progress locally' };
  }

  // Multi-Instance Concurrency Guard: Distributed Firestore Lock
  const lockAcquired = await acquireDistributedSchedulerLock(instanceId);
  if (!lockAcquired) {
    return {
      actionTaken: 'none',
      details: 'Distributed lock currently held by another active Cloud Run instance.',
    };
  }

  const { kolkataDate, hour, minute, timeString } = getKolkataTimeComponents(now);
  state.lastCheckedAt = new Date().toISOString();
  state.isRunning = true;

  // Hydrate persistent dates from Firestore
  try {
    const persistentDates = await getPersistentSchedulerDates();
    if (persistentDates.lastGenerationDate) {
      state.lastGenerationDate = persistentDates.lastGenerationDate;
    }
    if (persistentDates.lastDeliveryDate) {
      state.lastDeliveryDate = persistentDates.lastDeliveryDate;
    }
  } catch (_) {}

  const actions: string[] = [];
  let actionTaken: 'none' | 'generated_news' | 'delivered_news' | 'reminders_sent' | 'both' | 'all' = 'none';
  let reminderResults: any = undefined;

  try {
    // 1. AUTOMATED DAY-3 TRIAL REMINDERS (Evaluated persistently on each periodic tick)
    reminderResults = await evaluateAndSendDay3TrialReminders(now, options);
    if (reminderResults.totalSent > 0) {
      actions.push(`Automated Day-3 trial reminders: ${reminderResults.totalSent} sent`);
      actionTaken = 'reminders_sent';
    }

    // 2. MORNING NEWS & DELIVERY WINDOW (06:00 AM - 07:00 AM Asia/Kolkata)
    const isMorningWindow = hour === 6;

    if (isMorningWindow) {
      const db = getDb();
      const existingPackages = db.dailyNewsPackages.filter(
        (p) => p.newsDate === kolkataDate && (p.generationStatus === 'success' || p.generationStatus === 'partial')
      );

      // Generation Check (starts at 06:00 AM IST)
      if (existingPackages.length < 10 && state.lastGenerationDate !== kolkataDate) {
        console.log(`[Scheduler 06:00 IST] Starting automated daily news generation for ${kolkataDate}...`);
        const genResult = await generateDailyAllCategoriesNews(kolkataDate);
        state.lastGenerationDate = kolkataDate;
        await setPersistentSchedulerDates({ lastGenerationDate: kolkataDate });
        actions.push(`Generated ${genResult.totalStories} stories across ${genResult.successfulCategories} categories`);
        actionTaken = actionTaken === 'reminders_sent' ? 'both' : 'generated_news';
      }

      // Delivery Check (starts at 06:15 AM IST)
      if (minute >= 15 && state.lastDeliveryDate !== kolkataDate) {
        console.log(`[Scheduler 06:15 IST] Starting automated daily private Telegram delivery for ${kolkataDate}...`);
        const delResult = await deliverDailyBriefingsToAllEligibleCustomers(kolkataDate, now);
        state.lastDeliveryDate = kolkataDate;
        await setPersistentSchedulerDates({ lastDeliveryDate: kolkataDate });
        actions.push(
          `Dispatched deliveries: ${delResult.totalDeliveriesSent} sent, ${delResult.totalDeliveriesSkipped} skipped, ${delResult.totalDeliveriesFailed} failed`
        );
        actionTaken = 'all';
      }
    }
  } catch (err: any) {
    console.error('[Scheduler Error]:', err);
    actions.push(`Error: ${err.message}`);
  } finally {
    state.isRunning = false;
    await releaseDistributedSchedulerLock(instanceId);
  }

  return {
    actionTaken,
    details: actions.length > 0 ? actions.join('; ') : `Evaluated at ${timeString} IST. No pending actions required.`,
    reminderResults,
  };
}

/**
 * Initializes the background scheduler loop (evaluates every 60 seconds)
 */
export function startDailyScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  console.log('[Scheduler] Initialized automated daily scheduler (Target: 06:00 - 07:00 AM Asia/Kolkata + persistent Day-3 checks).');

  // Check immediately on startup
  evaluateAndRunDailySchedule().catch((err) => {
    console.error('[Scheduler Startup Check Error]:', err);
  });

  // Evaluate every 60 seconds
  schedulerInterval = setInterval(() => {
    evaluateAndRunDailySchedule().catch((err) => {
      console.error('[Scheduler Interval Error]:', err);
    });
  }, 60 * 1000);
}

/**
 * Returns current scheduler status for administration and reporting
 */
export function getSchedulerStatus(): SchedulerState & {
  currentTimeKolkata: string;
  currentDateKolkata: string;
  isWithinMorningWindow: boolean;
} {
  const { kolkataDate, hour, timeString } = getKolkataTimeComponents();
  return {
    ...state,
    currentTimeKolkata: timeString,
    currentDateKolkata: kolkataDate,
    isWithinMorningWindow: hour === 6,
  };
}

/**
 * Allows an authorized scheduler or admin to trigger a run (or specific action)
 */
export async function triggerManualSchedulerRun(
  targetDate?: string,
  action: 'all' | 'generate' | 'deliver' | 'reminders' = 'all'
): Promise<{
  newsDate: string;
  action: string;
  generationResult?: any;
  deliveryResult?: any;
  reminderResult?: any;
}> {
  const newsDate = targetDate || getKolkataDateString();
  let generationResult: any = null;
  let deliveryResult: any = null;
  let reminderResult: any = null;

  if (action === 'all' || action === 'generate') {
    generationResult = await generateDailyAllCategoriesNews(newsDate);
    state.lastGenerationDate = newsDate;
  }

  if (action === 'all' || action === 'deliver') {
    deliveryResult = await deliverDailyBriefingsToAllEligibleCustomers(newsDate);
    state.lastDeliveryDate = newsDate;
  }

  if (action === 'all' || action === 'reminders') {
    reminderResult = await evaluateAndSendDay3TrialReminders();
  }

  return {
    newsDate,
    action,
    generationResult,
    deliveryResult,
    reminderResult,
  };
}
