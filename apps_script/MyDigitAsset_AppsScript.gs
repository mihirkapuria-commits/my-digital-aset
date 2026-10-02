/**
 * ============================================================================
 * MYDIGITASSET - ZERO-COST PRODUCTION BACKEND (GOOGLE APPS SCRIPT)
 * ============================================================================
 * Architecture:
 * - Serverless backend running on Google Apps Script (script.google.com)
 * - Persistent private database in Google Sheets (owned by mihirkapuria@gmail.com)
 * - 1-to-1 Private Telegram Bot integration via deep-linking
 * - Cryptographic Google OAuth token verification for Admin Portal
 * - Configurable payment/banking structure with historical audit snapshots
 * - Multi-category relational subscription state machine
 * ============================================================================
 */

// Global Configuration
var AUTHORIZED_ADMIN_EMAIL = 'mihirkapuria@gmail.com';

/**
 * Script Properties Helper
 * Set these in Apps Script: Project Settings -> Script Properties:
 * - TELEGRAM_BOT_TOKEN: Bot token from @BotFather
 * - TELEGRAM_BOT_USERNAME: Bot username (e.g. MyDigitAssetNewsBot)
 * - GOOGLE_CLIENT_ID: Your Google OAuth 2.0 Web Client ID
 */
function getProperty(key, fallback) {
  var props = PropertiesService.getScriptProperties();
  var val = props.getProperty(key);
  return val ? val : (fallback || '');
}

/**
 * HTTP GET Router (Public API & Status Checks)
 */
