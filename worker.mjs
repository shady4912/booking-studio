import { BookingError, defaultAvailability, validateAvailabilitySettings } from "./bookings.mjs";
import { BookingProjectObject } from "./booking-object.mjs";
import {
  isValidSender,
  parseEmailRecipients,
  sendResendEmail,
} from "./email.mjs";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sessionCookieName = "booking_studio_session";
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const maxBodyBytes = 2 * 1024 * 1024;
const textEncoder = new TextEncoder();
const emptyLedger = () => ({ holds: [], bookings: [], holdKeys: {}, confirmKeys: {}, emailOutbox: [] });

function jsonResponse(value, status = 200, headers = {}) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function errorResponse(error) {
  if (error instanceof BookingError || Number.isInteger(error.status)) {
    return jsonResponse({ error: error.message }, error.status);
  }
  console.error("Booking Studio request failed.", error);
  return jsonResponse({ error: "Request failed. Check the Worker logs." }, 500);
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBodyBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  const text = await request.text();
  if (textEncoder.encode(text).byteLength > maxBodyBytes) {
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function requireJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) {
    throw Object.assign(new Error("Changes must be sent as JSON."), { status: 415 });
  }
}

function checkOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin === new URL(request.url).origin) return;
    } catch {
      // Invalid origins are rejected below.
    }
    throw Object.assign(new Error("Cross-origin requests are not allowed."), { status: 403 });
  }
}

function cookieValue(request, name) {
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseAdminEmails(value) {
  const emails = value.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error("ADMIN_EMAILS must contain valid comma-separated addresses.");
  }
  return [...new Set(emails)];
}

function applySecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com https://photon.komoot.io; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function validateProject(project, projectId) {
  if (!project || typeof project !== "object" || project.version !== 1 ||
    !project.service || typeof project.service.name !== "string" ||
    project.service.name.length > 100 || !Array.isArray(project.sections) ||
    project.sections.length > 100) {
    throw new BookingError(400, "Project structure is invalid.");
  }
  const pricing = project.service.pricing;
  const validMoney = (value) => value === "" || value == null || /^\d{1,8}(?:\.\d{1,2})?$/.test(String(value));
  if (pricing && (
    !["EUR", "USD", "GBP", "CHF"].includes(pricing.currency || "EUR") ||
    !["none", "fixed", "percent"].includes(pricing.discountType || "none") ||
    !validMoney(pricing.baseFee) || !validMoney(pricing.minimum) ||
    !validMoney(pricing.discountValue) ||
    (pricing.discountType === "percent" && Number(pricing.discountValue || 0) > 100)
  )) {
    throw new BookingError(400, "Project pricing settings are invalid.");
  }
  let availability;
  try {
    availability = validateAvailabilitySettings({
      timezone: project.service.timezone || "Europe/Berlin",
      availability: project.service.availability || defaultAvailability(),
    });
  } catch (error) {
    if (error instanceof BookingError) throw error;
    throw new BookingError(400, "Project availability settings are invalid.");
  }
  const slug = project.service.slug || "";
  if ((project.service.published != null && typeof project.service.published !== "boolean") ||
    (project.service.published === true && (!slugPattern.test(slug) || slug.length > 100 || availability.mode !== "verified"))) {
    throw new BookingError(400, "Publishing requires a valid page URL and verified business hours.");
  }
  const identifiers = new Set();
  let fieldCount = 0;
  for (const section of project.sections) {
    if (!section || typeof section.id !== "string" || typeof section.title !== "string" ||
      section.title.length > 100 ||
      !["questions", "addons", "schedule", "payment"].includes(section.type) ||
      !Array.isArray(section.fields) || section.fields.length > 500 ||
      identifiers.has(section.id)) {
      throw new BookingError(400, "A project section is invalid.");
    }
    identifiers.add(section.id);
    fieldCount += section.fields.length;
    if (fieldCount > 1000) throw new BookingError(400, "Project has too many fields.");
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
        throw new BookingError(400, "A project question is invalid.");
      }
      identifiers.add(field.id);
      if (field.pricing && (
        !["none", "fixed", "per_unit"].includes(field.pricing.type) ||
        !validMoney(field.pricing.rate) ||
        (field.pricing.type === "per_unit" && field.type !== "number")
      )) {
        throw new BookingError(400, "A question pricing rule is invalid.");
      }
    }
  }
  return {
    ...project,
    projectId,
    updatedAt: new Date().toISOString(),
  };
}

