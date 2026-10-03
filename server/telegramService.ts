import crypto from 'crypto';
import {
  Customer,
  TelegramConnectionToken,
  TelegramConnectionAuditEvent,
} from '../src/types';
import {
  getDb,
  saveDb,
  getCustomerById,
} from './db.js';
import {
  atomicReserveOperation,
  atomicCompleteOperation,
  atomicReleaseReservation,
} from './idempotencyService.js';

// Server-side environment variables (NEVER exposed to frontend)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'MyDigitAssetNewsBot';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

/**
 * Verifies Telegram webhook secret token (Section 1)
 */
export function verifyTelegramWebhookSecret(providedSecretHeader?: string): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    return true;
  }
  return providedSecretHeader === secret;
}

/**
 * Returns whether real Telegram bot credentials are configured (Section 18)
 */
export function isTelegramBotConfigured(): boolean {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN.length > 10);
}

/**
 * Returns safe public bot username for deep-link generation
 */
export function getTelegramBotUsername(): string {
  return TELEGRAM_BOT_USERNAME;
}

/**
 * Helper to record immutable Telegram connection audit events (Section 16)
 */
export function recordTelegramAuditEvent(params: {
  customerId: string;
  eventType: TelegramConnectionAuditEvent['eventType'];
  telegramChatId?: string | null;
  result: 'SUCCESS' | 'REJECTED' | 'FAILED';
  details: string;
}): TelegramConnectionAuditEvent {
  const db = getDb();
  const event: TelegramConnectionAuditEvent = {
    eventId: `tga_${crypto.randomBytes(8).toString('hex')}`,
    customerId: params.customerId,
    eventType: params.eventType,
    telegramChatId: params.telegramChatId ? String(params.telegramChatId) : null,
    timestamp: new Date().toISOString(),
    result: params.result,
    details: params.details,
  };

  db.telegramConnectionAudits.push(event);
  saveDb();
  return event;
}

/**
 * ============================================================================
 * 1. GENERATE CRYPTOGRAPHIC CONNECTION TOKEN (Section 4 & 5)
 * ============================================================================
 * Short-lived (15 mins), single-use, cryptographically random, customer-scoped.
 */
export function generateTelegramConnectionToken(customerId: string): {
  token: string;
  deepLink: string;
  expiresAt: string;
  botUsername: string;
} {
  const db = getDb();
  const customer = getCustomerById(customerId);
  if (!customer) {
    throw new Error(`Customer with ID ${customerId} not found.`);
  }

  // Invalidate any existing unused tokens for this customer
  const now = new Date();
  for (const t of db.telegramConnectionTokens) {
    if (t.customerId === customerId && !t.used) {
      t.used = true; // Invalidate previous token
    }
  }

  // Generate cryptographically secure token strictly <= 64 chars for Telegram deep-link compliance
  // 6 char prefix + 48 hex chars (24 bytes = 192 bits of entropy) = 54 chars total <= 64 chars
  const token = `tgtok_${crypto.randomBytes(24).toString('hex')}`;
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString(); // 15 mins expiry

  const connectionTokenRecord: TelegramConnectionToken = {
    tokenId: `tgtok_${crypto.randomBytes(8).toString('hex')}`,
    token,
    customerId: customer.customerId,
    expiresAt,
    used: false,
    createdAt: now.toISOString(),
  };

  db.telegramConnectionTokens.push(connectionTokenRecord);
  saveDb();

  recordTelegramAuditEvent({
    customerId: customer.customerId,
    eventType: 'TOKEN_GENERATED',
    result: 'SUCCESS',
    details: 'Generated 15-minute connection token for Telegram linking',
  });

  const botUsername = getTelegramBotUsername();
  const deepLink = `https://t.me/${botUsername}?start=${token}`;

  return {
    token,
    deepLink,
    expiresAt,
    botUsername,
  };
}

/**
 * ============================================================================
 * 2. CONNECT TELEGRAM ACCOUNT (Section 4, 6, 7, 8, 9)
 * ============================================================================
 * Associates Telegram Chat ID with the authenticated customer.
 * Enforces single-use, expiry, customer existence, and one-account-per-chat-id rule.
 */
