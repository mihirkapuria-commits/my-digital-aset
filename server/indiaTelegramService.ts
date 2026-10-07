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

// ============================================================================
// SYSTEM B: NEW INDIA NEWS TELEGRAM BOT SERVICE
// ============================================================================
// Dedicated Telegram Bot for the 10 India categories.
// Kept strictly separate from System A's specialist bot.
// Tokens and credentials are never exposed in frontend code, Firestore, logs, or API responses.

const TELEGRAM_INDIA_BOT_TOKEN = process.env.TELEGRAM_INDIA_BOT_TOKEN || '';
const TELEGRAM_INDIA_BOT_USERNAME = process.env.TELEGRAM_INDIA_BOT_USERNAME || 'MyDigitAssetIndiaBot';
const TELEGRAM_INDIA_WEBHOOK_SECRET = process.env.TELEGRAM_INDIA_WEBHOOK_SECRET || '';

/**
 * Verifies India Telegram webhook secret token
 */
export function verifyIndiaTelegramWebhookSecret(providedSecretHeader?: string): boolean {
  const secret = process.env.TELEGRAM_INDIA_WEBHOOK_SECRET;
  if (!secret) {
    return true;
  }
  return providedSecretHeader === secret;
}

/**
 * Returns whether real India Telegram bot credentials are configured
 */
export function isIndiaTelegramBotConfigured(): boolean {
  return Boolean(TELEGRAM_INDIA_BOT_TOKEN && TELEGRAM_INDIA_BOT_TOKEN.length > 10);
}

/**
 * Returns safe public India bot username for deep-link generation
 */
export function getIndiaTelegramBotUsername(): string {
  return TELEGRAM_INDIA_BOT_USERNAME;
}

/**
 * Helper to record immutable India Telegram connection audit events
 */
export function recordIndiaTelegramAuditEvent(params: {
  customerId: string;
  eventType: TelegramConnectionAuditEvent['eventType'];
  telegramChatId?: string | null;
  result: 'SUCCESS' | 'REJECTED' | 'FAILED';
  details: string;
}): TelegramConnectionAuditEvent {
  const db = getDb();
  if (!Array.isArray(db.indiaTelegramConnectionAudits)) {
    db.indiaTelegramConnectionAudits = [];
  }

  const event: TelegramConnectionAuditEvent = {
    eventId: `tga_india_${crypto.randomBytes(8).toString('hex')}`,
    customerId: params.customerId,
    eventType: params.eventType,
    telegramChatId: params.telegramChatId ? String(params.telegramChatId) : null,
    timestamp: new Date().toISOString(),
    result: params.result,
    details: `[System B India Bot] ${params.details}`,
  };

  db.indiaTelegramConnectionAudits.push(event);
  saveDb();
  return event;
}

/**
 * Generates cryptographic connection token for System B (India News Bot)
 * Short-lived (15 mins), single-use, customer-scoped.
 */
export function generateIndiaTelegramConnectionToken(customerId: string): {
  token: string;
  deepLink: string;
  expiresAt: string;
  botUsername: string;
} {
  const db = getDb();
  if (!Array.isArray(db.indiaTelegramConnectionTokens)) {
    db.indiaTelegramConnectionTokens = [];
  }

  const customer = getCustomerById(customerId);
  if (!customer) {
    throw new Error(`Customer with ID ${customerId} not found.`);
  }

  // Invalidate any existing unused India tokens for this customer
  const now = new Date();
  for (const t of db.indiaTelegramConnectionTokens) {
    if (t.customerId === customerId && !t.used) {
      t.used = true;
    }
  }

  // Cryptographically random 48-hex character token
  const token = `tgtok_in_${crypto.randomBytes(22).toString('hex')}`;
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

  const connectionTokenRecord: TelegramConnectionToken = {
    tokenId: `tgtok_in_${crypto.randomBytes(8).toString('hex')}`,
    token,
    customerId: customer.customerId,
    expiresAt,
    used: false,
    createdAt: now.toISOString(),
  };

  db.indiaTelegramConnectionTokens.push(connectionTokenRecord);
  saveDb();

  recordIndiaTelegramAuditEvent({
    customerId: customer.customerId,
    eventType: 'TOKEN_GENERATED',
    result: 'SUCCESS',
    details: `Generated single-use India Telegram connection token (valid until ${expiresAt}).`,
  });

  const botUsername = getIndiaTelegramBotUsername();
  const deepLink = `https://t.me/${botUsername}?start=${token}`;

  return {
    token,
    deepLink,
    expiresAt,
    botUsername,
  };
}

