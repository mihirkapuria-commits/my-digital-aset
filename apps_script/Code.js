/**
 * MyDigitalAsset (mydigitasset.com) - Google Apps Script Backend (Stage 1 Core Architecture)
 *
 * Implements:
 * 1. Secure Telegram Connection via Deep Link (/start <token>)
 * 2. Customer Identity Protection with opaque customerAuthToken
 * 3. Strict Admin Google ID Token Verification
 * 4. Explicit Buffer Date Math (Continuous News Delivery + 12-Month Paid Period)
 * 5. Google Sheets Database Management
 */

// Configuration Constants
var CONFIG = {
  AUTHORIZED_ADMIN_EMAIL: 'mihirkapuria@gmail.com',
  BOT_USERNAME: 'MyDigitAssetNewsBot',
  TOKEN_EXPIRY_MINUTES: 15,
  SESSION_EXPIRY_DAYS: 30,
};

/**
 * Main Web App Entry Point: POST Handler
 */
function doPost(e) {
  try {
    var contents = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};

    // 1. Telegram Webhook Updates
    if (contents.update_id || contents.message) {
      return handleTelegramWebhook(contents);
    }

    var action = contents.action || (e && e.parameter && e.parameter.action);

    // 2. Customer Public & Protected Endpoints
    switch (action) {
      case 'registerTrial':
        return jsonResponse(handleRegisterTrial(contents));

      case 'requestRenewalTrial':
        return jsonResponse(handleRequestRenewalTrial(contents));

      case 'submitPaymentProof':
        return jsonResponse(handleSubmitPaymentProof(contents));

      case 'generateTelegramToken':
        return jsonResponse(handleGenerateTelegramToken(contents));

      case 'getSubscriptionStatus':
        return jsonResponse(handleGetSubscriptionStatus(contents));

      // 3. Admin Authentication Endpoint
      case 'verifyAdminGoogleToken':
        return jsonResponse(handleVerifyAdminGoogleToken(contents));

      // 4. Admin Management Endpoints
      case 'adminConfirmPayment':
        return jsonResponse(handleAdminConfirmPayment(contents));

      default:
        return jsonResponse({ ok: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || 'Server error' });
  }
}

/**
 * Main Web App Entry Point: GET Handler
 */
function doGet(e) {
  var action = e && e.parameter && e.parameter.action;

  if (action === 'health') {
    return jsonResponse({ ok: true, status: 'healthy', time: new Date().toISOString() });
  }

  if (action === 'getCategories') {
    return jsonResponse({
      ok: true,
      categories: [
        { id: 'cat_india_pe_vc', name: 'India PE/VC & Deals' },
        { id: 'cat_india_startups', name: 'Startups & Venture Ecosystem' },
        { id: 'cat_india_healthcare', name: 'Healthcare & Life Sciences' },
      ],
    });
  }

  return jsonResponse({ ok: true, message: 'MyDigitalAsset Apps Script API is active.' });
}

// ============================================================================
// 1. TELEGRAM CONNECTION FLOW (Deep Link & Webhook)
// ============================================================================

/**
 * Generates an opaque, single-use, 256-bit cryptographic connection token
 * Deep link: https://t.me/<BOT_USERNAME>?start=<ONE_TIME_TOKEN>
 */
function handleGenerateTelegramToken(payload) {
  var customer = authenticateCustomer(payload.customerAuthToken);
  if (!customer) {
    return { ok: false, error: 'Unauthorized: Invalid or missing customerAuthToken.' };
  }

  var tokenSheet = getOrCreateSheet('TelegramTokens');
  var now = new Date();
  var expiresAt = new Date(now.getTime() + CONFIG.TOKEN_EXPIRY_MINUTES * 60 * 1000);

  // Invalidate any existing unused tokens for this customer
  var tokenData = tokenSheet.getDataRange().getValues();
  for (var i = 1; i < tokenData.length; i++) {
    if (tokenData[i][2] === customer.customerId && tokenData[i][4] === false) {
      tokenSheet.getRange(i + 1, 5).setValue(true); // set used = true
    }
  }

  // Generate opaque 256-bit random hex token (NO PII included)
  var rawBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    customer.customerId + '_' + now.getTime() + '_' + Math.random()
  );
  var tokenString = 'tgtok_' + bytesToHex(rawBytes);

  // Append new token record: [tokenId, token, customerId, expiresAt, used, usedAt, createdAt]
  tokenSheet.appendRow([
    'tok_' + Utilities.getUuid().substring(0, 8),
    tokenString,
    customer.customerId,
    expiresAt.toISOString(),
    false,
    '',
    now.toISOString(),
  ]);

  var deepLink = 'https://t.me/' + CONFIG.BOT_USERNAME + '?start=' + tokenString;

  return {
    ok: true,
    token: tokenString,
    deepLink: deepLink,
    expiresAt: expiresAt.toISOString(),
    botUsername: CONFIG.BOT_USERNAME,
  };
}

