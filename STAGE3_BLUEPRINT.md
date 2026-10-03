# Stage 3 Architecture Blueprint: Operational Automation (Stage 3A MVP vs Stage 3B Future Scale)
**MyDigitAsset (`mydigitasset.com`) Platform Specification**
**Status:** STAGE 3A IMPLEMENTED & VERIFIED (FROZEN ARCHITECTURES PRESERVED; STAGE 3B DEFERRED)

---

## 1. Executive Summary & Architecture Division

Stage 3 operationalizes the business lifecycle of MyDigitAsset without manual daily labor. To balance MVP delivery speed with production safety, Stage 3 is divided into:

1. **Stage 3A (MVP Operational Automation — Current Focus):**
   * Automatic Day-3 complimentary trial reminder via Telegram only.
   * Automated morning daily news generation (06:00 AM IST) and private Telegram delivery (06:15 AM IST) for entitled subscribers.
   * Persistent deterministic idempotency keys (`newsDate_customerId_categoryId_operation`) preventing duplicate deliveries.
   * Authenticated Google Cloud Scheduler invocation via OIDC service account token verification.
   * Source article retrieval, URL verification, and grounded provenance tracking (measurable criteria).
   * Safe failure logging and bounded retry handling.
2. **Stage 3B (Future Scale & Hardening — Deferred):**
   * Sophisticated distributed lease locking across large-scale multi-region clusters.
   * Multi-instance concurrency auto-rebalancing.
   * Advanced multi-tier retry orchestration with dead-letter queue sinks.
   * Automated self-healing disaster recovery workflows.

---

## 2. Frozen Boundaries & Unchanged Systems

1. **Payment Model is 100% Frozen:**
   * Payment method: Manual UPI / QR code payment.
   * Customer action: Submits UTR reference / payment proof.
   * Admin action: Google OAuth authenticated admin manually reviews proof and clicks confirm.
   * Subscription math: Exactly 5 courtesy buffer days (`Oct 3–7`) + 12-month paid term (`Oct 8–Oct 8 next year`).
   * **Prohibition:** Zero automated Razorpay payment activation, zero payment webhooks, zero automated verification.
2. **Authoritative Persistence:**
   * Google Cloud Firestore Native Mode remains the authoritative persistence layer with local filesystem JSON sync backup.
3. **Google Sheets Mirror:**
   * One-way mirror sync via HMAC-SHA256 request signing over canonical payload content remains unchanged.

---

## 3. Measurable News Validation Requirements

The system **does not** claim an LLM can mathematically guarantee "0 hallucinations". Instead, it enforces strict, measurable algorithmic constraints across four discrete pipeline stages:

```
[ Step 1: Source Retrieval ] 
       │  Collects articles from configured publication RSS/APIs (The Economic Times, Mint, etc.)
       ▼
[ Step 2: Source Validation ]
       │  Validates: (a) HTTP 200 reachable, (b) Published <= 48h, (c) Domain matches whitelist
       ▼
[ Step 3: Summarization & Assembly ]
       │  LLM synthesizes executive briefing. EVERY output story MUST cite an actual candidate URL.
       │  Synthesized stories citing non-existent or unverified URLs are strictly rejected.
       ▼
[ Step 4: Entitled Delivery ]
          Dispatches only if package status === 'success' and stories count >= 10.
```

### Measurable Criteria:
1. **Actual Retrieved Source URL:** Every delivered story must be associated with an actual retrieved source article URL collected during Step 1.
2. **Association Check:** If a summarized story references a URL outside the verified candidate pool, that story is invalidated and discarded.
3. **Failed Source Retrieval Guard:** If source retrieval yields $< 10$ fresh verified candidate articles for a category, package generation fails safely; no stories are invented or delivered.
4. **Duplicate Story Filtering:** URL canonicalization strips tracking query parameters (`utm_*`) and suppresses duplicate stories across publication feeds.
5. **Full Pipeline Audit Logging:** Generation, validation failures, and delivery outcomes are recorded in `dailyNewsPackages` and `telegramDeliveryLogs`.

---

## 4. Cloud Scheduler Security & OIDC Service Account Authentication

The Cloud Scheduler endpoint (`POST /api/admin/scheduler/trigger`) **must not be publicly executable** via obscure URLs or static URL query parameters.

### 4.1 OIDC Service Account Authentication
1. **Dedicated Service Account:** A dedicated Google Cloud service account is provisioned:
   `mydigitasset-scheduler@<PROJECT_ID>.iam.gserviceaccount.com`
2. **Minimum IAM Permissions:**
   * Role: `roles/run.invoker` on the Cloud Run service `mydigitasset`.
   * The service account possesses zero database read/write permissions and zero admin portal roles.
3. **OIDC Token Generation:**
   * When Cloud Scheduler invokes `POST /api/admin/scheduler/trigger`, it generates a cryptographically signed Google OpenID Connect (OIDC) ID token with target audience:
     `https://<CLOUD_RUN_SERVICE_URL>`
