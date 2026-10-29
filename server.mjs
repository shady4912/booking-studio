import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BookingService, BookingError, defaultAvailability, validateAvailabilitySettings } from "./bookings.mjs";
import {
  createBookingEmailMessages,
  createCancellationEmailMessages,
  isValidSender,
  parseEmailRecipients,
  sendResendEmail,
} from "./email.mjs";
import { BookingDatabase } from "./database.mjs";
import {
  clearSessionCookie,
  createToken,
  hashToken,
  parseAdminEmails,
  readCookie,
  sessionCookie,
  sessionLifetimeMs,
  sessionCookieName,
} from "./auth.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const rootDirectory = resolve(root);
const projectsDirectory = join(process.env.BOOKING_STUDIO_DATA_DIR || join(root, ".data"), "projects");
const bookingsDirectory = join(process.env.BOOKING_STUDIO_DATA_DIR || join(root, ".data"), "bookings");
const database = process.env.DATABASE_URL
  ? new BookingDatabase(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === "true" })
  : null;
const isProduction = process.env.NODE_ENV === "production";
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
let canonicalPublicUrl = null;
if (isProduction && publicBaseUrl) {
  try {
    canonicalPublicUrl = new URL(publicBaseUrl);
    if (canonicalPublicUrl.protocol !== "https:" || canonicalPublicUrl.pathname !== "/" ||
      canonicalPublicUrl.search || canonicalPublicUrl.hash || canonicalPublicUrl.username || canonicalPublicUrl.password) {
      throw new Error();
    }
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a canonical HTTPS origin without a path or credentials.");
  }
}
const adminEmails = parseAdminEmails(process.env.BOOKING_ADMIN_EMAILS || "");
const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validSlug = (value) => typeof value === "string" && value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const maxBodyBytes = 2 * 1024 * 1024;
const validMoney = (value) => value === "" || value == null || /^\d{1,8}(?:\.\d{1,2})?$/.test(String(value));
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
const sendJson = (response, status, value) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};
const readBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("Project file is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
};
const assertLocalRequest = (request) => {
  const host = request.headers.host || "";
  if (isProduction) {
    if (!canonicalPublicUrl || host.toLowerCase() !== canonicalPublicUrl.host.toLowerCase()) {
      throw Object.assign(new Error("Request host is not configured for this service."), { status: 403 });
    }
    if (request.headers.origin) {
      let origin;
      try {
        origin = new URL(request.headers.origin);
      } catch {
        throw Object.assign(new Error("Request origin is invalid."), { status: 403 });
      }
      if (origin.protocol !== "https:" || origin.host.toLowerCase() !== canonicalPublicUrl.host.toLowerCase()) {
        throw Object.assign(new Error("Cross-origin requests are not allowed."), { status: 403 });
      }
    }
    return;
  }
  if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host)) {
    throw Object.assign(new Error("This local prototype accepts loopback requests only."), { status: 403 });
  }
  if (request.headers.origin) {
    let origin;
    try {
      origin = new URL(request.headers.origin);
    } catch {
      throw Object.assign(new Error("Request origin is invalid."), { status: 403 });
    }
    if (origin.protocol !== "http:" || origin.host !== host) {
      throw Object.assign(new Error("Cross-origin requests are not allowed."), { status: 403 });
    }
  }
};
const assertJsonRequest = (request) => {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    throw Object.assign(new Error("Project changes must be sent as JSON."), { status: 415 });
  }
};
const projectPath = (id) => join(projectsDirectory, `${id}.json`);
const readProject = async (id) => {
  if (database) return database.loadProject(id);
  try {
    return JSON.parse(await readFile(projectPath(id), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const validateProject = (project, id) => {
  if (!project || typeof project !== "object" || project.version !== 1 ||
    !project.service || typeof project.service.name !== "string" || project.service.name.length > 100 ||
    !Array.isArray(project.sections) || project.sections.length > 100) {
    throw Object.assign(new Error("Project structure is invalid."), { status: 400 });
  }
  const pricing = project.service.pricing;
  if (pricing && (
    !["EUR", "USD", "GBP", "CHF"].includes(pricing.currency || "EUR") ||
    !["none", "fixed", "percent"].includes(pricing.discountType || "none") ||
    !validMoney(pricing.baseFee) || !validMoney(pricing.minimum) ||
    !validMoney(pricing.discountValue) ||
    (pricing.discountType === "percent" && Number(pricing.discountValue || 0) > 100)
  )) {
    throw Object.assign(new Error("Project pricing settings are invalid."), { status: 400 });
  }
  let availability;
  try {
    availability = validateAvailabilitySettings({
      timezone: project.service.timezone || "Europe/Berlin",
      availability: project.service.availability || defaultAvailability(),
    });
  } catch (error) {
    if (error instanceof BookingError) throw error;
    throw Object.assign(new Error("Project availability settings are invalid."), { status: 400 });
  }
  if ((project.service.published != null && typeof project.service.published !== "boolean") ||
    (project.service.published === true && (
      !validSlug(project.service.slug) ||
      availability.mode !== "verified"
    ))) {
    throw Object.assign(new Error("Publishing requires a valid page URL and verified business hours."), { status: 400 });
  }
  let fieldCount = 0;
  const identifiers = new Set();
  for (const section of project.sections) {
    if (!section || typeof section.id !== "string" || typeof section.title !== "string" ||
      section.title.length > 100 || !["questions", "addons", "schedule", "payment"].includes(section.type) ||
      !Array.isArray(section.fields) || section.fields.length > 500 || identifiers.has(section.id)) {
      throw Object.assign(new Error("A project section is invalid."), { status: 400 });
    }
    identifiers.add(section.id);
    fieldCount += section.fields.length;
    if (fieldCount > 1000) throw Object.assign(new Error("Project has too many fields."), { status: 400 });
    for (const field of section.fields) {
      if (!field || typeof field.id !== "string" || typeof field.label !== "string" ||
        field.label.length > 120 || identifiers.has(field.id) ||
        !["select", "number", "text", "textarea", "boolean", "email"].includes(field.type) ||
        (section.type === "addons" && field.type !== "boolean") ||
        (field.options != null && (!Array.isArray(field.options) || field.options.length > 100 ||
          field.options.some((option) => typeof option !== "string" || option.length > 180))) ||
        (field.min != null && (!Number.isFinite(field.min) || field.min < 0)) ||
        (field.max != null && (!Number.isFinite(field.max) || field.max < 0)) ||
        (field.min != null && field.max != null && field.min > field.max)) {
        throw Object.assign(new Error("A project question is invalid."), { status: 400 });
      }
      identifiers.add(field.id);
      if (field.pricing && (
        !["none", "fixed", "per_unit"].includes(field.pricing.type) ||
        !validMoney(field.pricing.rate) ||
        (field.pricing.type === "per_unit" && field.type !== "number")
      )) {
        throw Object.assign(new Error("A question pricing rule is invalid."), { status: 400 });
      }
    }
  }
  return { ...project, projectId: id, updatedAt: new Date().toISOString() };
};
const saveProject = async (id, project) => {
  const validated = validateProject(project, id);
  if (validated.service.published) {
    const existing = await findPublishedProject(validated.service.slug);
    if (existing && existing.projectId !== id) {
      throw Object.assign(new Error("That public page URL is already in use."), { status: 409 });
    }
  }
  if (database) return database.saveProject(id, validated);
  await mkdir(projectsDirectory, { recursive: true });
  const target = projectPath(id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(validated), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, target);
  return validated;
};
const listAllProjects = async () => {
  if (database) return database.listProjects();
  await mkdir(projectsDirectory, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(projectsDirectory);
  const projects = [];
  for (const name of names.filter((entry) => projectIdPattern.test(entry.slice(0, -5)) && entry.endsWith(".json"))) {
    const project = await readProject(name.slice(0, -5));
    if (project) projects.push(project);
  }
  return projects;
};
const findPublishedProject = async (slug) => {
  if (database) return database.findPublishedProject(slug);
  const projects = await listAllProjects();
  return projects.find((project) => project.service.published && project.service.slug === slug) || null;
};
const verifyTurnstile = async (token) => {
  if (!isProduction) return;
  if (typeof token !== "string" || token.length < 20 || token.length > 2048) {
    throw new BookingError(400, "Complete the anti-spam check before booking.");
  }
  let response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: turnstileSecretKey, response: token }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    console.error("Cloudflare Turnstile verification request failed.", error);
    throw Object.assign(new Error("The anti-spam check is temporarily unavailable. Please try again."), { status: 503 });
  }
  if (!response.ok) {
    console.error(`Cloudflare Turnstile verification returned HTTP ${response.status}.`);
    throw Object.assign(new Error("The anti-spam check is temporarily unavailable. Please try again."), { status: 503 });
  }
  const result = await response.json();
  if (!result.success || result.hostname !== canonicalPublicUrl.hostname || result.action !== "booking") {
    throw new BookingError(400, "The anti-spam check expired or could not be verified. Please try again.");
  }
};

const ledgerPath = (id) => join(bookingsDirectory, `${id}.json`);
const emptyLedger = () => ({ holds: [], bookings: [], holdKeys: {}, confirmKeys: {}, emailOutbox: [] });
const loadLedger = async (id) => {
  if (database) return database.loadLedger(id);
  try {
    const ledger = JSON.parse(await readFile(ledgerPath(id), "utf8"));
    if (!Array.isArray(ledger.holds) || !Array.isArray(ledger.bookings) ||
      !ledger.holdKeys || !ledger.confirmKeys) {
      throw new Error("Stored booking ledger has an invalid structure.");
    }
    if (ledger.emailOutbox != null && !Array.isArray(ledger.emailOutbox)) {
      throw new Error("Stored booking email outbox has an invalid structure.");
    }
    return ledger;
  } catch (error) {
    if (error.code === "ENOENT") return emptyLedger();
    throw error;
  }
};
const saveLedger = async (id, ledger) => {
  if (database) return database.saveLedger(id, ledger);
  await mkdir(bookingsDirectory, { recursive: true });
  const target = ledgerPath(id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, target);
};

const resendApiKey = process.env.RESEND_API_KEY || "";
const resendFrom = process.env.RESEND_FROM || "";
const businessRecipients = parseEmailRecipients(process.env.BOOKING_NOTIFICATION_EMAILS || "");
const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY || "";
const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY || "";
const privacyPolicyUrl = process.env.PRIVACY_POLICY_URL || "";
let validatedPrivacyPolicyUrl = "";
if (privacyPolicyUrl) {
  try {
    const parsed = new URL(privacyPolicyUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
    validatedPrivacyPolicyUrl = parsed.href;
  } catch {
    throw new Error("PRIVACY_POLICY_URL must be an HTTPS URL without embedded credentials.");
  }
}
if (resendApiKey && !isValidSender(resendFrom)) {
  throw new Error("Set RESEND_FROM to a sender address verified in Resend.");
}
if (isProduction) {
  if (!database) throw new Error("DATABASE_URL is required in production. Local JSON storage is not production-safe.");
  if (!canonicalPublicUrl) throw new Error("PUBLIC_BASE_URL must be the canonical HTTPS deployment URL.");
  if (!resendApiKey || !isValidSender(resendFrom)) {
    throw new Error("RESEND_API_KEY and a verified RESEND_FROM are required in production.");
  }
  if (!turnstileSiteKey || !turnstileSecretKey) {
    throw new Error("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are required for public booking protection.");
  }
  if (!validatedPrivacyPolicyUrl) throw new Error("PRIVACY_POLICY_URL is required before accepting customer data.");
  if (adminEmails.length === 0) throw new Error("BOOKING_ADMIN_EMAILS must authorize at least one administrator.");
  if (businessRecipients.length === 0) throw new Error("BOOKING_NOTIFICATION_EMAILS must include a business notification address.");
}

const bookings = new BookingService({
  loadProject: readProject,
  loadLedger,
  saveLedger,
  withWriteLock: database ? (operation) => database.withWriteLock(operation) : undefined,
  createEmailMessages: resendApiKey
    ? (details) => createBookingEmailMessages({ ...details, businessRecipients })
    : undefined,
  createCancellationEmailMessages: resendApiKey
    ? (details) => createCancellationEmailMessages({ ...details, businessRecipients })
    : undefined,
});

const authRateLimits = new Map();
const getAdminEmail = async (request) => {
  if (!isProduction) return "local-development";
  const token = readCookie(request, sessionCookieName);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return database.getSession(hashToken(token));
};

const handleAuthApi = async (request, response, pathname) => {
  if (pathname === "/api/auth/me" && request.method === "GET") {
    const email = await getAdminEmail(request);
    sendJson(response, 200, { authenticated: Boolean(email), email: email === "local-development" ? null : email });
    return true;
  }
  if (pathname === "/api/auth/request-link" && request.method === "POST") {
    assertJsonRequest(request);
    const body = await readBody(request);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new BookingError(400, "Enter a valid email address.");
    }
    const now = Date.now();
    const recent = authRateLimits.get(email) || [];
    const permitted = recent.filter((timestamp) => now - timestamp < 15 * 60 * 1000);
    if (permitted.length >= 3) {
      sendJson(response, 429, { error: "Too many sign-in requests. Try again later." });
      return true;
    }
    if (adminEmails.includes(email)) {
      authRateLimits.set(email, [...permitted, now]);
      const token = createToken();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(now + 10 * 60 * 1000);
      await database.createMagicLink(email, tokenHash, expiresAt);
      const link = `${publicBaseUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;
      await sendResendEmail({
        apiKey: resendApiKey,
        from: resendFrom,
        message: {
          id: `admin-login-${tokenHash}`,
          to: email,
          subject: "Your Booking Studio sign-in link",
          text: `Use this one-time link to sign in to Booking Studio. It expires in 10 minutes.\n\n${link}\n\nIf you did not request this link, you can ignore this email.`,
        },
      });
    }
    sendJson(response, 202, { message: "If that address is authorized, a sign-in link will arrive shortly." });
    return true;
  }
  if (pathname === "/api/auth/verify" && request.method === "GET") {
    const token = new URL(request.url || "/", publicBaseUrl).searchParams.get("token") || "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      response.writeHead(303, { Location: "/login.html?error=expired", "Cache-Control": "no-store" }).end();
      return true;
    }
    response.writeHead(303, {
      Location: `/verify.html?token=${encodeURIComponent(token)}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    }).end();
    return true;
  }
  if (pathname === "/api/auth/verify" && request.method === "POST") {
    assertJsonRequest(request);
    const body = await readBody(request);
    const token = typeof body?.token === "string" ? body.token : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new BookingError(400, "This sign-in link has expired. Request a new one.");
    }
    const email = await database.consumeMagicLink(hashToken(token));
    if (!email || !adminEmails.includes(email)) {
      throw new BookingError(400, "This sign-in link has expired. Request a new one.");
    }
    const sessionToken = createToken();
    await database.createSession(
      hashToken(sessionToken),
      email,
      new Date(Date.now() + sessionLifetimeMs),
    );
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": sessionCookie(sessionToken),
      "Cache-Control": "no-store",
    }).end(JSON.stringify({ ok: true }));
    return true;
  }
  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const token = readCookie(request, sessionCookieName);
    if (isProduction && token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      await database.deleteSession(hashToken(token));
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": clearSessionCookie(),
      "Cache-Control": "no-store",
    }).end(JSON.stringify({ ok: true }));
    return true;
  }
  return false;
};

