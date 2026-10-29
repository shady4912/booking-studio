export function parseCents(value) {
  if (value === "" || value == null) return null;
  const match = String(value).match(/^(\d{1,8})(?:\.(\d{1,2}))?$/);
  return match ? Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0")) : null;
}

export function formatMoney(cents, currency = "EUR") {
  const supportedCurrency = ["EUR", "USD", "GBP", "CHF"].includes(currency) ? currency : "EUR";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: supportedCurrency }).format(cents / 100);
}

export function calculatePreviewQuote(project, answers) {
  const pricing = project.service.pricing || {};
  const items = [];
  let subtotal = 0;
  let configured = false;
  let unpriced = false;
  const baseFee = parseCents(pricing.baseFee);
  if (pricing.baseFee !== "" && pricing.baseFee != null) {
    configured = true;
    if (baseFee == null) unpriced = true;
    else {
      subtotal += baseFee;
      items.push({ label: "Base fee", cents: baseFee });
    }
  }

  project.sections.forEach((section) => section.fields?.forEach((item) => {
    const mode = item.pricing?.type || "none";
    const value = answers.get(item.id);
    if (mode === "none") return;
    configured = true;
    if (!value || (item.type === "boolean" && value.toLowerCase() === "no")) return;
    const rate = parseCents(item.pricing?.rate);
    if (rate == null) {
      unpriced = true;
      return;
    }
    const quantity = mode === "per_unit" ? Number(value) : 1;
    if (!Number.isFinite(quantity) || quantity < 0 ||
      (item.min != null && quantity < item.min) ||
      (item.max != null && quantity > item.max) ||
      !Number.isSafeInteger(Math.round(rate * quantity))) {
      unpriced = true;
      return;
    }
    const cents = Math.round(rate * quantity);
    if (!Number.isSafeInteger(subtotal + cents)) {
      unpriced = true;
      return;
    }
    subtotal += cents;
    items.push({
      label: mode === "per_unit" ? `${item.label} (${quantity} × ${formatMoney(rate, pricing.currency)})` : item.label,
      cents,
    });
  }));

  let discount = 0;
  if (pricing.discountType && pricing.discountType !== "none") {
    configured = true;
    if (pricing.discountValue === "") unpriced = true;
    else {
      const value = Number(pricing.discountValue);
      if (!Number.isFinite(value) || value < 0 || (pricing.discountType === "percent" && value > 100)) unpriced = true;
      else if (pricing.discountType === "fixed") {
        const cents = parseCents(pricing.discountValue);
        if (cents == null) unpriced = true;
        else discount = Math.min(subtotal, cents);
      } else if (pricing.discountType === "percent") {
        const basisPoints = parseCents(pricing.discountValue);
        if (basisPoints == null) unpriced = true;
        else discount = Number((BigInt(subtotal) * BigInt(basisPoints) + 5000n) / 10000n);
      }
      else unpriced = true;
    }
  }
  if (discount) items.push({ label: "Discount", cents: -discount });
  let total = Math.max(0, subtotal - discount);

  const minimum = parseCents(pricing.minimum);
  if (pricing.minimum !== "" && pricing.minimum != null) {
    configured = true;
    if (minimum == null) unpriced = true;
    else if (total < minimum) {
      items.push({ label: "Minimum total adjustment", cents: minimum - total });
      total = minimum;
    }
  }
  return { items, total, configured, unpriced };
}