export interface ConnectTelegramResult {
  success: boolean;
  customerId?: string;
  customerName?: string;
  error?: string;
}

export function connectTelegramAccount(
  tokenString: string,
  telegramChatId: string,
  telegramUsername?: string
): ConnectTelegramResult {
  const db = getDb();
  const cleanToken = (tokenString || '').trim();
  const cleanChatId = (telegramChatId || '').trim();

  if (!cleanToken) {
    return { success: false, error: 'Connection token is required.' };
  }

  if (!cleanChatId) {
    return { success: false, error: 'Telegram Chat ID is required.' };
  }

  // 1. Token validation
  const tokenRecord = db.telegramConnectionTokens.find((t) => t.token === cleanToken);
  if (!tokenRecord) {
    recordTelegramAuditEvent({
      customerId: 'unknown',
      eventType: 'REJECTED',
      telegramChatId: cleanChatId,
      result: 'REJECTED',
      details: `Attempted connection with non-existent token: ${cleanToken.substring(0, 8)}...`,
    });
    return { success: false, error: 'Invalid or unrecognized connection token.' };
  }

  // 2. Single-use enforcement (Section 5)
  if (tokenRecord.used) {
    recordTelegramAuditEvent({
      customerId: tokenRecord.customerId,
      eventType: 'REJECTED',
      telegramChatId: cleanChatId,
      result: 'REJECTED',
      details: 'Attempted to reuse an already consumed connection token.',
    });
    return { success: false, error: 'This connection token has already been used. Please generate a fresh token.' };
  }

  // 3. Expiry enforcement (Section 5)
  const now = new Date();
  if (new Date(tokenRecord.expiresAt) < now) {
    recordTelegramAuditEvent({
      customerId: tokenRecord.customerId,
      eventType: 'EXPIRED',
      telegramChatId: cleanChatId,
      result: 'REJECTED',
      details: 'Connection token expired before completion.',
    });
    return { success: false, error: 'Connection token has expired (15-minute validity limit). Please generate a fresh token.' };
  }

  // 4. Customer validation
  const customer = getCustomerById(tokenRecord.customerId);
  if (!customer) {
    return { success: false, error: 'Customer associated with this token no longer exists.' };
  }

  // 5. ONE TELEGRAM ACCOUNT / ONE CUSTOMER RELATIONSHIP (Section 8)
  // Check if this Telegram Chat ID is already associated with ANY other customer
  const existingCustomerWithChat = db.customers.find(
    (c) => c.telegramChatId === cleanChatId && c.customerId !== customer.customerId
  );

  if (existingCustomerWithChat) {
    recordTelegramAuditEvent({
      customerId: customer.customerId,
      eventType: 'REJECTED',
      telegramChatId: cleanChatId,
      result: 'REJECTED',
      details: `Telegram Chat ID is already associated with another customer (${existingCustomerWithChat.customerId}). Assignment rejected.`,
    });
    return {
      success: false,
      error: 'This Telegram account is already connected to another MyDigitAsset customer account. Cross-account association is strictly prohibited.',
    };
  }

  // 6. Execute Connection Atomically (Section 4 & 7)
  customer.telegramChatId = cleanChatId;
  customer.telegramConnected = true;
  customer.updatedAt = now.toISOString();

  // Mark token single-use consumed
  tokenRecord.used = true;
  tokenRecord.usedAt = now.toISOString();

  recordTelegramAuditEvent({
    customerId: customer.customerId,
    eventType: 'CONNECTED',
    telegramChatId: cleanChatId,
    result: 'SUCCESS',
    details: `Telegram connected successfully${telegramUsername ? ` (@${telegramUsername})` : ''}`,
  });

  saveDb();

  return {
    success: true,
    customerId: customer.customerId,
    customerName: customer.fullName,
  };
}

/**
 * ============================================================================
 * 3. DISCONNECT TELEGRAM ACCOUNT (Section 10)
 * ============================================================================
 * Removes/disables the Telegram association, sets telegramConnected = false.
 * Prevents future news delivery without modifying subscriptions or payments.
 */
