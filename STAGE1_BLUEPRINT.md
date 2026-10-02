# Stage 1 Architecture Blueprint: MyDigitalAsset (mydigitasset.com)
**Google Apps Script & Web Platform Architecture Specification**
**Approved for Stage 2 Implementation**

---

## Executive Summary & System Scope

**MyDigitalAsset** (`mydigitasset.com`) is a premium paid daily executive news subscription service for business leaders, investors, and founders in India, delivering curated morning briefings across key sectors:
1. **India PE/VC** (`cat_india_pe_vc`)
2. **Startups & Venture Ecosystem** (`cat_india_startups`)
3. **Healthcare & Life Sciences** (`cat_india_healthcare`)

Daily executive briefings are synchronized and delivered every morning between **6:00 AM and 7:00 AM IST** directly to subscribers' private Telegram chats via the official Telegram Bot.

The backend infrastructure utilizes **Google Apps Script** powered by **Google Sheets** as the authoritative database, coupled with a responsive modern web application frontend, automated Telegram Bot API integration, Razorpay/UPI payment verification, and Google OAuth 2.0 administrator authentication.

---

## 1. Telegram Connection Flow (Complete Secure Specification)

To ensure privacy, usability, and data protection, customers are **never asked to manually find or type their Telegram Chat ID**. The connection is established via single-use, high-entropy cryptographic deep links.

```
+-----------------------------------------------------------------------------------------+
|                                TELEGRAM CONNECTION FLOW                                 |
+-----------------------------------------------------------------------------------------+

  [ Website Signup / Dashboard ]
                 |
                 v
  [ Apps Script / Server: generateTelegramConnectionToken(customerAuthToken) ]
                 |
                 +---> Generates high-entropy token: "tgtok_" + 64 random hex characters (256-bit)
                 +---> Opaque & Anonymous: Zero PII (NO email, phone, name, or Chat ID)
                 +---> Single-use, 15-minute validity window, customer-scoped
                 |
                 v
  [ UI: "Connect Telegram" Button ]
                 |
                 v (Deep Link Opened)
  https://t.me/<BOT_USERNAME>?start=<ONE_TIME_TOKEN>
                 |
                 v
  [ Customer taps "START" in Telegram App ]
                 |
                 v (Telegram sends message to Bot)
  "/start <ONE_TIME_TOKEN>"
                 |
                 v (Telegram Webhook POST)
  [ Apps Script doPost(e) / Webhook Receiver ]
                 |
                 +---> 1. Verifies Webhook Secret Token header
                 +---> 2. Extracts <ONE_TIME_TOKEN> from message text
                 +---> 3. Looks up token in 'TelegramTokens' sheet/table:
                 |         * Token must exist
                 |         * used === false (Single-use enforcement)
                 |         * now <= expiresAt (15-min expiration check)
                 +---> 4. Resolves customerId associated with token
                 +---> 5. Enforces One-Account-per-Telegram-Chat-ID rule:
                 |         * Checks if Telegram chat_id is linked to any other customer
                 |         * If linked to another account, connection is rejected
                 +---> 6. Atomic Association:
                 |         * customer.telegramChatId = message.chat.id
                 |         * customer.telegramConnected = true
                 |         * token.used = true
                 |         * token.usedAt = ISO timestamp
                 +---> 7. Logs audit record in 'TelegramAudit' sheet
                 +---> 8. Sends immediate confirmation in Telegram:
                           "✅ Account Connected! You will receive morning briefings here (6:00-7:00 AM IST)."
```

### Security & Privacy Guarantees for Telegram:
- **No Manual Chat ID Entry**: Customers never copy, paste, or type numeric Telegram Chat IDs.
- **Opaque Token Design**: The token is an unguessable 256-bit random string (`tgtok_[a-f0-9]{64}`). It contains no email, phone number, Telegram ID, or internal sequence numbers.
- **Strict Privacy**: A customer's Telegram `chat_id` is stored strictly in server-side sheets/databases and is **never returned to any public or client API**. The customer profile only receives `telegramConnected: true`.
- **One-Account Rule**: A single Telegram Chat ID can only ever be bound to one MyDigitalAsset customer account. Cross-linking is rejected with an audit log entry.
- **Single-Use & Fast Expiry**: Once consumed, the token is permanently invalidated. Unconsumed tokens automatically expire after 15 minutes.

