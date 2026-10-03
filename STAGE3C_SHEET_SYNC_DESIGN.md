# MyDigitAsset — Stage 3C Google Sheets Synchronization Specification

This document details the authoritative architecture, machine-to-machine authentication, and operational specifications for synchronizing Cloud Firestore Native data to the existing Google Sheet.

---

## 1. Authoritative Architecture & Tenets

* **Firestore is Authoritative:** Cloud Firestore Native Mode is the single authoritative production database.
* **Google Sheet is a One-Way Mirror:** Google Sheet serves exclusively as a persistent, human-readable audit mirror for business reporting and visibility. Google Sheets NEVER writes back into Firestore.
* **Spreadsheet ID:** `1VxEwbU0TupxdqNIhslFDL-hcZLpY0QBPcqVt-h8O43A` (The existing production spreadsheet).
* **Zero Destruction Rule:** The synchronization engine NEVER calls `clear()`, `clearContents()`, `deleteRows()`, or `deleteColumns()`. Existing historical rows are preserved in perpetuity.
* **Complete Business Decoupling:** Core business operations (`paymentService.ts`, `newsService.ts`, `telegramService.ts`, customer registration, entitlement management) are 100% decoupled from Google Sheet synchronization. A failure, timeout, or unavailability of Google Sheets or Apps Script does not block or fail user actions.

---

## 2. Machine-to-Machine Cryptographic HMAC Authentication

### Secret Configuration (`SHEET_SYNC_SECRET`)
* **Entropy:** Cryptographically secure, high-entropy 256-bit random secret.
* **Location:** Stored exclusively in server-side environment variable (`SHEET_SYNC_SECRET`) on Cloud Run and in Google Apps Script **Script Properties** (`PropertiesService.getScriptProperties().getProperty('SHEET_SYNC_SECRET')`).
* **Zero-Knowledge Transport Rule:** The secret itself is **NEVER TRANSMITTED** across the network:
  - NOT in HTTP request headers.
  - NOT in JSON request body.
  - NOT in URL or query string.
  - NOT logged to stdout, stderr, or persistent log sinks.
  - NOT returned in any API response or visible in frontend/browser code.
  - NOT stored in Google Sheets cells.

### Cryptographic Request Signing & Canonicalization
Every synchronization request is cryptographically signed using HMAC-SHA256:

1. **Deterministic Canonicalization:**
   The `entities` payload is recursively serialized with sorted object keys (`canonicalizeJson`) into an unambiguous deterministic string.
2. **Payload Hash:**
   A SHA-256 digest of the canonical entities string is computed:
   $$\text{payloadHash} = \text{SHA256}(\text{canonicalEntities})$$
3. **Canonical Message to Sign:**
   A strict colon-delimited string is constructed covering all request metadata and content:
   $$\text{messageToSign} = \text{action} + \text{":"} + \text{batchId} + \text{":"} + \text{timestamp} + \text{":"} + \text{nonce} + \text{":"} + \text{spreadsheetId} + \text{":"} + \text{payloadHash}$$
4. **HMAC-SHA256 Signature:**
   $$\text{signature} = \text{HMAC-SHA256}(\text{messageToSign}, \text{SHEET\_SYNC\_SECRET})$$

### Request Envelope Structure
```json
{
  "action": "SYNC_FIRESTORE_BATCH",
  "auth": {
    "timestamp": 1727878800000,
    "nonce": "e3b0c44298fc1c149afbf4c8996fb924",
    "signature": "7a35b1d4c28f..."
  },
  "batchId": "sync_1727878800000_a1b2c3d4",
  "spreadsheetId": "1VxEwbU0TupxdqNIhslFDL-hcZLpY0QBPcqVt-h8O43A",
  "entities": {
    "customers": [...],
    "subscriptions": [...]
  }
}
```

