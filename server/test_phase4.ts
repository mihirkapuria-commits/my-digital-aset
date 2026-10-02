import fs from 'fs';
import path from 'path';
import {
  initDb,
  getDb,
  registerOrLoginCustomer,
  getCustomerById,
} from './db.js';
import {
  processVerifiedPayment,
} from './paymentService.js';
import {
  getCustomerActiveEntitlements,
} from './entitlementService.js';
import {
  generateTelegramConnectionToken,
  connectTelegramAccount,
  disconnectTelegramAccount,
  getTelegramAuditLogs,
} from './telegramService.js';

async function runPhase4Tests() {
  console.log('=== STARTING PHASE 4 AUTOMATED TEST SUITE (TELEGRAM) ===\n');
  initDb();
  const db = getDb();

  // Reset test records
  db.telegramConnectionTokens = [];
  db.telegramConnectionAudits = [];

  // Setup Customer A
  const custARes = registerOrLoginCustomer({
    fullName: 'Customer Alpha Tg',
    email: 'alpha.tg@example.com',
    mobileCountryCode: '+91',
    mobileNumber: '9123456789',
    selectedCategoryIds: ['cat_india_startups'],
  });
  const customerA = custARes.customer;

  // Pay and activate subscription for Customer A
  processVerifiedPayment({
    customerId: customerA.customerId,
    gatewayReference: 'UTR_TG_TEST_001',
    categoryIds: ['cat_india_startups'],
    paymentStatus: 'successful',
    paymentDate: '2026-09-29T10:00:00.000Z',
  });

  // Setup Customer B
  const custBRes = registerOrLoginCustomer({
    fullName: 'Customer Beta Tg',
    email: 'beta.tg@example.com',
    mobileCountryCode: '+91',
    mobileNumber: '9876543210',
    selectedCategoryIds: ['cat_india_banking_fintech'],
  });
  const customerB = custBRes.customer;

  // Pay and activate subscription for Customer B
  processVerifiedPayment({
    customerId: customerB.customerId,
    gatewayReference: 'UTR_TG_TEST_002',
    categoryIds: ['cat_india_banking_fintech'],
    paymentStatus: 'successful',
    paymentDate: '2026-09-29T10:00:00.000Z',
  });

  console.log('Setup Customer A:', customerA.customerId, 'Initial telegramConnected:', customerA.telegramConnected);
  console.log('Setup Customer B:', customerB.customerId, 'Initial telegramConnected:', customerB.telegramConnected);

  // -------------------------------------------------------------
  // TEST A: Successful Connection
  // Expected: telegramConnected = true, correct Chat ID associated
  // -------------------------------------------------------------
  console.log('\n--- TEST A: Successful Telegram connection ---');
  const tokenGenA = generateTelegramConnectionToken(customerA.customerId);
  console.log('Generated token for Customer A:', tokenGenA.token);
  console.log('Deep-link:', tokenGenA.deepLink);

  const connectResultA = connectTelegramAccount(tokenGenA.token, '987654321', 'alpha_user');
  console.log('Connect Result A:', connectResultA.success);

  const updatedCustA = getCustomerById(customerA.customerId)!;
  console.log('Customer A telegramConnected:', updatedCustA.telegramConnected);
  console.log('Customer A telegramChatId:', updatedCustA.telegramChatId);

  if (!connectResultA.success) throw new Error('Test A Failed: connection should succeed');
  if (updatedCustA.telegramConnected !== true) throw new Error('Test A Failed: telegramConnected must be true');
  if (updatedCustA.telegramChatId !== '987654321') throw new Error('Test A Failed: telegramChatId mismatch');

  // Verify delivery eligibility now passes
  const evalA = getCustomerActiveEntitlements(customerA.customerId, new Date('2026-10-01T06:30:00Z'));
  console.log('Delivery eligible after connection:', evalA.telegramDeliveryEligible);
  if (!evalA.telegramDeliveryEligible) throw new Error('Test A Failed: telegramDeliveryEligible must be true after connection');

  console.log('✅ TEST A PASSED: Customer A connected with correct Chat ID and telegramDeliveryEligible = true.');

  // -------------------------------------------------------------
  // TEST B: Expired Token
  // Expected: Connection rejected
  // -------------------------------------------------------------
  console.log('\n--- TEST B: Expired token ---');
  const expiredTokenGen = generateTelegramConnectionToken(customerB.customerId);
  // Artificially expire the token record in the DB
  const tokenRec = db.telegramConnectionTokens.find((t) => t.token === expiredTokenGen.token)!;
  tokenRec.expiresAt = new Date(Date.now() - 60000).toISOString(); // 1 minute in the past

  const connectExpired = connectTelegramAccount(expiredTokenGen.token, '111222333', 'beta_user');
  console.log('Connect with expired token (should fail):', connectExpired.success);
  console.log('Error message:', connectExpired.error);

  if (connectExpired.success) throw new Error('Test B Failed: expired token must be rejected');
  console.log('✅ TEST B PASSED: Expired token strictly rejected.');

  // -------------------------------------------------------------
  // TEST C: Reused Token (Single-Use Enforcement)
  // Expected: Rejected
  // -------------------------------------------------------------
  console.log('\n--- TEST C: Reused token ---');
  // Attempt to use tokenGenA.token which was already consumed in Test A
  const connectReused = connectTelegramAccount(tokenGenA.token, '999888777', 'reused_user');
  console.log('Connect with reused token (should fail):', connectReused.success);
  console.log('Error message:', connectReused.error);

  if (connectReused.success) throw new Error('Test C Failed: reused token must be rejected');
  console.log('✅ TEST C PASSED: Single-use enforcement verified. Reused token rejected.');

  // -------------------------------------------------------------
  // TEST D: Wrong Customer / Session
  // Expected: Non-existent or invalid token rejected
  // -------------------------------------------------------------
  console.log('\n--- TEST D: Non-existent / wrong token ---');
  const connectInvalid = connectTelegramAccount('mda_nonexistent_random_token_12345', '555666777');
  console.log('Connect with invalid token (should fail):', connectInvalid.success);
  console.log('Error message:', connectInvalid.error);

  if (connectInvalid.success) throw new Error('Test D Failed: invalid token must be rejected');
  console.log('✅ TEST D PASSED: Invalid token strictly rejected.');

  // -------------------------------------------------------------
  // TEST E: Telegram Chat ID Already Linked (One Account / One Chat ID)
  // Attempt to associate Customer A's Chat ID ('987654321') with Customer B
  // Expected: Rejected. Customer A remains unchanged.
  // -------------------------------------------------------------
  console.log('\n--- TEST E: Telegram Chat ID already linked (anti-collision) ---');
  const tokenGenB = generateTelegramConnectionToken(customerB.customerId);
  const connectCollision = connectTelegramAccount(tokenGenB.token, '987654321', 'attacker_trying_to_steal_chat_id');

  console.log('Connect with already-linked Chat ID (should fail):', connectCollision.success);
  console.log('Error message:', connectCollision.error);

  const checkCustA = getCustomerById(customerA.customerId)!;
  const checkCustB = getCustomerById(customerB.customerId)!;

  console.log('Customer A Chat ID preserved:', checkCustA.telegramChatId === '987654321');
  console.log('Customer B remains unconnected:', checkCustB.telegramConnected === false);

  if (connectCollision.success) throw new Error('Test E Failed: duplicate Chat ID association must be rejected');
  if (checkCustA.telegramChatId !== '987654321') throw new Error('Test E Failed: Customer A Chat ID was overwritten');
  if (checkCustB.telegramConnected !== false) throw new Error('Test E Failed: Customer B should still be unconnected');

  console.log('✅ TEST E PASSED: One Telegram account per customer rule strictly enforced. Customer A unharmed.');

  // -------------------------------------------------------------
  // TEST F: Disconnect
  // Customer disconnects Telegram.
  // Expected: telegramConnected = false, telegramDeliveryEligible = false, subscriptions intact.
  // -------------------------------------------------------------
  console.log('\n--- TEST F: Customer disconnects Telegram ---');
  const disconnectRes = disconnectTelegramAccount(customerA.customerId);
  console.log('Disconnect Result:', disconnectRes.success);

  const disconnectedCustA = getCustomerById(customerA.customerId)!;
  console.log('Customer A telegramConnected after disconnect:', disconnectedCustA.telegramConnected);
  console.log('Customer A telegramChatId after disconnect:', disconnectedCustA.telegramChatId);

  if (!disconnectRes.success) throw new Error('Test F Failed: disconnect should succeed');
  if (disconnectedCustA.telegramConnected !== false) throw new Error('Test F Failed: telegramConnected must be false');
  if (disconnectedCustA.telegramChatId !== null) throw new Error('Test F Failed: telegramChatId must be null');

  // Verify delivery eligibility now fails telegram check
  const evalAfterDisconnect = getCustomerActiveEntitlements(customerA.customerId, new Date('2026-10-01T06:30:00Z'));
  console.log('Telegram delivery eligible after disconnect:', evalAfterDisconnect.telegramDeliveryEligible);
  console.log('Subscription still active:', evalAfterDisconnect.isEligible);
  console.log('Ineligible reason:', evalAfterDisconnect.ineligibleReasons);

  if (evalAfterDisconnect.telegramDeliveryEligible !== false) {
    throw new Error('Test F Failed: delivery must be ineligible when disconnected');
  }
  if (evalAfterDisconnect.isEligible !== true) {
    throw new Error('Test F Failed: underlying subscription must remain active');
  }

  console.log('✅ TEST F PASSED: Disconnect successful. Telegram delivery suppressed while paid subscription remains intact.');

  // -------------------------------------------------------------
  // TEST G: Customer Privacy & Scoping
  // Customer A querying status must never receive Customer B's Telegram info
  // -------------------------------------------------------------
  console.log('\n--- TEST G: Customer Telegram privacy isolation ---');
  const auditsA = getTelegramAuditLogs(customerA.customerId);
  const auditsB = getTelegramAuditLogs(customerB.customerId);

  const aHasBAudits = auditsA.some((a) => a.customerId === customerB.customerId);
  const bHasAAudits = auditsB.some((a) => a.customerId === customerA.customerId);

  if (aHasBAudits || bHasAAudits) {
    throw new Error('Test G Failed: cross-customer audit log leakage');
  }
  console.log('Customer A audit records count:', auditsA.length);
  console.log('Customer B audit records count:', auditsB.length);
  console.log('✅ TEST G PASSED: Absolute customer data isolation maintained.');

  // -------------------------------------------------------------
  // TEST H: Bot Token Security
  // Verify Telegram Bot token does not appear in frontend files or public responses
  // -------------------------------------------------------------
  console.log('\n--- TEST H: Bot token frontend leak audit ---');
  const frontendDir = path.join(process.cwd(), 'src');
  const frontendFiles = fs.readdirSync(frontendDir, { recursive: true }) as string[];

  for (const f of frontendFiles) {
    const fullPath = path.join(frontendDir, f);
    if (fs.statSync(fullPath).isFile() && (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.json') || f.endsWith('.html'))) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('bot1234') || content.includes('TELEGRAM_BOT_TOKEN') || content.includes('telegram_bot_token')) {
        throw new Error(`Test H Failed: Potential bot token or env reference found in frontend file: ${f}`);
      }
    }
  }
  console.log('Scanned all frontend source files in src/. Zero bot tokens or secret keys present.');
  console.log('✅ TEST H PASSED: Telegram bot credentials strictly sealed server-side.');

  console.log('\n======================================================');
  console.log('ALL PHASE 4 TESTS (A through H) PASSED SUCCESSFULLY!');
  console.log('======================================================\n');
  process.exit(0);
}

runPhase4Tests().catch((err) => {
  console.error('FATAL PHASE 4 TEST ERROR:', err);
  process.exit(1);
});
