# Stage 2 Architecture Blueprint: Customer Identity, Authentication & Tenant Isolation
**MyDigitAsset (`mydigitasset.com`) Platform Specification**
**Status:** DRAFT PROPOSAL FOR STAGE 2 APPROVAL (FROZEN ARCHITECTURE PRESERVED)

---

## 1. Executive Scope & Objective

Stage 2 focuses strictly on **Customer Identity, Authentication, Registration, Protected Customer Endpoints, and Tenant Isolation**.

### Core Tenets:
1. **Authoritative Identity by Token Only:** The client identity is derived **exclusively** from the server-validated opaque session token (`customerAuthToken` / `sessionToken`). A client request can never specify or override its identity by passing `customerId`, `email`, `phone`, or `telegramChatId`.
2. **Absolute Tenant Isolation:** Customer A has zero mathematical or operational access to Customer B's records, subscriptions, payments, UTRs, Telegram connection details, or admin notes.
3. **No Directory Enumeration:** No endpoint allows listing, searching, or scanning other customers.
4. **Data Minimization:** APIs return strictly the minimal sanitized data required for the customer dashboard. Private server fields, admin audit logs, and Telegram chat IDs are never returned to client responses.
5. **Freeze & Parity:** Preserves the approved Stage 1 Google Apps Script and Firestore hybrid mirror architecture without introducing unrelated features.

---

## 2. Section A: Customer Registration Flow

### 2.1 Required Fields & Input Validation
Registration requires the following fields:
* `fullName`: String, 2 to 100 characters, sanitized against HTML/script injection.
* `email`: String, valid RFC 5322 format, normalized to lowercase.
* `mobileCountryCode`: String, standard international dialing code (e.g. `+91`), regex `^\+[0-9]{1,4}$`.
* `mobileNumber`: String, normalized to 7–15 decimal digits (standard E.164 without country code).
* `selectedCategoryIds`: Array of 1 or more valid category IDs (e.g. `['cat_india_pe_vc', 'cat_india_startups']`).

### 2.2 Duplicate Account Handling
* **Email Uniqueness:** The system checks if `email` (case-insensitive) already exists in the persistent database.
  * If the email exists: The registration acts as a secure session resume / re-login. The customer's existing profile is updated with fresh contact numbers/categories if provided, but the immutable `customerId`, trial start date, and historical subscriptions/payments are **strictly preserved**. A new session token is issued to the authenticating user.
  * If the email is new: A new customer record is provisioned with a fresh deterministic ID (`cust_<16_hex_chars>`), initial 3-day complimentary trial window, and a new session token.
* **Phone Numbers:** Phone numbers are updated for the customer upon valid authenticated sessions, preventing account lockouts if a subscriber changes their SIM while preserving identity continuity.

### 2.3 Token Generation & Storage
* **Generation Method:** Cryptographically secure pseudorandom number generator (`crypto.randomBytes(32)` in Node.js, `Utilities.getUuid() + Utilities.getUuid()` in Apps Script).
* **Entropy:** 256 bits (32 bytes / 64 hex characters).
* **Format:** `csec_<64_hex_chars>` or `csess_<64_hex_chars>`.
* **Storage:**
  * Stored in the `customerSessions` collection with `customerId`, `createdAt`, and `expiresAt` (30 days TTL).
  * Stored as primary active session token on the `Customer` record (`customerAuthToken`).

### 2.4 Data Return Boundaries
* **Returned to Browser:**
  * `ok: true`
  * `customer`: `{ customerId, fullName, email, mobileCountryCode, mobileNumber, telegramConnected, accountStatus, trialStartDate, trialEndDate, trialStatus, selectedCategoryIds }`
  * `sessionToken`: The 256-bit opaque session token.
  * `subscription`: Initial active trial entitlement metadata.