### Verification & Replay Protection (Apps Script)
1. **Freshness Window:** Validates that $|\text{now} - \text{timestamp}| \le 300,000\text{ ms}$ (5 minutes). Rejects stale requests.
2. **Nonce Replay Protection:** Checks `CacheService.getScriptCache()` for `sync_nonce_<nonce>`. If already present, rejects as replay; otherwise stores with 6-minute TTL.
3. **Idempotency Guarantee:** Even if replayed, deterministic primary-key in-place upsert guarantees zero duplicate rows.
4. **Constant-Time Comparison:** Apps Script recomputes the HMAC using its local Script Property and validates via `safeCompareStrings`.

---

## 3. Safe Secret Rotation Procedure

When rotating `SHEET_SYNC_SECRET`:
1. **Generate New Secret:** Generate a fresh 64-character hexadecimal or 32-byte base64 string.
2. **Maintenance / Quiet Window:** Trigger a manual sync from Admin Portal (`POST /api/admin/sheet-sync/trigger`) to ensure high-water marks are fully up-to-date.
3. **Update Apps Script Script Properties:**
   - Open Apps Script Editor -> Project Settings -> Script Properties.
   - Set `SHEET_SYNC_SECRET` to the new secret string.
4. **Update Cloud Run Environment:**
   - Update `SHEET_SYNC_SECRET` in Cloud Run environment variables / Google Secret Manager.
   - Deploy/redeploy the Cloud Run revision.
5. **Verify Resumption:**
   - Trigger `POST /api/admin/sheet-sync/trigger` or inspect `GET /api/admin/sheet-sync/status`.
   - The timestamp overlap window guarantees that any mutations occurring during the brief rotation window are automatically and deterministically captured and upserted.

---

## 4. Durable Firestore Checkpoint & Concurrency Lock

### Firestore Checkpoint Document
* **Collection:** `system`
* **Document:** `sheetSyncCheckpoint`
* **Schema:**
  ```typescript
  interface SheetSyncCheckpoint {
    stateId: 'sheetSyncCheckpoint';
    spreadsheetId: '1VxEwbU0TupxdqNIhslFDL-hcZLpY0QBPcqVt-h8O43A';
    lastSyncStartedAt: string | null;
    lastSyncCompletedAt: string | null;
    lastSyncStatus: 'idle' | 'in_progress' | 'success' | 'failed';
    lastSyncError: string | null;
    totalSyncRuns: number;
    concurrencyLock: {
      lockedAt: string;
      lockedBy: string;
      leaseExpiresAt: string;
    } | null;
    highWaterMarks: {
      customers: string;
      subscriptions: string;
      subscriptionCategories: string;
      payments: string;
      paymentOrders: string;
      dailyNewsPackages: string;
      newsStories: string;
      telegramDeliveryLogs: string;
      telegramConnectionTokens: string;
      categoryTransferAudits: string;
      systemScheduler: string;
    };
    lastStats: {
      syncedEntities: Record<string, { inserted: number; updated: number; total: number }>;
      durationMs: number;
    } | null;
    updatedAt: string;
  }
  ```

### Multi-Instance Concurrency Protection
* Cloud Run autoscaling can spin up multiple instances.
* Before executing a sync run, an instance acquires a distributed lease lock in Firestore (`concurrencyLock`) with a **90-second lease expiration**.
* If an instance crashes or scales to zero mid-execution, the lease expires automatically, enabling the next instance to resume without deadlock.

---

## 5. Timestamp Overlap Window & Deterministic Idempotency

### Safety Overlap Window
* Incremental sync queries calculate the lower boundary as:
  $$\text{Query Boundary} = \text{High-Water Mark} - 5\text{ minutes}$$
* This protects against clock skew, identical millisecond timestamps, and transactions committed slightly out-of-order.