let emailDeliveryRunning = false;
const deliverPendingEmails = async () => {
  if (!resendApiKey || emailDeliveryRunning) return;
  emailDeliveryRunning = true;
  try {
    const projectIds = (await listAllProjects()).map((project) => project.projectId);
    for (const projectId of projectIds) {
      const ledger = await bookings.serialize(() => loadLedger(projectId));
      const dueMessages = (ledger.emailOutbox || []).filter((message) =>
        message.status === "pending" && Date.parse(message.nextAttemptAt) <= Date.now(),
      );
      for (const message of dueMessages) {
        let deliveryError;
        try {
          await sendResendEmail({ apiKey: resendApiKey, from: resendFrom, message });
        } catch (error) {
          deliveryError = error;
        }
        await bookings.serialize(async () => {
          const latest = await loadLedger(projectId);
          const queued = (latest.emailOutbox || []).find((item) => item.id === message.id);
          if (!queued || queued.status !== "pending") return;
          queued.attempts += 1;
          if (deliveryError) {
            queued.lastError = deliveryError.message.slice(0, 300);
            if (queued.attempts >= 8) {
              queued.status = "failed";
            } else {
              const delay = Math.min(60_000 * 2 ** (queued.attempts - 1), 6 * 60 * 60 * 1000);
              queued.nextAttemptAt = new Date(Date.now() + delay).toISOString();
            }
            console.error(`Email delivery failed for queued message ${queued.id}: ${queued.lastError}`);
          } else {
            queued.status = "sent";
            queued.sentAt = new Date().toISOString();
            delete queued.lastError;
          }
          await saveLedger(projectId, latest);
        });
      }
    }
  } finally {
    emailDeliveryRunning = false;
  }
};