* **NEVER Returned to Browser:**
  * Raw database indexes or internal spreadsheet row numbers.
  * `telegramChatId` (remains server-side only).
  * Other customers' records or counts.
  * Internal server secrets (`SHEET_SYNC_SECRET`, `TELEGRAM_BOT_TOKEN`, `GOOGLE_CLIENT_SECRET`).
  * Admin notes or payment verification audit logs.

---

## 3. Section B: Authoritative Customer Authentication

All customer-protected endpoints enforce **server-side identity derivation**:

1. **Extraction:** The server extracts the token from either:
   * HTTP header: `Authorization: Bearer <sessionToken>`
   * Secure cookie: `customerSession=<sessionToken>` (when browser cookies are active)
   * Request body envelope: `{ customerAuthToken: "<sessionToken>" }`
2. **Authoritative Resolution:**
   $$\text{session} = \text{lookupSession}(\text{sessionToken})$$
   $$\text{customer} = \text{lookupCustomer}(\text{session.customerId})$$
3. **Identity Prohibition:**
   If a client includes `customerId`, `email`, `phone`, or `telegramChatId` in the request body, **these fields are strictly ignored for identity resolution**. The backend uses **ONLY** `session.customerId`.
4. **Invalidation:** If the token is missing, expired, revoked, or non-existent, the request is rejected with `401 Unauthorized` without executing any database query or mutation.

---

## 4. Section C: Tenant Isolation & Anti-Tampering Rules

| Vector | Attack Description | Enforced Defense |
| :--- | :--- | :--- |
| **ID Parameter Tampering** | Customer A passes Customer B's `customerId` in request payload | The endpoint discards client-provided `customerId` and forces the query/update to target `authenticatedCustomer.customerId`. |
| **Cross-Customer Payment Proof** | Customer A attempts to attach UTR to Customer B's order | UTR submission is bound strictly to `authenticatedCustomer.customerId`. Matching orders belonging to another customer throw `403 Forbidden`. |
| **Cross-Customer Telegram Binding** | Customer A tries to connect Customer B's Telegram chat | The deep-link token is single-use, 15-minute expiring, and bound to `authenticatedCustomer.customerId`. Telegram Chat ID is checked for existing bindings; collisions are rejected. |
| **Directory Enumeration** | Attacker queries `/api/customer/:id` or loops through customer IDs | No customer lookup endpoint takes an arbitrary ID parameter. The only endpoint is `/api/customer/me` or `action=getCustomerStatus` using the bearer token. |
| **Subscriber List Leakage** | Attacker requests subscriber roster or count | Zero customer-facing endpoints return lists of customers. Bulk retrieval methods (`getAdminCustomersList`) require Google OAuth Admin JWT verifying `mihirkapuria@gmail.com`. |
| **Sensitive Data Exposure** | Customer attempts to inspect response payload for Telegram Chat IDs or UTRs | Response serialization runs through explicit DTO projection whitelist. `telegramChatId` is projected as boolean `telegramConnected`. |

---

## 5. Section D: Protected Endpoints Specification

### 1. `registerTrial` (`POST /api/customer/register-trial`)
* **Auth Required:** No (Public onboarding).
* **Allowed Request Fields:** `fullName`, `email`, `mobileCountryCode`, `mobileNumber`, `selectedCategoryIds`.
* **Forbidden Fields:** `customerId`, `telegramChatId`, `accountStatus`, `trialStatus`, `adminNotes`.
* **Server Resolution:** Validates fields; creates or resolves customer by lowercase email.
* **Return:** `{ ok: true, customer: CustomerProfileDTO, sessionToken: string }`.

### 2. `getCustomerStatus` (`GET /api/customer/me` or `POST action=getCustomerStatus`)
* **Auth Required:** Yes (`Bearer <token>` or `customerSecretToken`).
* **Forbidden Fields:** Any parameter attempting to specify a target user.
* **Server Resolution:** Resolves session → retrieves customer record → retrieves active subscriptions for `session.customerId`.
* **Return:** `{ ok: true, customer: CustomerProfileDTO, subscriptions: SubscriptionDTO[], activeCategories: string[] }`.