### Deterministic Primary-Key Upsert Engine (Apps Script)
* For each batch, Apps Script builds an in-memory index mapping `Primary Key -> Row Index`.
* **If Row with PK Exists:** Updates row in-place via `sheet.getRange(row, 1, 1, cols).setValues([rowData])`.
* **If Row Does Not Exist:** Appends row via `sheet.appendRow(rowData)`.
* **Guarantee:** Retrying an entire batch or overlapping transactions produces **ZERO duplicate rows**.

---

## 6. Target Google Sheet Tab Schemas

### Existing Reused Tabs
1. **`Customers`** (Primary Key: `customerId`)
   * `customerId`, `customerSecretToken`, `fullName`, `email`, `mobileCountryCode`, `mobileNumber`, `telegramChatId`, `telegramUsername`, `accountStatus`, `createdAt`, `updatedAt`
2. **`Subscriptions`** (Primary Key: `subscriptionId`)
   * `subscriptionId`, `customerId`, `cycleType`, `parentSubscriptionId`, `state`, `trialStartDate`, `trialEndDate`, `day3ReminderSent`, `day3ReminderSentAt`, `customerReportedPaymentDate`, `adminConfirmedPaymentDate`, `bufferStartDate`, `bufferEndDate`, `paidStartDate`, `paidExpiryDate`, `renewalReminderSent`, `renewalReminderSentAt`, `createdAt`, `updatedAt`
3. **`SubscriptionCategories`** (Primary Key: `entitlementId`)
   * `entitlementId`, `subscriptionId`, `customerId`, `categoryId`, `categoryName`, `status`, `assignedAt`
4. **`Payments`** (Primary Key: `paymentId`)
   * `paymentId`, `subscriptionId`, `customerId`, `configVersion`, `basePriceAtPayment`, `gstRateAtPayment`, `gstAmountAtPayment`, `totalAmountPaid`, `currency`, `paymentMethod`, `destinationVpaOrAccount`, `utrReference`, `customerReportedPaymentDate`, `adminConfirmedPaymentDate`, `verificationStatus`, `verifiedAt`, `verifiedBy`, `notes`
5. **`DailyNews`** (Primary Key: `storyId` / composite `newsDate_categoryId_headline`)
   * `newsDate`, `categoryId`, `headline`, `summary`, `sourceName`, `sourceUrl`, `createdAt`
6. **`DeliveryLogs`** (Primary Key: `logId`)
   * `logId`, `timestamp`, `customerId`, `telegramChatId`, `categoryId`, `deliveryType`, `status`, `error`
7. **`TelegramTokens`** (Primary Key: `token`)
   * `token`, `customerId`, `expiresAt`, `used`, `usedAt`, `createdAt`
8. **`CategoryTransferAudits`** (Primary Key: `auditId`)
   * `auditId`, `customerId`, `previousCategoryId`, `newCategoryId`, `transferredBy`, `reason`, `timestamp`

### New Tabs Added
1. **`PaymentOrders`** (Primary Key: `orderId`)
   * `orderId`, `customerId`, `amount`, `currency`, `status`, `utrReference`, `createdAt`, `updatedAt`
2. **`DailyNewsPackages`** (Primary Key: `packageId`)
   * `packageId`, `newsDate`, `generatedAt`, `totalStories`, `categoryIds`, `status`
3. **`SystemScheduler`** (Primary Key: `stateId`)
   * `stateId`, `lastGenerationDate`, `lastDeliveryDate`, `lastDay3EvaluationDate`, `lastSyncDate`, `updatedAt`

---

## 7. Administrative APIs

* **`GET /api/admin/sheet-sync/status`**
  - Requires Google Admin ID Token session.
  - Returns current checkpoint state, high-water marks, total sync runs, last stats, and configuration status (`secretConfigured: boolean`, `configured: boolean`).
  - Never leaks secrets.
* **`POST /api/admin/sheet-sync/trigger`**
  - Requires Google Admin ID Token session.
  - Supports `{ forceFullSync?: boolean }`.
  - Executes synchronization cycle and returns execution stats.
