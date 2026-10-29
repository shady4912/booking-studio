import { createHash, randomBytes } from "node:crypto";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const sessionCookieName = "booking_studio_session";
export const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export function parseAdminEmails(value) {
  const emails = value.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails.some((email) => !emailPattern.test(email))) {
    throw new Error("BOOKING_ADMIN_EMAILS must contain valid comma-separated email addresses.");
  }
  return [...new Set(emails)];
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createToken() {
  return randomBytes(32).toString("base64url");
}

export function readCookie(request, name) {
  const cookie = request.headers.cookie || "";
  for (const item of cookie.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(item.slice(separator + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

export function sessionCookie(token, maxAgeSeconds = Math.floor(sessionLifetimeMs / 1000)) {
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie() {
  return sessionCookie("", 0);
}