### 3. `requestRenewalTrial` (`POST /api/customer/request-renewal-trial`)
* **Auth Required:** Yes (`Bearer <token>`).
* **Allowed Request Fields:** `reason` (optional string), `categoryId` (optional string).
* **Forbidden Fields:** `customerId`, `subscriptionId`, `status`.
* **Server Resolution:** Resolves customer via session token. Validates eligibility for renewal; logs audit event.
* **Return:** `{ ok: true, message: string, renewalStatus: string }`.

### 4. `submitPaymentProof` (`POST /api/customer/submit-payment-proof`)
* **Auth Required:** Yes (`Bearer <token>`).
* **Allowed Request Fields:** `utrReference`, `paymentMethod`, `paymentDate`, `purchasedCategoryIds`.
* **Forbidden Fields:** `customerId`, `paymentId`, `paymentStatus` (customer cannot mark payment "successful").
* **Server Resolution:** Resolves `customerId` from session. Creates pending `Payment` record tied strictly to that `customerId`.
* **Return:** `{ ok: true, paymentId: string, status: "pending_verification" }`.

### 5. `generateTelegramToken` (`POST /api/customer/generate-telegram-token`)
* **Auth Required:** Yes (`Bearer <token>`).
* **Allowed Request Fields:** None required (derived completely from session).
* **Forbidden Fields:** `customerId`, `telegramChatId`.
* **Server Resolution:** Generates single-use deep-link token bound to `session.customerId`.
* **Return:** `{ ok: true, token: string, deepLink: string, botUsername: string }`.

---

## 6. Section E: Customer Session & Token Security Specification

* **Algorithm:** PRNG using OS entropy (`crypto.randomBytes(32)`).
* **Token Entropy:** 256 bits (unpredictable, immunity to brute-force).
* **Telegram Deep-Link Compliance (Telegram Bot API Limit):**
  * Telegram `start` parameter constraint: **Maximum 64 characters** from `[A-Za-z0-9_-]`.
  * Stage 2 Format: `tgtok_` (6 chars) + 48 hex chars = **54 characters total** (192 bits of entropy), strictly within Telegram's 64-char ceiling.
* **Expiration (TTL):**
  * Web Session Token: 30 days of inactivity.
  * Telegram Connection Token: Exactly 15 minutes, single-use.
* **Revocation & Logout:**
  * Calling `/api/customer/logout` removes the session from in-memory cache and Firestore Native mode immediately.
* **Brute-Force & Rate Limiting:**
  * Rate-limiting applied on token validation: max 60 requests/minute per IP.
  * Constant-time comparison for authentication tokens where hash checking is performed.

---

## 7. Section F: Persistent Database Model & Visibility Matrix

### Schema Field Classifications:

| Collection / Field | Data Type | Visibility Tier | Description |
| :--- | :--- | :--- | :--- |
| **`Customers`** | | | |
| `customerId` | String (`cust_*`) | Customer-Facing | Opaque immutable primary key |
| `fullName` | String | Customer-Facing | Customer full name |
| `email` | String | Customer-Facing | Customer email address |
| `mobileCountryCode` | String | Customer-Facing | Country code (e.g. `+91`) |
| `mobileNumber` | String | Customer-Facing | Phone number |
| `customerAuthToken` | String | Sensitive (Auth Only) | Returned only in auth envelope, never in profiles |
| `telegramChatId` | String | **Server-Only / Secret** | Numeric chat ID; NEVER returned to customer |
| `telegramConnected` | Boolean | Customer-Facing | Safe boolean indicator |
| `accountStatus` | String | Customer-Facing | `active`, `suspended`, `inactive` |
| `trialStartDate` | ISO String | Customer-Facing | Trial start timestamp |
| `trialEndDate` | ISO String | Customer-Facing | Trial end timestamp |
| `trialStatus` | String | Customer-Facing | `active`, `expired`, `converted` |
| `createdAt` / `updatedAt` | ISO String | Customer-Facing | Timestamps |
| **`Subscriptions`** | | | |
| `subscriptionId` | String (`sub_*`) | Customer-Facing | Unique ID |
| `customerId` | String | Tenant Boundary | Associated customer ID |
| `bufferStartDate` | ISO String | Customer-Facing | Courtesy buffer start date |
| `bufferEndDate` | ISO String | Customer-Facing | Courtesy buffer end date (+4 days) |
| `paidStartDate` | ISO String | Customer-Facing | Paid period start date (+5 days) |
| `paidEndDate` | ISO String | Customer-Facing | Paid expiry date (+12 months) |
| `status` | String | Customer-Facing | `active`, `expired`, `pending` |
| **`Payments`** | | | |
| `paymentId` | String (`pay_*`) | Customer-Facing | Payment record ID |
| `customerId` | String | Tenant Boundary | Associated customer ID |
| `amount` | Number | Customer-Facing | Amount in INR |
| `gatewayReference` | String | Customer-Facing | Customer-provided UTR or Razorpay ID |
| `paymentStatus` | String | Customer-Facing | `pending`, `successful`, `failed` |
| `adminNotes` | String | **Admin-Only** | Private admin verification notes |