if (resendApiKey) {
  setInterval(() => {
    deliverPendingEmails().catch((error) => console.error("Email outbox processing failed.", error));
  }, 15_000);
  setTimeout(() => {
    deliverPendingEmails().catch((error) => console.error("Email outbox processing failed.", error));
  }, 1_000);
} else {
  console.warn("Resend email delivery is disabled; set RESEND_API_KEY and RESEND_FROM to enable it.");
}

const handleApi = async (request, response, pathname) => {
  assertLocalRequest(request);
  if (pathname.startsWith("/api/auth/") && await handleAuthApi(request, response, pathname)) return true;
  const publicServiceMatch = pathname.match(/^\/api\/public\/services\/([a-z0-9-]{1,100})$/);
  const publicReleaseMatch = pathname.match(/^\/api\/public\/holds\/([0-9a-f-]{36})\/release$/i);
  if (publicServiceMatch && request.method === "GET") {
    const project = await findPublishedProject(publicServiceMatch[1]);
    if (!project) {
      sendJson(response, 404, { error: "This booking page is not available." });
      return true;
    }
    sendJson(response, 200, {
      project,
      turnstileSiteKey: turnstileSiteKey || null,
      privacyPolicyUrl: validatedPrivacyPolicyUrl || null,
    });
    return true;
  }
  if (pathname === "/api/public/availability" && request.method === "GET") {
    const url = new URL(request.url || "/", "http://localhost");
    const slug = url.searchParams.get("slug") || "";
    if (!validSlug(slug)) throw new BookingError(400, "A valid booking page URL is required.");
    const project = await findPublishedProject(slug);
    if (!project) throw new BookingError(404, "This booking page is not available.");
    const days = Number(url.searchParams.get("days") || 7);
    sendJson(response, 200, await bookings.availability(project.projectId, url.searchParams.get("from"), days));
    return true;
  }
  if (pathname === "/api/public/holds" && request.method === "POST") {
    assertJsonRequest(request);
    const body = await readBody(request);
    if (!body || typeof body !== "object" || !validSlug(body.slug)) {
      throw new BookingError(400, "A valid booking page URL is required.");
    }
    const project = await findPublishedProject(body.slug);
    if (!project) throw new BookingError(404, "This booking page is not available.");
    await verifyTurnstile(body.turnstileToken);
    sendJson(response, 201, await bookings.createHold({ ...body, projectId: project.projectId }));
    return true;
  }
  if (publicReleaseMatch && request.method === "POST") {
    assertJsonRequest(request);
    const body = await readBody(request);
    if (!validSlug(body?.slug)) throw new BookingError(400, "A valid booking page URL is required.");
    const project = await findPublishedProject(body.slug);
    if (!project) throw new BookingError(404, "This booking page is not available.");
    sendJson(response, 200, await bookings.releaseHold(project.projectId, publicReleaseMatch[1]));
    return true;
  }
  if (pathname === "/api/public/bookings/confirm" && request.method === "POST") {
    assertJsonRequest(request);
    const body = await readBody(request);
    if (!body || typeof body !== "object" || !validSlug(body.slug)) {
      throw new BookingError(400, "A valid booking page URL is required.");
    }
    const project = await findPublishedProject(body.slug);
    if (!project) throw new BookingError(404, "This booking page is not available.");
    await verifyTurnstile(body.turnstileToken);
    if (isProduction && body.privacyNoticeAccepted !== true) {
      throw new BookingError(400, "Acknowledge the privacy notice before confirming.");
    }
    sendJson(response, 201, await bookings.confirmBooking({
      ...body,
      projectId: project.projectId,
      privacyNotice: body.privacyNoticeAccepted === true && validatedPrivacyPolicyUrl
        ? { url: validatedPrivacyPolicyUrl, acceptedAt: new Date().toISOString() }
        : null,
    }));
    return true;
  }
  if (isProduction && !pathname.startsWith("/api/public/") && !await getAdminEmail(request)) {
    sendJson(response, 401, { error: "Administrator sign-in is required." });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/availability") {
    const url = new URL(request.url || "/", "http://localhost");
    const projectId = url.searchParams.get("projectId") || "";
    if (!projectIdPattern.test(projectId)) {
      sendJson(response, 400, { error: "A valid service project ID is required." });
      return true;
    }
    const days = Number(url.searchParams.get("days") || 7);
    sendJson(response, 200, await bookings.availability(projectId, url.searchParams.get("from"), days));
    return true;
  }
  if (pathname === "/api/holds" && request.method === "POST") {
    assertJsonRequest(request);
    const body = await readBody(request);
    if (!body || typeof body !== "object" || !projectIdPattern.test(body.projectId || "")) throw new BookingError(400, "A valid service project ID is required.");
    sendJson(response, 201, await bookings.createHold(body));
    return true;
  }
  const releaseMatch = pathname.match(/^\/api\/holds\/([0-9a-f-]{36})\/release$/i);
  if (releaseMatch && request.method === "POST") {
    assertJsonRequest(request);
    const { projectId } = await readBody(request);
    if (!projectIdPattern.test(projectId || "")) throw new BookingError(400, "A valid service project ID is required.");
    sendJson(response, 200, await bookings.releaseHold(projectId, releaseMatch[1]));
    return true;
  }
  if (pathname === "/api/bookings/confirm" && request.method === "POST") {
    assertJsonRequest(request);
    const body = await readBody(request);
    if (!body || typeof body !== "object" || !projectIdPattern.test(body.projectId || "")) throw new BookingError(400, "A valid service project ID is required.");
    sendJson(response, 201, await bookings.confirmBooking(body));
    return true;
  }
  const cancelMatch = pathname.match(/^\/api\/bookings\/([0-9a-f-]{36})\/cancel$/i);
  if (cancelMatch && request.method === "POST") {
    assertJsonRequest(request);
    const { projectId } = await readBody(request);
    if (!projectIdPattern.test(projectId || "")) throw new BookingError(400, "A valid service project ID is required.");
    sendJson(response, 200, await bookings.cancelBooking(projectId, cancelMatch[1]));
    return true;
  }
  if (pathname === "/api/bookings" && request.method === "GET") {
    const projectId = new URL(request.url || "/", "http://localhost").searchParams.get("projectId") || "";
    if (!projectIdPattern.test(projectId)) {
      sendJson(response, 400, { error: "A valid service project ID is required." });
      return true;
    }
    if (!await readProject(projectId)) {
      sendJson(response, 404, { error: "Service project not found." });
      return true;
    }
    sendJson(response, 200, { bookings: await bookings.listBookings(projectId) });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/projects") {
    const projects = [];
    for (const project of await listAllProjects()) {
      projects.push({
        id: project.projectId,
        name: project.service.name,
        slug: project.service.slug || "",
        updatedAt: project.updatedAt || "",
      });
    }
    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sendJson(response, 200, { projects });
    return true;
  }

  const match = pathname.match(/^\/api\/projects\/([0-9a-f-]{36})$/i);
  if (match && !projectIdPattern.test(match[1])) {
    sendJson(response, 400, { error: "Project ID is invalid." });
    return true;
  }
  if (match && request.method === "GET") {
    const project = await readProject(match[1]);
    sendJson(response, project ? 200 : 404, project || { error: "Project not found." });
    return true;
  }
  if (match && request.method === "PUT") {
    assertJsonRequest(request);
    const project = await readBody(request);
    sendJson(response, 200, await bookings.serialize(() => saveProject(match[1], project)));
    return true;
  }
  if (pathname === "/api/projects" && request.method === "POST") {
    assertJsonRequest(request);
    const project = await readBody(request);
    const saved = await bookings.serialize(() => saveProject(randomUUID(), project));
    sendJson(response, 201, saved);
    return true;
  }
  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "API route not found." });
    return true;
  }
  return false;
};

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (pathname === "/healthz" && request.method === "GET") {
      if (database) await database.pool.query("SELECT 1");
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (await handleApi(request, response, pathname)) return;
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }
    const decoded = decodeURIComponent(pathname);
    const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    const filePath = resolve(rootDirectory, relativePath);
    const pathFromRoot = relative(rootDirectory, filePath);

    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    const publicPageMatch = pathname.match(/^\/book\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
    if (publicPageMatch) {
      const project = await findPublishedProject(publicPageMatch[1]);
      if (!project) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Booking page not found.");
        return;
      }
      const body = await readFile(join(root, "public.html"));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (isProduction && ["/", "/index.html", "/bookings.html"].includes(pathname) && !await getAdminEmail(request)) {
      response.writeHead(303, { Location: "/login.html", "Cache-Control": "no-store" }).end();
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, { "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream" });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error instanceof BookingError || error.status) {
      sendJson(response, error.status, { error: error.message });
      return;
    }
    console.error("Booking Studio request failed.", error);
    sendJson(response, 500, { error: "Request failed. Check the local server logs." });
  }
});

const port = Number(process.env.PORT || 4173);
const startServer = async () => {
  if (database) await database.initialize();
  if (database) await database.cleanExpiredAuthRecords();
  server.listen(port, process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1", () => {
    console.log(`Booking Studio running on port ${port}`);
  });
};
startServer().catch((error) => {
  console.error("Booking Studio could not start.", error);
  process.exitCode = 1;
});