async function getProject(env, projectId) {
  const row = await env.DB.prepare("SELECT project FROM booking_projects WHERE project_id = ?")
    .bind(projectId).first();
  return row ? JSON.parse(row.project) : null;
}

async function getPublishedProject(env, slug) {
  const row = await env.DB.prepare(`
    SELECT project FROM booking_projects
    WHERE json_extract(project, '$.service.slug') = ?
      AND json_extract(project, '$.service.published') = 1
    LIMIT 1
  `).bind(slug).first();
  return row ? JSON.parse(row.project) : null;
}

async function listProjects(env) {
  const result = await env.DB.prepare("SELECT project FROM booking_projects ORDER BY updated_at DESC").all();
  return (result.results || []).map((row) => JSON.parse(row.project));
}

function bookingStub(env, projectId) {
  const id = env.BOOKING_OBJECTS.idFromName(projectId);
  return env.BOOKING_OBJECTS.get(id);
}

async function invokeBooking(env, projectId, action, payload = {}) {
  const response = await bookingStub(env, projectId).fetch("https://booking-object.internal/operation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "Booking operation failed."), { status: response.status });
  return result;
}

async function verifyTurnstile(request, token, env) {
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) {
    throw Object.assign(new Error("Booking protection is not configured."), { status: 503 });
  }
  if (typeof token !== "string" || token.length < 20 || token.length > 2048) {
    throw new BookingError(400, "Complete the anti-spam check before booking.");
  }
  let response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
    });
  } catch (error) {
    console.error("Turnstile verification request failed.", error);
    throw Object.assign(new Error("The anti-spam check is temporarily unavailable."), { status: 503 });
  }
  if (!response.ok) throw Object.assign(new Error("The anti-spam check is temporarily unavailable."), { status: 503 });
  const result = await response.json();
  const hostname = new URL(request.url).hostname;
  if (!result.success || result.hostname !== hostname || result.action !== "booking") {
    throw new BookingError(400, "The anti-spam check expired or could not be verified. Please try again.");
  }
}

async function enforceRateLimit(env, scope, key, limit, windowMs) {
  const bucket = await hashToken(`${scope}:${key || "unknown"}`);
  const now = Date.now();
  const row = await env.DB.prepare(`
    INSERT INTO rate_limits (bucket, scope, window_start, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(bucket, scope) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start <= ? THEN ? ELSE rate_limits.window_start END
    RETURNING count
  `).bind(bucket, scope, now, now - windowMs, now - windowMs, now).first();
  if (row.count > limit) {
    throw Object.assign(new Error("Too many requests. Please try again later."), { status: 429 });
  }
}

async function sessionEmail(request, env) {
  const token = cookieValue(request, sessionCookieName);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await env.DB.prepare(`
    SELECT email FROM admin_sessions WHERE token_hash = ? AND expires_at > ?
  `).bind(await hashToken(token), Date.now()).first();
  return row?.email || null;
}

function requireAdmin(request, env) {
  return sessionEmail(request, env).then((email) => {
    if (!email) throw Object.assign(new Error("Administrator sign-in is required."), { status: 401 });
    return email;
  });
}

function adminEmails(env) {
  return parseAdminEmails(env.ADMIN_EMAILS || "");
}

