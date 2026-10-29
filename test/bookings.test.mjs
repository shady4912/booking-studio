import test from "node:test";
import assert from "node:assert/strict";
import { BookingError, BookingService, defaultAvailability } from "../bookings.mjs";

const projectId = "2b7bca11-c5aa-4c6e-87f8-20d9686be225";
const nextMonday = (timestamp) => {
  const date = new Date(timestamp);
  const daysUntilMonday = ((8 - date.getUTCDay()) % 7) || 7;
  date.setUTCDate(date.getUTCDate() + daysUntilMonday);
  return date.toISOString().slice(0, 10);
};
const makeProject = (overrides = {}) => ({
  version: 1,
  projectId,
  service: {
    name: "Example test service",
    timezone: "Europe/Berlin",
    pricing: { currency: "EUR", baseFee: "50.00", discountType: "none", discountValue: "", minimum: "" },
    availability: {
      ...defaultAvailability(),
      mode: "verified",
      durationMinutes: 60,
      bufferMinutes: 0,
      capacity: 1,
      holdMinutes: 10,
      horizonDays: 30,
      minimumNoticeMinutes: 0,
      workingHours: { 0: null, 1: { start: "09:00", end: "11:00" }, 2: null, 3: null, 4: null, 5: null, 6: null },
    },
  },
  sections: [{
    id: "contact",
    title: "Contact",
    type: "questions",
    fields: [{ id: "email", label: "Email", type: "email", required: true, options: [] }],
  }],
  ...overrides,
});
const createMemoryService = (
  project,
  clock,
  createEmailMessages = () => [],
  createCancellationEmailMessages = () => [],
) => {
  const ledgers = new Map();
  const service = new BookingService({
    loadProject: async (id) => id === projectId ? project : null,
    loadLedger: async (id) => structuredClone(ledgers.get(id) || { holds: [], bookings: [], holdKeys: {}, confirmKeys: {} }),
    saveLedger: async (id, ledger) => ledgers.set(id, structuredClone(ledger)),
    createEmailMessages,
    createCancellationEmailMessages,
    clock,
  });
  return { service, ledgers };
};

test("returns timezone-aware working-hour slots and excludes blackout dates", async () => {
  const now = Date.parse("2026-10-22T00:00:00.000Z");
  const monday = nextMonday(now);
  const project = makeProject();
  project.service.availability.blackoutDates = [monday];
  const { service } = createMemoryService(project, () => now);
  const blackedOut = await service.availability(projectId, monday, 1);
  assert.equal(blackedOut.slots.length, 0);

  project.service.availability.blackoutDates = [];
  const available = await service.availability(projectId, monday, 1);
  assert.equal(available.timezone, "Europe/Berlin");
  assert.deepEqual(available.slots.map((slot) => slot.localTime), ["09:00", "10:00"]);
  assert.equal(available.slots[0].start, `${monday}T08:00:00.000Z`);
});