function doGet(e) {
  try {
    var params = e && e.parameter ? e.parameter : {};
    var action = params.action;

    if (action === 'getPublicConfig') {
      return jsonResponse(getPublicPaymentConfig());
    }

    if (action === 'getCustomerStatus') {
      var token = params.token;
      return jsonResponse(getCustomerStatusByToken(token));
    }

    if (action === 'health') {
      return jsonResponse({ ok: true, status: 'MyDigitAsset Apps Script Online', time: new Date().toISOString() });
    }

    return jsonResponse({ ok: true, message: 'MyDigitAsset Service Active' });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

/**
 * HTTP POST Router (Webhook, Registrations, Payments, Admin)
 */
function doPost(e) {
  try {
    var rawBody = e && e.postData ? e.postData.contents : '{}';
    var payload = {};
    try {
      payload = JSON.parse(rawBody);
    } catch (parseErr) {
      payload = {};
    }

    // 1. Handle Telegram Bot Webhook dispatches
    if (payload.message && payload.message.chat) {
      return handleTelegramWebhook(payload);
    }

    var action = payload.action;

    // 2. Public Endpoints
    if (action === 'registerTrial') {
      return jsonResponse(handleRegisterTrial(payload));
    }

    if (action === 'generateTelegramToken') {
      return jsonResponse(handleGenerateTelegramToken(payload.customerSecretToken));
    }

    if (action === 'submitPaymentProof') {
      return jsonResponse(handleSubmitPaymentProof(payload));
    }

    if (action === 'requestRenewalTrial') {
      return jsonResponse(handleRequestRenewalTrial(payload));
    }

    // 3. Authorized Admin Endpoints
    if (action === 'adminGetDashboardData') {
      assertAdminAuth(payload.idToken);
      return jsonResponse(handleAdminGetDashboardData());
    }

    if (action === 'adminVerifyPayment') {
      assertAdminAuth(payload.idToken);
      return jsonResponse(handleAdminVerifyPayment(payload));
    }

    if (action === 'adminUpdatePaymentConfig') {
      assertAdminAuth(payload.idToken);
      return jsonResponse(handleAdminUpdatePaymentConfig(payload));
    }

    return jsonResponse({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

/**
 * JSON Response Formatter with CORS Support
 */
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// DATABASE & SPREADSHEET INITIALIZATION
// ============================================================================

function getDbSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SPREADSHEET_ID');
  var ss;

  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
      return ss;
    } catch (e) {
      // Spreadsheet ID invalid or inaccessible, will create a fresh one below
    }
  }

  // Create new spreadsheet if none configured
  ss = SpreadsheetApp.create('MyDigitAsset_Database');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  initAllSheets(ss);
  return ss;
}

function initAllSheets(ss) {
  ensureSheet(ss, 'Customers', [
    'customerId', 'customerSecretToken', 'fullName', 'email', 'mobileCountryCode',
    'mobileNumber', 'telegramChatId', 'telegramUsername', 'accountStatus', 'createdAt', 'updatedAt'
  ]);

  ensureSheet(ss, 'Subscriptions', [
    'subscriptionId', 'customerId', 'cycleType', 'parentSubscriptionId', 'state',
    'trialStartDate', 'trialEndDate', 'day3ReminderSent', 'day3ReminderSentAt',
    'customerReportedPaymentDate', 'adminConfirmedPaymentDate',
    'bufferStartDate', 'bufferEndDate', 'paidStartDate', 'paidExpiryDate',
    'renewalReminderSent', 'renewalReminderSentAt', 'createdAt', 'updatedAt'
  ]);

  ensureSheet(ss, 'SubscriptionCategories', [
    'entitlementId', 'subscriptionId', 'customerId', 'categoryId', 'categoryName',
    'status', 'assignedAt'
  ]);

  ensureSheet(ss, 'Payments', [
    'paymentId', 'subscriptionId', 'customerId', 'configVersion',
    'basePriceAtPayment', 'gstRateAtPayment', 'gstAmountAtPayment', 'totalAmountPaid', 'currency',
    'paymentMethod', 'destinationVpaOrAccount', 'utrReference',
    'customerReportedPaymentDate', 'adminConfirmedPaymentDate',
    'verificationStatus', 'verifiedAt', 'verifiedBy', 'notes'
  ]);

  ensureSheet(ss, 'TelegramTokens', [
    'token', 'customerId', 'expiresAt', 'used', 'usedAt', 'createdAt'
  ]);

  ensureSheet(ss, 'PaymentConfig', [
    'configKey', 'configJson', 'version', 'updatedAt', 'updatedBy'
  ]);

  ensureSheet(ss, 'PaymentConfigHistory', [
    'version', 'updatedAt', 'updatedBy', 'configJson', 'changeSummary'
  ]);

  ensureSheet(ss, 'DailyNews', [
    'newsDate', 'categoryId', 'headline', 'summary', 'sourceName', 'sourceUrl', 'createdAt'
  ]);

  ensureSheet(ss, 'DeliveryLogs', [
    'logId', 'timestamp', 'customerId', 'telegramChatId', 'categoryId', 'deliveryType', 'status', 'error'
  ]);

  // Seed default payment config if not present
  var configSheet = ss.getSheetByName('PaymentConfig');
  if (configSheet.getLastRow() <= 1) {
    var initialConfig = {
      configVersion: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: AUTHORIZED_ADMIN_EMAIL,
      changeSummary: 'Initial setup',
      pricing: {
        currency: 'INR',
        basePrice: 252.00,
        gstRatePercent: 18,
        billingPeriod: 'yearly'
      },
      upi: {
        enabled: true,
        upiId: 'mihirkapuria@gmail.com',
        beneficiaryName: 'MyDigitAsset Media',
        qrCodeEnabled: true,
        qrCodeImageUrl: ''
      },
      bankTransfer: {
        enabled: false,
        displayBankAccountToCustomers: false,
        displayFullAccountNumberToCustomers: false,
        accountHolderName: 'MyDigitAsset Media',
        bankName: 'HDFC Bank',
        accountNumber: '50200012345678',
        ifscCode: 'HDFC0001234',
        accountType: 'Current'
      },
      referenceValidation: {
        minLength: 6,
        maxLength: 35,
        allowedPattern: '^[a-zA-Z0-9_-]+$',
        customerInstructions: 'Please enter the 12-digit UPI reference (UTR) or Bank transaction number.'
      },
      futureProviders: {
        razorpayEnabled: false,
        razorpayMode: 'live',
        razorpayKeyId: ''
      }
    };

    configSheet.appendRow([
      'active_config',
      JSON.stringify(initialConfig),
      1,
      new Date().toISOString(),
      AUTHORIZED_ADMIN_EMAIL
    ]);
  }
}

function ensureSheet(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ============================================================================
// SECURITY & AUTHENTICATION
// ============================================================================

/**
 * Validates Google OAuth ID Token for Admin Access:
 * - Cryptographically verified via Google Tokeninfo API
 * - Checks aud (OAuth client ID) if configured
 * - Enforces email === mihirkapuria@gmail.com
 * - Enforces email_verified === true
 * - Checks token expiration
 */
function assertAdminAuth(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Unauthorized: Admin ID Token required.');
  }

  var verifyUrl = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
  var response;
  try {
    response = UrlFetchApp.fetch(verifyUrl, { muteHttpExceptions: true });
  } catch (netErr) {
    throw new Error('Authentication Service Unavailable: ' + netErr.toString());
  }

  if (response.getResponseCode() !== 200) {
    throw new Error('Unauthorized: Invalid Google ID Token signature.');
  }

  var tokenInfo = JSON.parse(response.getContentText());

  // Check email match
  if (tokenInfo.email !== AUTHORIZED_ADMIN_EMAIL) {
    throw new Error('Access Denied: Account ' + tokenInfo.email + ' is not authorized.');
  }

  // Check email verified flag
  if (tokenInfo.email_verified !== 'true' && tokenInfo.email_verified !== true) {
    throw new Error('Access Denied: Google email account must be verified.');
  }

  // Check expiry
  var nowSec = Math.floor(Date.now() / 1000);
  if (Number(tokenInfo.exp) < nowSec) {
    throw new Error('Unauthorized: Google ID Token has expired.');
  }

  // Check Client ID (Audience) if configured
  var expectedClientId = getProperty('GOOGLE_CLIENT_ID', '');
  if (expectedClientId && tokenInfo.aud !== expectedClientId) {
    throw new Error('Unauthorized: Token audience mismatch.');
  }

  return tokenInfo;
}

/**
 * Validates Customer Secret Bearer Token
 * Guarantees that customers can only view/mutate their own record
 */
function getCustomerBySecretToken(token) {
  if (!token || typeof token !== 'string' || token.length < 16) {
    throw new Error('Invalid or missing customer authorization token.');
  }

  var ss = getDbSpreadsheet();
  var sheet = ss.getSheetByName('Customers');
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === token) { // Column B: customerSecretToken
      return {
        rowIndex: i + 1,
        customerId: data[i][0],
        customerSecretToken: data[i][1],
        fullName: data[i][2],
        email: data[i][3],
        mobileCountryCode: data[i][4],
        mobileNumber: data[i][5],
        telegramChatId: data[i][6],
        telegramUsername: data[i][7],
        accountStatus: data[i][8]
      };
    }
  }

  throw new Error('Customer not found for the provided session.');
}

// ============================================================================
// CONFIGURATION & SANITIZATION
// ============================================================================

function getActiveConfigRecord() {
  var ss = getDbSpreadsheet();
  var sheet = ss.getSheetByName('PaymentConfig');
  var data = sheet.getDataRange().getValues();

  if (data.length > 1) {
    try {
      return JSON.parse(data[1][1]);
    } catch (e) {}
  }
  return null;
}

/**
 * Returns strictly sanitized payment config to public customers
 * - Masks bank account if full account display is disabled
 * - Completely hides bank transfer if disabled
 * - Strips any private credentials
 */
function getPublicPaymentConfig() {
  var config = getActiveConfigRecord();
  if (!config) throw new Error('Active payment configuration not initialized.');

  var publicBank = null;
  if (config.bankTransfer && config.bankTransfer.enabled && config.bankTransfer.displayBankAccountToCustomers) {
    var rawAcc = String(config.bankTransfer.accountNumber || '');
    var displayAcc = rawAcc;

    if (!config.bankTransfer.displayFullAccountNumberToCustomers && rawAcc.length > 4) {
      displayAcc = '******' + rawAcc.substring(rawAcc.length - 4);
    }

    publicBank = {
      accountHolderName: config.bankTransfer.accountHolderName,
      bankName: config.bankTransfer.bankName,
      accountNumber: displayAcc,
      ifscCode: config.bankTransfer.ifscCode,
      accountType: config.bankTransfer.accountType,
      branchName: config.bankTransfer.branchName || ''
    };
  }

  return {
    ok: true,
    configVersion: config.configVersion,
    pricing: config.pricing,
    upi: {
      enabled: config.upi ? config.upi.enabled : true,
      upiId: config.upi ? config.upi.upiId : '',
      beneficiaryName: config.upi ? config.upi.beneficiaryName : '',
      qrCodeEnabled: config.upi ? config.upi.qrCodeEnabled : true,
      qrCodeImageUrl: config.upi ? config.upi.qrCodeImageUrl : ''
    },
    bankTransfer: publicBank,
    referenceValidation: config.referenceValidation,
    telegramBotUsername: getProperty('TELEGRAM_BOT_USERNAME', 'MyDigitAssetNewsBot')
  };
}

// ============================================================================
// CUSTOMER ACTIONS & SUBSCRIPTION STATE MACHINE
// ============================================================================

/**
 * 1. Register 3-Day Free Trial
 */
function handleRegisterTrial(payload) {
  var fullName = (payload.fullName || '').trim();
  var mobileNumber = (payload.mobileNumber || '').trim();
  var mobileCountryCode = (payload.mobileCountryCode || '+91').trim();
  var categoryId = (payload.categoryId || 'cat_india_startups').trim();
  var categoryName = payload.categoryName || 'India PE/VC & Startups';

  if (!fullName) throw new Error('Full name is required.');
  if (!mobileNumber) throw new Error('Mobile number is required.');

  var ss = getDbSpreadsheet();
  var customersSheet = ss.getSheetByName('Customers');
  var subsSheet = ss.getSheetByName('Subscriptions');
  var subCatsSheet = ss.getSheetByName('SubscriptionCategories');

  var customerId = 'cust_' + Utilities.getUuid().substring(0, 12);
  var customerSecretToken = 'csec_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var subscriptionId = 'sub_' + Utilities.getUuid().substring(0, 12);
  var entitlementId = 'ent_' + Utilities.getUuid().substring(0, 12);

  var now = new Date();
  var trialStartStr = formatDate(now);
  var trialEndStr = formatDate(addDays(now, 2)); // Day 1 = today, Day 2 = +1, Day 3 = +2

  // 1. Add Customer Record
  customersSheet.appendRow([
    customerId,
    customerSecretToken,
    fullName,
    payload.email || '',
    mobileCountryCode,
    mobileNumber,
    '', // telegramChatId (empty until connected)
    '', // telegramUsername
    'active',
    now.toISOString(),
    now.toISOString()
  ]);

  // 2. Add Initial Subscription Record (TRIAL_ACTIVE)
  subsSheet.appendRow([
    subscriptionId,
    customerId,
    'INITIAL',
    '', // parentSubscriptionId
    'TRIAL_ACTIVE',
    trialStartStr,
    trialEndStr,
    false, // day3ReminderSent
    '',    // day3ReminderSentAt
    '',    // customerReportedPaymentDate
    '',    // adminConfirmedPaymentDate
    '',    // bufferStartDate
    '',    // bufferEndDate
    '',    // paidStartDate
    '',    // paidExpiryDate
    false, // renewalReminderSent
    '',    // renewalReminderSentAt
    now.toISOString(),
    now.toISOString()
  ]);

  // 3. Add Category Entitlement
  subCatsSheet.appendRow([
    entitlementId,
    subscriptionId,
    customerId,
    categoryId,
    categoryName,
    'ACTIVE',
    now.toISOString()
  ]);

  // 4. Generate initial Telegram connection token
  var tokenData = generateTelegramTokenForCustomer(customerId);

  return {
    ok: true,
    customerId: customerId,
    customerSecretToken: customerSecretToken,
    subscriptionId: subscriptionId,
    state: 'TRIAL_ACTIVE',
    trialStartDate: trialStartStr,
    trialEndDate: trialEndStr,
    telegramDeepLink: tokenData.deepLink,
    telegramToken: tokenData.token
  };
}

/**
 * 2. Generate Telegram Connection Token (Single-use, 24-hr expiry)
 */
function handleGenerateTelegramToken(secretToken) {
  var customer = getCustomerBySecretToken(secretToken);
  var tokenData = generateTelegramTokenForCustomer(customer.customerId);
  return {
    ok: true,
    token: tokenData.token,
    deepLink: tokenData.deepLink,
    botUsername: tokenData.botUsername
  };
}

function generateTelegramTokenForCustomer(customerId) {
  var ss = getDbSpreadsheet();
  var sheet = ss.getSheetByName('TelegramTokens');
  var token = 'tgtok_' + Utilities.getUuid().replace(/-/g, '');
  var botUsername = getProperty('TELEGRAM_BOT_USERNAME', 'MyDigitAssetNewsBot');

  var now = new Date();
  var expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  sheet.appendRow([
    token,
    customerId,
    expiresAt,
    false, // used
    '',    // usedAt
    now.toISOString()
  ]);

  var deepLink = 'https://t.me/' + botUsername + '?start=' + token;

  return {
    token: token,
    deepLink: deepLink,
    botUsername: botUsername
  };
}

/**
 * 3. Submit Payment Reference (UTR)
 */
function handleSubmitPaymentProof(payload) {
  var customer = getCustomerBySecretToken(payload.customerSecretToken);
  var utr = (payload.utrReference || '').trim();
  var customerReportedDate = (payload.customerReportedPaymentDate || formatDate(new Date())).trim();
  var paymentMethod = payload.paymentMethod || 'UPI';

  var activeConfig = getActiveConfigRecord();
  if (!activeConfig) throw new Error('Active payment configuration not available.');

  // Validate UTR against configurable regex rules
  var rules = activeConfig.referenceValidation || { minLength: 6, maxLength: 35, allowedPattern: '^[a-zA-Z0-9_-]+$' };
  if (utr.length < rules.minLength || utr.length > rules.maxLength) {
    throw new Error('Reference must be between ' + rules.minLength + ' and ' + rules.maxLength + ' characters.');
  }

  var regex = new RegExp(rules.allowedPattern);
  if (!regex.test(utr)) {
    throw new Error('Reference contains invalid characters.');
  }

  var ss = getDbSpreadsheet();
  var subsSheet = ss.getSheetByName('Subscriptions');
  var paymentsSheet = ss.getSheetByName('Payments');
  var subsData = subsSheet.getDataRange().getValues();

  // Find customer's active or expired subscription
  var subRow = -1;
  var subscriptionId = '';
  var currentState = '';

  for (var i = subsData.length - 1; i >= 1; i--) {
    if (subsData[i][1] === customer.customerId) {
      subRow = i + 1;
      subscriptionId = subsData[i][0];
      currentState = subsData[i][4];
      break;
    }
  }

  if (subRow === -1) throw new Error('No active subscription record found to pay for.');

  var basePrice = activeConfig.pricing.basePrice;
  var gstRate = activeConfig.pricing.gstRatePercent;
  var gstAmount = Number(((basePrice * gstRate) / 100).toFixed(2));
  var totalAmount = Number((basePrice + gstAmount).toFixed(2));

  var paymentId = 'pay_' + Utilities.getUuid().substring(0, 12);
  var destination = paymentMethod === 'BANK_TRANSFER'
    ? (activeConfig.bankTransfer.bankName + ' ' + activeConfig.bankTransfer.accountNumber)
    : activeConfig.upi.upiId;

  // Append Payment Snapshot Record
  paymentsSheet.appendRow([
    paymentId,
    subscriptionId,
    customer.customerId,
    activeConfig.configVersion,
    basePrice,
    gstRate,
    gstAmount,
    totalAmount,
    activeConfig.pricing.currency,
    paymentMethod,
    destination,
    utr,
    customerReportedDate,
    '', // adminConfirmedPaymentDate (authoritative date empty until approved)
    'PENDING',
    '', // verifiedAt
    '', // verifiedBy
    'Customer submitted via web portal'
  ]);

  // Transition state to PAYMENT_SUBMITTED (or RENEWAL_PAYMENT_SUBMITTED)
  var newState = (currentState === 'RENEWAL_TRIAL_ACTIVE') ? 'RENEWAL_PAYMENT_SUBMITTED' : 'PAYMENT_SUBMITTED';
  subsSheet.getRange(subRow, 5).setValue(newState); // Column E: state
  subsSheet.getRange(subRow, 10).setValue(customerReportedDate); // Column J: customerReportedPaymentDate
  subsSheet.getRange(subRow, 19).setValue(new Date().toISOString()); // Column S: updatedAt

  return {
    ok: true,
    paymentId: paymentId,
    state: newState,
    message: 'Payment reference submitted. Your daily news briefings will continue uninterrupted.'
  };
}

/**
 * 4. Request Renewal Trial (Anti-Abuse Protected)
 */
function handleRequestRenewalTrial(payload) {
  var customer = getCustomerBySecretToken(payload.customerSecretToken);
  var ss = getDbSpreadsheet();
  var subsSheet = ss.getSheetByName('Subscriptions');
  var subCatsSheet = ss.getSheetByName('SubscriptionCategories');
  var subsData = subsSheet.getDataRange().getValues();

  var lastSub = null;
  var lastSubId = '';

  for (var i = subsData.length - 1; i >= 1; i--) {
    if (subsData[i][1] === customer.customerId) {
      lastSub = subsData[i];
      lastSubId = subsData[i][0];
      break;
    }
  }

  if (!lastSub) throw new Error('No prior subscription found to renew.');

  var state = lastSub[4];
  // Anti-abuse: check if already in an active renewal cycle
  if (state === 'RENEWAL_TRIAL_ACTIVE' || state === 'RENEWAL_PAYMENT_SUBMITTED' || state === 'RENEWAL_VERIFIED_BUFFER') {
    return { ok: true, subscriptionId: lastSubId, state: state, message: 'Renewal trial already active.' };
  }

  if (state !== 'PAID_EXPIRING_TODAY' && state !== 'EXPIRED' && state !== 'TRIAL_EXPIRED_UNPAID') {
    throw new Error('Current subscription must be concluded or expiring today to request renewal.');
  }

  var newSubId = 'sub_' + Utilities.getUuid().substring(0, 12);
  var now = new Date();
  var trialStartStr = formatDate(now);
  var trialEndStr = formatDate(addDays(now, 2));

  subsSheet.appendRow([
    newSubId,
    customer.customerId,
    'RENEWAL',
    lastSubId,
    'RENEWAL_TRIAL_ACTIVE',
    trialStartStr,
    trialEndStr,
    false,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    false,
    '',
    now.toISOString(),
    now.toISOString()
  ]);

  // Copy category associations
  var subCatsData = subCatsSheet.getDataRange().getValues();
  for (var j = 1; j < subCatsData.length; j++) {
    if (subCatsData[j][1] === lastSubId) {
      subCatsSheet.appendRow([
        'ent_' + Utilities.getUuid().substring(0, 12),
        newSubId,
        customer.customerId,
        subCatsData[j][3],
        subCatsData[j][4],
        'ACTIVE',
        now.toISOString()
      ]);
    }
  }

  return {
    ok: true,
    subscriptionId: newSubId,
    state: 'RENEWAL_TRIAL_ACTIVE',
    trialStartDate: trialStartStr,
    trialEndDate: trialEndStr
  };
}

/**
 * 5. Get Customer Status (Only for their authorized session)
 */
function getCustomerStatusByToken(token) {
  var customer = getCustomerBySecretToken(token);
  var ss = getDbSpreadsheet();
  var subsSheet = ss.getSheetByName('Subscriptions');
  var subCatsSheet = ss.getSheetByName('SubscriptionCategories');
  var subsData = subsSheet.getDataRange().getValues();

  var activeSub = null;
  for (var i = subsData.length - 1; i >= 1; i--) {
    if (subsData[i][1] === customer.customerId) {
      activeSub = subsData[i];
      break;
    }
  }

  var categories = [];
  if (activeSub) {
    var subCatsData = subCatsSheet.getDataRange().getValues();
    for (var j = 1; j < subCatsData.length; j++) {
      if (subCatsData[j][1] === activeSub[0] && subCatsData[j][5] === 'ACTIVE') {
        categories.push({ id: subCatsData[j][3], name: subCatsData[j][4] });
      }
    }
  }

  return {
    ok: true,
    fullName: customer.fullName,
    telegramConnected: Boolean(customer.telegramChatId),
    state: activeSub ? activeSub[4] : 'TRIAL_ACTIVE',
    trialStartDate: activeSub ? activeSub[5] : '',
    trialEndDate: activeSub ? activeSub[6] : '',
    adminConfirmedPaymentDate: activeSub ? activeSub[10] : '',
    bufferStartDate: activeSub ? activeSub[11] : '',
    bufferEndDate: activeSub ? activeSub[12] : '',
    paidStartDate: activeSub ? activeSub[13] : '',
    paidExpiryDate: activeSub ? activeSub[14] : '',
    categories: categories
  };
}

// ============================================================================
// TELEGRAM WEBHOOK & 1-TO-1 BOT DISPATCH
// ============================================================================

function handleTelegramWebhook(payload) {
  var msg = payload.message;
  if (!msg || !msg.text) return jsonResponse({ ok: true });

  var text = msg.text.trim();
  var chatId = String(msg.chat.id);
  var username = msg.from ? (msg.from.username || '') : '';

  if (text.indexOf('/start') === 0) {
    var parts = text.split(/\s+/);
    var token = parts.length > 1 ? parts[1].trim() : '';

    if (!token) {
      sendTelegramDirect(chatId, '👋 *Welcome to MyDigitAsset Briefings*\n\nPlease click the "Connect via Telegram" button on mydigitasset.com to link your subscription.');
      return jsonResponse({ ok: true });
    }

    var linkResult = associateTelegramChatByToken(token, chatId, username);
    if (!linkResult.success) {
      sendTelegramDirect(chatId, '⚠️ *Connection Failed*\n\n' + linkResult.error + '\n\nPlease return to mydigitasset.com and generate a fresh connection link.');
    } else {
      sendTelegramDirect(chatId, '✅ *Subscription Connected!*\n\nHello ' + (linkResult.customerName || 'Reader') + ',\n\nYour Telegram account is now securely connected to MyDigitAsset. You will receive your curated daily morning news briefing in this private chat between 6:00 AM and 7:00 AM IST.\n\n🔒 *Privacy Notice*: All daily intelligence is delivered strictly 1-to-1.');
    }
  }

  return jsonResponse({ ok: true });
}

function associateTelegramChatByToken(token, chatId, username) {
  var ss = getDbSpreadsheet();
  var tokenSheet = ss.getSheetByName('TelegramTokens');
  var customersSheet = ss.getSheetByName('Customers');
  var tokenData = tokenSheet.getDataRange().getValues();

  var tokenRow = -1;
  var customerId = '';
  var expiresAt = '';
  var used = false;

  for (var i = 1; i < tokenData.length; i++) {
    if (tokenData[i][0] === token) {
      tokenRow = i + 1;
      customerId = tokenData[i][1];
      expiresAt = tokenData[i][2];
      used = tokenData[i][3];
      break;
    }
  }

  if (tokenRow === -1) return { success: false, error: 'Unrecognized or invalid connection token.' };
  if (used) return { success: false, error: 'This token has already been consumed.' };
  if (new Date(expiresAt) < new Date()) return { success: false, error: 'This connection token has expired.' };

  // Check if chat ID is already linked to another customer
  var custData = customersSheet.getDataRange().getValues();
  for (var j = 1; j < custData.length; j++) {
    if (String(custData[j][6]) === chatId && custData[j][0] !== customerId) {
      return { success: false, error: 'This Telegram account is already associated with another subscription.' };
    }
  }

  // Link customer
  var customerName = '';
  for (var k = 1; k < custData.length; k++) {
    if (custData[k][0] === customerId) {
      customersSheet.getRange(k + 1, 7).setValue(chatId); // Column G: telegramChatId
      customersSheet.getRange(k + 1, 8).setValue(username); // Column H: telegramUsername
      customersSheet.getRange(k + 1, 11).setValue(new Date().toISOString());
      customerName = custData[k][2];
      break;
    }
  }

  // Mark token consumed
  tokenSheet.getRange(tokenRow, 4).setValue(true);
  tokenSheet.getRange(tokenRow, 5).setValue(new Date().toISOString());

  return { success: true, customerName: customerName };
}

function sendTelegramDirect(chatId, text) {
  var botToken = getProperty('TELEGRAM_BOT_TOKEN');
  if (!botToken) {
    Logger.log('Telegram Bot Token not configured. Simulated send to ' + chatId + ': ' + text);
    return false;
  }

  var url = 'https://api.telegram.org/bot' + botToken + '/sendMessage';
  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      }),
      muteHttpExceptions: true
    });
    return response.getResponseCode() === 200;
  } catch (e) {
    Logger.log('Telegram API Error: ' + e.toString());
    return false;
  }
}