function configuredPrivacyPolicy(env) {
  if (!env.PRIVACY_POLICY_URL) return null;
  try {
    const url = new URL(env.PRIVACY_POLICY_URL);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {
    return null;
  }
  return null;
}

function requireBookingEmailConfiguration(env) {
  let recipients;
  try {
    recipients = parseEmailRecipients(env.BOOKING_NOTIFICATION_EMAILS || "");
  } catch {
    throw Object.assign(new Error("Booking notification email is not configured correctly."), { status: 503 });
  }
  if (!env.RESEND_API_KEY || !isValidSender(env.RESEND_FROM || "") || recipients.length === 0) {
    throw Object.assign(new Error("Booking confirmation email is not configured."), { status: 503 });
  }
}

async function authRoute(request, env, url) {
  const path = url.pathname;
  if (path === "/api/auth/me" && request.method === "GET") {
    const email = await sessionEmail(request, env);
    return jsonResponse({ authenticated: Boolean(email), email });
  }
  if (path === "/api/auth/request-link" && request.method === "POST") {
    requireJson(request);
    const body = await readJson(request);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new BookingError(400, "Enter a valid email address.");
    }
    if (!env.RESEND_API_KEY || !isValidSender(env.RESEND_FROM || "")) {
      throw Object.assign(new Error("Administrator email sign-in is not configured."), { status: 503 });
    }
    await enforceRateLimit(env, "login", email, 3, 15 * 60 * 1000);
    if (adminEmails(env).includes(email)) {
      const token = randomToken();
      const tokenHash = await hashToken(token);
      const expiresAt = Date.now() + 10 * 60 * 1000;
      await env.DB.prepare(`
        INSERT INTO admin_magic_links (token_hash, email, expires_at) VALUES (?, ?, ?)
      `).bind(tokenHash, email, expiresAt).run();
      const link = `${url.origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
      await sendResendEmail({
        apiKey: env.RESEND_API_KEY,
        from: env.RESEND_FROM,
        message: {
          id: `admin-login-${tokenHash}`,
          to: email,
          subject: "Your Booking Studio sign-in link",
          text: `Use this one-time link to sign in to Booking Studio. It expires in 10 minutes.\n\n${link}\n\nIf you did not request this link, you can ignore this email.`,
        },
      });
    }
    return jsonResponse({ message: "If that address is authorized, a sign-in link will arrive shortly." }, 202);
  }
  if (path === "/api/auth/verify" && request.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return Response.redirect(`${url.origin}/login.html?error=expired`, 303);
    }
    const target = new URL("/verify.html", url.origin);
    target.searchParams.set("token", token);
    return new Response(null, {
      status: 303,
      headers: { Location: target.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  if (path === "/api/auth/verify" && request.method === "POST") {
    requireJson(request);
    const body = await readJson(request);
    if (!/^[A-Za-z0-9_-]{43}$/.test(body?.token || "")) {
      throw new BookingError(400, "This sign-in link has expired. Request a new one.");
    }
    const tokenHash = await hashToken(body.token);
    const result = await env.DB.prepare(`
      UPDATE admin_magic_links SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      RETURNING email
    `).bind(Date.now(), tokenHash, Date.now()).first();
    if (!result || !adminEmails(env).includes(result.email)) {
      throw new BookingError(400, "This sign-in link has expired. Request a new one.");
    }
    const sessionToken = randomToken();
    await env.DB.prepare(`
      INSERT INTO admin_sessions (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)
    `).bind(
      await hashToken(sessionToken),
      result.email,
      Date.now() + sessionLifetime,
      Date.now(),
    ).run();
    return jsonResponse({ ok: true }, 200, {
      "Set-Cookie": `${sessionCookieName}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionLifetime / 1000}`,
    });
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    const token = cookieValue(request, sessionCookieName);
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
      await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
        .bind(await hashToken(token)).run();
    }
    return jsonResponse({ ok: true }, 200, {
      "Set-Cookie": `${sessionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    });
  }
  return null;
}

