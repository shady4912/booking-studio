import test from "node:test";
import assert from "node:assert/strict";
import {
  clearSessionCookie,
  createToken,
  hashToken,
  parseAdminEmails,
  readCookie,
  sessionCookie,
  sessionCookieName,
} from "../auth.mjs";

test("normalizes administrator allowlists and rejects invalid addresses", () => {
  assert.deepEqual(
    parseAdminEmails(" Owner@example.com,office@example.com,owner@example.com "),
    ["owner@example.com", "office@example.com"],
  );
  assert.throws(() => parseAdminEmails("owner@example.com,not-an-email"), /BOOKING_ADMIN_EMAILS/);
});

test("creates URL-safe tokens and stores only their stable hashes", () => {
  const token = createToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(hashToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashToken(token), token);
});

test("reads cookies safely and builds secure session cookie headers", () => {
  assert.equal(readCookie({ headers: { cookie: "other=1; booking_studio_session=abc" } }, sessionCookieName), "abc");
  assert.equal(readCookie({ headers: { cookie: "booking_studio_session=%ZZ" } }, sessionCookieName), "");
  assert.match(sessionCookie("token"), /HttpOnly; Secure; SameSite=Strict/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
});
