import { BookingError, BookingService } from "./bookings.mjs";
import {
  createBookingEmailMessages,
  createCancellationEmailMessages,
  parseEmailRecipients,
  sendResendEmail,
} from "./email.mjs";

const emptyLedger = () => ({ holds: [], bookings: [], holdKeys: {}, confirmKeys: {}, emailOutbox: [] });
const getProject = async (env, projectId) => {
  const row = await env.DB.prepare("SELECT project FROM booking_projects WHERE project_id = ?")
    .bind(projectId).first();
  return row ? JSON.parse(row.project) : null;
};
const getLedger = async (env, projectId) => {
  const row = await env.DB.prepare("SELECT ledger FROM booking_ledgers WHERE project_id = ?")
    .bind(projectId).first();
  return row ? JSON.parse(row.ledger) : emptyLedger();
};
const saveLedger = async (env, projectId, ledger) => {
  await env.DB.prepare(`
    INSERT INTO booking_ledgers (project_id, ledger, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET ledger = excluded.ledger, updated_at = excluded.updated_at
  `).bind(projectId, JSON.stringify(ledger), new Date().toISOString()).run();
};

export class BookingProjectObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    const businessRecipients = parseEmailRecipients(env.BOOKING_NOTIFICATION_EMAILS || "");
    this.service = new BookingService({
      loadProject: (projectId) => getProject(env, projectId),
      loadLedger: (projectId) => getLedger(env, projectId),
      saveLedger: (projectId, ledger) => saveLedger(env, projectId, ledger),
      createEmailMessages: env.RESEND_API_KEY
        ? (details) => createBookingEmailMessages({
          ...details,
          businessRecipients,
        })
        : undefined,
      createCancellationEmailMessages: env.RESEND_API_KEY
        ? (details) => createCancellationEmailMessages({
          ...details,
          businessRecipients,
        })
        : undefined,
    });
  }

  async fetch(request) {
    try {
      const { action, payload = {} } = await request.json();
      const projectId = this.ctx.id.name;
      let result;
      if (action === "availability") {
        result = await this.service.availability(projectId, payload.from, payload.days);
      } else if (action === "hold") {
        result = await this.service.createHold({ ...payload, projectId });
      } else if (action === "confirm") {
        result = await this.service.confirmBooking({ ...payload, projectId });
      } else if (action === "release") {
        result = await this.service.releaseHold(projectId, payload.holdId);
      } else if (action === "cancel") {
        result = await this.service.cancelBooking(projectId, payload.bookingId);
      } else if (action === "list") {
        result = await this.service.listBookings(projectId);
      } else if (action === "deliver-emails") {
        result = await this.deliverEmails(projectId);
      } else {
        throw new BookingError(404, "Booking operation not found.");
      }
      return Response.json(result);
    } catch (error) {
      if (error instanceof BookingError || Number.isInteger(error.status)) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      console.error("Durable booking operation failed.", error);
      return Response.json({ error: "Booking operation failed." }, { status: 500 });
    }
  }

  async deliverEmails(projectId) {
    if (!this.env.RESEND_API_KEY || !this.env.RESEND_FROM) return { sent: 0 };
    return this.service.serialize(async () => {
      const ledger = await getLedger(this.env, projectId);
      ledger.emailOutbox ||= [];
      let sent = 0;
      for (const message of ledger.emailOutbox.filter((item) =>
        item.status === "pending" && Date.parse(item.nextAttemptAt) <= Date.now(),
      )) {
        let deliveryError;
        try {
          await sendResendEmail({
            apiKey: this.env.RESEND_API_KEY,
            from: this.env.RESEND_FROM,
            message,
          });
        } catch (error) {
          deliveryError = error;
        }
        message.attempts += 1;
        if (deliveryError) {
          message.lastError = deliveryError.message.slice(0, 300);
          if (message.attempts >= 8) {
            message.status = "failed";
          } else {
            const delay = Math.min(60_000 * 2 ** (message.attempts - 1), 6 * 60 * 60 * 1000);
            message.nextAttemptAt = new Date(Date.now() + delay).toISOString();
          }
          console.error(`Email delivery failed for queued message ${message.id}: ${message.lastError}`);
        } else {
          message.status = "sent";
          message.sentAt = new Date().toISOString();
          delete message.lastError;
          sent += 1;
        }
      }
      await saveLedger(this.env, projectId, ledger);
      return { sent };
    });
  }
}