---

## 2. Customer Identity & Public Endpoint Protection

All public customer-facing endpoints are protected against cross-customer record manipulation and directory enumeration.

### Protected Public Endpoints:
1. `registerTrial` (`POST /api/customer/register-trial`)
2. `requestRenewalTrial` (`POST /api/customer/request-renewal-trial`)
3. `submitPaymentProof` (`POST /api/customer/submit-payment-proof`)
4. `getCustomerProfile` / `getCustomerSubscription`

### Opaque Customer Session Identifier Mechanism:
- Upon signup/trial registration via `registerTrial`, Apps Script / the server generates an unguessable, cryptographically random, 256-bit customer session identifier: **`customerAuthToken`** (e.g. `cat_[a-f0-9]{64}`).
- The `customerAuthToken` is returned exclusively to the caller in the response payload and set as an `HttpOnly` cookie where applicable.
- For all subsequent requests (`requestRenewalTrial`, `submitPaymentProof`, `generateTelegramToken`, subscription status queries), the client MUST present this `customerAuthToken` (via `Authorization: Bearer <token>`, `customerAuthToken` payload field, or session cookie).
- **Server-Authoritative Resolution**: The backend resolves the customer identity **exclusively from the validated `customerAuthToken`**.
- **Immutable Scoping**: A customer can **never** pass another customer's ID, email, or reference to alter or read another record. Even if an attacker passes arbitrary `customerId` values, the backend binds the operation solely to the record matching the authenticated `customerAuthToken`.

### Customer Capability Boundaries:
| Permitted for Customer | Strictly Forbidden / Never Disclosed |
| :--- | :--- |
| Access their own subscription status | Subscriber lists or counts |
| Submit their own payment reference / UTR | Other customer names |
| Connect their own Telegram account | Phone numbers of other subscribers |
| Request renewal for their own subscription | Email addresses of other subscribers |
| Update their own mobile number | Telegram Chat IDs of any customer |
| View their own payment receipts | UTRs or payment receipts of other customers |
| Access daily briefings for entitled categories | Admin notes, audit trails, or internal flags |

---

## 3. Admin Google Token Verification

Administrator access to the management portal and privileged actions requires authentication via **Google OAuth 2.0 / Google Identity Services**.

Verification of the Google ID Token is comprehensive and cryptographically rigorous. The system **never relies only on matching the email address string**.

```
+-----------------------------------------------------------------------------------------+
|                          ADMIN GOOGLE ID TOKEN VERIFICATION                             |
+-----------------------------------------------------------------------------------------+

  Admin signs in with Google
                 |
                 v
  Google issues cryptographically signed JWT ID Token
                 |
                 v
  Admin client sends ID Token to Apps Script / Server
                 |
                 v
  [ Apps Script / Server Cryptographic Verification Pipeline ]
                 |
                 +---> 1. Signature Verification:
                 |         Cryptographically verified against Google's published public keys
                 |         (via https://oauth2.googleapis.com/tokeninfo or OAuth2Client)
                 |
                 +---> 2. Audience (aud) Validation:
                 |         payload.aud === GOOGLE_CLIENT_ID
                 |         (Guarantees token was issued specifically for our application)
                 |
                 +---> 3. Email Match Validation:
                 |         payload.email.toLowerCase() === "mihirkapuria@gmail.com"
                 |         (Only this single authoritative account is authorized)
                 |
                 +---> 4. Email Verified Validation:
                 |         payload.email_verified === true
                 |         (Guarantees Google has verified ownership of the email)
                 |
                 +---> 5. Expiration (exp) Validation:
                 |         payload.exp > Math.floor(Date.now() / 1000)
                 |         (Guarantees token has not expired)
                 |
                 +---> 6. Issuer (iss) Validation:
                           payload.iss IN ("accounts.google.com", "https://accounts.google.com")
                 |
                 v
  [ All 6 Checks PASS ] ---> Issue 8-hour Admin Session + CSRF Token + Write Security Audit Log
  [ Any Check FAILS ]   ---> Immediate 401/403 Reject + Log Unauthorized Attempt with IP
```