export function disconnectTelegramAccount(customerId: string): { success: boolean; error?: string } {
  const db = getDb();
  const customer = getCustomerById(customerId);
  if (!customer) {
    return { success: false, error: `Customer with ID ${customerId} not found.` };
  }

  const prevChatId = customer.telegramChatId;
  customer.telegramChatId = null;
  customer.telegramConnected = false;
  customer.updatedAt = new Date().toISOString();

  recordTelegramAuditEvent({
    customerId: customer.customerId,
    eventType: 'DISCONNECTED',
    telegramChatId: prevChatId,
    result: 'SUCCESS',
    details: 'Customer disconnected their Telegram account.',
  });

  saveDb();
  return { success: true };
}

/**
 * ============================================================================
 * 4. TELEGRAM WEBHOOK / MESSAGE HANDLER (Section 4, 12, 14)
 * ============================================================================
 * Receives webhook updates from Telegram Bot API when a user sends `/start <token>`.
 */
export async function processTelegramWebhookUpdate(update: any): Promise<{ handled: boolean; replyText?: string }> {
  if (!update || !update.message) {
    return { handled: false };
  }

  const message = update.message;
  const chatId = message.chat?.id ? String(message.chat.id) : null;
  const text = (message.text || '').trim();
  const username = message.from?.username || message.from?.first_name || '';

  if (!chatId || !text) {
    return { handled: false };
  }

  // Check for `/start <token>`
  if (text.startsWith('/start')) {
    const parts = text.split(/\s+/);
    const token = parts[1] ? parts[1].trim() : '';

    if (!token) {
      const welcomeMsg = `👋 Welcome to the official *MyDigitAsset* Briefing Bot.\n\nTo connect your subscription, please click **Connect Telegram** in your MyDigitAsset account dashboard to obtain your secure single-use linking token.\n\n🔒 *Privacy Notice*: All daily briefings are delivered directly to your private chat. Subscriber identities are strictly protected.`;
      await sendTelegramMessage(chatId, welcomeMsg);
      return { handled: true, replyText: welcomeMsg };
    }

    // Connect customer via token
    const connectResult = connectTelegramAccount(token, chatId, username);
    if (!connectResult.success) {
      const errorMsg = `⚠️ *Connection Failed*\n\n${connectResult.error}\n\nPlease return to your MyDigitAsset dashboard and generate a fresh connection token.`;
      await sendTelegramMessage(chatId, errorMsg);
      return { handled: true, replyText: errorMsg };
    }

    const successMsg = `✅ *MyDigitAsset Account Connected!*\n\nHello ${connectResult.customerName || 'Subscriber'},\n\nYour Telegram account has been linked to your MyDigitAsset subscription.\n\n📰 You will receive your synchronized daily executive briefings in this private chat every morning between 6:00 AM and 7:00 AM IST.`;
    await sendTelegramMessage(chatId, successMsg);
    return { handled: true, replyText: successMsg };
  }

  return { handled: false };
}

export interface TelegramSendOptions {
  maxRetries?: number;
  simulateFailuresUntilAttempt?: number; // for testing Test M
}

export interface TelegramSendResult {
  success: boolean;
  attempts: number;
  telegramMessageId?: string;
  error?: string;
}

// Rate limiting and queueing state (Section 28 & Requirement 4)
const lastSendTimeByChatId = new Map<string, number>();
let lastGlobalSendTime = 0;
let globalRateLimitPauseUntil = 0;
let queuePromiseChain: Promise<any> = Promise.resolve();

/**
 * Enqueues a message send operation to ensure:
 * 1. Sequential serialization (no simultaneous requests flooding Telegram)
 * 2. Conservative global pacing (at least 100ms between calls)
 * 3. Strict per-chat throttling (at least 1000ms between messages to the same chat)
 * 4. Respects Telegram HTTP 429 retry_after by pausing the queue
 */
