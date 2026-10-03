# Stage 3 Architecture Blueprint: Operational Automation & Google Sheets Mirror
**MyDigitAsset — Google Apps Script & Sheets Integration Specification**
**Status:** STAGE 3A IMPLEMENTED & VERIFIED (FROZEN ARCHITECTURES PRESERVED; STAGE 3B DEFERRED)

Refer to `/STAGE3_BLUEPRINT.md` for the primary platform specification.

---

## Google Apps Script & Sheet Integration Rules for Stage 3

### 1. Authoritative Role of Google Apps Script in Stage 3
* **Stage 3A Option 2: Time-Driven Trigger Orchestration:** Google Apps Script hosts the 2 authoritative installable time-driven triggers that invoke Cloud Run via HTTPS with `X-Scheduler-Token`:
  1. `scheduledMorningNewsCycle`: ~06:00 AM Asia/Kolkata -> calls Cloud Run `{"action":"generate"}` and upon verified success sequentially calls `{"action":"deliver"}`.
  2. `scheduledNoonRemindersCycle`: ~12:00 PM Asia/Kolkata -> calls Cloud Run `{"action":"reminders"}`.
  3. All news synthesis, private Telegram dispatch, and Day-3 reminder evaluation remain executed authoritatively on Cloud Run with Firestore Native idempotency.
* **Passive Webhook & Mirror Storage:** Apps Script also acts as:
  1. A webhook endpoint for incoming Telegram Bot updates (`doPost(e)`).
  2. The Google Sheets database driver receiving batch updates via the Stage 3C `SYNC_FIRESTORE_BATCH` route.
  3. Public configuration and customer status endpoint.

### 2. Google Sheet Mirror State Reflection
When Firestore Native records operational events, the Stage 3C synchronization engine mirrors them into the Google Sheet:
* **`Subscriptions` Tab:** Reflects `status` transitions (`TRIAL_ACTIVE`, `PAYMENT_PENDING`, `ACTIVE`, `EXPIRED`) with exact buffer dates.
* **`TelegramTokens` Tab:** Reflects generated connection tokens and consumption status (`used: true`, `usedAt: ISO Date`).
* **`SystemScheduler` Tab:** Reflects scheduler timestamps (`lastGenerationDate`, `lastDeliveryDate`, `lastSyncStartedAt`).

### 3. Machine-to-Machine Cryptographic Security
* All sync operations from Cloud Run continue to be authenticated via the approved Stage 3C **HMAC-SHA256 request signing** over canonical payload content (`SHEET_SYNC_SECRET`).
* Apps Script enforces constant-time signature comparison (`safeCompareStrings`) and nonce replay protection.

### 4. Zero Destruction Guarantee
* Zero calls to `clear()`, `clearContents()`, `deleteRows()`, or `deleteColumns()`.
* Historical spreadsheet rows and columns are preserved in perpetuity.