---

## 4. Buffer Date & Subscription Period Specification

### Authoritative Formulas:
```
bufferStartDate = adminConfirmedPaymentDate
bufferEndDate   = adminConfirmedPaymentDate + 4 calendar days
paidStartDate   = adminConfirmedPaymentDate + 5 calendar days
paidEndDate     = paidStartDate + 12 calendar months (365 days / anniversary date)
```

### Explicit Calendar Date Example:
For payment confirmed on **October 3**:

| Date | Subscription Phase | Delivery Status | Notes |
| :--- | :--- | :--- | :--- |
| **Oct 3** | Buffer Day 1 (`bufferStartDate`) | **Delivered** | Continuous news starts immediately upon confirmation |
| **Oct 4** | Buffer Day 2 | **Delivered** | Continuous daily news |
| **Oct 5** | Buffer Day 3 | **Delivered** | Continuous daily news |
| **Oct 6** | Buffer Day 4 | **Delivered** | Continuous daily news |
| **Oct 7** | Buffer Day 5 (`bufferEndDate`) | **Delivered** | Final day of courtesy buffer window |
| **Oct 8** | Paid Subscription Day 1 (`paidStartDate`) | **Delivered** | Formal 12-month paid subscription begins |
| **Oct 8 + 12 mo** | Paid Subscription End (`paidEndDate`) | **Delivered** | Full 12-month paid period concludes |

### Continuous Delivery Principle:
- Executive news briefings are delivered **continuously from October 3 through October 7** (the 5-day inclusive buffer period: Day 0, +1, +2, +3, +4).
- The formal 12-month paid subscription duration begins on **October 8** (`paidStartDate`) without any interruption or reduction in paid days.
- Total active service received: **5 buffer days + 12 full calendar months**.

---

## 5. Google Sheets Database Schema (Authoritative Storage)

The Google Spreadsheet acts as the relational database with dedicated sheets:

### Sheet 1: `Customers`
| Column | Field Name | Type | Description |
| :--- | :--- | :--- | :--- |
| A | `customerId` | String | Unique ID: `cust_<nanoid>` |
| B | `fullName` | String | Customer full name |
| C | `email` | String | Customer email (case-insensitive indexed) |
| D | `mobileCountryCode` | String | Country dial code (e.g. `+91`) |
| E | `mobileNumber` | String | 10-digit mobile number |
| F | `customerAuthToken` | String | Opaque 256-bit unguessable session token |
| G | `telegramChatId` | String | Private Telegram numeric chat ID (or blank) |
| H | `telegramConnected` | Boolean | `TRUE` if connected, `FALSE` otherwise |
| I | `accountStatus` | String | `active` \| `inactive` \| `suspended` |
| J | `selectedCategoryIds` | String | JSON array of category IDs |
| K | `createdAt` | ISO Date | Timestamp of account creation |
| L | `updatedAt` | ISO Date | Timestamp of last modification |

### Sheet 2: `Subscriptions`
| Column | Field Name | Type | Description |
| :--- | :--- | :--- | :--- |
| A | `subscriptionId` | String | Unique ID: `sub_<nanoid>` |
| B | `customerId` | String | Associated `customerId` |
| C | `paymentId` | String | Foreign key to `Payments` |
| D | `bufferStartDate` | ISO Date | `adminConfirmedPaymentDate` (Oct 3) |
| E | `bufferEndDate` | ISO Date | `adminConfirmedPaymentDate + 4 days` (Oct 7) |
| F | `paidStartDate` | ISO Date | `adminConfirmedPaymentDate + 5 days` (Oct 8) |
| G | `paidEndDate` | ISO Date | `paidStartDate + 12 months` (Oct 8 next year) |
| H | `status` | String | `active` \| `expired` \| `pending` \| `suspended` |
| I | `createdAt` | ISO Date | Timestamp created |
| J | `updatedAt` | ISO Date | Timestamp updated |