export function enqueueTelegramMessage(
  chatId: string,
  text: string,
  options: TelegramSendOptions = {}
): Promise<TelegramSendResult> {
  const executeInQueue = async (): Promise<TelegramSendResult> => {
    // 1. Wait out global rate limit pause if Telegram previously responded with 429
    const now = Date.now();
    if (globalRateLimitPauseUntil > now) {
      const waitMs = globalRateLimitPauseUntil - now;
      await new Promise((r) => setTimeout(r, waitMs));
    }

    // 2. Global inter-request pacing (100ms minimum)
    const timeSinceLastGlobal = Date.now() - lastGlobalSendTime;
    if (timeSinceLastGlobal < 100) {
      await new Promise((r) => setTimeout(r, 100 - timeSinceLastGlobal));
    }

    // 3. Per-chat rate limiting: Telegram limits 1 message/sec per recipient chat
    const lastChatTime = lastSendTimeByChatId.get(chatId) || 0;
    const timeSinceLastChat = Date.now() - lastChatTime;
    if (timeSinceLastChat < 1000) {
      await new Promise((r) => setTimeout(r, 1000 - timeSinceLastChat));
    }

    const result = await rawSendTelegramMessage(chatId, text, options);

    // Update timestamps on success or completion
    const completionTime = Date.now();
    lastGlobalSendTime = completionTime;
    lastSendTimeByChatId.set(chatId, completionTime);

    return result;
  };

  // Chain into sequential queue promise
  const nextPromise = queuePromiseChain.then(executeInQueue, executeInQueue);
  queuePromiseChain = nextPromise.catch(() => {});
  return nextPromise;
}

/**
 * Sends a private Telegram message to a specific Chat ID (Section 2, 3, 14)
 * Strictly 1-to-1: Never sends to shared groups.
 * Handles rate-limiting (HTTP 429 with retry_after) and bounded exponential backoff (Section 28).
 */
