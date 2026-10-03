# Stage 2 Architecture Blueprint: Customer Identity, Authentication & Tenant Isolation
**MyDigitAsset — Google Apps Script & Sheets Integration Specification**
**Status:** DRAFT PROPOSAL FOR STAGE 2 APPROVAL (FROZEN ARCHITECTURE PRESERVED)

Refer to `/STAGE2_BLUEPRINT.md` for the full platform specification.

---

## Google Apps Script Specific Implementations for Stage 2

### 1. Telegram Deep-Link Start Parameter Constraint Compliance
* **Constraint:** Telegram Bot API limits the deep-link `start` parameter to **maximum 64 characters** containing only `[A-Za-z0-9_-]`.
* **Apps Script Format:**
  * Prefix: `tgtok_` (6 chars)
  * Entropy: 48 hex characters (generated via `Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').substring(0, 16)`)
  * Total length: **54 characters** (54 $\le$ 64 characters).
  * URL: `https://t.me/<BOT_USERNAME>?start=tgtok_<48_hex_chars>`

### 2. Opaque Customer Authentication in `doPost(e)` and `doGet(e)`
* All customer-protected actions in Apps Script (`getCustomerStatus`, `submitPaymentProof`, `requestRenewalTrial`, `generateTelegramToken`) resolve identity **strictly** via:
  ```javascript
  var customer = getCustomerBySecretToken(payload.customerSecretToken);
  ```
* Any client-provided `customerId` or `telegramChatId` inside `payload` is completely discarded.
* `getCustomerBySecretToken` looks up column B of the `Customers` sheet and throws `Error('Customer not found for the provided session.')` on missing or invalid tokens.

### 3. Data Sanitization & Customer Privacy
* Public and customer responses strip:
  * `telegramChatId` (replaced with `telegramConnected: true | false`)
  * Row index numbers
  * Admin notes and internal audit logs
  * Other customers' subscription or payment records

### 4. Zero Disruption Guarantee
* Existing `doGet` public configuration routes remain 100% active.
* Admin endpoints protected by Google OAuth ID token verification remain 100% active.
* Stage 3C `SYNC_FIRESTORE_BATCH` route and HMAC authentication remain 100% active.