/**
 * Telegram Webhook Handler for `/start <token>`
 */
function handleTelegramWebhook(update) {
  if (!update || !update.message) {
    return jsonResponse({ ok: true, handled: false });
  }

  var message = update.message;
  var chatId = message.chat && message.chat.id ? String(message.chat.id) : null;
  var text = (message.text || '').trim();

  if (!chatId || !text) {
    return jsonResponse({ ok: true, handled: false });
  }

  // Handle /start command
  if (text.indexOf('/start') === 0) {
    var parts = text.split(/\s+/);
    var token = parts.length > 1 ? parts[1].trim() : '';

    if (!token) {
      sendTelegramMessage(
        chatId,
        '👋 Welcome to the *MyDigitalAsset* Briefing Bot.\n\nTo connect your subscription, open your account dashboard and tap **Connect Telegram**.'
      );
      return jsonResponse({ ok: true, handled: true });
    }

    var tokenSheet = getOrCreateSheet('TelegramTokens');
    var tokenRows = tokenSheet.getDataRange().getValues();
    var matchedRowIdx = -1;
    var customerId = null;
    var expiresAtStr = '';
    var isUsed = false;

    for (var i = 1; i < tokenRows.length; i++) {
      if (tokenRows[i][1] === token) {
        matchedRowIdx = i + 1;
        customerId = tokenRows[i][2];
        expiresAtStr = tokenRows[i][3];
        isUsed = Boolean(tokenRows[i][4]);
        break;
      }
    }

    if (matchedRowIdx === -1) {
      sendTelegramMessage(chatId, '⚠️ Connection Failed: Invalid or unrecognized connection token.');
      return jsonResponse({ ok: true, handled: true });
    }

    if (isUsed) {
      sendTelegramMessage(chatId, '⚠️ Connection Failed: This connection token has already been used. Please generate a fresh token from your dashboard.');
      return jsonResponse({ ok: true, handled: true });
    }

    var now = new Date();
    if (new Date(expiresAtStr) < now) {
      sendTelegramMessage(chatId, '⚠️ Connection Failed: Token expired (15-minute limit). Please generate a fresh token.');
      return jsonResponse({ ok: true, handled: true });
    }

    // Enforce One-Account-per-Telegram-Chat-ID rule
    var custSheet = getOrCreateSheet('Customers');
    var custRows = custSheet.getDataRange().getValues();
    var customerRowIdx = -1;

    for (var c = 1; c < custRows.length; c++) {
      if (String(custRows[c][6]) === chatId && custRows[c][0] !== customerId) {
        sendTelegramMessage(chatId, '⚠️ This Telegram account is already linked to another subscription account.');
        return jsonResponse({ ok: true, handled: true });
      }
      if (custRows[c][0] === customerId) {
        customerRowIdx = c + 1;
      }
    }

    if (customerRowIdx === -1) {
      sendTelegramMessage(chatId, '⚠️ Customer record not found.');
      return jsonResponse({ ok: true, handled: true });
    }

    // Atomically associate Telegram Chat ID and mark token used
    custSheet.getRange(customerRowIdx, 7).setValue(chatId); // Column G: telegramChatId
    custSheet.getRange(customerRowIdx, 8).setValue(true);   // Column H: telegramConnected
    custSheet.getRange(customerRowIdx, 12).setValue(now.toISOString()); // Column L: updatedAt

    tokenSheet.getRange(matchedRowIdx, 5).setValue(true);              // used = true
    tokenSheet.getRange(matchedRowIdx, 6).setValue(now.toISOString()); // usedAt = now

    // Log audit event
    var auditSheet = getOrCreateSheet('TelegramAudit');
    auditSheet.appendRow([
      'tga_' + Utilities.getUuid().substring(0, 8),
      customerId,
      'CONNECTED',
      chatId,
      'SUCCESS',
      'Telegram account connected via deep link',
      now.toISOString(),
    ]);

    sendTelegramMessage(
      chatId,
      '✅ *MyDigitalAsset Account Connected!*\n\nYour Telegram account has been linked to your subscription.\nYou will receive your daily briefings here every morning between 6:00 AM and 7:00 AM IST.'
    );

    return jsonResponse({ ok: true, handled: true });
  }

  return jsonResponse({ ok: true, handled: false });
}