### Sheet 3: `Payments`
| Column | Field Name | Type | Description |
| :--- | :--- | :--- | :--- |
| A | `paymentId` | String | Unique ID: `pay_<nanoid>` |
| B | `customerId` | String | Associated `customerId` |
| C | `amount` | Number | Total amount in INR (e.g. 297.36) |
| D | `currency` | String | Currency code: `INR` |
| E | `paymentStatus` | String | `successful` \| `pending` \| `failed` |
| F | `paymentDate` | ISO Date | Admin confirmation date or gateway timestamp |
| G | `gatewayReference` | String | UTR number / Razorpay payment ID |
| H | `provider` | String | `razorpay` \| `manual_upi` |
| I | `purchasedCategoryIds`| String | JSON array of categories |
| J | `createdAt` | ISO Date | Timestamp created |

### Sheet 4: `TelegramTokens`
| Column | Field Name | Type | Description |
| :--- | :--- | :--- | :--- |
| A | `tokenId` | String | Unique ID: `tgtok_<nanoid>` |
| B | `token` | String | 256-bit random hex string |
| C | `customerId` | String | Associated `customerId` |
| D | `expiresAt` | ISO Date | Expiry timestamp (createdAt + 15 minutes) |
| E | `used` | Boolean | `TRUE` if consumed, `FALSE` if active |
| F | `usedAt` | ISO Date | Timestamp of consumption (or blank) |
| G | `createdAt` | ISO Date | Generation timestamp |

### Sheet 5: `TelegramAudit`
| Column | Field Name | Type | Description |
| :--- | :--- | :--- | :--- |
| A | `auditId` | String | Unique ID: `tga_<nanoid>` |
| B | `customerId` | String | Associated `customerId` |
| C | `eventType` | String | `TOKEN_GENERATED` \| `CONNECTED` \| `REJECTED` \| `DISCONNECTED` |
| D | `telegramChatId` | String | Chat ID involved |
| E | `result` | String | `SUCCESS` \| `REJECTED` \| `FAILED` |
| F | `details` | String | Human-readable audit narrative |
| G | `timestamp` | ISO Date | Timestamp of event |

### Sheet 6: `AdminAudit`
| Column | Field Name | Type | Description |
| :--- | :--- | :--- | :--- |
| A | `auditId` | String | Unique ID: `sec_<nanoid>` |
| B | `adminEmail` | String | `mihirkapuria@gmail.com` |
| C | `eventType` | String | `GOOGLE_LOGIN_SUCCESS` \| `PAYMENT_CONFIRMED` \| `CATEGORY_TRANSFER` |
| D | `clientIp` | String | Client IP address |
| E | `details` | String | Details of administrative action |
| F | `timestamp` | ISO Date | Timestamp of event |

---

## 6. Public & Protected API Contracts

### 6.1 `registerTrial`
- **Method**: `POST`
- **Route**: `/api/customer/register-trial` or `/api/registerTrial`
- **Request Body**:
  ```json
  {
    "fullName": "Aarav Sharma",
    "email": "aarav.sharma@example.com",
    "mobileCountryCode": "+91",
    "mobileNumber": "9876543210",
    "selectedCategoryIds": ["cat_india_startups", "cat_india_pe_vc"]
  }
  ```
- **Response**:
  ```json
  {
    "ok": true,
    "success": true,
    "customerId": "cust_a7b8c9d0e1",
    "customerAuthToken": "cat_3f8a91b2c4d5e6f7a8b9c0d1e2f3a4b5...",
    "customer": {
      "customerId": "cust_a7b8c9d0e1",
      "fullName": "Aarav Sharma",
      "email": "aarav.sharma@example.com",
      "mobileCountryCode": "+91",
      "mobileNumber": "9876543210",
      "telegramConnected": false,
      "accountStatus": "active",
      "selectedCategoryIds": ["cat_india_startups", "cat_india_pe_vc"]
    }
  }
  ```

