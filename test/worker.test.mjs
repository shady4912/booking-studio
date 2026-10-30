import test from "node:test";
import assert from "node:assert/strict";
import { BookingProjectObject } from "../booking-object.mjs";
import worker from "../worker.mjs";
import { defaultAvailability } from "../bookings.mjs";

const projectId = "2b7bca11-c5aa-4c6e-87f8-20d9686be225";
const nextMonday = (timestamp) => {
  const date = new Date(timestamp);
  const daysUntilMonday = ((8 - date.getUTCDay()) % 7) || 7;
  date.setUTCDate(date.getUTCDate() + daysUntilMonday);
  return date.toISOString().slice(0, 10);
};
const makeProject = () => ({
  version: 1,
  projectId,
  service: {
    name: "Worker test service",
    timezone: "Europe/Berlin",
    pricing: { currency: "EUR", baseFee: "50.00", discountType: "none", discountValue: "", minimum: "" },
    availability: {
      ...defaultAvailability(),
      mode: "verified",
      capacity: 1,
      minimumNoticeMinutes: 0,
      workingHours: {
        0: null,
        1: { start: "09:00", end: "11:00" },
        2: null,
        3: null,
        4: null,
        5: null,
        6: null,
      },
    },
  },
  sections: [{
    id: "contact",
    title: "Contact",
    type: "questions",
    fields: [{ id: "email", label: "Email", type: "email", required: true, options: [] }],
  }],
});

function memoryDatabase(project = null) {
  let ledger = null;
  const rateCounts = new Map();
  const sessions = [];
  return {
    sessions,
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) {
          values = args;
          return statement;
        },
        async first() {
          if (sql.includes("SELECT project FROM booking_projects")) {
            return project ? { project: JSON.stringify(project) } : null;
          }
          if (sql.includes("SELECT ledger FROM booking_ledgers")) {
            return ledger ? { ledger } : null;
          }
          if (sql.includes("SELECT email FROM admin_sessions")) return null;
          if (sql.includes("INSERT INTO rate_limits")) {
            const key = `${values[1]}:${values[0]}`;
            const count = (rateCounts.get(key) || 0) + 1;
            rateCounts.set(key, count);
            return { count };
          }
          if (sql.includes("SELECT 1")) return { result: 1 };
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO booking_ledgers")) ledger = values[1];
          if (sql.includes("INSERT INTO admin_sessions")) sessions.push(values);
          return { success: true };
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
  };
}

test("Worker password login creates a secure session for an authorized administrator", async () => {
  const DB = memoryDatabase();
  const response = await worker.fetch(new Request("https://studio.example/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://studio.example",
      "CF-Connecting-IP": "203.0.113.10",
    },
    body: JSON.stringify({ email: "OWNER@example.com", password: "correct horse battery staple" }),
  }), {
    DB,
    ADMIN_EMAILS: "owner@example.com,office@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(DB.sessions.length, 1);
  assert.equal(DB.sessions[0][1], "owner@example.com");
});

test("Worker password login rejects wrong passwords and unauthorized email addresses", async () => {
  const env = {
    DB: memoryDatabase(),
    ADMIN_EMAILS: "owner@example.com",
    ADMIN_PASSWORD: "correct horse battery staple",
  };
  for (const credentials of [
    { email: "owner@example.com", password: "incorrect password" },
    { email: "other@example.com", password: "correct horse battery staple" },
  ]) {
    const response = await worker.fetch(new Request("https://studio.example/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://studio.example" },
      body: JSON.stringify(credentials),
    }), env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Email or password is incorrect." });
  }
});

test("Worker password login requires a configured password and rejects cross-origin requests", async () => {
  const env = {
    DB: memoryDatabase(),
    ADMIN_EMAILS: "owner@example.com",
  };
  const request = (origin) => worker.fetch(new Request("https://studio.example/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email: "owner@example.com", password: "a secure password" }),
  }), env);

  const unconfigured = await request("https://studio.example");
  assert.equal(unconfigured.status, 503);
  const crossOrigin = await request("https://attacker.example");
  assert.equal(crossOrigin.status, 403);
});

test("Worker health endpoint uses its D1 binding", async () => {
  const response = await worker.fetch(new Request("https://studio.example/healthz"), {
    DB: memoryDatabase(),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("Worker protects studio APIs and returns a controlled public not-found", async () => {
  const env = {
    DB: memoryDatabase(),
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const protectedResponse = await worker.fetch(
    new Request("https://studio.example/api/projects"),
    env,
  );
  assert.equal(protectedResponse.status, 401);

  const publicResponse = await worker.fetch(
    new Request("https://studio.example/api/public/services/missing"),
    env,
  );
  assert.equal(publicResponse.status, 404);
  assert.match((await publicResponse.json()).error, /not available/);
});

test("Worker serves a published booking shell without redirecting away from its slug URL", async () => {
  const project = makeProject();
  project.service.slug = "worker-test-service";
  project.service.published = true;
  const assetRequests = [];
  const response = await worker.fetch(
    new Request("https://studio.example/book/worker-test-service"),
    {
      DB: memoryDatabase(project),
      ASSETS: {
        async fetch(request) {
          assetRequests.push(new URL(request.url));
          return new Response("booking shell");
        },
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "booking shell");
  assert.equal(assetRequests.length, 1);
  assert.equal(assetRequests[0].pathname, "/public");
});

test("Durable Object serializes holds for a project's capacity", async () => {
  const project = makeProject();
  const object = new BookingProjectObject(
    { id: { name: projectId } },
    { DB: memoryDatabase(project) },
  );
  const monday = nextMonday(Date.now());
  const availability = await object.fetch(new Request("https://object.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "availability", payload: { from: monday, days: 1 } }),
  })).then((response) => response.json());
  assert.equal(availability.slots.length, 2);
  assert.ok(availability.slots.every((slot) => slot.date === monday));

  const [first, second] = await Promise.all([
    object.fetch(new Request("https://object.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "hold",
        payload: { slotStart: availability.slots[0].start, idempotencyKey: "worker-hold-one" },
      }),
    })),
    object.fetch(new Request("https://object.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "hold",
        payload: { slotStart: availability.slots[0].start, idempotencyKey: "worker-hold-two" },
      }),
    })),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
});
