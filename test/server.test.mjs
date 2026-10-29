import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serverFile = fileURLToPath(new URL("../server.mjs", import.meta.url));
let child;
let baseUrl;
let dataDirectory;

const nextMonday = () => {
  const date = new Date();
  const daysUntilMonday = ((8 - date.getUTCDay()) % 7) || 7;
  date.setUTCDate(date.getUTCDate() + daysUntilMonday);
  return date.toISOString().slice(0, 10);
};

async function getAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

before(async () => {
  const port = await getAvailablePort();
  dataDirectory = await mkdtemp(join(tmpdir(), "booking-studio-test-"));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(port), BOOKING_STUDIO_DATA_DIR: dataDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start. ${output}`)), 5000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("Booking Studio running")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  });
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

test("creates, lists, reads, and updates a locally stored project", async () => {
  const created = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      service: { name: "Test Service", slug: "test-service", pricing: { currency: "EUR", baseFee: "" } },
      sections: [{ id: "details", title: "Details", type: "questions", fields: [] }],
    }),
  });
  assert.equal(created.status, 201);
  const project = await created.json();
  assert.match(project.projectId, /^[0-9a-f-]{36}$/);

  const listed = await fetch(`${baseUrl}/api/projects`).then((response) => response.json());
  assert.equal(listed.projects.length, 1);
  assert.equal(listed.projects[0].name, "Test Service");

  const loaded = await fetch(`${baseUrl}/api/projects/${project.projectId}`).then((response) => response.json());
  assert.equal(loaded.service.name, "Test Service");

  const updated = await fetch(`${baseUrl}/api/projects/${project.projectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...loaded, service: { ...loaded.service, name: "Updated Service" } }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).service.name, "Updated Service");
});

test("rejects invalid project structure and malformed JSON", async () => {
  const invalid = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      service: { name: "Invalid" },
      sections: [{ id: "bad", title: "Bad", type: "questions", fields: [{ id: "unsafe", label: "Unsafe", type: "script" }] }],
    }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /question is invalid/);

  const malformed = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
});

test("rejects cross-origin attempts to write local drafts", async () => {
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
    body: JSON.stringify({ version: 1, service: { name: "Blocked" }, sections: [] }),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /Cross-origin/);
});

test("rejects duplicate question IDs and incompatible add-on fields", async () => {
  const project = {
    version: 1,
    service: { name: "Invalid fields" },
    sections: [
      { id: "details", title: "Details", type: "questions", fields: [{ id: "duplicate", label: "One", type: "text" }] },
      { id: "extras", title: "Extras", type: "addons", fields: [{ id: "duplicate", label: "Two", type: "boolean" }] },
    ],
  };
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /question is invalid/);

  project.sections[1].fields = [{ id: "wrong-kind", label: "Not a tile", type: "text" }];
  const incompatible = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  assert.equal(incompatible.status, 400);
  assert.match((await incompatible.json()).error, /question is invalid/);
});

