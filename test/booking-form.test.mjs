import test from "node:test";
import assert from "node:assert/strict";
import { collectBookingAnswers } from "../booking-form.mjs";

test("booking answer collection excludes Turnstile and unrelated form fields", () => {
  const project = {
    sections: [
      { fields: [{ id: "email" }, { id: "service_type" }] },
      { fields: [{ id: "addon" }] },
    ],
  };
  const answers = collectBookingAnswers(project, [
    ["email", "customer@example.com"],
    ["service_type", "Cleaning"],
    ["addon", "yes"],
    ["cf-turnstile-response", "turnstile-token"],
    ["privacy-consent", "on"],
  ]);
  assert.deepEqual(Object.fromEntries(answers), {
    email: "customer@example.com",
    service_type: "Cleaning",
    addon: "yes",
  });
});
