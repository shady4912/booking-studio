import { randomUUID } from "node:crypto";
import { calculatePreviewQuote } from "./pricing.mjs";

export class BookingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const defaultAvailability = () => ({
  mode: "demo",
  durationMinutes: 60,
  bufferMinutes: 0,
  capacity: 1,
  holdMinutes: 10,
  horizonDays: 30,
  minimumNoticeMinutes: 60,
  workingHours: {
    0: null,
    1: { start: "09:00", end: "17:00" },
    2: { start: "09:00", end: "17:00" },
    3: { start: "09:00", end: "17:00" },
    4: { start: "09:00", end: "17:00" },
    5: { start: "09:00", end: "17:00" },
    6: null,
  },
  blackoutDates: [],
});

export function availabilitySettings(service) {
  const saved = service.availability || {};
  const defaults = defaultAvailability();
  return {
    ...defaults,
    ...saved,
    workingHours: { ...defaults.workingHours, ...(saved.workingHours || {}) },
    blackoutDates: Array.isArray(saved.blackoutDates) ? saved.blackoutDates : [],
  };
}

export function validateAvailabilitySettings(service) {
  const settings = availabilitySettings(service);
  const fail = (message) => { throw new BookingError(400, message); };
  if (!["demo", "verified"].includes(settings.mode)) fail("Availability mode is invalid.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: service.timezone || "Europe/Berlin" });
  } catch {
    fail("Business timezone must be a valid IANA timezone.");
  }
  if (![15, 30, 45, 60, 90, 120, 180, 240, 360, 480].includes(settings.durationMinutes)) fail("Appointment duration is invalid.");
  if (!Number.isInteger(settings.bufferMinutes) || settings.bufferMinutes < 0 || settings.bufferMinutes > 240) fail("Appointment buffer must be between 0 and 240 minutes.");
  if (!Number.isInteger(settings.capacity) || settings.capacity < 1 || settings.capacity > 100) fail("Resource capacity must be between 1 and 100.");
  if (!Number.isInteger(settings.holdMinutes) || settings.holdMinutes < 1 || settings.holdMinutes > 30) fail("Hold duration must be between 1 and 30 minutes.");
  if (!Number.isInteger(settings.horizonDays) || settings.horizonDays < 1 || settings.horizonDays > 90) fail("Booking horizon must be between 1 and 90 days.");
  if (!Number.isInteger(settings.minimumNoticeMinutes) || settings.minimumNoticeMinutes < 0 || settings.minimumNoticeMinutes > 10080) fail("Minimum booking notice is invalid.");
  for (let day = 0; day < 7; day += 1) {
    const hours = settings.workingHours[day];
    if (hours == null) continue;
    if (!hours || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hours.start) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hours.end) || hours.start >= hours.end) {
      fail("Working hours must have a valid start and a later end time.");
    }
  }
  if (settings.blackoutDates.length > 366 || settings.blackoutDates.some((date) => !isDateKey(date))) {
    fail("Blackout dates must use YYYY-MM-DD format and be limited to one year.");
  }
  return settings;
}

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function dateKeyAt(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function weekdayFor(dateKey) {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

function localPartsAt(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function zonedDateTimeToUtc(dateKey, time, timezone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = target + hours * 60 * 60 * 1000;
    const local = localPartsAt(probe, timezone);
    offsets.add(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute)) - probe);
  }
  const candidates = [...offsets]
    .map((offset) => target - offset)
    .filter((candidate) => {
      const local = localPartsAt(candidate, timezone);
      return Number(local.year) === year && Number(local.month) === month &&
        Number(local.day) === day && Number(local.hour) === hour && Number(local.minute) === minute;
    })
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}

function dateRange(start, days) {
  const [year, month, day] = start.split("-").map(Number);
  const base = Date.UTC(year, month - 1, day);
  return Array.from({ length: days }, (_, index) => new Date(base + index * 86400000).toISOString().slice(0, 10));
}

