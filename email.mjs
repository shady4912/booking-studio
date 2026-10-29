const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailAddress(value) {
  return emailPattern.test(value);
}

export function isValidSender(value) {
  if (/[\r\n]/.test(value)) return false;
  const match = /^(?:[^<>]*<([^<>]+)>|([^<>\s]+))$/.exec(value.trim());
  return Boolean(match && emailPattern.test(match[1] || match[2]));
}

export function parseEmailRecipients(value) {
  if (!value.trim()) return [];
  const recipients = value.split(",").map((email) => email.trim()).filter(Boolean);
  if (recipients.length !== value.split(",").length || recipients.some((email) => !emailPattern.test(email))) {
    throw new Error("BOOKING_NOTIFICATION_EMAILS must contain valid comma-separated email addresses.");
  }
  return [...new Set(recipients)];
}

export function createBookingEmailMessages({ booking, project, businessRecipients }) {
  const serviceName = booking.serviceName;
  const dateTime = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: booking.appointment.timezone,
  }).format(new Date(booking.appointment.start));
  const total = new Intl.NumberFormat("en", {
    style: "currency",
    currency: booking.quote.currency,
  }).format(booking.quote.totalMinor / 100);
  const details = [
    `Service: ${serviceName}`,
    `Appointment: ${dateTime} (${booking.appointment.timezone})`,
    `Total: ${total}`,
    `Booking reference: ${booking.id}`,
  ].join("\n");
  const customerDetails = project.sections
    .flatMap((section) => section.fields || [])
    .filter((field) => /^(?:email|text)$/.test(field.type) && /name|email|phone/i.test(field.label))
    .filter((field) => booking.answers[field.id])
    .map((field) => `${field.label}: ${booking.answers[field.id]}`)
    .join("\n");
  const messages = [];
  const emailField = project.sections
    .flatMap((section) => section.fields || [])
    .find((field) => field.type === "email" && booking.answers[field.id]);
  if (emailField) {
    messages.push({
      to: booking.answers[emailField.id],
      subject: `Booking confirmed: ${serviceName}`,
      text: `Your booking is confirmed.\n\n${details}`,
    });
  }
  for (const recipient of businessRecipients) {
    messages.push({
      to: recipient,
      subject: `New booking: ${serviceName}`,
      text: `A new booking has been confirmed.\n\n${details}${customerDetails ? `\n\nCustomer contact:\n${customerDetails}` : ""}`,
    });
  }
  return messages;
}

export function createCancellationEmailMessages({ booking, project, businessRecipients }) {
  const dateTime = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: booking.appointment.timezone,
  }).format(new Date(booking.appointment.start));
  const details = [
    `Service: ${booking.serviceName}`,
    `Appointment: ${dateTime} (${booking.appointment.timezone})`,
    `Booking reference: ${booking.id}`,
  ].join("\n");
  const emailField = project.sections
    .flatMap((section) => section.fields || [])
    .find((field) => field.type === "email" && booking.answers[field.id]);
  const customerDetails = project.sections
    .flatMap((section) => section.fields || [])
    .filter((field) => /^(?:email|text)$/.test(field.type) && /name|email|phone/i.test(field.label))
    .filter((field) => booking.answers[field.id])
    .map((field) => `${field.label}: ${booking.answers[field.id]}`)
    .join("\n");
  const messages = [];
  if (emailField) {
    messages.push({
      to: booking.answers[emailField.id],
      subject: `Booking cancelled: ${booking.serviceName}`,
      text: `Your booking has been cancelled.\n\n${details}`,
    });
  }
  for (const recipient of businessRecipients) {
    messages.push({
      to: recipient,
      subject: `Booking cancelled: ${booking.serviceName}`,
      text: `A booking has been cancelled.\n\n${details}${customerDetails ? `\n\nCustomer contact:\n${customerDetails}` : ""}`,
    });
  }
  return messages;
}

export async function sendResendEmail({ apiKey, from, message, fetchImpl = fetch }) {
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": message.id,
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Resend rejected email (HTTP ${response.status}).`);
  }
}