### 6.2 `requestRenewalTrial`
- **Method**: `POST`
- **Route**: `/api/customer/request-renewal-trial` or `/api/requestRenewalTrial`
- **Headers**: `Authorization: Bearer <customerAuthToken>`
- **Request Body**:
  ```json
  {
    "customerAuthToken": "cat_3f8a91b2c4d5e6f7...",
    "notes": "Requesting annual renewal"
  }
  ```
- **Response**:
  ```json
  {
    "ok": true,
    "success": true,
    "message": "Renewal request recorded successfully for your account.",
    "customerId": "cust_a7b8c9d0e1",
    "requestedAt": "2026-10-02T06:00:00.000Z"
  }
  ```

### 6.3 `submitPaymentProof`
- **Method**: `POST`
- **Route**: `/api/customer/submit-payment-proof` or `/api/submitPaymentProof`
- **Headers**: `Authorization: Bearer <customerAuthToken>`
- **Request Body**:
  ```json
  {
    "customerAuthToken": "cat_3f8a91b2c4d5e6f7...",
    "paymentReference": "UTR2026100398765432",
    "amount": 297.36,
    "categoryIds": ["cat_india_startups"]
  }
  ```
- **Response**:
  ```json
  {
    "ok": true,
    "success": true,
    "paymentId": "proof_1a2b3c4d",
    "reference": "UTR2026100398765432",
    "status": "pending",
    "message": "Payment proof submitted successfully and queued for admin review."
  }
  ```

### 6.4 `generateTelegramToken`
- **Method**: `POST`
- **Route**: `/api/customer/telegram/token`
- **Headers**: `Authorization: Bearer <customerAuthToken>`
- **Response**:
  ```json
  {
    "ok": true,
    "token": "tgtok_8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c...",
    "deepLink": "https://t.me/MyDigitAssetNewsBot?start=tgtok_8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c...",
    "expiresAt": "2026-10-02T06:15:00.000Z",
    "botUsername": "MyDigitAssetNewsBot"
  }
  ```

### 6.5 Telegram Bot Webhook `/start <token>`
- **Method**: `POST`
- **Route**: `/api/telegram/webhook` (or Apps Script `doPost(e)`)
- **Headers**: `X-Telegram-Bot-Api-Secret-Token: <SECRET>`
- **Telegram Payload**:
  ```json
  {
    "update_id": 10001,
    "message": {
      "message_id": 42,
      "from": { "id": 987654321, "first_name": "Aarav", "username": "aarav_s" },
      "chat": { "id": 987654321, "type": "private" },
      "text": "/start tgtok_8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c..."
    }
  }
  ```
- **Processing**:
  Validates token, matches customer, enforces one-account rule, binds `telegramChatId = "987654321"`, sets `used = true`, and replies with confirmation.

---

## 7. Approval & Stage 2 Transition Readiness

All 5 core requirements and clarifications have been fully integrated:
1. **Telegram Connection Flow**: Complete end-to-end deep link mechanism (`https://t.me/<BOT_USERNAME>?start=<ONE_TIME_TOKEN>`), automated `/start <token>` validation, zero manual Chat ID typing, zero PII in token, private Chat ID storage.
2. **Customer Identity Protection**: Unguessable `customerAuthToken` session architecture protecting `registerTrial`, `requestRenewalTrial`, and `submitPaymentProof`. Strict tenant isolation with zero exposure of other subscribers or directory lists.
3. **Admin Google ID Token Verification**: Cryptographic signature validation, OAuth audience match, `mihirkapuria@gmail.com` email check, `email_verified === true`, expiration validation (without relying solely on string email match).
4. **Buffer Date Calculations**: Explicit inclusive dates documented and programmed (`bufferStartDate = adminConfirmedPaymentDate`, `bufferEndDate = adminConfirmedPaymentDate + 4 days`, `paidStartDate = adminConfirmedPaymentDate + 5 days`, continuous delivery Oct 3-7, paid period Oct 8 onwards).
5. **Blueprint Integration**: Authoritative blueprint recorded in repository.

**Stage 1 is formally finalized and approved. Ready to proceed to Stage 2 implementation.**