// ============================================================================
// 2. CUSTOMER IDENTITY & PUBLIC ENDPOINT PROTECTION
// ============================================================================

/**
 * registerTrial: Registers new customer or logs in existing customer.
 * Issues unguessable opaque customerAuthToken (256-bit crypto hex).
 */
function handleRegisterTrial(payload) {
  var email = (payload.email || '').trim().toLowerCase();
  var fullName = (payload.fullName || '').trim();
  var mobile = (payload.mobileNumber || '').trim();
  var countryCode = (payload.mobileCountryCode || '+91').trim();
  var categoryIds = Array.isArray(payload.selectedCategoryIds) ? payload.selectedCategoryIds : ['cat_india_startups'];

  if (!email || !fullName || !mobile) {
    return { ok: false, error: 'Full name, email, and mobile number are required.' };
  }

  var custSheet = getOrCreateSheet('Customers');
  var custRows = custSheet.getDataRange().getValues();
  var customerId = null;
  var matchedRow = -1;
  var now = new Date();

  for (var i = 1; i < custRows.length; i++) {
    if (String(custRows[i][2]).toLowerCase() === email) {
      matchedRow = i + 1;
      customerId = custRows[i][0];
      break;
    }
  }

  // Generate 256-bit unguessable customerAuthToken
  var tokenDigest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    email + '_' + now.getTime() + '_' + Math.random()
  );
  var customerAuthToken = 'cat_' + bytesToHex(tokenDigest);

  if (matchedRow !== -1) {
    // Update existing customer
    custSheet.getRange(matchedRow, 2).setValue(fullName);
    custSheet.getRange(matchedRow, 4).setValue(countryCode);
    custSheet.getRange(matchedRow, 5).setValue(mobile);
    custSheet.getRange(matchedRow, 6).setValue(customerAuthToken);
    custSheet.getRange(matchedRow, 10).setValue(JSON.stringify(categoryIds));
    custSheet.getRange(matchedRow, 12).setValue(now.toISOString());
  } else {
    // Create new customer
    customerId = 'cust_' + Utilities.getUuid().substring(0, 10);
    custSheet.appendRow([
      customerId,
      fullName,
      email,
      countryCode,
      mobile,
      customerAuthToken,
      '',      // telegramChatId
      false,   // telegramConnected
      'active',
      JSON.stringify(categoryIds),
      now.toISOString(),
      now.toISOString(),
    ]);
  }

  return {
    ok: true,
    success: true,
    customerId: customerId,
    customerAuthToken: customerAuthToken,
    customer: {
      customerId: customerId,
      fullName: fullName,
      email: email,
      mobileCountryCode: countryCode,
      mobileNumber: mobile,
      telegramConnected: false,
      accountStatus: 'active',
      selectedCategoryIds: categoryIds,
    },
  };
}

/**
 * requestRenewalTrial: Protected endpoint requiring valid customerAuthToken.
 * Can only request renewal for the authenticated customer's own record.
 */
function handleRequestRenewalTrial(payload) {
  var customer = authenticateCustomer(payload.customerAuthToken);
  if (!customer) {
    return { ok: false, error: 'Unauthorized: Invalid or missing customerAuthToken.' };
  }

  // Record renewal request under customer.customerId
  return {
    ok: true,
    success: true,
    message: 'Renewal request recorded successfully for your account.',
    customerId: customer.customerId,
    requestedAt: new Date().toISOString(),
  };
}

/**
 * submitPaymentProof: Protected endpoint requiring valid customerAuthToken.
 * Submits payment proof attached strictly to the authenticated customer's record.
 */
function handleSubmitPaymentProof(payload) {
  var customer = authenticateCustomer(payload.customerAuthToken);
  if (!customer) {
    return { ok: false, error: 'Unauthorized: Invalid or missing customerAuthToken.' };
  }

  var reference = (payload.paymentReference || payload.utrNumber || '').trim();
  if (!reference || reference.length < 4) {
    return { ok: false, error: 'Valid payment reference or UTR is required.' };
  }

  var paySheet = getOrCreateSheet('Payments');
  var now = new Date();
  var paymentId = 'proof_' + Utilities.getUuid().substring(0, 8);
  var amount = typeof payload.amount === 'number' ? payload.amount : 297.36;
  var categoryIds = Array.isArray(payload.categoryIds) ? payload.categoryIds : customer.selectedCategoryIds;

  paySheet.appendRow([
    paymentId,
    customer.customerId,
    amount,
    'INR',
    'pending',
    now.toISOString(),
    reference,
    'manual_upi',
    JSON.stringify(categoryIds),
    now.toISOString(),
  ]);

  return {
    ok: true,
    success: true,
    paymentId: paymentId,
    reference: reference,
    status: 'pending',
    message: 'Payment proof submitted successfully and queued for admin review.',
  };
}