function isOverlapping(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function activeReservations(ledger, now) {
  return ledger.holds.filter((hold) => hold.status === "held" && Date.parse(hold.expiresAt) > now)
    .concat(ledger.bookings.filter((booking) => booking.status === "confirmed"));
}

function buildSlots(project, ledger, from, days, now) {
  const service = project.service;
  const settings = validateAvailabilitySettings(service);
  const timezone = service.timezone || "Europe/Berlin";
  const firstDate = from || dateKeyAt(now, timezone);
  if (!isDateKey(firstDate)) throw new BookingError(400, "Availability start date must use YYYY-MM-DD format.");
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new BookingError(400, "Availability requests must cover between 1 and 14 days.");
  const lastDate = dateRange(dateKeyAt(now, timezone), settings.horizonDays)[settings.horizonDays - 1];
  const reservations = activeReservations(ledger, now);
  const cutoff = now + settings.minimumNoticeMinutes * 60000;
  const slots = [];
  for (const date of dateRange(firstDate, days)) {
    if (date > lastDate) continue;
    const hours = settings.workingHours[weekdayFor(date)];
    if (!hours || settings.blackoutDates.includes(date)) continue;
    const openMinute = Number(hours.start.slice(0, 2)) * 60 + Number(hours.start.slice(3));
    const closeMinute = Number(hours.end.slice(0, 2)) * 60 + Number(hours.end.slice(3));
    const step = settings.durationMinutes + settings.bufferMinutes;
    for (let minute = openMinute; minute + settings.durationMinutes <= closeMinute; minute += step) {
      const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      const startMs = zonedDateTimeToUtc(date, time, timezone);
      if (startMs == null || startMs < cutoff) continue;
      const endMs = startMs + settings.durationMinutes * 60000;
      const occupiedEndMs = endMs + settings.bufferMinutes * 60000;
      const occupied = reservations.filter((reservation) => {
        if (reservation.status === "held" && Date.parse(reservation.expiresAt) <= now) return false;
        const reservationStart = Date.parse(reservation.slotStart);
        const reservationEnd = Date.parse(reservation.slotEnd) + settings.bufferMinutes * 60000;
        return isOverlapping(startMs, occupiedEndMs, reservationStart, reservationEnd);
      }).length;
      if (occupied < settings.capacity) {
        slots.push({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), date, localTime: time });
      }
    }
  }
  return slots;
}

function cleanLedger(ledger, now) {
  ledger.holds = ledger.holds.filter((hold) => hold.status !== "held" || Date.parse(hold.expiresAt) > now);
  ledger.emailOutbox ||= [];
  return ledger;
}

function validIdempotencyKey(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(value);
}

function validateAnswers(project, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BookingError(400, "Booking answers are required.");
  const knownFields = new Map(project.sections.flatMap((section) => section.fields || []).map((field) => [field.id, field]));
  const answers = {};
  for (const [id, rawValue] of Object.entries(input)) {
    const field = knownFields.get(id);
    if (!field) throw new BookingError(400, "Booking contains an unknown question.");
    if (typeof rawValue !== "string" || rawValue.length > 2000) throw new BookingError(400, `Answer for ${field.label} is invalid.`);
    const value = rawValue.trim();
    if (!value) continue;
    if (field.type === "select" && !field.options?.includes(value)) throw new BookingError(400, `Choose a valid option for ${field.label}.`);
    if (field.type === "boolean" && !["yes", "no", "selected"].includes(value.toLowerCase())) throw new BookingError(400, `Answer for ${field.label} is invalid.`);
    if (field.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number) || (field.min != null && number < field.min) || (field.max != null && number > field.max)) {
        throw new BookingError(400, `Answer for ${field.label} is outside the allowed range.`);
      }
    }
    if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new BookingError(400, "Enter a valid email address.");
    answers[id] = value;
  }
  for (const field of knownFields.values()) {
    if (field.required && !answers[field.id]) throw new BookingError(400, `${field.label} is required.`);
  }
  return answers;
}

export class BookingService {
  constructor({
    loadProject,
    loadLedger,
    saveLedger,
    createEmailMessages = () => [],
    createCancellationEmailMessages = () => [],
    withWriteLock = (operation) => operation(),
    clock = () => Date.now(),
  }) {
    this.loadProject = loadProject;
    this.loadLedger = loadLedger;
    this.saveLedger = saveLedger;
    this.createEmailMessages = createEmailMessages;
    this.createCancellationEmailMessages = createCancellationEmailMessages;
    this.withWriteLock = withWriteLock;
    this.clock = clock;
    this.queue = Promise.resolve();
  }