async function rawSendTelegramMessage(
  chatId: string,
  text: string,
  options: TelegramSendOptions = {}
): Promise<TelegramSendResult> {
  const maxRetries = options.maxRetries ?? 3;
  let attempts = 0;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts++;

    // Hook for simulating transient network errors (Test M)
    if (options.simulateFailuresUntilAttempt && attempt < options.simulateFailuresUntilAttempt) {
      lastError = `Simulated transient Telegram network drop on attempt ${attempt}`;
      const backoffMs = Math.min(100 * Math.pow(2, attempt - 1), 2000);
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }

    if (!TELEGRAM_BOT_TOKEN) {
      // Sandbox / Test Mode log (Section 18 & 29)
      console.log(`[Telegram Sandbox Attempt ${attempt}] To Chat ID ${chatId}: ${text.substring(0, 80)}...`);
      return {
        success: true,
        attempts,
        telegramMessageId: `msg_sandbox_${Date.now()}_${attempts}`,
      };
    }

    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
        }),
      });

      if (res.status === 429) {
        // Rate limit hit: Telegram provides retry_after parameter in seconds
        const data = await res.json().catch(() => ({}));
        const retryAfterSec = data.parameters?.retry_after || 1;
        const waitMs = Math.min(retryAfterSec * 1000 + 200, 30000);
        globalRateLimitPauseUntil = Date.now() + waitMs;
        lastError = `Telegram 429 rate limit exceeded. Retrying after ${waitMs}ms`;
        console.warn(`[Telegram Rate Limit 429] Waiting ${waitMs}ms before attempt ${attempt + 1}`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unknown error');
        lastError = `Telegram HTTP ${res.status}: ${errorText}`;
        const backoffMs = Math.min(150 * Math.pow(2, attempt - 1), 3000);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      const body = await res.json().catch(() => ({}));
      const messageId = body.result?.message_id ? String(body.result.message_id) : `msg_${Date.now()}`;
      return {
        success: true,
        attempts,
        telegramMessageId: messageId,
      };
    } catch (err: any) {
      lastError = err.message || 'Telegram network send failure';
      const backoffMs = Math.min(150 * Math.pow(2, attempt - 1), 3000);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  return {
    success: false,
    attempts,
    error: lastError || 'Max retries exhausted',
  };
}

export const sendTelegramMessage = enqueueTelegramMessage;

/**
 * Retrieves Telegram connection audit logs for an authenticated customer or admin (Section 16)
 */
export function getTelegramAuditLogs(customerId?: string): TelegramConnectionAuditEvent[] {
  const db = getDb();
  if (customerId) {
    return db.telegramConnectionAudits
      .filter((a) => a.customerId === customerId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }
  return [...db.telegramConnectionAudits].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

/**
 * ============================================================================
 * STAGE 2: DAY-3 FREE TRIAL REMINDER (Section 16)
 * ============================================================================
 * Product Rule: Day-3 trial payment reminder is Telegram-ONLY (NO email).
 * Strictly checks that:
 * 1. Customer has telegramConnected === true and telegramChatId
 * 2. Customer does NOT already have an active paid subscription
 * 3. Reminder was not previously sent (deduplication)
 */
export async function sendDay3TrialReminder(
  customerId: string,
  options?: { maxRetries?: number; simulateFailuresUntilAttempt?: number }
): Promise<{
  success: boolean;
  skipped?: boolean;
  reason?: string;
  telegramMessageId?: string;
}> {
  const db = getDb();
  const customer = getCustomerById(customerId);
  if (!customer) {
    return { success: false, reason: 'Customer not found' };
  }

  if (!customer.telegramConnected || !customer.telegramChatId) {
    return { success: false, skipped: true, reason: 'Telegram account not connected' };
  }

  // Check if customer already has an active paid subscription
  const hasPaid = db.subscriptions.some(
    (s) => s.customerId === customerId && s.status === 'active'
  );
  if (hasPaid) {
    return { success: true, skipped: true, reason: 'Customer already has active paid subscription' };
  }

  // Check if Day 3 reminder was already sent (deduplication check)
  const alreadySent = db.telegramConnectionAudits.some(
    (a) => a.customerId === customerId && (a.eventType as string) === 'DAY3_REMINDER_SENT' && a.result === 'SUCCESS'
  );
  if (alreadySent) {
    return { success: true, skipped: true, reason: 'Day-3 reminder already sent previously' };
  }

  const day3Key = `tga_day3_${customerId}`;

  // Atomic check-and-reserve for tga_day3_<customerId>
  // Prevents concurrent scheduler executions from sending duplicate reminders
  const reservation = await atomicReserveOperation(day3Key, {
    metadata: {
      customerId,
      eventType: 'DAY3_REMINDER_SENT',
      telegramChatId: customer.telegramChatId,
    },
  });

  if (!reservation.reserved) {
    return {
      success: true,
      skipped: true,
      reason: 'Day-3 reminder already in progress or sent previously',
    };
  }

  const reminderText = `🔔 *MyDigitAsset Free Trial Notice*\n\nHello ${customer.fullName},\n\nYour 3-day complimentary trial is completing today. To ensure uninterrupted daily morning briefings delivered to this private chat between 6:00 AM and 7:00 AM IST, please complete your annual subscription.\n\nYour 12-month paid subscription includes an extra 5-day continuous delivery buffer!\n\nOpen your subscriber dashboard at https://www.mydigitasset.com to submit your payment.`;

  const sendResult = await sendTelegramMessage(customer.telegramChatId, reminderText, {
    maxRetries: options?.maxRetries ?? 3,
    simulateFailuresUntilAttempt: options?.simulateFailuresUntilAttempt,
  });

  if (sendResult.success) {
    await atomicCompleteOperation(day3Key, {
      telegramMessageId: sendResult.telegramMessageId,
    });
    recordTelegramAuditEvent({
      customerId: customer.customerId,
      eventType: 'DAY3_REMINDER_SENT' as any,
      telegramChatId: customer.telegramChatId,
      result: 'SUCCESS',
      details: 'Telegram-only Day 3 trial payment reminder delivered successfully (zero email).',
    });
    return { success: true, telegramMessageId: sendResult.telegramMessageId };
  }

  await atomicReleaseReservation(day3Key, sendResult.error);
  recordTelegramAuditEvent({
    customerId: customer.customerId,
    eventType: 'DAY3_REMINDER_FAILED' as any,
    telegramChatId: customer.telegramChatId,
    result: 'FAILED',
    details: `Telegram Day 3 reminder delivery failed: ${sendResult.error || 'Unknown network error'}`,
  });

  return { success: false, reason: sendResult.error };
}
