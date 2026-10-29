import { calculatePreviewQuote, formatMoney } from "./pricing.mjs";

const root = document.querySelector("#public-content");
const slug = decodeURIComponent(location.pathname.slice("/book/".length));
const idempotencyKey = () => crypto.randomUUID();
let project;
let currentWeekStart;
let selectedSlot = null;
let activeHold = null;
let availabilitySequence = 0;
let turnstileSiteKey = null;
let turnstileWidgetId = null;
let turnstileToken = "";
let privacyPolicyUrl = null;

async function request(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

function dateKeyInZone(date, timezone) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildField(field) {
  const wrapper = element("div", "public-field");
  const label = element("label", "", `${field.label}${field.required ? " *" : ""}`);
  const control = field.type === "textarea"
    ? document.createElement("textarea")
    : field.type === "select" || field.type === "boolean"
      ? document.createElement("select")
      : document.createElement("input");
  control.name = field.id;
  control.id = `field-${field.id}`;
  control.required = Boolean(field.required);
  if (field.type === "email" || field.type === "number" || field.type === "text") control.type = field.type;
  if (field.type === "number") {
    if (field.min != null) control.min = field.min;
    if (field.max != null) control.max = field.max;
    control.step = "any";
  }
  if (field.type === "text" || field.type === "email" || field.type === "textarea") control.maxLength = 2000;
  if (field.type === "select" || field.type === "boolean") {
    control.append(new Option("Choose an option", ""));
    const options = field.type === "boolean" ? ["Yes", "No"] : field.options || [];
    options.forEach((value) => control.append(new Option(
      value,
      field.type === "boolean" ? value.toLowerCase() : value,
    )));
  }
  label.htmlFor = control.id;
  wrapper.append(label, control);
  if (field.help) wrapper.append(element("small", "public-help", field.help));
  return wrapper;
}

function currentAnswers(form) {
  return new Map([...new FormData(form)].map(([key, value]) => [key, String(value)]));
}

function refreshQuote(form, totalNode, statusNode, submitButton) {
  const quote = calculatePreviewQuote(project, currentAnswers(form));
  if (!quote.configured || quote.unpriced) {
    totalNode.textContent = "Price not configured";
    statusNode.textContent = "The business needs to finish pricing this service before bookings can be confirmed.";
    statusNode.classList.add("public-error");
    submitButton.disabled = true;
    return false;
  }
  totalNode.textContent = formatMoney(quote.total, project.service.pricing.currency);
  statusNode.textContent = activeHold
    ? `Slot held until ${new Date(activeHold.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
    : "Select an available appointment to continue.";
  statusNode.classList.remove("public-error");
  submitButton.disabled = !activeHold || (turnstileSiteKey && !turnstileToken);
  return true;
}

function renderTurnstile(statusNode, form, totalNode, submitButton) {
  if (!turnstileSiteKey) return;
  const widget = element("div", "public-field");
  widget.id = "turnstile-widget";
  widget.setAttribute("aria-label", "Anti-spam verification");
  form.append(widget);
  const render = () => {
    if (!window.turnstile || turnstileWidgetId != null) return;
    turnstileWidgetId = window.turnstile.render(widget, {
      sitekey: turnstileSiteKey,
      action: "booking",
      callback: (token) => {
        turnstileToken = token;
        refreshQuote(form, totalNode, statusNode, submitButton);
      },
      "expired-callback": () => {
        turnstileToken = "";
        refreshQuote(form, totalNode, statusNode, submitButton);
      },
      "error-callback": () => {
        turnstileToken = "";
        statusNode.textContent = "Anti-spam verification failed. Please retry the check.";
        statusNode.classList.add("public-error");
        refreshQuote(form, totalNode, statusNode, submitButton);
      },
    });
  };
  if (window.turnstile) {
    render();
  } else {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = render;
    script.onerror = () => {
      statusNode.textContent = "Anti-spam verification could not load. Please try again later.";
      statusNode.classList.add("public-error");
    };
    document.head.append(script);
  }
}

function consumeTurnstileToken() {
  const token = turnstileToken;
  turnstileToken = "";
  if (turnstileWidgetId != null && window.turnstile) window.turnstile.reset(turnstileWidgetId);
  return token;
}

async function releaseActiveHold() {
  const hold = activeHold;
  activeHold = null;
  selectedSlot = null;
  if (!hold) return;
  try {
    await request(`/api/public/holds/${encodeURIComponent(hold.id)}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
  } catch (error) {
    console.warn("The previous appointment hold may expire automatically.", error);
  }
}