test("only one simultaneous hold can claim capacity one and expired holds reopen the slot", async () => {
  let now = Date.parse("2026-10-22T00:00:00.000Z");
  const monday = nextMonday(now);
  const { service } = createMemoryService(makeProject(), () => now);
  const availability = await service.availability(projectId, monday, 1);
  const slotStart = availability.slots[0].start;
  const results = await Promise.allSettled([
    service.createHold({ projectId, slotStart, idempotencyKey: "hold-key-one" }),
    service.createHold({ projectId, slotStart, idempotencyKey: "hold-key-two" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.status === 409).length, 1);

  const held = results.find((result) => result.status === "fulfilled").value;
  now += 11 * 60 * 1000;
  const reopened = await service.availability(projectId, monday, 1);
  assert.ok(reopened.slots.some((slot) => slot.start === slotStart));
  await assert.rejects(
    service.confirmBooking({
      projectId, holdId: held.id, idempotencyKey: "confirm-key-one",
      inputAnswers: { email: "person@example.com" },
    }),
    (error) => error instanceof BookingError && error.status === 409,
  );
});

test("confirmation is idempotent, validates required answers, and stores a price snapshot", async () => {
  const now = Date.parse("2026-10-22T00:00:00.000Z");
  const monday = nextMonday(now);
  const { service, ledgers } = createMemoryService(makeProject(), () => now);
  const slot = (await service.availability(projectId, monday, 1)).slots[0];
  const hold = await service.createHold({ projectId, slotStart: slot.start, idempotencyKey: "hold-confirm-01" });
  await assert.rejects(
    service.confirmBooking({ projectId, holdId: hold.id, idempotencyKey: "confirm-missing", inputAnswers: {} }),
    (error) => error instanceof BookingError && error.status === 400 && /Email is required/.test(error.message),
  );
  const request = {
    projectId, holdId: hold.id, idempotencyKey: "confirm-same-key",
    inputAnswers: { email: "person@example.com" },
  };
  const [first, retry] = await Promise.all([
    service.confirmBooking(request),
    service.confirmBooking(request),
  ]);
  assert.equal(first.id, retry.id);
  assert.equal(first.status, "confirmed");
  assert.equal(first.quote.totalMinor, 5000);
  assert.equal(first.quote.pricingSnapshot.baseFee, "50.00");
  assert.equal((await service.listBookings(projectId)).length, 1);
  assert.equal(ledgers.get(projectId).holds[0].status, "confirmed");
});

test("confirmation queues email notifications once, including on idempotent retries", async () => {
  const now = Date.parse("2026-10-22T00:00:00.000Z");
  const monday = nextMonday(now);
  const { service, ledgers } = createMemoryService(makeProject(), () => now, ({ booking }) => [{
    to: "person@example.com",
    subject: `Booking confirmed: ${booking.serviceName}`,
    text: `Booking ${booking.id} confirmed.`,
  }]);
  const slot = (await service.availability(projectId, monday, 1)).slots[0];
  const hold = await service.createHold({ projectId, slotStart: slot.start, idempotencyKey: "hold-email-01" });
  const request = {
    projectId, holdId: hold.id, idempotencyKey: "confirm-email-01",
    inputAnswers: { email: "person@example.com" },
  };

  await service.confirmBooking(request);
  await service.confirmBooking(request);

  const [message] = ledgers.get(projectId).emailOutbox;
  assert.equal(ledgers.get(projectId).emailOutbox.length, 1);
  assert.equal(message.to, "person@example.com");
  assert.equal(message.status, "pending");
  assert.equal(message.attempts, 0);
});

test("cancellation queues customer and business emails once", async () => {
  const now = Date.parse("2026-10-22T00:00:00.000Z");
  const monday = nextMonday(now);
  const { service, ledgers } = createMemoryService(
    makeProject(),
    () => now,
    () => [{ to: "person@example.com", subject: "Confirmed", text: "Confirmed" }],
    () => [
      { to: "person@example.com", subject: "Cancelled", text: "Cancelled" },
      { to: "business@example.com", subject: "Cancelled", text: "Cancelled" },
    ],
  );
  const slot = (await service.availability(projectId, monday, 1)).slots[0];
  const hold = await service.createHold({ projectId, slotStart: slot.start, idempotencyKey: "hold-cancel-01" });
  const booking = await service.confirmBooking({
    projectId,
    holdId: hold.id,
    idempotencyKey: "confirm-cancel-01",
    inputAnswers: { email: "person@example.com" },
  });

  await service.cancelBooking(projectId, booking.id);
  await service.cancelBooking(projectId, booking.id);

  const outbox = ledgers.get(projectId).emailOutbox;
  assert.equal(outbox.length, 3);
  assert.deepEqual(outbox.slice(1).map(({ to }) => to), ["person@example.com", "business@example.com"]);
  assert.ok(outbox.slice(1).every(({ status }) => status === "pending"));
});

test("rejects confirmations until the example schedule is explicitly verified", async () => {
  const now = Date.parse("2026-10-22T00:00:00.000Z");
  const monday = nextMonday(now);
  const project = makeProject();
  project.service.availability.mode = "demo";
  const { service } = createMemoryService(project, () => now);
  const slot = (await service.availability(projectId, monday, 1)).slots[0];
  const hold = await service.createHold({ projectId, slotStart: slot.start, idempotencyKey: "hold-demo-01" });
  await assert.rejects(
    service.confirmBooking({
      projectId, holdId: hold.id, idempotencyKey: "confirm-demo-01",
      inputAnswers: { email: "person@example.com" },
    }),
    (error) => error instanceof BookingError && error.status === 409 && /Verify the business hours/.test(error.message),
  );
});

test("skips nonexistent local times across daylight-saving transitions", async () => {
  const project = makeProject();
  project.service.availability.workingHours = {
    0: { start: "02:00", end: "04:00" }, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null,
  };
  project.service.availability.durationMinutes = 60;
  project.service.availability.horizonDays = 90;
  project.service.availability.minimumNoticeMinutes = 0;
  const now = Date.parse("2027-03-27T00:00:00.000Z");
  const { service } = createMemoryService(project, () => now);
  const slots = await service.availability(projectId, "2027-03-28", 1);
  assert.deepEqual(slots.slots.map((slot) => slot.localTime), ["03:00"]);
  assert.equal(slots.slots[0].start, "2027-03-28T01:00:00.000Z");
});