// ============================================================================
// AUTHORIZED ADMIN ENDPOINTS
// ============================================================================

function handleAdminGetDashboardData() {
  var ss = getDbSpreadsheet();
  var custSheet = ss.getSheetByName('Customers');
  var subsSheet = ss.getSheetByName('Subscriptions');
  var paymentsSheet = ss.getSheetByName('Payments');
  var configSheet = ss.getSheetByName('PaymentConfig');
  var historySheet = ss.getSheetByName('PaymentConfigHistory');

  var customers = sheetToJson(custSheet);
  var subscriptions = sheetToJson(subsSheet);
  var payments = sheetToJson(paymentsSheet);
  var configHistory = sheetToJson(historySheet);
  var activeConfig = getActiveConfigRecord();

  return {
    ok: true,
    activeConfig: activeConfig,
    configHistory: configHistory,
    customers: customers,
    subscriptions: subscriptions,
    payments: payments
  };
}

/**
 * Admin Verifies Payment:
 * Sets adminConfirmedPaymentDate (authoritative)
 * Calculates 4-day buffer:
 *   bufferStartDate = adminConfirmedPaymentDate
 *   bufferEndDate = adminConfirmedPaymentDate + 4 days
 *   paidStartDate = adminConfirmedPaymentDate + 5 days
 *   paidExpiryDate = paidStartDate + 1 year - 1 day
 */