async function renderAvailability(container, statusNode, form, totalNode, submitButton) {
  const sequence = ++availabilitySequence;
  container.replaceChildren(element("p", "public-message", "Checking available appointments…"));
  const controls = element("div", "week-controls");
  const previous = element("button", "button quiet", "Previous week");
  previous.type = "button";
  previous.disabled = currentWeekStart <= dateKeyInZone(new Date(), project.service.timezone);
  const weekLabel = element("span", "", currentWeekStart);
  const next = element("button", "button quiet", "Next week");
  next.type = "button";
  previous.addEventListener("click", async () => {
    await releaseActiveHold();
    currentWeekStart = shiftDateKey(currentWeekStart, -7);
    await renderAvailability(container, statusNode, form, totalNode, submitButton);
    refreshQuote(form, totalNode, statusNode, submitButton);
  });
  next.addEventListener("click", async () => {
    await releaseActiveHold();
    currentWeekStart = shiftDateKey(currentWeekStart, 7);
    await renderAvailability(container, statusNode, form, totalNode, submitButton);
    refreshQuote(form, totalNode, statusNode, submitButton);
  });
  controls.append(previous, weekLabel, next);
  container.replaceChildren(controls);
  try {
    const result = await request(
      `/api/public/availability?slug=${encodeURIComponent(slug)}&from=${encodeURIComponent(currentWeekStart)}&days=7`,
    );
    if (sequence !== availabilitySequence) return;
    const groups = new Map();
    result.slots.forEach((slot) => {
      if (!groups.has(slot.date)) groups.set(slot.date, []);
      groups.get(slot.date).push(slot);
    });
    if (!groups.size) {
      container.append(element("p", "public-message", "No appointments are available this week. Try another week."));
    }
    for (const [date, slots] of groups) {
      const day = element("div", "public-day");
      day.append(element("h3", "", new Intl.DateTimeFormat(undefined, {
        weekday: "long", month: "long", day: "numeric", timeZone: project.service.timezone,
      }).format(new Date(`${date}T12:00:00`))));
      const slotList = element("div", "public-slots");
      slots.forEach((slot) => {
        const button = element("button", "public-slot", slot.localTime);
        button.type = "button";
        button.setAttribute("aria-pressed", String(selectedSlot === slot.start));
        button.addEventListener("click", async () => {
          await releaseActiveHold();
          selectedSlot = slot.start;
          button.disabled = true;
          statusNode.textContent = "Holding this appointment…";
          try {
            activeHold = await request("/api/public/holds", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                slug,
                slotStart: slot.start,
                idempotencyKey: idempotencyKey(),
                turnstileToken: consumeTurnstileToken(),
              }),
            });
            await renderAvailability(container, statusNode, form, totalNode, submitButton);
            refreshQuote(form, totalNode, statusNode, submitButton);
          } catch (error) {
            selectedSlot = null;
            statusNode.textContent = error.message;
            statusNode.classList.add("public-error");
            await renderAvailability(container, statusNode, form, totalNode, submitButton);
            refreshQuote(form, totalNode, statusNode, submitButton);
            statusNode.textContent = error.message;
            statusNode.classList.add("public-error");
          }
        });
        slotList.append(button);
      });
      day.append(slotList);
      container.append(day);
    }
  } catch (error) {
    if (sequence === availabilitySequence) container.append(element("p", "public-message public-error", error.message));
  }
}