/**
 * Connects a customer's Telegram account to System B (India Bot)
 */
export function connectIndiaTelegramAccount(
  tokenStr: string,
  telegramChatId: string | number,
  telegramUsername?: string
): { success: boolean; customerId?: string; customerName?: string; error?: string } {
  const db = getDb();
  if (!Array.isArray(db.indiaTelegramConnectionTokens)) {
    db.indiaTelegramConnectionTokens = [];
  }

  const cleanToken = (tokenStr || '').trim();
  const cleanChatId = String(telegramChatId || '').trim();
  const now = new Date();

  if (!cleanToken || !cleanChatId) {
    return { success: false, error: 'Token and Telegram Chat ID are required.' };
  }

  const tokenRecord = db.indiaTelegramConnectionTokens.find((t) => t.token === cleanToken);
  if (!tokenRecord) {
    return { success: false, error: 'Invalid or unknown India Telegram connection token.' };
  }

  if (tokenRecord.used) {
    recordIndiaTelegramAuditEvent({
      customerId: tokenRecord.customerId,
      eventType: 'REJECTED',
      telegramChatId: cleanChatId,
      result: 'REJECTED',
      details: 'Attempted to reuse previously consumed India connection token.',
    });
    return { success: false, error: 'This India connection token has already been used. Please generate a new link.' };
  }

  if (new Date(tokenRecord.expiresAt) < now) {
    tokenRecord.used = true;
    saveDb();
    recordIndiaTelegramAuditEvent({
      customerId: tokenRecord.customerId,
      eventType: 'EXPIRED',
      telegramChatId: cleanChatId,
      result: 'REJECTED',
      details: 'India connection token expired prior to verification.',
    });
    return { success: false, error: 'Connection token has expired (15-minute validity limit). Please generate a fresh token.' };
  }

  const customer = getCustomerById(tokenRecord.customerId);
  if (!customer) {
    return { success: false, error: 'Customer associated with this token no longer exists.' };
  }

  // 1-to-1 account enforcement for India bot
  const existingCustomerWithChat = db.customers.find(
    (c) => c.indiaTelegramChatId === cleanChatId && c.customerId !== customer.customerId
  );

  if (existingCustomerWithChat) {
    recordIndiaTelegramAuditEvent({
      customerId: customer.customerId,
      eventType: 'REJECTED',
      telegramChatId: cleanChatId,
      result: 'REJECTED',
      details: `Telegram Chat ID is already associated with another customer (${existingCustomerWithChat.customerId}) on India Bot.`,
    });
    return {
      success: false,
      error: 'This Telegram account is already connected to another MyDigitAsset customer account on the India News Bot.',
    };
  }

  // Execute Connection Atomically for System B
  customer.indiaTelegramChatId = cleanChatId;
  customer.indiaTelegramConnected = true;
  customer.updatedAt = now.toISOString();

  tokenRecord.used = true;
  tokenRecord.usedAt = now.toISOString();

  recordIndiaTelegramAuditEvent({
    customerId: customer.customerId,
    eventType: 'CONNECTED',
    telegramChatId: cleanChatId,
    result: 'SUCCESS',
    details: `Connected to India News Bot successfully${telegramUsername ? ` (@${telegramUsername})` : ''}`,
  });

  saveDb();

  return {
    success: true,
    customerId: customer.customerId,
    customerName: customer.fullName,
  };
}

