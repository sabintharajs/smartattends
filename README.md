# Smart Attendance Management System

A period-wise college attendance application with a React dashboard, an Express API, MySQL persistence, role-based sign-in, and separate WhatsApp Cloud API alerts for parents and HODs.

## Requirements

- Node.js 20 or newer
- MySQL 8.0 or newer
- A Meta WhatsApp Business Cloud API phone number and access token to send real WhatsApp alerts

## Local setup

1. Install the JavaScript dependencies:

   ```powershell
   npm install
   ```

2. Create the database and tables in MySQL:

   ```powershell
   mysql -u root -p < database/schema.sql
   ```

3. Create a local environment file and edit the database, secret, and admin settings:

   ```powershell
   Copy-Item .env.example .env
   ```

   Set `JWT_SECRET` to a cryptographically random value of at least 32 characters. Set `ADMIN_EMAIL` and a unique `ADMIN_PASSWORD` of at least 12 characters. Configure `DB_HOST`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` for your MySQL server.

4. Create the initial administrator account:

   ```powershell
   npm run seed:admin
   ```

5. Start the frontend and API in development mode:

   ```powershell
   npm run dev
   ```

   Open `http://localhost:5173`. The API health check is at `http://localhost:4000/api/health`.

The first sign-in is the administrator account configured above. In **Manage college**, add departments, classes, subjects, faculty and their login accounts, HOD contact/login details, periods, and timetable assignments. Add students with a parent/guardian WhatsApp number and record their explicit notification consent. Faculty sign in with their faculty ID; HODs sign in with their configured login ID.

The Express API listens on port `4000` by default. If you set `PORT` in `.env`, the Vite development proxy uses the same port; restart both the API and Vite after changing it.

The Forgot Password form sends `POST /api/auth/forgot-password`; Vite proxies `/api` to the Express API port. If this endpoint returns 404, an older Express process may still be listening on that port. Stop that process, then start the updated API from this project with `npm run server` (or restart both services with `npm run dev`). Do not start a second API on the same port.

Faculty, students, and HODs can submit registration requests from the sign-in page. An administrator must approve each request in **Manage college** before the account can sign in. Faculty use their faculty ID, students use their registration email, and HODs use their chosen login ID. Student requests create a profile linked to the selected class; parent contact details are optional, and WhatsApp alerts remain disabled unless the guardian has explicitly consented. Approved students can view only their own attendance history. Administrator accounts are created through the seed process or managed by an administrator, not public sign-up.

For an existing database, rerun `database/schema.sql` before starting the updated server. The schema updates the student login role and safely adds the registration password-hash column required to activate approved accounts, including when a registration table already exists:

```powershell
mysql -u root -p < database/schema.sql
```

## Password recovery