  serialize(operation) {
    const result = this.queue.then(() => this.withWriteLock(operation));
    this.queue = result.catch(() => {});
    return result;
  }

  async availability(projectId, from, days = 7) {
    const project = await this.loadProject(projectId);
    if (!project) throw new BookingError(404, "Service project not found.");
    const ledger = await this.loadLedger(projectId);
    return {
      timezone: project.service.timezone || "Europe/Berlin",
      mode: availabilitySettings(project.service).mode,
      slots: buildSlots(project, ledger, from, days, this.clock()),
    };
  }

  async createHold({ projectId, slotStart, idempotencyKey }) {
    if (!validIdempotencyKey(idempotencyKey)) throw new BookingError(400, "A valid idempotency key is required.");
    return this.serialize(async () => {
      const now = this.clock();
      const project = await this.loadProject(projectId);
      if (!project) throw new BookingError(404, "Service project not found.");
      const ledger = cleanLedger(await this.loadLedger(projectId), now);
      const priorId = ledger.holdKeys[idempotencyKey];
      if (priorId) {
        const previous = ledger.holds.find((hold) => hold.id === priorId);
        if (previous?.slotStart !== slotStart) throw new BookingError(409, "This idempotency key was already used for another appointment.");
        if (previous?.status === "held" && Date.parse(previous.expiresAt) > now) return previous;
        throw new BookingError(409, "This hold request has expired. Select a slot again.");
      }
      if (typeof slotStart !== "string" || Number.isNaN(Date.parse(slotStart)) || !slotStart.endsWith("Z")) {
        throw new BookingError(400, "Appointment start must be a UTC timestamp.");
      }
      const slotDate = dateKeyAt(Date.parse(slotStart), project.service.timezone || "Europe/Berlin");
      const slot = buildSlots(project, ledger, slotDate, 1, now)
        .find((available) => available.start === slotStart);
      if (!slot) throw new BookingError(409, "That appointment is no longer available. Choose another slot.");
      const settings = availabilitySettings(project.service);
      const hold = {
        id: randomUUID(),
        projectId,
        slotStart: slot.start,
        slotEnd: slot.end,
        status: "held",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + settings.holdMinutes * 60000).toISOString(),
      };
      ledger.holds.push(hold);
      ledger.holdKeys[idempotencyKey] = hold.id;
      await this.saveLedger(projectId, ledger);
      return hold;
    });
  }

  async confirmBooking({ projectId, holdId, idempotencyKey, inputAnswers, privacyNotice = null }) {
    if (!validIdempotencyKey(idempotencyKey)) throw new BookingError(400, "A valid booking confirmation key is required.");
    return this.serialize(async () => {
      const now = this.clock();
      const project = await this.loadProject(projectId);
      if (!project) throw new BookingError(404, "Service project not found.");
      const ledger = cleanLedger(await this.loadLedger(projectId), now);
      const priorId = ledger.confirmKeys[idempotencyKey];
      if (priorId) {
        const bookingId = typeof priorId === "string" ? priorId : priorId.bookingId;
        const existing = ledger.bookings.find((booking) => booking.id === bookingId);
        if (existing && typeof priorId === "object" && priorId.holdId !== holdId) {
          throw new BookingError(409, "This idempotency key was already used for another appointment.");
        }
        if (existing) return existing;
      }
      const hold = ledger.holds.find((item) => item.id === holdId && item.projectId === projectId);
      if (!hold) throw new BookingError(409, "Appointment hold expired. Please select an available slot again.");
      if (hold.status === "confirmed" && hold.bookingId) {
        const existing = ledger.bookings.find((booking) => booking.id === hold.bookingId);
        if (existing) return existing;
      }
      if (hold.status !== "held" || Date.parse(hold.expiresAt) <= now) {
        throw new BookingError(409, "Appointment hold expired. Please select an available slot again.");
      }
      const settings = availabilitySettings(project.service);
      if (settings.mode !== "verified") {
        throw new BookingError(409, "Verify the business hours and capacity in service settings before confirming appointments.");
      }
      const slotDate = dateKeyAt(Date.parse(hold.slotStart), project.service.timezone || "Europe/Berlin");
      const validationNow = Date.parse(hold.slotStart) - settings.minimumNoticeMinutes * 60000 - 1;
      const validSchedule = buildSlots(project, { holds: [], bookings: [] }, slotDate, 1, validationNow)
        .some((slot) => slot.start === hold.slotStart);
      if (!validSchedule) throw new BookingError(409, "The service schedule changed. Select an available slot again.");
      const competing = activeReservations(ledger, now).filter((reservation) => reservation.id !== hold.id);
      const start = Date.parse(hold.slotStart);
      const end = Date.parse(hold.slotEnd) + settings.bufferMinutes * 60000;
      const occupied = competing.filter((reservation) => isOverlapping(
        start, end, Date.parse(reservation.slotStart),
        Date.parse(reservation.slotEnd) + settings.bufferMinutes * 60000,
      )).length;
      if (occupied >= settings.capacity) throw new BookingError(409, "That appointment is no longer available.");
      const answers = validateAnswers(project, inputAnswers);
      const quote = calculatePreviewQuote(project, new Map(Object.entries(answers)));
      if (!quote.configured || quote.unpriced) throw new BookingError(422, "Set valid service rates before confirming a booking.");
      const booking = {
        id: randomUUID(),
        projectId,
        status: "confirmed",
        createdAt: new Date(now).toISOString(),
        appointment: {
          start: hold.slotStart,
          end: hold.slotEnd,
          timezone: project.service.timezone || "Europe/Berlin",
        },
        serviceName: project.service.name,
        answers,
        privacyNotice,
        quote: {
          currency: project.service.pricing?.currency || "EUR",
          totalMinor: quote.total,
          items: quote.items,
          pricingSnapshot: project.service.pricing,
        },
        availabilitySnapshot: settings,
      };
      ledger.bookings.push(booking);
      ledger.confirmKeys[idempotencyKey] = { bookingId: booking.id, holdId: hold.id };
      hold.status = "confirmed";
      hold.bookingId = booking.id;
      for (const message of this.createEmailMessages({ booking, project })) {
        ledger.emailOutbox.push({
          id: randomUUID(),
          bookingId: booking.id,
          ...message,
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date(now).toISOString(),
          createdAt: new Date(now).toISOString(),
        });
      }
      await this.saveLedger(projectId, ledger);
      return booking;
    });
  }

  async listBookings(projectId) {
    const ledger = await this.loadLedger(projectId);
    return ledger.bookings;
  }

  async releaseHold(projectId, holdId) {
    return this.serialize(async () => {
      const ledger = await this.loadLedger(projectId);
      const hold = ledger.holds.find((item) => item.id === holdId && item.projectId === projectId);
      if (!hold) throw new BookingError(404, "Appointment hold not found.");
      if (hold.status === "confirmed") throw new BookingError(409, "A confirmed booking cannot be released as a hold.");
      if (hold.status === "held") {
        hold.status = "released";
        hold.releasedAt = new Date(this.clock()).toISOString();
        await this.saveLedger(projectId, ledger);
      }
      return { released: true };
    });
  }

  async cancelBooking(projectId, bookingId) {
    return this.serialize(async () => {
      const ledger = await this.loadLedger(projectId);
      ledger.emailOutbox ||= [];
      const booking = ledger.bookings.find((item) => item.id === bookingId);
      if (!booking) throw new BookingError(404, "Booking not found.");
      if (booking.status === "confirmed") {
        booking.status = "cancelled";
        booking.cancelledAt = new Date(this.clock()).toISOString();
        const project = await this.loadProject(projectId);
        if (project) {
          for (const message of this.createCancellationEmailMessages({ booking, project })) {
            ledger.emailOutbox.push({
              id: randomUUID(),
              bookingId: booking.id,
              ...message,
              status: "pending",
              attempts: 0,
              nextAttemptAt: new Date(this.clock()).toISOString(),
              createdAt: new Date(this.clock()).toISOString(),
            });
          }
        }
        await this.saveLedger(projectId, ledger);
      }
      return booking;
    });
  }
}
