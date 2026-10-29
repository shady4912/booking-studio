import test from "node:test";
import assert from "node:assert/strict";
import {
  createBookingEmailMessages,
  createCancellationEmailMessages,
  isValidSender,
  parseEmailRecipients,
  sendResendEmail,
} from "../email.mjs";

test("parses and validates distinct business notification recipients", () => {
  assert.deepEqual(
    parseEmailRecipients("one@example.com, two@example.com,one@example.com"),
    ["one@example.com", "two@example.com"],
  );
  assert.throws(() => parseEmailRecipients("one@example.com,invalid"), /valid comma-separated/);
  assert.equal(isValidSender("CasaHelp bookings <bookings@example.com>"), true);
  assert.equal(isValidSender("invalid sender\r\nBcc: attacker@example.com"), false);
});

test("creates customer confirmation and separate business notification emails", () => {
  const booking = {
    id: "booking-reference",
    serviceName: "Example service",
    answers: { customerEmail: "person@example.com" },
    appointment: {
      start: "2026-10-26T08:00:00.000Z",
      timezone: "Europe/Berlin",
    },
    quote: { currency: "EUR", totalMinor: 5000 },
  };
  const messages = createBookingEmailMessages({
    booking,
    project: {
      sections: [{ fields: [{ id: "customerEmail", type: "email", label: "Email" }] }],
    },
    businessRecipients: ["staff-one@example.com", "staff-two@example.com"],
  });

  assert.deepEqual(messages.map(({ to }) => to), [
    "person@example.com",
    "staff-one@example.com",
    "staff-two@example.com",
  ]);
  assert.equal(messages[0].subject, "Booking confirmed: Example service");
  assert.match(messages[0].text, /€50\.00/);
  assert.match(messages[1].text, /Customer contact/);
  assert.doesNotMatch(messages[1].text, /access_details|Special Instructions/);
});

test("builds cancellation emails for the customer and business", () => {
  const messages = createCancellationEmailMessages({
    booking: {
      id: "booking-reference",
      serviceName: "Example service",
      answers: { customerEmail: "person@example.com", firstName: "Sam" },
      appointment: { start: "2026-10-26T08:00:00.000Z", timezone: "Europe/Berlin" },
    },
    project: {
      sections: [{
        fields: [
          { id: "customerEmail", type: "email", label: "Email" },
          { id: "firstName", type: "text", label: "First name" },
          { id: "access_details", type: "select", label: "Access details" },
        ],
      }],
    },
    businessRecipients: ["staff@example.com"],
  });
  assert.deepEqual(messages.map(({ to }) => to), ["person@example.com", "staff@example.com"]);
  assert.match(messages[0].text, /booking has been cancelled/);
  assert.match(messages[1].text, /First name: Sam/);
});

test("sends through Resend with an idempotency key and reports rejected requests", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true };
  };
  await sendResendEmail({
    apiKey: "test-key",
    from: "CasaHelp <bookings@example.com>",
    message: { id: "email-id", to: "person@example.com", subject: "Confirmed", text: "Thanks" },
    fetchImpl,
  });
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(request.options.headers["Idempotency-Key"], "email-id");
  assert.deepEqual(JSON.parse(request.options.body).to, ["person@example.com"]);

  await assert.rejects(sendResendEmail({
    apiKey: "test-key",
    from: "CasaHelp <bookings@example.com>",
    message: { id: "email-id", to: "person@example.com", subject: "Confirmed", text: "Thanks" },
    fetchImpl: async () => ({ ok: false, status: 422 }),
  }), /Resend rejected email \(HTTP 422\)/);
});