The login page's **Forgot Password?** link sends a generic recovery response and emails a one-time reset link when the account has a registered email address. Links expire after 30 minutes. To enable delivery, configure these values in `.env` using your SMTP provider's credentials:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASSWORD=your-smtp-password
MAIL_FROM=Smart Attendance <no-reply@example.com>
CLIENT_ORIGIN=http://localhost:5173
```

Use the TLS/SSL settings and verified sender address required by your provider; port 465 generally uses `SMTP_SECURE=true`, while port 587 generally uses `SMTP_SECURE=false` with STARTTLS. For Gmail, use `smtp.gmail.com`, port `587`, `SMTP_SECURE=false`, your Gmail address as `SMTP_USER`, and a Google app password as `SMTP_PASSWORD` (not your regular Gmail password). Keep SMTP credentials private. Restart the server after changing `.env`. The recovery endpoint verifies SMTP and the reset-token schema before looking up an account and returns a service error when required settings are missing or unavailable; these checks do not reveal whether the account exists. Individual email-delivery failures are recorded in the API logs while the public response stays generic to prevent account enumeration. SMTP connection, greeting, and socket operations have bounded timeouts. HOD accounts need a registered email; add it through college setup if the HOD account predates this field.

If SMTP is not configured or a user cannot access their email, an administrator can use **Manage college → Admin password reset**. The reset is restricted to signed-in administrators, invalidates outstanding reset links, and requires a 12-character password containing uppercase and lowercase letters, a number, and a symbol. Apply the database changes before using recovery features:

```powershell
Get-Content .\database\schema.sql | mysql -u root -p
npm run dev
```

To test email recovery, request a reset from the login page for an account with an email address, open the received link within 30 minutes, and set a new password. The new password can then be used on the matching role's login portal.

## WhatsApp Cloud API

Configure these values in `.env` from your Meta developer app:

- `META_WHATSAPP_TOKEN`: a valid WhatsApp Cloud API access token
- `META_PHONE_NUMBER_ID`: the sending phone number ID
- `META_WHATSAPP_TEMPLATE`: the name of an approved WhatsApp message template
- `META_WHATSAPP_TEMPLATE_LANGUAGE`: the approved template language code, default `en`
- `META_VERIFY_TOKEN`: a private string used when registering the webhook callback
- `META_APP_SECRET`: the Meta app secret used to authenticate webhook signatures
- `META_API_VERSION`: Graph API version, default `v21.0`

Keep every Meta credential in the backend environment; do not add them to frontend settings or source control. Create and get approval for a utility template that takes four body parameters, in order: student name, register number, department and year/section, and attendance date. Configure its exact name and language above. The template's approved copy should notify the parent/guardian that the student was marked absent and include the college contact/sign-off. Business-initiated absence alerts use this approved template rather than free-form messages.

Expose the API over HTTPS and configure the callback URL as `https://your-host/api/whatsapp/webhook`, subscribing to WhatsApp message status updates. Use the same `META_VERIFY_TOKEN` in Meta's webhook verification settings. The webhook verifies Meta's `X-Hub-Signature-256` signature before recording delivery updates. Send recipient phone numbers in international format with country code.

After attendance is saved, a single parent notification is created per student, class, and attendance date, and only if a registered WhatsApp number has explicit guardian consent. Present attendance never triggers a message. Repeated saves and multiple period entries on the same date do not create duplicate daily alerts. Correcting an absence to present retains its history and prevents pending sends; a later correction back to absent does not send a second daily alert. The API records provider acceptance as **Sent**; Meta delivery webhooks update the state to **Delivered** or **Failed**. An administrator or department HOD can retry a failed alert while attendance remains absent and consent is active. The notification history shows parent number, student, register number, attendance date, attempt count, delivery status, and provider failure reason; the totals are scoped to the viewer's authorized departments.

WhatsApp credentials and the approved template configuration are intentionally optional for local development. Without them, opted-in absence notifications are retained as **Failed** with a configuration error and no message is sent. Run `database/schema.sql` before starting the updated server so the guardian-consent and in-progress delivery fields are available.

## Production

Build the client and start the API:

```powershell
npm run build
npm start
```

The Express server serves the built frontend from `dist` and the API from `/api`. Deploy behind HTTPS, configure a production `CLIENT_ORIGIN`, use a secret manager for credentials, and restrict database network access. Set the server timezone to the college's timezone so the configured period editing deadlines align with local time.

## Features

- Separate Admin, Faculty, HOD, and Student login portals with bcrypt password hashes, JWT sessions, rate-limited login, and role-based API access.
- Single-use, expiring email password-reset links and an administrator-only password-reset fallback.
- Admin configuration for departments, classes, student profiles and parent contacts, faculty logins, HOD contacts/logins, subjects, configurable periods, and timetable assignments.
- Faculty period attendance, saved attendance history, class roster search, and an editable submission window based on each period's configured end time and deadline.
- HOD/admin dashboards, department-scoped HOD views, notification history, date-range reports, and Excel-compatible CSV export (CSV can also be printed/saved to PDF from the browser).
- Transactional MySQL attendance persistence, duplicate-safe per-student attendance, consent-gated Meta WhatsApp template notifications, delivery history, retry support, and correction history.

## Notes

- Student photo URLs are stored as profile metadata; upload/storage hosting is not included.
- Attendance reports export to CSV, which opens in Excel. Use the browser print dialog to save a report view as PDF.
- Production WhatsApp delivery requires a Meta-approved sender, correctly configured templates where required by Meta's conversation policy, and opted-in recipients.