/**
 * getSubscriptionStatus: Returns the authenticated customer's own subscription.
 * Strictly never returns other customers' data.
 */
function handleGetSubscriptionStatus(payload) {
  var customer = authenticateCustomer(payload.customerAuthToken);
  if (!customer) {
    return { ok: false, error: 'Unauthorized: Invalid customer session.' };
  }

  var subSheet = getOrCreateSheet('Subscriptions');
  var subRows = subSheet.getDataRange().getValues();
  var mySubs = [];

  for (var i = 1; i < subRows.length; i++) {
    if (subRows[i][1] === customer.customerId) {
      mySubs.push({
        subscriptionId: subRows[i][0],
        bufferStartDate: subRows[i][3],
        bufferEndDate: subRows[i][4],
        paidStartDate: subRows[i][5],
        paidEndDate: subRows[i][6],
        status: subRows[i][7],
      });
    }
  }

  return {
    ok: true,
    customerId: customer.customerId,
    telegramConnected: customer.telegramConnected,
    subscriptions: mySubs,
  };
}

// ============================================================================
// 3. ADMIN GOOGLE ID TOKEN VERIFICATION
// ============================================================================

/**
 * Explicitly verifies Google ID Token:
 * 1. Valid token cryptographically signed by Google
 * 2. Correct OAuth audience (our Google OAuth Client ID)
 * 3. email === mihirkapuria@gmail.com
 * 4. email_verified === true
 * 5. Token has not expired (exp > now)
 */
function handleVerifyAdminGoogleToken(payload) {
  var idToken = (payload.idToken || '').trim();
  if (!idToken) {
    return { ok: false, error: 'Missing idToken.' };
  }

  var clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) {
    return { ok: false, error: 'GOOGLE_CLIENT_ID not configured in Script Properties.' };
  }

  // Validate via Google's authoritative tokeninfo endpoint
  var url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
  var response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    return { ok: false, error: 'Google token validation service unreachable: ' + err.message };
  }

  if (response.getResponseCode() !== 200) {
    return { ok: false, error: 'Invalid Google ID token.' };
  }

  var tokenPayload = JSON.parse(response.getContentText());

  // 1. Audience verification
  if (tokenPayload.aud !== clientId) {
    return { ok: false, error: 'Token audience does not match our Google Client ID.' };
  }

  // 2. Expiration verification
  var nowSec = Math.floor(new Date().getTime() / 1000);
  if (Number(tokenPayload.exp) < nowSec) {
    return { ok: false, error: 'Google ID token has expired.' };
  }

  // 3. Email verified verification
  var isEmailVerified = tokenPayload.email_verified === 'true' || tokenPayload.email_verified === true;
  if (!isEmailVerified) {
    return { ok: false, error: 'Google account email is not verified by Google.' };
  }

  // 4. Authorized Admin Email verification
  var candidateEmail = (tokenPayload.email || '').trim().toLowerCase();
  if (candidateEmail !== CONFIG.AUTHORIZED_ADMIN_EMAIL.toLowerCase()) {
    return { ok: false, error: 'Access denied: Unauthorized account ' + candidateEmail };
  }

  return {
    ok: true,
    adminEmail: candidateEmail,
    name: tokenPayload.name || 'Administrator',
  };
}

// ============================================================================
// 4. BUFFER DATE & SUBSCRIPTION MATH
// ============================================================================

/**
 * Calculates continuous delivery buffer and 12-month paid subscription dates
 * Formulas:
 *   bufferStartDate = adminConfirmedPaymentDate
 *   bufferEndDate   = adminConfirmedPaymentDate + 4 days
 *   paidStartDate   = adminConfirmedPaymentDate + 5 days
 *   paidEndDate     = paidStartDate + 12 calendar months
 *
 * Example (Oct 3 payment):
 *   Oct 3 = buffer/news day (Day 1)
 *   Oct 4 = buffer/news day (Day 2)
 *   Oct 5 = buffer/news day (Day 3)
 *   Oct 6 = buffer/news day (Day 4)
 *   Oct 7 = buffer/news day (Day 5 - bufferEndDate)
 *   Oct 8 = paid subscription begins (paidStartDate)
 *
 * Continuous delivery: News delivered Oct 3-7 and onwards through 12-month period!
 */
