import test from "node:test";
import assert from "node:assert/strict";
import { calculatePreviewQuote, formatMoney, parseCents } from "../pricing.mjs";

const projectWith = (pricing, fields) => ({
  service: { pricing },
  sections: [{ fields }],
});

test("parses decimal rates into integer minor units", () => {
  assert.equal(parseCents("12"), 1200);
  assert.equal(parseCents("12.3"), 1230);
  assert.equal(parseCents("12.34"), 1234);
  assert.equal(parseCents("-1.00"), null);
  assert.equal(parseCents("1.234"), null);
});

test("prices base, conditional, and per-unit charges before a discount and minimum floor", () => {
  const project = projectWith(
    { currency: "EUR", baseFee: "25.00", discountType: "percent", discountValue: "10", minimum: "50.00" },
    [
      { id: "area", label: "Area", type: "number", min: 1, max: 20, pricing: { type: "per_unit", rate: "2.50" } },
      { id: "weekend", label: "Weekend service", type: "boolean", pricing: { type: "fixed", rate: "15.00" } },
    ],
  );
  const quote = calculatePreviewQuote(project, new Map([["area", "3"], ["weekend", "yes"]]));
  assert.equal(quote.total, 5000);
  assert.equal(quote.configured, true);
  assert.equal(quote.unpriced, false);
  assert.equal(quote.items[0].label, "Base fee");
  assert.match(quote.items[1].label, /^Area \(3 × /);
  assert.equal(quote.items[2].label, "Weekend service");
  assert.equal(quote.items[3].label, "Discount");
  assert.equal(quote.items[4].label, "Minimum total adjustment");
  assert.equal(quote.items.at(-2).cents, -475);
  assert.equal(quote.items.at(-1).cents, 725);
});

test("does not charge a false boolean answer and flags missing selected rates", () => {
  const project = projectWith(
    { currency: "EUR", baseFee: "", discountType: "none", minimum: "" },
    [{ id: "extra", label: "Extra", type: "boolean", pricing: { type: "fixed", rate: "" } }],
  );
  const noQuote = calculatePreviewQuote(project, new Map([["extra", "no"]]));
  assert.equal(noQuote.unpriced, false);
  assert.equal(noQuote.total, 0);

  const yesQuote = calculatePreviewQuote(project, new Map([["extra", "yes"]]));
  assert.equal(yesQuote.unpriced, true);
});

test("formats using the selected currency", () => {
  assert.equal(formatMoney(1234, "EUR").replace(/\D/g, ""), "1234");
});
