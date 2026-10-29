import { calculatePreviewQuote, formatMoney } from "./pricing.mjs";
import { collectBookingAnswers } from "./booking-form.mjs";
import { formatAddressFeature } from "./address-search.mjs";

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

function fieldRole(field) {
  const value = `${field.id} ${field.label}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(street|address|location)\b/.test(value)) return "address";
  if (/\b(city|town|municipality)\b/.test(value)) return "city";
  if (/\b(zip|postal|postcode)\b/.test(value)) return "postcode";
  return "";
}

function setupAddressAutocomplete(addressInput, cityInput, postcodeInput) {
  if (!addressInput || addressInput.tagName !== "INPUT" || addressInput.type !== "text") return;

  const wrapper = addressInput.closest(".public-field");
  if (!wrapper) return;
  const listId = `${addressInput.id}-suggestions`;
  const list = element("div", "address-suggestions");
  list.id = listId;
  list.setAttribute("role", "listbox");
  list.hidden = true;
  const status = element("div", "address-search-status");
  status.setAttribute("role", "status");
  const attribution = document.createElement("small");
  attribution.className = "address-attribution";
  attribution.append(document.createTextNode("Address suggestions by "));
  const photonLink = document.createElement("a");
  photonLink.href = "https://photon.komoot.io/";
  photonLink.target = "_blank";
  photonLink.rel = "noopener noreferrer";
  photonLink.textContent = "Photon";
  attribution.append(photonLink, document.createTextNode(" · © "));
  const osmLink = document.createElement("a");
  osmLink.href = "https://www.openstreetmap.org/copyright";
  osmLink.target = "_blank";
  osmLink.rel = "noopener noreferrer";
  osmLink.textContent = "OpenStreetMap contributors";
  attribution.append(osmLink);
  const privacyNote = element(
    "small",
    "address-privacy-note",
    "Search text is sent to Photon for suggestions. You can also enter the address manually.",
  );
  const help = wrapper.querySelector(".public-help");
  wrapper.insertBefore(list, help || null);
  wrapper.insertBefore(status, help || null);
  wrapper.insertBefore(attribution, help || null);
  wrapper.insertBefore(privacyNote, help || null);
  addressInput.setAttribute("role", "combobox");
  addressInput.setAttribute("aria-autocomplete", "list");
  addressInput.setAttribute("aria-controls", listId);
  addressInput.setAttribute("aria-expanded", "false");
  addressInput.autocomplete = "off";

  let debounceTimer;
  let activeRequest;
  let requestSequence = 0;
  let activeIndex = -1;
  let selectedAddress = "";
  let options = [];

  const closeList = () => {
    list.hidden = true;
    list.replaceChildren();
    status.textContent = "";
    addressInput.setAttribute("aria-expanded", "false");
    addressInput.removeAttribute("aria-activedescendant");
    activeIndex = -1;
    options = [];
  };

  const selectSuggestion = (suggestion) => {
    selectedAddress = suggestion.address;
    addressInput.value = suggestion.address;
    if (cityInput && suggestion.city) cityInput.value = suggestion.city;
    if (postcodeInput && suggestion.postcode) postcodeInput.value = suggestion.postcode;
    closeList();
    addressInput.dispatchEvent(new Event("input", { bubbles: true }));
    addressInput.dispatchEvent(new Event("change", { bubbles: true }));
    cityInput?.dispatchEvent(new Event("input", { bubbles: true }));
    cityInput?.dispatchEvent(new Event("change", { bubbles: true }));
    postcodeInput?.dispatchEvent(new Event("input", { bubbles: true }));
    postcodeInput?.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const setActiveOption = (index) => {
    if (!options.length) return;
    activeIndex = (index + options.length) % options.length;
    for (const [optionIndex, option] of [...list.children].entries()) {
      const active = optionIndex === activeIndex;
      option.setAttribute("aria-selected", String(active));
      option.classList.toggle("active", active);
    }
    addressInput.setAttribute("aria-activedescendant", list.children[activeIndex].id);
    list.children[activeIndex].scrollIntoView?.({ block: "nearest" });
  };

  const search = async (query, sequence) => {
    activeRequest?.abort();
    activeRequest = new AbortController();
    status.textContent = "Searching addresses…";
    list.hidden = false;
    addressInput.setAttribute("aria-expanded", "true");
    const url = new URL("https://photon.komoot.io/api/");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "5");
    url.searchParams.set("lang", navigator.language?.split("-")[0] || "en");
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: activeRequest.signal,
      });
      if (!response.ok) throw new Error(`Address search failed (HTTP ${response.status}).`);
      const result = await response.json();
      if (sequence !== requestSequence) return;
      options = (result.features || []).map(formatAddressFeature).filter(Boolean);
      list.replaceChildren();
      if (!options.length) {
        status.textContent = "No matching addresses found. You can enter the address manually.";
        return;
      }
      status.textContent = "";
      for (const [index, suggestion] of options.entries()) {
        const option = element("button", "address-suggestion");
        option.type = "button";
        option.id = `${listId}-option-${index}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        const title = element("span", "address-suggestion-title", suggestion.title);
        const details = element("small", "address-suggestion-details", suggestion.details);
        option.append(title, details);
        option.addEventListener("pointerdown", (event) => event.preventDefault());
        option.addEventListener("click", () => selectSuggestion(suggestion));
        list.append(option);
      }
      list.hidden = false;
      addressInput.setAttribute("aria-expanded", "true");
    } catch (error) {
      if (error.name === "AbortError" || sequence !== requestSequence) return;
      console.error("Address autocomplete request failed.", error);
      list.replaceChildren();
      status.textContent = "Address suggestions are temporarily unavailable. You can enter the address manually.";
      list.hidden = false;
      addressInput.setAttribute("aria-expanded", "true");
    }
  };

  addressInput.addEventListener("input", () => {
    if (selectedAddress && addressInput.value === selectedAddress) {
      clearTimeout(debounceTimer);
      activeRequest?.abort();
      closeList();
      return;
    }
    if (selectedAddress && addressInput.value !== selectedAddress) {
      selectedAddress = "";
      if (cityInput) cityInput.value = "";
      if (postcodeInput) postcodeInput.value = "";
    }
    clearTimeout(debounceTimer);
    activeRequest?.abort();
    const query = addressInput.value.trim();
    const sequence = ++requestSequence;
    if (query.length < 3) {
      closeList();
      return;
    }
    debounceTimer = setTimeout(() => search(query, sequence), 300);
  });

  addressInput.addEventListener("keydown", (event) => {
    if (list.hidden) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveOption(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveOption(activeIndex < 0 ? options.length - 1 : activeIndex - 1);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      selectSuggestion(options[activeIndex]);
    } else if (event.key === "Escape") {
      closeList();
    }
  });

  addressInput.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!wrapper.contains(document.activeElement)) closeList();
    }, 0);
  });
}

function currentAnswers(form) {
  return collectBookingAnswers(project, new FormData(form));
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
  const fieldControls = new Map();
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
      fieldControls.set(field.id, control.querySelector("input,select,textarea"));
      sectionNode.append(control);
      if (!firstFieldset) firstFieldset = control.querySelector("input,select,textarea");
    });
    form.append(sectionNode);
  });
  const addressField = project.sections
    .flatMap((section) => section.fields || [])
    .find((field) => fieldRole(field) === "address");
  const cityField = project.sections.flatMap((section) => section.fields || [])
    .find((field) => fieldRole(field) === "city");
  const postcodeField = project.sections.flatMap((section) => section.fields || [])
    .find((field) => fieldRole(field) === "postcode");
  setupAddressAutocomplete(
    addressField ? fieldControls.get(addressField.id) : null,
    cityField ? fieldControls.get(cityField.id) : null,
    postcodeField ? fieldControls.get(postcodeField.id) : null,
  );
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
