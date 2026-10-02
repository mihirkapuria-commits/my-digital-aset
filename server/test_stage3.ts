import crypto from 'crypto';
import {
  initDb,
  getDb,
  saveDb,
} from './db.js';
import {
  evaluateAndSendDay3TrialReminders,
  evaluateAndRunDailySchedule,
  isCustomerAtDay3OrLater,
} from './schedulerService.js';
import {
  confirmPaymentByAdmin,
} from './paymentService.js';
import { Customer } from '../src/types.js';

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`✅ PASS - ${testName}`);
    if (detail) console.log(`   └─ ${detail}`);
    passedTests++;
  } else {
    console.error(`❌ FAIL - ${testName}`);
    if (detail) console.error(`   └─ FAILED: ${detail}`);
    failedTests++;
  }
}

async function runStage3TestSuite() {
  console.log('================================================================');
  console.log('STAGE 3 AUTOMATED OPERATIONAL TESTS: AUTOMATIC DAY-3 REMINDER');
  console.log('================================================================\n');

  // Initialize fresh in-memory test database
  initDb();
  const db = getDb();
  db.customers = db.customers.filter(
    (c) =>
      !c.email.includes('day3') &&
      !c.email.includes('alice.day3') &&
      !c.email.includes('dave.transient') &&
      !c.email.includes('grace.cycle') &&
      !c.email.includes('eve.paid') &&
      !c.email.includes('frank.notg')
  );

  // Helper to create test customer in current live database
  const createTestCustomer = (params: {
    fullName: string;
    email: string;
    trialStartDate: string;
    trialEndDate: string;
    telegramConnected: boolean;
    telegramChatId?: string | null;
  }): Customer => {
    const custId = `cust_${crypto.randomBytes(8).toString('hex')}`;
    const cust: Customer = {
      customerId: custId,
      fullName: params.fullName,
      email: params.email,
      mobileCountryCode: '+91',
      mobileNumber: '9876543210',
      telegramChatId: params.telegramChatId !== undefined ? params.telegramChatId : (params.telegramConnected ? `tg_${custId}` : null),
      telegramConnected: params.telegramConnected,
      accountStatus: 'active',
      trialStartDate: params.trialStartDate,
      trialEndDate: params.trialEndDate,
      trialStatus: 'active',
      selectedCategoryIds: ['cat_india_startups'],
      createdAt: params.trialStartDate,
      updatedAt: params.trialStartDate,
    };
    getDb().customers.push(cust);
    saveDb();
    return cust;
  };

  // Base reference date for tests: 2026-10-03T06:15:00.000Z
  const referenceDate = new Date('2026-10-03T06:15:00.000Z');

  // ============================================================================
  // Test A: Automatic Day-3 reminder
  // Customer trial reaches Day 3. Scheduler runs. DAY3_REMINDER_SENT is recorded.
  // Telegram reminder sent. Zero admin API calls.
  // ============================================================================
  console.log('--- TEST A: Automatic Day-3 reminder ---');
  // Registered on 2026-10-01 (Day 1). On 2026-10-03 it is Day 3.
  const customerA = createTestCustomer({
    fullName: 'Alice Day3 Automatic',
    email: 'alice.day3@example.com',
    trialStartDate: '2026-10-01T08:00:00.000Z',
    trialEndDate: '2026-10-04T08:00:00.000Z',
    telegramConnected: true,
    telegramChatId: 'tg_alice_999',
  });

  const isAtDay3 = isCustomerAtDay3OrLater(customerA, referenceDate);
  assert(isAtDay3 === true, 'Test A.1: isCustomerAtDay3OrLater correctly identifies Day 3', `Identified Day 3: ${isAtDay3}`);

  // Run the scheduler automatic evaluation
  const evalResultA = await evaluateAndSendDay3TrialReminders(referenceDate);
  assert(evalResultA.totalSent === 1, 'Test A.2: Automatic scheduler sent exactly 1 Day-3 reminder', `Total sent: ${evalResultA.totalSent}`);

  const auditEventsA = getDb().telegramConnectionAudits.filter(
    (a) => a.customerId === customerA.customerId && (a.eventType as string) === 'DAY3_REMINDER_SENT'
  );
  assert(
    auditEventsA.length === 1 && auditEventsA[0].result === 'SUCCESS',
    'Test A.3: DAY3_REMINDER_SENT recorded persistently with SUCCESS',
    `Audit event result: ${auditEventsA[0]?.result}, details: ${auditEventsA[0]?.details}`
  );

  // ============================================================================
  // Test B: Duplicate scheduler ticks
  // Run scheduler repeatedly for the same Day-3 customer.
  // Expected: Exactly one successful Day-3 reminder.
  // ============================================================================
  console.log('\n--- TEST B: Duplicate scheduler ticks ---');
  const tick2 = await evaluateAndSendDay3TrialReminders(referenceDate);
  const tick3 = await evaluateAndSendDay3TrialReminders(referenceDate);
  const tick4 = await evaluateAndSendDay3TrialReminders(new Date('2026-10-03T07:00:00.000Z'));

  assert(
    tick2.totalSent === 0 && tick3.totalSent === 0 && tick4.totalSent === 0,
    'Test B.1: Subsequent scheduler ticks send 0 additional reminders',
    `Tick2: ${tick2.totalSent}, Tick3: ${tick3.totalSent}, Tick4: ${tick4.totalSent}`
  );

  const totalAuditsB = getDb().telegramConnectionAudits.filter(
    (a) => a.customerId === customerA.customerId && (a.eventType as string) === 'DAY3_REMINDER_SENT'
  );
  assert(
    totalAuditsB.length === 1,
    'Test B.2: Idempotency guarantee: exactly 1 DAY3_REMINDER_SENT in persistent audits',
    `Count: ${totalAuditsB.length}`
  );

  // ============================================================================
  // Test C: Application restart
  // Run Day-3 processing, restart application, and run scheduler again.
  // Expected: No duplicate reminder.
  // ============================================================================
  console.log('\n--- TEST C: Application restart ---');
  // Snapshot current database state
  const currentDbState = JSON.parse(JSON.stringify(getDb()));
  
  // Re-init (simulating server reboot) and restore persistent storage
  initDb();
  Object.assign(getDb(), currentDbState);
  saveDb();

  // Run scheduler after restart
  const postRestartEval = await evaluateAndSendDay3TrialReminders(new Date('2026-10-03T10:30:00.000Z'));
  assert(
    postRestartEval.totalSent === 0,
    'Test C.1: Scheduler execution post-restart detects existing reminder and sends 0',
    `Sent after restart: ${postRestartEval.totalSent}`
  );

  const postRestartAudits = getDb().telegramConnectionAudits.filter(
    (a) => a.customerId === customerA.customerId && (a.eventType as string) === 'DAY3_REMINDER_SENT'
  );
  assert(
    postRestartAudits.length === 1,
    'Test C.2: Zero duplicate reminders post-restart',
    `Total audits post-restart: ${postRestartAudits.length}`
  );

  // ============================================================================
  // Test D: Telegram failure
  // Force Telegram failure on first attempt. Reminder not falsely marked sent.
  // Later scheduler execution retries successfully.
  // ============================================================================
  console.log('\n--- TEST D: Telegram failure and recovery ---');
  const customerD = createTestCustomer({
    fullName: 'Dave Transient Failure',
    email: 'dave.transient@example.com',
    trialStartDate: '2026-10-01T08:00:00.000Z',
    trialEndDate: '2026-10-04T08:00:00.000Z',
    telegramConnected: true,
    telegramChatId: 'tg_dave_transient',
  });

  // Attempt 1: Simulate network drop on all retries (simulateTelegramFailureUntilAttempt: 5 > maxRetries: 3)
  const failureEval = await evaluateAndSendDay3TrialReminders(referenceDate, {
    maxRetries: 3,
    simulateTelegramFailureUntilAttempt: 5,
  });

  assert(failureEval.totalFailed === 1, 'Test D.1: Failed dispatch cleanly counted as failed', `Failed count: ${failureEval.totalFailed}`);
  assert(failureEval.totalSent === 0, 'Test D.2: Failed dispatch was not counted as sent', `Sent count: ${failureEval.totalSent}`);

  const successfulAuditsD1 = getDb().telegramConnectionAudits.filter(
    (a) => a.customerId === customerD.customerId && (a.eventType as string) === 'DAY3_REMINDER_SENT' && a.result === 'SUCCESS'
  );
  assert(
    successfulAuditsD1.length === 0,
    'Test D.3: DAY3_REMINDER_SENT with SUCCESS is NOT recorded on failure',
    `Success audit count: ${successfulAuditsD1.length}`
  );

  const failedAuditsD = getDb().telegramConnectionAudits.filter(
    (a) => a.customerId === customerD.customerId && (a.eventType as string) === 'DAY3_REMINDER_FAILED'
  );
  assert(
    failedAuditsD.length >= 1,
    'Test D.4: DAY3_REMINDER_FAILED audit is recorded for operational visibility',
    `Failure audit count: ${failedAuditsD.length}`
  );

  // Attempt 2: Later scheduler execution occurs when network is restored
  const recoveryEval = await evaluateAndSendDay3TrialReminders(new Date('2026-10-03T07:15:00.000Z'));
  assert(
    recoveryEval.totalSent === 1,
    'Test D.5: Later scheduler run automatically retries and succeeds',
    `Recovery sent count: ${recoveryEval.totalSent}`
  );

  const successfulAuditsD2 = getDb().telegramConnectionAudits.filter(
    (a) => a.customerId === customerD.customerId && (a.eventType as string) === 'DAY3_REMINDER_SENT' && a.result === 'SUCCESS'
  );
  assert(
    successfulAuditsD2.length === 1,
    'Test D.6: Post-recovery audit contains exactly 1 successful reminder',
    `Successful audits after recovery: ${successfulAuditsD2.length}`
  );

  // Attempt 3: Another tick after recovery
  const subsequentTickD = await evaluateAndSendDay3TrialReminders(new Date('2026-10-03T08:00:00.000Z'));
  assert(
    subsequentTickD.totalSent === 0,
    'Test D.7: Subsequent scheduler tick does not duplicate recovered reminder',
    `Subsequent sent count: ${subsequentTickD.totalSent}`
  );

  // ============================================================================
  // Test E: Paid customer
  // Customer has already received confirmed paid entitlement.
  // Expected: No Day-3 trial reminder.
  // ============================================================================
  console.log('\n--- TEST E: Paid customer receives no trial reminder ---');
  const customerE = createTestCustomer({
    fullName: 'Eve Converted Paid',
    email: 'eve.paid@example.com',
    trialStartDate: '2026-10-01T08:00:00.000Z',
    trialEndDate: '2026-10-04T08:00:00.000Z',
    telegramConnected: true,
    telegramChatId: 'tg_eve_paid',
  });

  // Admin confirms payment for customerE (Activating paid subscription)
  const confirmRes = confirmPaymentByAdmin({
    customerId: customerE.customerId,
    adminEmail: 'mihirkapuria@gmail.com',
    reference: 'UPI-PAID-EVE-001',
    amount: 297.36,
  });

  assert(confirmRes.success === true, 'Test E.1: Customer E payment confirmed and subscription activated', `SubId: ${confirmRes.subscription?.subscriptionId}`);

  // Run scheduler
  const evalE = await evaluateAndSendDay3TrialReminders(referenceDate);
  const eveDetails = evalE.results.find((r) => r.customerId === customerE.customerId);

  assert(
    eveDetails?.status === 'skipped',
    'Test E.2: Paid customer is safely skipped from trial reminders',
    `Eve status: ${eveDetails?.status}, reason: ${eveDetails?.reason}`
  );

  const auditsE = getDb().telegramConnectionAudits.filter(
    (a) => a.customerId === customerE.customerId && (a.eventType as string) === 'DAY3_REMINDER_SENT'
  );
  assert(auditsE.length === 0, 'Test E.3: Zero Day-3 reminder audits created for paid customer', `Audits count: ${auditsE.length}`);

  // ============================================================================
  // Test F: No Telegram connection
  // Customer reaches Day 3 but has not connected Telegram.
  // Expected: No Telegram message attempted, handled safely without admin involvement.
  // ============================================================================
  console.log('\n--- TEST F: Customer without Telegram connection ---');
  const customerF = createTestCustomer({
    fullName: 'Frank Unconnected',
    email: 'frank.unconnected@example.com',
    trialStartDate: '2026-10-01T08:00:00.000Z',
    trialEndDate: '2026-10-04T08:00:00.000Z',
    telegramConnected: false,
    telegramChatId: null,
  });

  const evalF = await evaluateAndSendDay3TrialReminders(referenceDate);
  const frankDetails = evalF.results.find((r) => r.customerId === customerF.customerId);

  assert(
    frankDetails?.status === 'skipped',
    'Test F.1: Customer without Telegram is safely skipped without crash or message attempt',
    `Frank status: ${frankDetails?.status}, reason: ${frankDetails?.reason}`
  );

  const auditsF = getDb().telegramConnectionAudits.filter(
    (a) => a.customerId === customerF.customerId && (a.eventType as string) === 'DAY3_REMINDER_SENT'
  );
  assert(auditsF.length === 0, 'Test F.2: Zero messages attempted or recorded for unconnected customer', `Audits count: ${auditsF.length}`);

  // ============================================================================
  // Test G: Full Scheduler Master Cycle Integration
  // Calling evaluateAndRunDailySchedule directly executes Day-3 checks automatically
  // ============================================================================
  console.log('\n--- TEST G: Full Scheduler Master Cycle Integration ---');
  const customerG = createTestCustomer({
    fullName: 'Grace Master Cycle',
    email: 'grace.cycle@example.com',
    trialStartDate: '2026-10-01T08:00:00.000Z',
    trialEndDate: '2026-10-04T08:00:00.000Z',
    telegramConnected: true,
    telegramChatId: 'tg_grace_cycle',
  });

  // Execute master scheduler function
  const masterSchedResult = await evaluateAndRunDailySchedule(referenceDate);

  assert(
    masterSchedResult.reminderResults?.totalSent >= 1,
    'Test G.1: Master evaluateAndRunDailySchedule automatically evaluates and sends Day-3 reminders',
    `Action taken: ${masterSchedResult.actionTaken}, details: ${masterSchedResult.details}`
  );

  const graceAudits = getDb().telegramConnectionAudits.filter(
    (a) => a.customerId === customerG.customerId && (a.eventType as string) === 'DAY3_REMINDER_SENT'
  );
  assert(
    graceAudits.length === 1 && graceAudits[0].result === 'SUCCESS',
    'Test G.2: Grace reminder sent automatically during scheduled tick with zero admin action',
    `Audit ID: ${graceAudits[0]?.eventId}`
  );

  console.log('\n================================================================');
  console.log(`STAGE 3 TEST SUITE SUMMARY: ${passedTests} of ${passedTests + failedTests} TESTS PASSED`);
  console.log('================================================================');

  if (failedTests > 0) {
    console.error(`\n❌ ${failedTests} TESTS FAILED!`);
    process.exit(1);
  } else {
    console.log('\n🎉 ALL STAGE 3 AUTOMATED TESTS PASSED WITH ZERO FAILURES!');
    process.exit(0);
  }
}

runStage3TestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
