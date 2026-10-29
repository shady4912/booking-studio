# CasaHelp Booking Studio

Booking Studio is a local-first service editor with an optional Render/PostgreSQL
deployment path. It is separate from the Cost Calculator Builder WordPress
plugin.

## Run locally

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:4173>. Local development binds to loopback and stores
projects and test bookings as JSON under `.data/`. The browser also keeps a
recovery copy. Export project JSON backups before moving work to another
environment.

Run the automated checks with `npm test`.

## Configure and publish a service

1. Edit the service's questions, add-ons, appearance, timezone, pricing, and
   availability in the studio.
2. Set real business-approved rates. The server rejects confirmations where
   any applicable charge is unpriced.
3. Configure the business IANA timezone, hours, duration, buffers, capacity,
   notice period, and blackout dates. Confirm the hours with the business and
   mark them verified. The selected initial launch uses manually managed hours;
   there is no external calendar sync.
4. Save the service and use **Publish**. The customer page is available at
   `/book/<slug>`. Customers choose an available time, accept the privacy notice,
   complete the booking form, and receive a confirmation email when Resend is
   configured. No online payment is taken.
5. Use **Bookings** in the studio to view bookings and cancel a confirmed
   appointment. A cancellation queues customer and business email notices.

Public booking is not enabled for an unpublished service. Publishing requires
verified hours. Booking confirmation also requires configured, valid prices.
The deployment refuses to start without production database, email, anti-bot,
administrator, canonical URL, and privacy-policy settings.

## Email delivery with Resend

Confirmed bookings queue a customer confirmation and a separate business
notification for each configured address. Cancellation queues notices too.
Messages are stored in the booking ledger and retried with exponential backoff;
after eight failed attempts they are marked failed and logged. Resend
idempotency keys protect retries against duplicate sends.

1. **Revoke any Resend key that has been shared in chat, tickets, or source
   control.** Create a replacement, and only enter it directly in Render's
   secret Environment setting. Never put it in a source file or share it in
   chat.
2. In Resend, add the recommended sending subdomain
   `bookings.quantumsoftworks.com`.
3. Resend provides the exact DNS records. Add those records in Hostinger's DNS
   zone for `quantumsoftworks.com`; do not guess or alter record names/values.
   Wait until Resend shows the sending subdomain as verified. See
   [Resend's domain setup](https://resend.com/docs/add-a-domain).
4. Set the verified sender, for example
   `CasaHelp bookings <bookings@bookings.quantumsoftworks.com>`.

## Prepare Render

`render.yaml` defines a single-instance Node web service, health check, and
environment-variable prompts. It does not create a database or deploy the
service by itself. A private Git repository and access to the Render account
are required; this workspace currently has no Git repository configured.

1. Revoke the exposed Resend key and create a replacement. Do not paste it into
   this repository or chat.
2. Add this project to a private Git repository under your account and connect
   that repository to Render. Review the files and backups first; do not upload
   customer booking data.
3. Create a Render PostgreSQL database in the same region as the web service.
   Choose a paid persistent database tier suitable for production and set its
   internal connection string as `DATABASE_URL`. Render Postgres setup is
   covered in [Render's database docs](https://render.com/docs/databases).
4. Create the web service from `render.yaml`. The app uses `npm ci`, `npm
   start`, and `/healthz`. Keep one web instance: the email worker is in-process.
   Choose a paid, always-on web tier before accepting bookings; free instances
   can sleep and are not an appropriate production booking host.
5. In Render's **Environment** settings, enter:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `PUBLIC_BASE_URL` | The exact HTTPS Render service origin, with no trailing path |
   | `DATABASE_URL` | Render Postgres internal connection string |
   | `DATABASE_SSL` | `false` when using Render's internal database URL |
   | `BOOKING_ADMIN_EMAILS` | `sadyslim49@gmail.com,casaHelp.office@gmail.com` |
   | `BOOKING_NOTIFICATION_EMAILS` | `sadyslim49@gmail.com,casaHelp.office@gmail.com` |
   | `RESEND_API_KEY` | Replacement key, entered only in Render |
   | `RESEND_FROM` | Verified sender on `bookings.quantumsoftworks.com` |
   | `TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key for the Render hostname |
   | `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret, entered only in Render |
   | `PRIVACY_POLICY_URL` | Public HTTPS URL to the business's actual privacy notice |

6. Create a Cloudflare Turnstile widget with the Render hostname, then add its
   site and secret keys in Render. The server checks each booking token with
   Cloudflare and validates the expected hostname and action.
7. Deploy, confirm `/healthz` is healthy, and test administrator sign-in,
   publishing, public booking, Resend delivery, cancellation emails, and
   Turnstile on the Render URL before sharing it.
8. Configure database backups and verify a restore process. Local `.data`
   drafts are not automatically copied to Render; import only the service
   projects you intend to publish.

The two addresses above are configured both as administrators and as booking
notification recipients. Studio access uses one-time Resend email links,
10-minute magic-link expiry, hashed tokens in PostgreSQL, and secure HTTP-only
session cookies. Project and booking-management APIs require administrator
sign-in. Public service data and booking endpoints are deliberately separate.

## Production limitations and launch checks

- The selected initial launch uses manually maintained hours. Staff must keep
  the Booking Studio schedule synchronized with any external calendars.
- Online payments, refunds, calendar sync, and customer self-service
  cancellation are not implemented.
- Before collecting customer details, publish a privacy notice that accurately
  identifies the business, purpose, retention, rights, and service providers.
  The deployment requires its HTTPS URL and requires the customer to acknowledge
  it before confirming.
- Verify actual business rates, timezone, capacity, hours, blackout dates, and
  email deliverability before sharing a public link.
- Render and Resend accounts, domain DNS changes, secret values, and billing
  decisions must be completed by the account owner. Do not use this prototype
  to accept real bookings until those items have been verified.
