# Stage 1 Architecture Blueprint: MyDigitalAsset (Google Apps Script Backend)
**Authoritative Architectural Specification for Google Apps Script, Sheets, and Telegram Integration**

Refer to `/STAGE1_BLUEPRINT.md` for the primary blueprint document.

### Quick Reference of Stage 1 Rules:

1. **Telegram Deep Linking**:
   - URL: `https://t.me/<BOT_USERNAME>?start=<ONE_TIME_TOKEN>`
   - Customer taps START -> Telegram sends `/start <token>` to Apps Script `doPost(e)`.
   - Apps Script validates token in `TelegramTokens` sheet, binds `telegramChatId`, and marks token used.
   - No manual typing of Chat IDs. Chat IDs are private and never leaked.

2. **Customer Identity Protection**:
   - `customerAuthToken` (opaque 256-bit crypto hex) required on all customer endpoints:
     - `registerTrial`
     - `requestRenewalTrial`
     - `submitPaymentProof`
   - Customers can only access/manipulate their own records.
   - Customers can never retrieve subscriber lists, other customer names, emails, phone numbers, Telegram IDs, UTRs, or admin notes.

3. **Admin Google Token Verification**:
   - Cryptographically validates:
     - Valid Google ID token
     - Correct OAuth audience/client ID (`aud === GOOGLE_CLIENT_ID`)
     - `email === "mihirkapuria@gmail.com"`
     - `email_verified === true`
     - Token has not expired (`exp > now`)
   - Rejects if any check fails.

4. **Buffer Date Formulas (Inclusive)**:
   - `bufferStartDate = adminConfirmedPaymentDate`
   - `bufferEndDate = adminConfirmedPaymentDate + 4 days`
   - `paidStartDate = adminConfirmedPaymentDate + 5 days`
   - `paidEndDate = paidStartDate + 12 months`
   - Example (Oct 3 payment):
     - Oct 3 = buffer/news day
     - Oct 4 = buffer/news day
     - Oct 5 = buffer/news day
     - Oct 6 = buffer/news day
     - Oct 7 = buffer/news day
     - Oct 8 = paid subscription begins
   - Continuous news delivered Oct 3 through Oct 7, formal 12-month paid subscription starts Oct 8.