/**
 * Disconnects a customer's India Telegram bot connection
 */
export function disconnectIndiaTelegramAccount(customerId: string): { success: boolean; error?: string } {
  const db = getDb();
  const customer = getCustomerById(customerId);
  if (!customer) {
    return { success: false, error: `Customer with ID ${customerId} not found.` };
  }

  const prevChatId = customer.indiaTelegramChatId;
  customer.indiaTelegramChatId = null;
  customer.indiaTelegramConnected = false;
  customer.updatedAt = new Date().toISOString();

  recordIndiaTelegramAuditEvent({
    customerId: customer.customerId,
    eventType: 'DISCONNECTED',
    telegramChatId: prevChatId,
    result: 'SUCCESS',
    details: 'Customer disconnected their India Telegram News Bot account.',
  });

  saveDb();
  return { success: true };
}

export interface TelegramSendOptions {
  maxRetries?: number;
  simulateFailuresUntilAttempt?: number;
}

export interface TelegramSendResult {
  success: boolean;
  attempts: number;
  telegramMessageId?: string;
  error?: string;
  botType?: 'india';
}

// System B isolated rate limiting and queueing state
const lastSendTimeByChatIdIndia = new Map<string, number>();
let lastGlobalSendTimeIndia = 0;
let globalRateLimitPauseUntilIndia = 0;
let queuePromiseChainIndia: Promise<any> = Promise.resolve();

/**
 * Enqueues a message send operation for System B (India Bot)
 */