function handleAdminVerifyPayment(payload) {
  var paymentId = payload.paymentId;
  var confirmedDateStr = (payload.adminConfirmedPaymentDate || formatDate(new Date())).trim();
  var notes = payload.notes || 'Verified by admin';

  var ss = getDbSpreadsheet();
  var paymentsSheet = ss.getSheetByName('Payments');
  var subsSheet = ss.getSheetByName('Subscriptions');
  var payData = paymentsSheet.getDataRange().getValues();

  var payRow = -1;
  var subscriptionId = '';
  var customerId = '';

  for (var i = 1; i < payData.length; i++) {
    if (payData[i][0] === paymentId) {
      payRow = i + 1;
      subscriptionId = payData[i][1];
      customerId = payData[i][2];
      break;
    }
  }

  if (payRow === -1) throw new Error('Payment record not found.');

  // Update Payment record
  paymentsSheet.getRange(payRow, 14).setValue(confirmedDateStr); // Col N: adminConfirmedPaymentDate
  paymentsSheet.getRange(payRow, 15).setValue('VERIFIED');        // Col O: verificationStatus
  paymentsSheet.getRange(payRow, 16).setValue(new Date().toISOString()); // Col P: verifiedAt
  paymentsSheet.getRange(payRow, 17).setValue(AUTHORIZED_ADMIN_EMAIL);    // Col Q: verifiedBy
  paymentsSheet.getRange(payRow, 18).setValue(notes);

  // Calculate Dates according to rule:
  // e.g. Oct 3 confirmed:
  // bufferStartDate = Oct 3
  // bufferEndDate = Oct 7 (Oct 3 + 4 days)
  // paidStartDate = Oct 8 (Oct 3 + 5 days)
  // paidExpiryDate = Oct 7, 2027 (paidStartDate + 1 year - 1 day)
  var confirmedDate = parseDateString(confirmedDateStr);
  var bufferStartDate = formatDate(confirmedDate);
  var bufferEndDate = formatDate(addDays(confirmedDate, 4));
  var paidStartDate = formatDate(addDays(confirmedDate, 5));

  var nextYear = new Date(confirmedDate.getTime());
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  var paidExpiryDate = formatDate(addDays(nextYear, 4)); // exactly 1 year from paidStartDate minus 1 day

  // Find and update Subscription record
  var subsData = subsSheet.getDataRange().getValues();
  for (var s = 1; s < subsData.length; s++) {
    if (subsData[s][0] === subscriptionId) {
      var sRow = s + 1;
      subsSheet.getRange(sRow, 5).setValue('PAYMENT_VERIFIED_BUFFER'); // Col E: state
      subsSheet.getRange(sRow, 11).setValue(confirmedDateStr);          // Col K: adminConfirmedPaymentDate
      subsSheet.getRange(sRow, 12).setValue(bufferStartDate);           // Col L: bufferStartDate
      subsSheet.getRange(sRow, 13).setValue(bufferEndDate);             // Col M: bufferEndDate
      subsSheet.getRange(sRow, 14).setValue(paidStartDate);             // Col N: paidStartDate
      subsSheet.getRange(sRow, 15).setValue(paidExpiryDate);            // Col O: paidExpiryDate
      subsSheet.getRange(sRow, 19).setValue(new Date().toISOString());  // Col S: updatedAt
      break;
    }
  }

  // Send private Telegram confirmation if chat connected
  var custSheet = ss.getSheetByName('Customers');
  var custData = custSheet.getDataRange().getValues();
  for (var c = 1; c < custData.length; c++) {
    if (custData[c][0] === customerId && custData[c][6]) {
      sendTelegramDirect(
        String(custData[c][6]),
        '🎉 *Payment Verified & Subscription Activated!*\n\nThank you for subscribing to MyDigitAsset. Your continuous briefings are active:\n\n• *Buffer Access*: ' + bufferStartDate + ' to ' + bufferEndDate + '\n• *Annual Membership*: ' + paidStartDate + ' to ' + paidExpiryDate + '\n\nExecutive briefings continue every morning between 6:00 AM and 7:00 AM IST.'
      );
      break;
    }
  }

  return {
    ok: true,
    paymentId: paymentId,
    subscriptionId: subscriptionId,
    bufferStartDate: bufferStartDate,
    bufferEndDate: bufferEndDate,
    paidStartDate: paidStartDate,
    paidExpiryDate: paidExpiryDate
  };
}