test("API holds capacity atomically and confirms a booking once", async () => {
  const created = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      service: {
        name: "Booking API test",
        timezone: "Europe/Berlin",
        pricing: { currency: "EUR", baseFee: "50.00", discountType: "none", discountValue: "", minimum: "" },
        availability: {
          mode: "verified",
          durationMinutes: 60,
          bufferMinutes: 0,
          capacity: 1,
          holdMinutes: 10,
          horizonDays: 30,
          minimumNoticeMinutes: 0,
          workingHours: { 0: null, 1: { start: "09:00", end: "10:00" }, 2: null, 3: null, 4: null, 5: null, 6: null },
          blackoutDates: [],
        },
      },
      sections: [{
        id: "contact", title: "Contact", type: "questions",
        fields: [{ id: "email", label: "Email", type: "email", required: true, options: [] }],
      }],
    }),
  });
  assert.equal(created.status, 201);
  const project = await created.json();
  const date = nextMonday();
  const available = await fetch(`${baseUrl}/api/availability?projectId=${project.projectId}&from=${date}&days=1`);
  assert.equal(available.status, 200);
  const { slots } = await available.json();
  assert.equal(slots.length, 1);

  const hold = (key) => fetch(`${baseUrl}/api/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: project.projectId, slotStart: slots[0].start, idempotencyKey: key }),
  });
  const holdResults = await Promise.all([hold("api-hold-one"), hold("api-hold-two")]);
  assert.deepEqual(holdResults.map((response) => response.status).sort(), [201, 409]);
  const heldIndex = holdResults.findIndex((response) => response.status === 201);
  const holdBody = await holdResults[heldIndex].json();

  const confirm = () => fetch(`${baseUrl}/api/bookings/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: project.projectId,
      holdId: holdBody.id,
      idempotencyKey: "api-confirm-same-key",
      inputAnswers: { email: "person@example.com" },
    }),
  });
  const confirmations = await Promise.all([confirm(), confirm()]);
  assert.deepEqual(confirmations.map((response) => response.status), [201, 201]);
  const confirmed = await Promise.all(confirmations.map((response) => response.json()));
  assert.equal(confirmed[0].id, confirmed[1].id);
  assert.equal(confirmed[0].quote.totalMinor, 5000);
  const saved = await fetch(`${baseUrl}/api/bookings?projectId=${project.projectId}`).then((response) => response.json());
  assert.equal(saved.bookings.length, 1);
  const cancelled = await fetch(`${baseUrl}/api/bookings/${confirmed[0].id}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: project.projectId }),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, "cancelled");
  const reopened = await fetch(`${baseUrl}/api/availability?projectId=${project.projectId}&from=${date}&days=1`).then((response) => response.json());
  assert.equal(reopened.slots.length, 1);
});

test("publishes a standalone booking page and accepts a public confirmation", async () => {
  const project = {
    version: 1,
    service: {
      name: "Published test service",
      title: "Book a test service",
      slug: "published-test-service",
      published: false,
      timezone: "Europe/Berlin",
      pricing: { currency: "EUR", baseFee: "25.00", discountType: "none", discountValue: "", minimum: "" },
      availability: {
        mode: "verified",
        durationMinutes: 60,
        bufferMinutes: 0,
        capacity: 1,
        holdMinutes: 10,
        horizonDays: 30,
        minimumNoticeMinutes: 0,
        workingHours: { 0: null, 1: { start: "09:00", end: "10:00" }, 2: null, 3: null, 4: null, 5: null, 6: null },
        blackoutDates: [],
      },
    },
    sections: [{
      id: "contact", title: "Contact", type: "questions",
      fields: [{ id: "email", label: "Email", type: "email", required: true, options: [] }],
    }],
  };
  const created = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  assert.equal(created.status, 201);
  const savedProject = await created.json();
  assert.equal((await fetch(`${baseUrl}/book/published-test-service`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/public/services/published-test-service`)).status, 404);

  savedProject.service.published = true;
  const published = await fetch(`${baseUrl}/api/projects/${savedProject.projectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(savedProject),
  });
  assert.equal(published.status, 200);
  const page = await fetch(`${baseUrl}/book/published-test-service`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /public\.js/);

  const pageResponse = await fetch(`${baseUrl}/api/public/services/published-test-service`);
  assert.equal(pageResponse.status, 200);
  const start = nextMonday();
  const availability = await fetch(
    `${baseUrl}/api/public/availability?slug=published-test-service&from=${start}&days=1`,
  ).then((response) => response.json());
  assert.equal(availability.slots.length, 1);
  const hold = await fetch(`${baseUrl}/api/public/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: "published-test-service",
      slotStart: availability.slots[0].start,
      idempotencyKey: "public-hold-key-01",
    }),
  }).then((response) => response.json());
  const confirmation = await fetch(`${baseUrl}/api/public/bookings/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: "published-test-service",
      holdId: hold.id,
      idempotencyKey: "public-confirm-key-01",
      inputAnswers: { email: "customer@example.com" },
    }),
  });
  assert.equal(confirmation.status, 201);
  assert.equal((await confirmation.json()).quote.totalMinor, 2500);
});