4. **Server-Side Token Verification:**
   * The backend validates the incoming `Authorization: Bearer <OIDC_TOKEN>`:
     * Signature verified against Google's public OAuth certificates (`https://www.googleapis.com/oauth2/v3/certs`).
     * `aud` must match the configured Cloud Run URL.
     * `email` must match `mydigitasset-scheduler@<PROJECT_ID>.iam.gserviceaccount.com`.
     * `exp` must be unexpired.
5. **Rejection:** Any request without a valid OIDC bearer token (or valid admin session cookie) is immediately rejected with `401 Unauthorized` or `403 Forbidden`.

---

## 5. Scheduling Timetable & Edge Case Handling (Asia/Kolkata)

### 5.1 Timetable
All operations are anchored to **`Asia/Kolkata`** (IST):
* **06:00 AM IST:** Daily News Generation (`generateDailyAllCategoriesNews`).
* **06:15 AM IST:** Daily Private Telegram Delivery (`deliverDailyBriefingsToAllEligibleCustomers`).
* **12:00 PM IST (and on morning tick):** Automated Day-3 Trial Payment Reminders (`evaluateAndSendDay3TrialReminders`).

### 5.2 Edge Case Definitions
* **Cloud Scheduler Fires Late:** The scheduler evaluates whether generation/delivery has already succeeded for today's date (`kolkataDate`). If it fires at 06:40 AM IST, it detects `lastGenerationDate !== kolkataDate`, generates the news, and dispatches deliveries immediately.
* **Job is Retried by Cloud Scheduler:** If Cloud Scheduler retries an HTTP invocation, deterministic idempotency checks detect that `newsDate === kolkataDate` and the package or delivery log already exists, returning `200 OK (already_completed)` with zero duplicate messages sent.
* **Cloud Run Starts Multiple Instances:** The scheduler checks the persistent state in Firestore (`system/schedulerDates`). Additionally, the basic concurrency guard ensures that if an instance starts processing today's news date, subsequent calls exit safely.
* **Previous Execution Still Running:** An in-process `isRunning` flag aborts overlapping execution ticks with `skipped: already_running`.
* **News Generation Fails:** Marked as `failed` in `dailyNewsPackages`. Delivery for that category is automatically aborted (never delivers incomplete packages).
* **Telegram Delivery Fails:** Transient network drops or 429 rate limits are retried with exponential backoff. If exhausted, logged as `FAILED` in `telegramDeliveryLogs` without blocking other customers.

---

## 6. Deterministic Idempotency Keys

Every automated communication and state transition derives a deterministic primary key:

1. **Daily Briefing Delivery Idempotency Key:**
   $$\text{deliveryId} = \text{"del\_"} + \text{newsDate} + \text{"\_"} + \text{customerId} + \text{"\_"} + \text{categoryId}$$
   *Example:* `del_2026-10-03_cust_a1b2c3d4_cat_india_startups`
   *Rule:* If `deliveryId` already exists in `telegramDeliveryLogs` with `status === 'sent'`, the delivery is skipped.
2. **Day-3 Reminder Idempotency Key:**
   $$\text{auditId} = \text{"tga\_day3\_"} + \text{customerId}$$
   *Rule:* If an audit record with `eventType === 'DAY3_REMINDER_SENT'` and `result === 'SUCCESS'` exists for that `customerId`, the reminder is permanently skipped.
3. **Daily News Package Idempotency Key:**
   $$\text{packageId} = \text{"pkg\_"} + \text{newsDate} + \text{"\_"} + \text{categoryId}$$
   *Rule:* If `packageId` exists with `generationStatus === 'success'`, package generation is skipped.

---

## 7. Acceptance Test Plan

### Stage 3A Test Suite (`server/test_stage3.ts`):
1. **Day-3 Reminder Eligibility:** Customer at Day 3 ($\ge 2.0$ days or $\ge 2$ calendar days) is identified as eligible.
2. **Day-3 Reminder Sent Once:** Exactly 1 reminder sent via Telegram.
3. **Day-3 Reminder Not Repeated:** Subsequent scheduler ticks send 0 additional messages.
4. **Paid Customers Excluded:** Paid/converted subscribers are skipped from trial reminders.
5. **Expired Trials Excluded:** Already expired trials receive 0 reminders.
6. **Daily Delivery Eligibility:** Evaluates active entitlements accurately for current date.
7. **Category Isolation:** Customer entitled to Category A never receives Category B.
8. **Duplicate Scheduler Invocation:** Invoking scheduler twice for the same date triggers 0 duplicate dispatches.
9. **Scheduler Authentication:** OIDC token validation accepts authorized service account and rejects unauthenticated callers.
10. **Failed News Generation:** Generation failure cleanly aborts delivery for that category.
11. **Failed Telegram Delivery:** Transient failure logged properly; retry succeeds.
12. **Restart / Repeated Execution:** Server restart preserves state and causes zero duplicates.
13. **Secret Protection:** Application logs and API responses verified 100% free of secrets.
14. **Complete Regression:** All 207 existing tests (Stage 1, Stage 2, Stage 3B, Stage 3C) pass with zero errors.

### Future Scale / Hardening (Stage 3B - Deferred):
* Multi-region distributed lock contention and lease expiry stress tests.
* Dead-letter queue reconciliation.
* High-volume concurrent webhook throughput.