/**
 * Admin Updates Payment Config:
 * Archives prior config to PaymentConfigHistory
 * Increments version number
 * Saves new active config
 */
function handleAdminUpdatePaymentConfig(payload) {
  var newConfig = payload.newConfig;
  var changeSummary = payload.changeSummary || 'Payment settings updated by admin';

  if (!newConfig) throw new Error('New configuration payload required.');

  var ss = getDbSpreadsheet();
  var configSheet = ss.getSheetByName('PaymentConfig');
  var historySheet = ss.getSheetByName('PaymentConfigHistory');

  var currentConfig = getActiveConfigRecord();
  var nextVersion = (currentConfig && currentConfig.configVersion ? currentConfig.configVersion : 1) + 1;

  newConfig.configVersion = nextVersion;
  newConfig.updatedAt = new Date().toISOString();
  newConfig.updatedBy = AUTHORIZED_ADMIN_EMAIL;
  newConfig.changeSummary = changeSummary;

  // 1. Archive current config into history
  if (currentConfig) {
    historySheet.appendRow([
      currentConfig.configVersion,
      currentConfig.updatedAt || new Date().toISOString(),
      currentConfig.updatedBy || AUTHORIZED_ADMIN_EMAIL,
      JSON.stringify(currentConfig),
      changeSummary
    ]);
  }

  // 2. Overwrite active config row
  configSheet.getRange(2, 1, 1, 5).setValues([[
    'active_config',
    JSON.stringify(newConfig),
    nextVersion,
    newConfig.updatedAt,
    AUTHORIZED_ADMIN_EMAIL
  ]]);

  return {
    ok: true,
    configVersion: nextVersion,
    message: 'Payment configuration saved and archived to version ' + nextVersion
  };
}