export function enqueueIndiaTelegramMessage(
  chatId: string,
  text: string,
  options: TelegramSendOptions = {}
): Promise<TelegramSendResult> {
  const executeInQueue = async (): Promise<TelegramSendResult> => {
    const now = Date.now();
    if (globalRateLimitPauseUntilIndia > now) {
      const waitMs = globalRateLimitPauseUntilIndia - now;
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const timeSinceLastGlobal = Date.now() - lastGlobalSendTimeIndia;
    if (timeSinceLastGlobal < 100) {
      await new Promise((r) => setTimeout(r, 100 - timeSinceLastGlobal));
    }

    const lastChatTime = lastSendTimeByChatIdIndia.get(chatId) || 0;
    const timeSinceLastChat = Date.now() - lastChatTime;
    if (timeSinceLastChat < 1000) {
      await new Promise((r) => setTimeout(r, 1000 - timeSinceLastChat));
    }

    const result = await rawSendIndiaTelegramMessage(chatId, text, options);

    const completionTime = Date.now();
    lastGlobalSendTimeIndia = completionTime;
    lastSendTimeByChatIdIndia.set(chatId, completionTime);

    return result;
  };

  const nextPromise = queuePromiseChainIndia.then(executeInQueue, executeInQueue);
  queuePromiseChainIndia = nextPromise.catch(() => {});
  return nextPromise;
}

/**
 * Sends a private Telegram message via System B India Bot
 */
async function rawSendIndiaTelegramMessage(
  chatId: string,
  text: string,
  options: TelegramSendOptions = {}
): Promise<TelegramSendResult> {
  const maxRetries = options.maxRetries ?? 3;
  let attempts = 0;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts++;

    if (options.simulateFailuresUntilAttempt && attempt < options.simulateFailuresUntilAttempt) {
      lastError = `Simulated transient India Telegram network drop on attempt ${attempt}`;
      const backoffMs = Math.min(100 * Math.pow(2, attempt - 1), 2000);
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }

    if (!TELEGRAM_INDIA_BOT_TOKEN) {
      // Sandbox / Test Mode log for System B
      console.log(`[India Telegram Sandbox Attempt ${attempt}] To Chat ID ${chatId}: ${text.substring(0, 80)}...`);
      return {
        success: true,
        attempts,
        telegramMessageId: `msg_india_sandbox_${Date.now()}_${attempts}`,
        botType: 'india',
      };
    }

    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_INDIA_BOT_TOKEN}/sendMessage`;
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
        const data = await res.json().catch(() => ({}));
        const retryAfterSec = Number(data.parameters?.retry_after) || 1;
        globalRateLimitPauseUntilIndia = Date.now() + retryAfterSec * 1000;
        lastError = `Telegram HTTP 429 Rate Limit. Pausing India queue for ${retryAfterSec}s`;
        await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
        continue;
      }

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        lastError = `Telegram API HTTP ${res.status}: ${errorBody}`;
        const backoffMs = Math.min(200 * Math.pow(2, attempt - 1), 2000);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      const body = await res.json().catch(() => ({}));
      const messageId = body.result?.message_id ? String(body.result.message_id) : `msg_india_${Date.now()}`;

      return {
        success: true,
        attempts,
        telegramMessageId: messageId,
        botType: 'india',
      };
    } catch (netErr: any) {
      lastError = `Network error connecting to Telegram Bot API: ${netErr.message || netErr}`;
      const backoffMs = Math.min(200 * Math.pow(2, attempt - 1), 2000);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  return {
    success: false,
    attempts,
    error: lastError || 'Max retries exceeded sending India Telegram message',
    botType: 'india',
  };
}

/**
 * Public dispatch wrapper for System B India Bot
 */
export async function sendIndiaTelegramMessage(
  chatId: string,
  text: string,
  options: TelegramSendOptions = {}
): Promise<TelegramSendResult> {
  return enqueueIndiaTelegramMessage(chatId, text, options);
}

/**
 * Receives webhook updates for System B India Bot
 */
export async function processIndiaTelegramWebhookUpdate(update: any): Promise<{ handled: boolean; replyText?: string }> {
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

  if (text.startsWith('/start')) {
    const parts = text.split(/\s+/);
    const token = parts[1] ? parts[1].trim() : '';

    if (!token) {
      const welcomeMsg = `👋 Welcome to the official *MyDigitAsset India News* Briefing Bot.\n\nTo connect your India News subscription, please click **Connect Telegram (India)** in your MyDigitAsset account dashboard to obtain your secure single-use linking token.\n\n🔒 *Privacy Notice*: All daily briefings are delivered directly to your private chat. Subscriber identities are strictly protected.`;
      await sendIndiaTelegramMessage(chatId, welcomeMsg);
      return { handled: true, replyText: welcomeMsg };
    }

    const connectResult = connectIndiaTelegramAccount(token, chatId, username);
    if (!connectResult.success) {
      const errorMsg = `⚠️ *Connection Failed*\n\n${connectResult.error}\n\nPlease return to your MyDigitAsset dashboard and generate a fresh connection token.`;
      await sendIndiaTelegramMessage(chatId, errorMsg);
      return { handled: true, replyText: errorMsg };
    }

    const successMsg = `✅ *MyDigitAsset India News Account Connected!*\n\nHello ${connectResult.customerName || 'Subscriber'},\n\nYour Telegram account has been linked to your MyDigitAsset India News subscription.\n\n🇮🇳 You will receive your synchronized daily executive briefings for your selected India categories in this private chat every morning between 6:00 AM and 7:00 AM IST.`;
    await sendIndiaTelegramMessage(chatId, successMsg);
    return { handled: true, replyText: successMsg };
  }

  return { handled: false };
}

/**
 * Retrieves audit logs for System B India Bot
 */
export function getIndiaTelegramAuditLogs(customerId?: string): TelegramConnectionAuditEvent[] {
  const db = getDb();
  const logs = db.indiaTelegramConnectionAudits || [];
  if (!customerId) return [...logs];
  return logs.filter((l) => l.customerId === customerId);
}