function renderPage() {
  document.title = `${project.service.title || project.service.name} · CasaHelp`;
  root.replaceChildren();
  const heading = element("h1", "", project.service.title || project.service.name);
  const intro = element("p", "public-intro", project.service.intro || "");
  const form = document.createElement("form");
  form.noValidate = false;
  const schedule = element("section", "public-section");
  schedule.append(element("h2", "", "Choose an appointment"));
  const availability = element("div", "public-schedule");
  schedule.append(availability);
  let firstFieldset = null;
  project.sections.forEach((section) => {
    if (section.type === "schedule") {
      form.append(schedule);
      return;
    }
    if (!section.fields?.length) return;
    const sectionNode = element("section", "public-section");
    sectionNode.append(element("h2", "", section.title));
    section.fields.forEach((field) => {
      const control = buildField(field);
      sectionNode.append(control);
      if (!firstFieldset) firstFieldset = control.querySelector("input,select,textarea");
    });
    form.append(sectionNode);
  });
  if (!project.sections.some((section) => section.type === "schedule")) form.prepend(schedule);
  const summary = element("div", "public-summary");
  const quoteBlock = element("div");
  quoteBlock.append(element("div", "eyebrow", "ESTIMATED TOTAL"));
  const total = element("div", "public-total");
  const status = element("p", "public-status", "Select an available appointment to continue.");
  quoteBlock.append(total, status);
  const submit = element("button", "button primary", "Confirm booking");
  submit.type = "submit";
  submit.disabled = true;
  summary.append(quoteBlock, submit);
  const consent = element("div", "public-field");
  const consentLabel = document.createElement("label");
  const consentCheckbox = document.createElement("input");
  consentCheckbox.type = "checkbox";
  consentCheckbox.required = true;
  consentCheckbox.id = "privacy-consent";
  consentLabel.htmlFor = consentCheckbox.id;
  consentLabel.append(consentCheckbox, document.createTextNode(
    privacyPolicyUrl ? " I have read the privacy notice" : " I understand this is a test booking",
  ));
  consent.append(consentLabel);
  if (privacyPolicyUrl) {
    const privacyLink = document.createElement("a");
    privacyLink.href = privacyPolicyUrl;
    privacyLink.target = "_blank";
    privacyLink.rel = "noopener noreferrer";
    privacyLink.textContent = "Read privacy notice";
    consent.append(privacyLink);
  }
  form.append(consent);
  renderTurnstile(status, form, total, submit);
  form.append(summary);
  form.addEventListener("input", () => refreshQuote(form, total, status, submit));
  form.addEventListener("change", () => refreshQuote(form, total, status, submit));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeHold || !form.reportValidity() || !refreshQuote(form, total, status, submit)) return;
    submit.disabled = true;
    status.textContent = "Confirming your appointment…";
    try {
      const booking = await request("/api/public/bookings/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          holdId: activeHold.id,
          idempotencyKey: idempotencyKey(),
          turnstileToken: consumeTurnstileToken(),
          privacyNoticeAccepted: consentCheckbox.checked,
          inputAnswers: Object.fromEntries(currentAnswers(form)),
        }),
      });
      activeHold = null;
      const success = element("section", "public-success");
      success.append(
        element("h2", "", "Your appointment is confirmed"),
        element("p", "", `${new Intl.DateTimeFormat(undefined, {
          dateStyle: "full",
          timeStyle: "short",
          timeZone: booking.appointment.timezone,
        }).format(new Date(booking.appointment.start))} (${booking.appointment.timezone})`),
        element("p", "", `Booking reference: ${booking.id}`),
        element("p", "", `Total: ${formatMoney(booking.quote.totalMinor, booking.quote.currency)}`),
      );
      root.replaceChildren(heading, intro, success);
    } catch (error) {
      status.textContent = error.message;
      status.classList.add("public-error");
      refreshQuote(form, total, status, submit);
      status.textContent = error.message;
      status.classList.add("public-error");
    }
  });
  root.append(heading, intro, form);
  currentWeekStart = dateKeyInZone(new Date(), project.service.timezone);
  renderAvailability(availability, status, form, total, submit)
    .then(() => refreshQuote(form, total, status, submit));
  refreshQuote(form, total, status, submit);
  firstFieldset?.focus({ preventScroll: true });
}

request(`/api/public/services/${encodeURIComponent(slug)}`)
  .then((result) => {
    project = result.project;
    turnstileSiteKey = result.turnstileSiteKey;
    privacyPolicyUrl = result.privacyPolicyUrl;
    renderPage();
  })
  .catch((error) => {
    root.replaceChildren(element("h1", "", "Booking page unavailable"), element("p", "public-message", error.message));
  });