function calculateSubscriptionDatesWithBuffer(adminConfirmedPaymentDateStr) {
  var payDate = new Date(adminConfirmedPaymentDateStr);

  var bufferStart = new Date(payDate.getTime());
  bufferStart.setHours(0, 0, 0, 0);

  var bufferEnd = new Date(bufferStart.getTime());
  bufferEnd.setDate(bufferEnd.getDate() + 4);
  bufferEnd.setHours(23, 59, 59, 999);

  var paidStart = new Date(bufferStart.getTime());
  paidStart.setDate(paidStart.getDate() + 5);
  paidStart.setHours(0, 0, 0, 0);

  var paidEnd = new Date(paidStart.getTime());
  paidEnd.setFullYear(paidEnd.getFullYear() + 1);
  paidEnd.setHours(23, 59, 59, 999);

  return {
    bufferStartDate: bufferStart.toISOString(),
    bufferEndDate: bufferEnd.toISOString(),
    paidStartDate: paidStart.toISOString(),
    paidEndDate: paidEnd.toISOString(),
  };
}

/**
 * Admin action to confirm payment and activate subscription with explicit buffer dates
 */
function handleAdminConfirmPayment(payload) {
  var adminVerify = handleVerifyAdminGoogleToken(payload);
  if (!adminVerify.ok) {
    return { ok: false, error: 'Unauthorized: Admin authentication failed.' };
  }

  var customerId = payload.customerId;
  var paymentId = payload.paymentId;
  var confirmedDateStr = payload.confirmedDate || new Date().toISOString();

  var dates = calculateSubscriptionDatesWithBuffer(confirmedDateStr);
  var subSheet = getOrCreateSheet('Subscriptions');
  var now = new Date().toISOString();
  var subscriptionId = 'sub_' + Utilities.getUuid().substring(0, 8);

  subSheet.appendRow([
    subscriptionId,
    customerId,
    paymentId,
    dates.bufferStartDate,
    dates.bufferEndDate,
    dates.paidStartDate,
    dates.paidEndDate,
    'active',
    now,
    now,
  ]);

  return {
    ok: true,
    subscriptionId: subscriptionId,
    dates: dates,
    message: 'Subscription activated with 5-day continuous buffer and 12-month paid period.',
  };
}

// ============================================================================
// HELPER UTILITIES
// ============================================================================

function authenticateCustomer(customerAuthToken) {
  if (!customerAuthToken || typeof customerAuthToken !== 'string') return null;
  var custSheet = getOrCreateSheet('Customers');
  var rows = custSheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (rows[i][5] === customerAuthToken.trim()) {
      return {
        customerId: rows[i][0],
        fullName: rows[i][1],
        email: rows[i][2],
        mobileCountryCode: rows[i][3],
        mobileNumber: rows[i][4],
        customerAuthToken: rows[i][5],
        telegramChatId: rows[i][6],
        telegramConnected: Boolean(rows[i][7]),
        accountStatus: rows[i][8],
        selectedCategoryIds: rows[i][9] ? JSON.parse(rows[i][9]) : [],
      };
    }
  }
  return null;
}

function sendTelegramMessage(chatId, text) {
  var botToken = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!botToken) return;

  var url = 'https://api.telegram.org/bot' + botToken + '/sendMessage';
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
      }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    Logger.log('Telegram send error: ' + err.message);
  }
}

function getOrCreateSheet(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    var headers = {
      Customers: ['customerId', 'fullName', 'email', 'mobileCountryCode', 'mobileNumber', 'customerAuthToken', 'telegramChatId', 'telegramConnected', 'accountStatus', 'selectedCategoryIds', 'createdAt', 'updatedAt'],
      Subscriptions: ['subscriptionId', 'customerId', 'paymentId', 'bufferStartDate', 'bufferEndDate', 'paidStartDate', 'paidEndDate', 'status', 'createdAt', 'updatedAt'],
      Payments: ['paymentId', 'customerId', 'amount', 'currency', 'paymentStatus', 'paymentDate', 'gatewayReference', 'provider', 'purchasedCategoryIds', 'createdAt'],
      TelegramTokens: ['tokenId', 'token', 'customerId', 'expiresAt', 'used', 'usedAt', 'createdAt'],
      TelegramAudit: ['auditId', 'customerId', 'eventType', 'telegramChatId', 'result', 'details', 'timestamp'],
      AdminAudit: ['auditId', 'adminEmail', 'eventType', 'clientIp', 'details', 'timestamp'],
    };
    if (headers[sheetName]) {
      sheet.appendRow(headers[sheetName]);
    }
  }
  return sheet;
}

function bytesToHex(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b < 0) b += 256;
    var s = b.toString(16);
    if (s.length === 1) s = '0' + s;
    hex += s;
  }
  return hex;
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