async function apiRoute(request, env, url) {
  const path = url.pathname;
  if (path.startsWith("/api/auth/")) {
    const response = await authRoute(request, env, url);
    if (response) return response;
  }

  const publicServiceMatch = path.match(/^\/api\/public\/services\/([a-z0-9-]{1,100})$/);
  if (publicServiceMatch && request.method === "GET") {
    const project = await getPublishedProject(env, publicServiceMatch[1]);
    if (!project) throw new BookingError(404, "This booking page is not available.");
    return jsonResponse({
      project,
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
      privacyPolicyUrl: configuredPrivacyPolicy(env),
    });
  }
  if (path === "/api/public/availability" && request.method === "GET") {
    const slug = url.searchParams.get("slug") || "";
    if (!slugPattern.test(slug) || slug.length > 100) throw new BookingError(400, "A valid booking page URL is required.");
    const project = await getPublishedProject(env, slug);
    if (!project) throw new BookingError(404, "This booking page is not available.");
    return jsonResponse(await invokeBooking(env, project.projectId, "availability", {
      from: url.searchParams.get("from"),
      days: Number(url.searchParams.get("days") || 7),
    }));
  }
  if (path === "/api/public/holds" && request.method === "POST") {
    checkOrigin(request);
    requireJson(request);
    const body = await readJson(request);
    if (!slugPattern.test(body?.slug || "") || body.slug.length > 100) {
      throw new BookingError(400, "A valid booking page URL is required.");
    }
    const project = await getPublishedProject(env, body.slug);
    if (!project) throw new BookingError(404, "This booking page is not available.");
    await enforceRateLimit(env, "public-booking", request.headers.get("cf-connecting-ip"), 12, 60 * 60 * 1000);
    await verifyTurnstile(request, body.turnstileToken, env);
    return jsonResponse(await invokeBooking(env, project.projectId, "hold", body), 201);
  }
  const publicRelease = path.match(/^\/api\/public\/holds\/([0-9a-f-]{36})\/release$/i);
  if (publicRelease && request.method === "POST") {
    checkOrigin(request);
    requireJson(request);
    const body = await readJson(request);
    if (!slugPattern.test(body?.slug || "")) throw new BookingError(400, "A valid booking page URL is required.");
    const project = await getPublishedProject(env, body.slug);
    if (!project) throw new BookingError(404, "This booking page is not available.");
    return jsonResponse(await invokeBooking(env, project.projectId, "release", { holdId: publicRelease[1] }));
  }
  if (path === "/api/public/bookings/confirm" && request.method === "POST") {
    checkOrigin(request);
    requireJson(request);
    const body = await readJson(request);
    if (!slugPattern.test(body?.slug || "") || body.slug.length > 100) {
      throw new BookingError(400, "A valid booking page URL is required.");
    }
    const project = await getPublishedProject(env, body.slug);
    if (!project) throw new BookingError(404, "This booking page is not available.");
    await enforceRateLimit(env, "public-booking", request.headers.get("cf-connecting-ip"), 12, 60 * 60 * 1000);
    await verifyTurnstile(request, body.turnstileToken, env);
    const privacyPolicyUrl = configuredPrivacyPolicy(env);
    if (body.privacyNoticeAccepted !== true || !privacyPolicyUrl) {
      throw new BookingError(400, "Acknowledge the privacy notice before confirming.");
    }
    requireBookingEmailConfiguration(env);
    return jsonResponse(await invokeBooking(env, project.projectId, "confirm", {
      ...body,
      privacyNotice: { url: privacyPolicyUrl, acceptedAt: new Date().toISOString() },
    }), 201);
  }

  const isPublicRoute = path.startsWith("/api/public/");
  if (!isPublicRoute) await requireAdmin(request, env);

  if (path === "/api/projects" && request.method === "GET") {
    const projects = (await listProjects(env)).map((project) => ({
      id: project.projectId,
      name: project.service.name,
      slug: project.service.slug || "",
      updatedAt: project.updatedAt || "",
    }));
    return jsonResponse({ projects });
  }
  if (path === "/api/projects" && request.method === "POST") {
    checkOrigin(request);
    requireJson(request);
    const body = await readJson(request);
    const projectId = crypto.randomUUID();
    const project = validateProject(body, projectId);
    await saveProject(env, projectId, project);
    return jsonResponse(project, 201);
  }
  const projectMatch = path.match(/^\/api\/projects\/([0-9a-f-]{36})$/i);
  if (projectMatch && !idPattern.test(projectMatch[1])) throw new BookingError(400, "Project ID is invalid.");
  if (projectMatch && request.method === "GET") {
    const project = await getProject(env, projectMatch[1]);
    return project ? jsonResponse(project) : jsonResponse({ error: "Project not found." }, 404);
  }
  if (projectMatch && request.method === "PUT") {
    checkOrigin(request);
    requireJson(request);
    const project = validateProject(await readJson(request), projectMatch[1]);
    await saveProject(env, projectMatch[1], project);
    return jsonResponse(project);
  }
  if (path === "/api/availability" && request.method === "GET") {
    const projectId = url.searchParams.get("projectId") || "";
    if (!idPattern.test(projectId)) throw new BookingError(400, "A valid service project ID is required.");
    return jsonResponse(await invokeBooking(env, projectId, "availability", {
      from: url.searchParams.get("from"),
      days: Number(url.searchParams.get("days") || 7),
    }));
  }
  if (path === "/api/holds" && request.method === "POST") {
    checkOrigin(request);
    requireJson(request);
    const body = await readJson(request);
    if (!idPattern.test(body?.projectId || "")) throw new BookingError(400, "A valid service project ID is required.");
    return jsonResponse(await invokeBooking(env, body.projectId, "hold", body), 201);
  }
  const releaseMatch = path.match(/^\/api\/holds\/([0-9a-f-]{36})\/release$/i);
  if (releaseMatch && request.method === "POST") {
    checkOrigin(request);
    requireJson(request);
    const body = await readJson(request);
    if (!idPattern.test(body?.projectId || "")) throw new BookingError(400, "A valid service project ID is required.");
    return jsonResponse(await invokeBooking(env, body.projectId, "release", { holdId: releaseMatch[1] }));
  }
  if (path === "/api/bookings/confirm" && request.method === "POST") {
    checkOrigin(request);
    requireJson(request);
    const body = await readJson(request);
    if (!idPattern.test(body?.projectId || "")) throw new BookingError(400, "A valid service project ID is required.");
    return jsonResponse(await invokeBooking(env, body.projectId, "confirm", body), 201);
  }
  const cancelMatch = path.match(/^\/api\/bookings\/([0-9a-f-]{36})\/cancel$/i);
  if (cancelMatch && request.method === "POST") {
    checkOrigin(request);
    requireJson(request);
    const body = await readJson(request);
    if (!idPattern.test(body?.projectId || "")) throw new BookingError(400, "A valid service project ID is required.");
    return jsonResponse(await invokeBooking(env, body.projectId, "cancel", {
      bookingId: cancelMatch[1],
    }));
  }
  if (path === "/api/bookings" && request.method === "GET") {
    const projectId = url.searchParams.get("projectId") || "";
    if (!idPattern.test(projectId)) throw new BookingError(400, "A valid service project ID is required.");
    if (!await getProject(env, projectId)) throw new BookingError(404, "Service project not found.");
    return jsonResponse({ bookings: await invokeBooking(env, projectId, "list") });
  }
  throw new BookingError(404, "API route not found.");
}