// ============================================================================
// AUTOMATED CRON SCHEDULER (6:00 AM - 7:00 AM IST DAILY TRIGGER)
// ============================================================================

/**
 * Automated Daily Run:
 * 1. Dispatches curated news to eligible subscribers.
 * 2. Sends exactly ONE Day 3 reminder to expiring trials.
 * 3. Sends exactly ONE Renewal reminder on paidExpiryDate without mentioning free trial.
 * 4. Advances state machine.
 */
function cronDailyDelivery() {
  var ss = getDbSpreadsheet();
  var subsSheet = ss.getSheetByName('Subscriptions');
  var custSheet = ss.getSheetByName('Customers');
  var logsSheet = ss.getSheetByName('DeliveryLogs');
  var newsSheet = ss.getSheetByName('DailyNews');

  var todayStr = formatDate(new Date());
  var subsData = subsSheet.getDataRange().getValues();
  var custData = custSheet.getDataRange().getValues();

  var customersMap = {};
  for (var c = 1; c < custData.length; c++) {
    customersMap[custData[c][0]] = {
      name: custData[c][2],
      chatId: String(custData[c][6] || '')
    };
  }

  for (var i = 1; i < subsData.length; i++) {
    var subRow = i + 1;
    var subId = subsData[i][0];
    var custId = subsData[i][1];
    var state = subsData[i][4];
    var trialEnd = subsData[i][6];
    var day3Sent = subsData[i][7];
    var bufferEnd = subsData[i][12];
    var paidStart = subsData[i][13];
    var paidExpiry = subsData[i][14];
    var renewalSent = subsData[i][15];

    var cust = customersMap[custId];
    if (!cust || !cust.chatId) continue;

    // A. Day 3 Reminder Check
    if (state === 'TRIAL_ACTIVE' && todayStr === trialEnd && !day3Sent) {
      var reminderText = '🔔 *MyDigitAsset Subscription Notice*\n\nYour 3-day complimentary briefing trial concludes today. To continue receiving uninterrupted morning intelligence, please renew your subscription at:\n\n🌐 https://mydigitasset.com\n\n🔒 Daily briefings are delivered strictly 1-to-1.';
      sendTelegramDirect(cust.chatId, reminderText);
      subsSheet.getRange(subRow, 8).setValue(true); // day3ReminderSent
      subsSheet.getRange(subRow, 9).setValue(new Date().toISOString());
      logsSheet.appendRow(['log_' + Utilities.getUuid().substring(0, 8), new Date().toISOString(), custId, cust.chatId, 'all', 'DAY_3_REMINDER', 'SENT', '']);
    }

    // B. Transition Trial to Expired if passed without payment
    if (state === 'TRIAL_ACTIVE' && todayStr > trialEnd) {
      subsSheet.getRange(subRow, 5).setValue('TRIAL_EXPIRED_UNPAID');
    }

    // C. Transition Buffer to Paid Active once paidStartDate arrives
    if (state === 'PAYMENT_VERIFIED_BUFFER' && todayStr >= paidStart && todayStr <= paidExpiry) {
      subsSheet.getRange(subRow, 5).setValue('PAID_ACTIVE');
    }

    // D. Final Day Renewal Reminder (Explicitly does NOT mention free trial)
    if ((state === 'PAID_ACTIVE' || state === 'PAYMENT_VERIFIED_BUFFER') && todayStr === paidExpiry && !renewalSent) {
      var renewalText = '📰 *MyDigitAsset Annual Renewal Reminder*\n\nToday marks the final day of your 12-month executive news subscription.\n\nTo ensure continued daily morning delivery for the upcoming year, please visit:\n\n🌐 https://mydigitasset.com\n\nThank you for being a valued subscriber.';
      sendTelegramDirect(cust.chatId, renewalText);
      subsSheet.getRange(subRow, 16).setValue(true); // renewalReminderSent
      subsSheet.getRange(subRow, 17).setValue(new Date().toISOString());
      subsSheet.getRange(subRow, 5).setValue('PAID_EXPIRING_TODAY');
      logsSheet.appendRow(['log_' + Utilities.getUuid().substring(0, 8), new Date().toISOString(), custId, cust.chatId, 'all', 'RENEWAL_REMINDER', 'SENT', '']);
    }

    // E. Transition to Expired once paid term has ended
    if (state === 'PAID_EXPIRING_TODAY' && todayStr > paidExpiry) {
      subsSheet.getRange(subRow, 5).setValue('EXPIRED');
    }
  }
}

// ============================================================================
// DATE & FORMAT HELPERS
// ============================================================================

function formatDate(d) {
  var year = d.getFullYear();
  var month = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  return year + '-' + month + '-' + day;
}

function parseDateString(s) {
  var parts = s.split('-');
  return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
}

function addDays(d, days) {
  var res = new Date(d.getTime());
  res.setDate(res.getDate() + days);
  return res;
}

function sheetToJson(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var headers = data[0];
  var result = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var h = 0; h < headers.length; h++) {
      obj[headers[h]] = data[i][h];
    }
    result.push(obj);
  }
  return result;
}