---

## 8. Section G: Stage 2 Test Matrix (Automated Suite)

The automated test suite (`server/test_stage2.ts`) will execute and verify:

1. **New Customer Registration:** Registers customer, validates required fields, verifies 3-day trial creation.
2. **Duplicate Email Re-Login:** Supplying existing email preserves `customerId` and returns a valid session token.
3. **Duplicate Phone Updating:** Updating phone on authenticated session modifies only that customer.
4. **Valid Authenticated Request:** Resolves customer identity accurately.
5. **Missing Authentication:** Rejection with `401 Unauthorized`.
6. **Invalid Authentication:** Forged or altered session token rejected.
7. **Expired Authentication:** Token past 30-day expiry rejected.
8. **Revoked Authentication:** Logged-out token immediately rejected.
9. **Tenant Isolation (Access):** Customer A cannot access Customer B's profile or status.
10. **Tenant Isolation (ID Spoofing):** Passing Customer B's `customerId` in payload has zero effect; targets Customer A.
11. **Tenant Isolation (Email Spoofing):** Passing Customer B's email does not switch identity.
12. **Tenant Isolation (Payment Records):** Customer A querying payments receives strictly Customer A's records.
13. **Enumeration Resistance:** No endpoint allows querying customer rosters or scanning by sequential IDs.
14. **Chat ID Privacy:** `telegramChatId` is never returned in any response DTO (verified `undefined` or omitted).
15. **Malformed Request Payload:** Invalid JSON or malformed inputs return `400 Bad Request`.
16. **Unexpected / Extra Fields:** Extra injected fields are stripped and never stored.
17. **Telegram Start Parameter Compliance:** Verification that generated deep link start parameter length is $\le 64$ characters (`[A-Za-z0-9_-]`).

---

## 9. Section H: Stage Boundary & Implementation Plan

### Files Requiring Modification/Verification in Stage 2:
1. `server/db.ts`:
   * Strict DTO projection whitelist for customer profiles (stripping `telegramChatId` and admin notes).
   * Session token validation and expiry enforcement.
2. `server/telegramService.ts`:
   * Ensure generated Telegram token start parameter is formatted as `tgtok_<48_hex_chars>` (54 chars $\le 64$ chars).
3. `server/test_stage2.ts`:
   * Comprehensive expansion to execute all 17 test cases in the test matrix.
4. `apps_script/MyDigitAsset_AppsScript.gs` & `apps_script/Code.js`:
   * Keep customer verification logic in exact parity with the DTO projection rules.

### Boundaries Strictly Maintained:
* No Razorpay live automation or gateway webhooks.
* No bulk email infrastructure.
* No changes to morning news ingestion or delivery schedulers.
* Zero disruption to existing Stage 1 Google Sheet schemas or Stage 3C HMAC sync.