async function saveProject(env, projectId, project) {
  try {
    await env.DB.prepare(`
      INSERT INTO booking_projects (project_id, project, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET project = excluded.project, updated_at = excluded.updated_at
    `).bind(projectId, JSON.stringify(project), project.updatedAt).run();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message)) {
      throw Object.assign(new Error("That public page URL is already in use."), { status: 409 });
    }
    throw error;
  }
  return project;
}

async function staticResponse(request, env, url) {
  const path = url.pathname;
  if (path === "/book/" || path === "/book") {
    return new Response("Booking page not found.", { status: 404 });
  }
  const publicPage = path.match(/^\/book\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  if (publicPage) {
    const project = await getPublishedProject(env, publicPage[1]);
    if (!project) return new Response("Booking page not found.", { status: 404 });
    return env.ASSETS.fetch(new Request(new URL("/public", url), request));
  }
  if (path === "/" || path === "/index.html" || path === "/bookings.html") {
    if (!await sessionEmail(request, env)) {
      return Response.redirect(new URL("/login.html", url), 303);
    }
  }
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404 && path.endsWith("/")) return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
  return response;
}

async function processEmailOutbox(env) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return;
  const result = await env.DB.prepare(`
    SELECT project_id
    FROM booking_ledgers
    WHERE EXISTS (
      SELECT 1 FROM json_each(json_extract(ledger, '$.emailOutbox'))
      WHERE json_extract(value, '$.status') = 'pending'
        AND julianday(json_extract(value, '$.nextAttemptAt')) <= julianday('now')
    )
    LIMIT 100
  `).all();
  for (const { project_id: projectId } of result.results || []) {
    try {
      await invokeBooking(env, projectId, "deliver-emails");
    } catch (error) {
      console.error(`Could not process email outbox for project ${projectId}.`, error);
    }
  }
}

export { BookingProjectObject };

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz" && request.method === "GET") {
        await env.DB.prepare("SELECT 1").first();
        return jsonResponse({ status: "ok" });
      }
      if (url.pathname.startsWith("/api/")) {
        return applySecurityHeaders(await apiRoute(request, env, url));
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed.", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      return applySecurityHeaders(await staticResponse(request, env, url));
    } catch (error) {
      return applySecurityHeaders(errorResponse(error));
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(processEmailOutbox(env));
    ctx.waitUntil(env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
      .bind(Date.now() - 24 * 60 * 60 * 1000).run());
    ctx.waitUntil(env.DB.prepare("DELETE FROM admin_magic_links WHERE expires_at <= ? OR consumed_at IS NOT NULL")
      .bind(Date.now()).run());
    ctx.waitUntil(env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?")
      .bind(Date.now()).run());
  },
};
