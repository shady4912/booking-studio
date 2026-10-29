import { calculatePreviewQuote, formatMoney } from "./pricing.mjs";

(() => {
  "use strict";

  const storageKey = "casahelp-booking-studio-v1";
  const sectionsRoot = document.querySelector("#page-sections");
  const sectionListRoot = document.querySelector("#section-list");
  const canvas = document.querySelector("#page-canvas");
  const toast = document.querySelector("#toast");
  const fieldDialog = document.querySelector("#field-dialog");
  const sectionDialog = document.querySelector("#section-dialog");
  const settingsDialog = document.querySelector("#settings-dialog");
  const projectsDialog = document.querySelector("#projects-dialog");
  const stateLabel = document.querySelector("#save-state");
  const editableSectionTypes = new Set(["questions", "addons"]);
  let toastTimer;
  let dragged = null;
  let selectedField = null;
  let previewMode = false;
  let selectedSlot = "";
  let selectedHold = null;
  let pendingHoldRequest = null;
  let availabilityWeekOffset = 0;
  let availabilityRequest = 0;
  let projectGeneration = 0;
  let saveChain = Promise.resolve();

  const defaultAvailability = () => ({
    mode: "demo",
    durationMinutes: 60,
    bufferMinutes: 0,
    capacity: 1,
    holdMinutes: 10,
    horizonDays: 30,
    minimumNoticeMinutes: 60,
    workingHours: {
      0: null,
      1: { start: "09:00", end: "17:00" },
      2: { start: "09:00", end: "17:00" },
      3: { start: "09:00", end: "17:00" },
      4: { start: "09:00", end: "17:00" },
      5: { start: "09:00", end: "17:00" },
      6: null,
    },
    blackoutDates: [],
  });
  const field = (id, label, type, options = [], extra = {}) => ({
    id,
    label,
    type,
    options,
    help: "",
    required: false,
    price: null,
    ...extra,
  });
  const defaultState = () => ({
    version: 1,
    service: {
      name: "Move In Move Out Cleaning",
      slug: "move-in-move-out-cleaning",
      title: "Move In Move Out Cleaning",
      intro: "Book a professional cleaning for your new beginning.",
      timezone: "Europe/Berlin",
      availability: defaultAvailability(),
      published: false,
      projectId: null,
      pricing: { currency: "EUR", baseFee: "", discountType: "none", discountValue: "", minimum: "" },
      accent: "#ffc928",
      background: "white",
      buttonStyle: "solid",
    },
    sections: [
      {
        id: "customize",
        title: "Customize your service",
        type: "questions",
        fields: [
          field("property_type", "Property type", "select", ["Studio", "Apartment", "House", "Villa"], { required: true }),
          field("square_meters", "Total area (sqm / sq ft)", "number", [], { required: true, min: 1, max: 10000, help: "Tell us the approximate property size." }),
          field("floors", "Number of floors", "select", ["Flat", "1", "2", "3 or more"], { required: true }),
          field("attic", "Attic", "boolean", ["No", "Yes"]),
          field("bathrooms", "Bathrooms", "select", ["1 Bathroom", "2 Bathrooms", "3 Bathrooms", "4 or more"], { required: true }),
          field("half_bathroom", "Half bathroom", "select", ["0 Half Bathroom", "1 Half Bathroom", "2 or more"], { required: true }),
          field("bedrooms", "Bedrooms", "select", ["Studio", "1 Bedroom", "2 Bedrooms", "3 Bedrooms", "4 or more"], { required: true }),
          field("extra_rooms", "Extra rooms", "select", ["0 Extra Room", "1 Extra Room", "2 Extra Rooms", "3 or more"]),
          field("laundry_room", "Laundry room", "boolean", ["No", "Yes"], { help: "Include the laundry room in your cleaning." }),
          field("basement", "Basement", "select", ["Not applicable", "Basement"], { help: "Bathrooms are excluded—please select “Bathroom” separately." }),
          field("guest_suite", "Guest suite", "select", ["Not applicable", "Guest suite"]),
          field("pets", "Pets", "boolean", ["No", "Yes"]),
          field("property_status", "Property status", "select", ["Empty – with fully equipped kitchen & appliances", "Furnished", "Other"]),
          field("property_floor", "Property floor", "select", ["Groundfloor", "1st floor", "2nd floor", "3rd floor or higher"]),
          field("parking", "Parking", "select", ["Park in my driveway", "Street parking", "Parking garage", "Other"]),
          field("access_details", "Access details", "select", ["Key under the doormat", "Meet at the property", "Key safe", "Other"]),
          field("customer_type", "New customer — 10% off", "select", ["I'm a Returning Customer", "I'm a New Customer"]),
          field("exclusive_discounts", "Exclusive discounts", "select", ["Not Applicable", "I have a discount code"]),
        ],
      },
      {
        id: "addons",
        title: "Add-On Services",
        type: "addons",
        fields: [
          field("emergency_cleaning", "Emergency cleaning", "boolean", [], { icon: "🧹" }),
          field("weekends_holidays", "Weekends & holidays", "boolean", [], { icon: "🗓️" }),
          field("heavy_duty", "Heavy-duty cleaning", "boolean", [], { icon: "🧽" }),
          field("handyman", "Handyman / odd jobs", "boolean", [], { icon: "🛠️" }),
          field("second_kitchen", "2nd kitchen", "boolean", [], { icon: "🏠" }),
          field("second_oven", "2nd oven", "boolean", [], { icon: "♨️" }),
          field("second_refrigerator", "2nd refrigerator", "boolean", [], { icon: "🧊" }),
          field("balcony_patio", "Sweep balcony / patio", "boolean", [], { icon: "🪴" }),
          field("storage_unit", "Storage unit", "boolean", [], { icon: "🚪" }),
          field("sewage_garage", "Sewage garage", "boolean", [], { icon: "🏡" }),
        ],
      },
      { id: "schedule", title: "Schedule your service", type: "schedule", fields: [] },
      {
        id: "notes",
        title: "Special Instructions & Additional Notes",
        type: "questions",
        fields: [field("special_notes", "Add any special instructions or additional requests here.", "textarea")],
      },
      {
        id: "contact",
        title: "Contact Information",
        type: "questions",
        fields: [
          field("first_name", "First name", "text", [], { required: true }),
          field("last_name", "Last name", "text", [], { required: true }),
          field("email", "Email", "email", [], { required: true }),
          field("phone", "Phone number", "text", [], { required: true }),
        ],
      },
      {
        id: "location",
        title: "Cleaning Location",
        type: "questions",
        fields: [
          field("street_address", "Street address", "text", [], { required: true }),
          field("unit", "Unit / Apt / Suite #", "text"),
          field("city", "City", "text", [], { required: true }),
          field("zip_code", "ZIP code", "text", [], { required: true }),
        ],
      },
      {
        id: "payment",
        title: "Payment",
        type: "payment",
        fields: [
          field("payment_method", "Choose a payment method", "select", ["Cash payment — on the day of service", "Bank transfer — prepaid"]),
        ],
      },
    ],
  });

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const readState = () => {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return defaultState();
    try {
      const value = JSON.parse(saved);
      if (value?.version !== 1 || !value.service || !Array.isArray(value.sections)) throw new Error("Unsupported booking project data.");
      value.service.projectId = value.service.projectId || null;
      value.service.pricing = {
        currency: "EUR",
        baseFee: "",
        discountType: "none",
        discountValue: "",
        minimum: "",
        ...(value.service.pricing || {}),
      };
      value.service.availability = normalizeAvailability(value.service.availability);
      return value;
    } catch (error) {
      console.error("Could not load saved Booking Studio project.", error);
      localStorage.removeItem(storageKey);
      showToast("The saved draft was invalid; a fresh example has been loaded.");
      return defaultState();
    }
  };
  let state = readState();

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2700);
  }

  function markDirty() {
    state.service.published = false;
    document.querySelector("#publish-button").textContent = "Publish";
    stateLabel.classList.add("saving");
    stateLabel.innerHTML = "<i></i> Unsaved changes";
    window.clearTimeout(markDirty.timer);
    markDirty.timer = window.setTimeout(() => saveDraft(), 500);
  }

  function saveDraft(showNotice = false) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
      stateLabel.classList.remove("saving");
      stateLabel.innerHTML = "<i></i> Saved on this device";
      if (showNotice) showToast("Draft saved in this browser.");
    } catch (error) {
      console.error("Could not save Booking Studio draft.", error);
      stateLabel.classList.add("saving");
      stateLabel.innerHTML = "<i></i> Save failed";
      showToast("Could not save locally. Check browser storage settings.");
    }
    const generation = projectGeneration;
    saveChain = saveChain.then(async () => {
      if (generation !== projectGeneration) return false;
      const snapshot = clone(state);
      const existingId = state.service.projectId;
      const response = await fetch(existingId ? `/api/projects/${existingId}` : "/api/projects", {
        method: existingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The project could not be saved to the local app.");
      if (generation !== projectGeneration) return false;
      state.service.projectId = result.projectId;
      state.updatedAt = result.updatedAt;
      localStorage.setItem(storageKey, JSON.stringify(state));
      stateLabel.classList.remove("saving", "save-error");
      stateLabel.innerHTML = "<i></i> Saved to this app";
      if (showNotice) showToast("Project saved to this computer.");
      return true;
    }).catch((error) => {
      console.error("Booking Studio server save failed.", error);
      stateLabel.classList.add("saving");
      stateLabel.classList.add("save-error");
      stateLabel.innerHTML = "<i></i> App save failed · device copy only";
      if (showNotice) showToast(`${error.message} A browser copy is still saved.`);
      return false;
    });
    return saveChain;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderAll() {
    document.querySelector("#publish-button").textContent = state.service.published ? "Unpublish" : "Publish";
    document.querySelector("#service-name-top").textContent = state.service.name;
    document.querySelector("#summary-service-name").textContent = state.service.name;
    document.querySelector("#page-title").textContent = state.service.title;
    document.querySelector("#page-intro").textContent = state.service.intro;
    document.documentElement.style.setProperty("--accent", state.service.accent || "#ffc928");
    canvas.classList.toggle("soft-background", state.service.background === "soft");
    canvas.classList.toggle("outline-buttons", state.service.buttonStyle === "outline");
    renderSidebarSections();
    renderCanvas();
    renderPricingPanel();
    updateSummary();
  }

  function normalizeAvailability(saved = {}) {
    const defaults = defaultAvailability();
    return {
      ...defaults,
      ...saved,
      workingHours: { ...defaults.workingHours, ...(saved.workingHours || {}) },
      blackoutDates: Array.isArray(saved.blackoutDates) ? saved.blackoutDates : [],
    };
  }

  function renderAvailabilitySettings() {
    const availability = normalizeAvailability(state.service.availability);
    document.querySelector("#availability-verified").checked = availability.mode === "verified";
    document.querySelector("#availability-duration").value = availability.durationMinutes;
    document.querySelector("#availability-buffer").value = availability.bufferMinutes;
    document.querySelector("#availability-capacity").value = availability.capacity;
    document.querySelector("#availability-hold").value = availability.holdMinutes;
    document.querySelector("#availability-blackouts").value = availability.blackoutDates.join("\n");
    const root = document.querySelector("#working-hours");
    root.replaceChildren();
    const weekdays = [
      ["1", "Monday"], ["2", "Tuesday"], ["3", "Wednesday"],
      ["4", "Thursday"], ["5", "Friday"], ["6", "Saturday"], ["0", "Sunday"],
    ];
    weekdays.forEach(([key, name]) => {
      const hours = availability.workingHours[key];
      const row = el("div", "working-hours-row");
      const day = el("label", "working-day");
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.dataset.hoursEnabled = key;
      enabled.checked = Boolean(hours);
      day.append(enabled, document.createTextNode(name));
      const start = document.createElement("input");
      start.type = "time";
      start.value = hours?.start || "09:00";
      start.dataset.hoursStart = key;
      start.disabled = !hours;
      start.setAttribute("aria-label", `${name} opening time`);
      const end = document.createElement("input");
      end.type = "time";
      end.value = hours?.end || "17:00";
      end.dataset.hoursEnd = key;
      end.disabled = !hours;
      end.setAttribute("aria-label", `${name} closing time`);
      enabled.addEventListener("change", () => {
        start.disabled = !enabled.checked;
        end.disabled = !enabled.checked;
      });
      row.append(day, start, end);
      root.append(row);
    });
  }

  function renderSidebarSections() {
    sectionListRoot.replaceChildren();
    state.sections.forEach((section) => {
      const row = el("div", "section-row");
      row.draggable = true;
      row.dataset.sectionId = section.id;
      const grip = el("span", "section-grip", "⠿");
      const copy = el("div", "section-row-copy");
      copy.append(el("div", "section-row-title", section.title));
      copy.append(el("span", "section-row-meta", `${section.fields?.length || 0} fields`));
      const tools = el("span", "section-row-tools");
      const jump = el("button", "", "↗");
      jump.type = "button";
      jump.title = "Go to section";
      jump.dataset.jump = section.id;
      const status = el("span", `section-status ${(section.fields?.length || section.type === "schedule") ? "ready" : ""}`);
      tools.append(jump, status);
      row.append(grip, copy, tools);
      sectionListRoot.append(row);
    });
  }

  function renderCanvas() {
    sectionsRoot.replaceChildren();
    state.sections.forEach((section, index) => {
      const container = el("section", "canvas-section");
      container.dataset.sectionId = section.id;
      container.draggable = !previewMode;
      const heading = el("h3", "canvas-section-heading");
      heading.append(el("span", "section-number", `STEP ${index + 1}:`), document.createTextNode(` ${section.title}`));
      const editSection = el("button", "section-edit-button", "Edit section");
      editSection.type = "button";
      editSection.dataset.editSection = section.id;
      heading.append(editSection);
      container.append(heading);

      if (editableSectionTypes.has(section.type)) {
        if (section.type === "addons") container.append(renderAddons(section));
        else container.append(renderQuestions(section));
        if (!previewMode) {
          const add = el("button", "inline-add-question", "+  Add question");
          add.type = "button";
          add.dataset.addField = section.id;
          container.append(add);
        }
      } else if (section.type === "schedule") {
        container.append(renderSchedule());
      } else if (section.type === "payment") {
        container.append(renderPayment(section));
      }
      sectionsRoot.append(container);
    });
  }

  function renderQuestions(section) {
    const list = el("div", "question-list");
    section.fields.forEach((item) => list.append(renderQuestion(section, item)));
    return list;
  }

  function renderQuestion(section, item) {
    const card = el("div", `question-card ${selectedField?.id === item.id ? "selected" : ""}`);
    card.dataset.fieldId = item.id;
    card.dataset.sectionId = section.id;
    card.draggable = !previewMode;
    const handle = el("span", "question-handle", "⠿");
    handle.setAttribute("aria-hidden", "true");
    const copy = el("div", "question-copy");
    copy.append(el("span", "question-label", `${item.label}${item.required ? " *" : ""}`));
    if (item.help) copy.append(el("span", "question-help", item.help));
    card.append(handle, copy, renderControl(item));
    return card;
  }

  function renderControl(item) {
    if (item.type === "boolean" && item.icon) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "tile-checkbox";
      checkbox.setAttribute("aria-label", item.label);
      checkbox.dataset.answerId = item.id;
      checkbox.disabled = !previewMode;
      const label = el("label", "addon-card");
      label.dataset.addonId = item.id;
      const illustration = el("span", "addon-illustration", item.icon);
      const caption = el("small", "", item.label);
      label.append(checkbox, illustration, caption);
      return label;
    }
    if (item.type === "boolean") {
      if (previewMode) {
        const group = el("div", "boolean-options");
        ["Yes", "No"].forEach((value) => {
          const label = el("label", "boolean-option");
          const input = document.createElement("input");
          input.type = "radio";
          input.name = `answer-${item.id}`;
          input.value = value.toLowerCase();
          input.className = "live-control";
          input.dataset.answerId = item.id;
          input.required = Boolean(item.required);
          label.append(input, document.createTextNode(value));
          group.append(label);
        });
        return group;
      }
      const group = el("div", "boolean-options");
      const yes = el("span", "", item.options?.[1] || "Yes");
      const no = el("span", "active", item.options?.[0] || "No");
      group.append(yes, no);
      return group;
    }
    if (previewMode && item.type === "select") {
      const select = document.createElement("select");
      select.className = "live-control";
      select.dataset.answerId = item.id;
      select.required = Boolean(item.required);
      select.add(new Option("Choose an option", ""));
      (item.options || []).forEach((option) => select.add(new Option(option, option)));
      return select;
    }
    if (previewMode && ["text", "number", "email"].includes(item.type)) {
      const input = document.createElement("input");
      input.className = "live-control fake-control";
      input.type = item.type === "number" ? "number" : item.type === "email" ? "email" : "text";
      input.placeholder = item.type === "number" ? "Enter a number" : "Type your answer";
      input.dataset.answerId = item.id;
      input.required = Boolean(item.required);
      if (item.type === "number") {
        if (item.min != null) input.min = item.min;
        if (item.max != null) input.max = item.max;
      }
      return input;
    }
    if (previewMode && item.type === "textarea") {
      const textarea = document.createElement("textarea");
      textarea.className = "live-control fake-control fake-textarea";
      textarea.placeholder = "Add your notes";
      textarea.dataset.answerId = item.id;
      textarea.required = Boolean(item.required);
      return textarea;
    }
    if (item.type === "select" || item.type === "email") return el("div", "fake-control", item.options?.[0] || (item.type === "email" ? "name@example.com" : "Select an option"));
    if (item.type === "number") return el("div", "fake-control fake-number", item.min ? `Up to ${item.max || "100"} sqm` : "Enter a number");
    if (item.type === "textarea") return el("div", "fake-control fake-text fake-textarea", item.help || "Add any special instructions or additional requests here.");
    if (item.type === "email") return el("div", "fake-control fake-text", "name@example.com");
    return el("div", "fake-control fake-text", "Type your answer");
  }

  function renderAddons(section) {
    const grid = el("div", "addon-grid");
    section.fields.forEach((item) => {
      const card = el("button", `addon-card ${selectedField?.id === item.id ? "selected" : ""}`);
      card.type = "button";
      card.dataset.fieldId = item.id;
      card.dataset.sectionId = section.id;
      const illustration = el("span", "addon-illustration", item.icon || "✦");
      const caption = el("small", "", item.label);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "tile-checkbox";
      checkbox.dataset.answerId = item.id;
      checkbox.setAttribute("aria-label", item.label);
      checkbox.disabled = !previewMode;
      card.replaceChildren(checkbox, illustration, caption);
      card.dataset.addonId = item.id;
      grid.append(card);
    });
    if (!previewMode) {
      const add = el("button", "add-addon-card", "+ Add new extra");
      add.type = "button";
      add.dataset.addField = section.id;
      grid.append(add);
    }
    return grid;
  }

  function renderSchedule() {
    const wrapper = el("div", "schedule-preview");
    const availability = normalizeAvailability(state.service.availability);
    const notice = el("div", `availability-mode ${availability.mode === "verified" ? "verified" : "demo"}`,
      availability.mode === "verified" ? "Hours verified" : "DEMO HOURS · Verify actual CasaHelp hours before confirmation");
    wrapper.append(notice);
    const arrows = el("div", "schedule-arrow-row");
    const previous = el("button", "round-arrow", "‹");
    const next = el("button", "round-arrow", "›");
    previous.type = next.type = "button";
    previous.setAttribute("aria-label", "Previous week");
    next.setAttribute("aria-label", "Next week");
    previous.disabled = availabilityWeekOffset <= 0;
    previous.addEventListener("click", () => {
      availabilityWeekOffset = Math.max(0, availabilityWeekOffset - 1);
      renderCalendarSlots(wrapper);
    });
    next.addEventListener("click", () => {
      if ((availabilityWeekOffset + 1) * 7 < availability.horizonDays) {
        availabilityWeekOffset += 1;
        renderCalendarSlots(wrapper);
      }
    });
    arrows.append(previous, next);
    wrapper.append(arrows);
    const calendar = el("div", "calendar-preview");
    calendar.classList.add("availability-loading");
    calendar.append(el("p", "availability-message", previewMode ? "Checking available appointments…" : "Switch to preview to check live local availability."));
    wrapper.append(calendar);
    const caption = el("div", "preview-caption", "Temporary holds and capacity are checked by the local server. No external calendar is connected.");
    wrapper.append(caption);
    if (previewMode) renderCalendarSlots(wrapper);
    return wrapper;
  }

  function weekStartDate(offset, timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const today = `${values.year}-${values.month}-${values.day}`;
    const todayUtc = new Date(`${today}T00:00:00Z`);
    const daysSinceMonday = (todayUtc.getUTCDay() + 6) % 7;
    const monday = todayUtc.getTime() - daysSinceMonday * 86400000 + offset * 7 * 86400000;
    return new Date(monday).toISOString().slice(0, 10);
  }

  async function renderCalendarSlots(wrapper) {
    if (!previewMode) return;
    if (selectedHold && Date.parse(selectedHold.expiresAt) <= Date.now()) {
      selectedHold = null;
      selectedSlot = "";
      updateSummary();
      showToast("Appointment hold expired. Choose another available time.");
    }
    const requestId = ++availabilityRequest;
    const calendar = wrapper.querySelector(".calendar-preview");
    calendar.classList.add("availability-loading");
    calendar.replaceChildren(el("p", "availability-message", "Checking available appointments…"));
    const projectId = state.service.projectId;
    if (!projectId) {
      calendar.replaceChildren(el("p", "availability-message", "Save this service before checking availability."));
      return;
    }
    const from = weekStartDate(availabilityWeekOffset, state.service.timezone);
    try {
      const query = new URLSearchParams({ projectId, from, days: "7" });
      const response = await fetch(`/api/availability?${query}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load availability.");
      if (requestId !== availabilityRequest || !wrapper.isConnected) return;
      const slots = result.slots || [];
      if (selectedHold && new Date(selectedHold.expiresAt) > new Date() &&
        !slots.some((slot) => slot.start === selectedHold.slotStart)) {
        const dateParts = new Intl.DateTimeFormat("en-CA", {
          timeZone: result.timezone, year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(new Date(selectedHold.slotStart));
        const dateValues = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
        const heldDate = `${dateValues.year}-${dateValues.month}-${dateValues.day}`;
        if (heldDate >= from && heldDate < addDays(from, 7)) {
          slots.push({
            start: selectedHold.slotStart,
            end: selectedHold.slotEnd,
            date: heldDate,
            localTime: new Intl.DateTimeFormat("en-GB", {
              timeZone: result.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
            }).format(new Date(selectedHold.slotStart)),
            heldByYou: true,
          });
        }
      }
      calendar.classList.remove("availability-loading");
      calendar.replaceChildren();
      if (!slots.length) {
        calendar.append(el("p", "availability-message", "No available appointments in this week."));
      } else {
        const byDate = new Map();
        slots.sort((a, b) => a.start.localeCompare(b.start)).forEach((slot) => {
          if (!byDate.has(slot.date)) byDate.set(slot.date, []);
          byDate.get(slot.date).push(slot);
        });
        byDate.forEach((daySlots, date) => {
          const column = el("div", "calendar-day");
          const dateObject = new Date(`${date}T00:00:00Z`);
          column.append(
            el("strong", "", new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(dateObject)),
            el("small", "", new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(dateObject)),
          );
          const slotsRoot = el("div", "calendar-day-slots");
          daySlots.forEach((slot) => {
            const selected = selectedHold?.slotStart === slot.start;
            const button = el("button", `available-slot${selected ? " selected" : ""}`, slot.heldByYou ? `${slot.localTime} · held` : slot.localTime);
            button.type = "button";
            button.dataset.slotStart = slot.start;
            button.disabled = !previewMode || Boolean(selectedHold && !selected);
            button.addEventListener("click", () => reserveAppointment(slot, wrapper));
            slotsRoot.append(button);
          });
          column.append(slotsRoot);
          calendar.append(column);
        });
      }
      wrapper.querySelector(".round-arrow[aria-label='Previous week']").disabled = availabilityWeekOffset <= 0;
      wrapper.querySelector(".round-arrow[aria-label='Next week']").disabled =
        (availabilityWeekOffset + 1) * 7 >= normalizeAvailability(state.service.availability).horizonDays;
      wrapper.querySelector(".hold-status")?.remove();
      if (selectedHold) {
        const expiry = new Date(selectedHold.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const holdStatus = el("div", "hold-status");
        holdStatus.append(el("p", "", `Slot held until ${expiry}. Complete required fields and confirm.`));
        const release = el("button", "button quiet release-hold", "Release hold");
        release.type = "button";
        release.addEventListener("click", async () => {
          await releaseAppointmentHold();
          await renderCalendarSlots(wrapper);
        });
        holdStatus.append(release);
        wrapper.append(holdStatus);
      }
    } catch (error) {
      if (requestId !== availabilityRequest || !wrapper.isConnected) return;
      console.error("Could not load live availability.", error);
      calendar.classList.remove("availability-loading");
      calendar.replaceChildren(el("p", "availability-message error", error.message || "Could not load appointments."));
    }
  }

  function addDays(date, days) {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  }

  async function reserveAppointment(slot, wrapper) {
    try {
      if (selectedHold) await releaseAppointmentHold(false);
      if (pendingHoldRequest?.slotStart !== slot.start) {
        pendingHoldRequest = { slotStart: slot.start, idempotencyKey: crypto.randomUUID() };
      }
      const response = await fetch("/api/holds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: state.service.projectId,
          slotStart: slot.start,
          idempotencyKey: pendingHoldRequest.idempotencyKey,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not hold that appointment.");
      selectedHold = result;
      pendingHoldRequest = null;
      selectedSlot = result.slotStart;
      updateSummary();
      await renderCalendarSlots(wrapper);
      showToast("Appointment held temporarily. Complete required fields to confirm.");
    } catch (error) {
      console.error("Could not hold appointment.", error);
      showToast(error.message || "Could not hold that appointment.");
      await renderCalendarSlots(wrapper);
    }
  }

  async function releaseAppointmentHold(showMessage = true) {
    if (!selectedHold) return;
    const hold = selectedHold;
    try {
      const response = await fetch(`/api/holds/${hold.id}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: state.service.projectId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not release appointment hold.");
      selectedHold = null;
      selectedSlot = "";
    } catch (error) {
      console.error("Could not release appointment hold.", error);
      if (Date.parse(hold.expiresAt) <= Date.now()) {
        selectedHold = null;
        selectedSlot = "";
      }
      if (showMessage) showToast(error.message || "Could not release the appointment hold.");
    }
    updateSummary();
  }

  async function confirmSelectedBooking() {
    if (!previewMode) {
      showToast("Switch to preview, select an available appointment, and hold it first.");
      return;
    }
    if (!selectedHold) {
      showToast("Select an available appointment to hold before confirming.");
      return;
    }
    const answers = {};
    document.querySelectorAll(".live-control, .tile-checkbox").forEach((control) => {
      const id = control.dataset.answerId;
      if (!id) return;
      if (control.type === "checkbox") answers[id] = control.checked ? "yes" : "no";
      else if (control.type === "radio") {
        if (control.checked) answers[id] = control.value;
      } else if (control.value.trim()) answers[id] = control.value.trim();
    });
    try {
      const response = await fetch("/api/bookings/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: state.service.projectId,
          holdId: selectedHold.id,
          idempotencyKey: crypto.randomUUID(),
          inputAnswers: answers,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Booking could not be confirmed.");
      selectedHold = null;
      selectedSlot = result.appointment.start;
      const appointment = new Intl.DateTimeFormat(undefined, {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: result.appointment.timezone,
      }).format(new Date(result.appointment.start));
      document.querySelector("#booking-confirmation-copy").textContent =
        `${result.serviceName} · ${appointment} · Booking reference ${result.id}`;
      document.querySelector("#booking-confirmation-dialog").showModal();
      sectionsRoot.querySelectorAll(".schedule-preview").forEach(renderCalendarSlots);
      updateSummary();
    } catch (error) {
      console.error("Could not confirm booking.", error);
      showToast(error.message || "Booking could not be confirmed.");
      sectionsRoot.querySelectorAll(".schedule-preview").forEach(renderCalendarSlots);
    }
  }

  function renderPayment(section) {
    const wrapper = el("div", "payment-preview");
    section.fields.forEach((item) => {
      const label = el("label", "payment-choice");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "payment-preview";
      radio.disabled = !previewMode;
      label.append(radio, document.createTextNode(item.label));
      wrapper.append(label);
    });
    const add = el("button", "inline-add-question", "+ Add payment option");
    add.type = "button";
    add.hidden = previewMode;
    add.dataset.addField = section.id;
    wrapper.append(add);
    return wrapper;
  }

  function updateSummary() {
    const lines = document.querySelector("#summary-lines");
    lines.replaceChildren();
    const answers = new Map();
    document.querySelectorAll(".live-control, .tile-checkbox").forEach((control) => {
      const value = control.type === "checkbox" || control.type === "radio"
        ? control.checked ? control.type === "checkbox" ? "Selected" : control.value : ""
        : control.value;
      if (value) answers.set(control.dataset.answerId, value);
    });
    if (!answers.size) lines.append(el("p", "summary-empty", "Your selected service details will appear here."));
    answers.forEach((value, id) => {
      const item = findField(id);
      if (!item) return;
      const row = el("div", "summary-line");
      row.append(el("span", "", item.label), el("strong", "", value));
      lines.append(row);
    });
    const currency = state.service.pricing?.currency || "EUR";
    const quote = calculatePreviewQuote(state, answers);
    quote.items.forEach(({ label, cents }) => {
      const row = el("div", "summary-line price-line");
      row.append(el("span", "", label), el("strong", "", formatMoney(cents, currency)));
      lines.append(row);
    });
    if (quote.unpriced) {
      const row = el("div", "summary-line price-warning");
      row.append(el("span", "", "Selected price rule needs a rate"));
      lines.append(row);
    }
    document.querySelector("#summary-total").textContent = !quote.configured
      ? "Configure pricing"
      : quote.unpriced ? "Set pricing" : formatMoney(quote.total, currency);
    document.querySelector(".summary-service small").textContent = selectedSlot
      ? `Appointment · ${new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium", timeStyle: "short", timeZone: state.service.timezone,
      }).format(new Date(selectedSlot))}`
      : "Appointment date · Choose a time";
  }

  function renderPricingPanel() {
    const pricing = state.service.pricing || (state.service.pricing = {});
    document.querySelector("#pricing-currency").value = pricing.currency || "EUR";
    document.querySelector("#pricing-base-fee").value = pricing.baseFee ?? "";
    document.querySelector("#pricing-discount-type").value = pricing.discountType || "none";
    document.querySelector("#pricing-discount-value").value = pricing.discountValue ?? "";
    document.querySelector("#pricing-discount-value").max = pricing.discountType === "percent" ? "100" : "99999999";
    document.querySelector("#pricing-minimum").value = pricing.minimum ?? "";
    const list = document.querySelector("#pricing-fields");
    list.replaceChildren();
    const fields = state.sections.flatMap((section) => section.fields || []);
    if (!fields.length) list.append(el("p", "pricing-empty", "Add questions to configure conditional charges."));
    fields.forEach((item) => {
      const rule = item.pricing || { type: "none", rate: "" };
      const row = el("div", "pricing-field");
      const heading = el("strong", "pricing-field-name", item.label);
      const controls = el("div", "pricing-field-controls");
      const select = document.createElement("select");
      select.dataset.priceRule = item.id;
      select.setAttribute("aria-label", `Pricing rule for ${item.label}`);
      [
        ["none", "No charge"],
        ["fixed", "Fixed when selected"],
        ...(item.type === "number" ? [["per_unit", "Per unit"]] : []),
      ].forEach(([value, label]) => select.add(new Option(label, value)));
      select.value = rule.type || "none";
      const rate = document.createElement("input");
      rate.type = "number";
      rate.min = "0";
      rate.max = "99999999";
      rate.step = "0.01";
      rate.placeholder = "Rate";
      rate.value = rule.rate ?? "";
      rate.dataset.priceRate = item.id;
      rate.setAttribute("aria-label", `Rate for ${item.label}`);
      controls.append(select, rate);
      row.append(heading, controls);
      list.append(row);
    });
  }

  function findField(id) {
    for (const section of state.sections) {
      const match = section.fields?.find((item) => item.id === id);
      if (match) return match;
    }
    return null;
  }

  function findSection(id) {
    return state.sections.find((section) => section.id === id);
  }

  async function openProjects() {
    const list = document.querySelector("#projects-list");
    list.replaceChildren();
    const loading = el("p", "projects-empty", "Loading saved projects…");
    list.append(loading);
    projectsDialog.showModal();
    try {
      const response = await fetch("/api/projects");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load saved projects.");
      list.replaceChildren();
      if (!result.projects.length) {
        list.append(el("p", "projects-empty", "No server-saved projects yet. Save a project to see it here."));
        return;
      }
      result.projects.forEach((project) => {
        const button = el("button", "project-list-item");
        button.type = "button";
        const copy = el("span", "project-list-copy");
        copy.append(el("strong", "", project.name || "Untitled service"));
        copy.append(el("small", "", project.slug || "No URL slug"));
        const date = el("time", "project-list-date", project.updatedAt ? new Date(project.updatedAt).toLocaleDateString() : "");
        button.append(copy, date);
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const load = await fetch(`/api/projects/${project.id}`);
            const loaded = await load.json();
            if (!load.ok) throw new Error(loaded.error || "Could not open this project.");
            state = loaded;
            state.service.projectId = loaded.projectId;
            state.service.pricing = {
              currency: "EUR", baseFee: "", discountType: "none", discountValue: "", minimum: "",
              ...(loaded.service.pricing || {}),
            };
            projectGeneration += 1;
            selectedSlot = "";
            selectedField = null;
            localStorage.setItem(storageKey, JSON.stringify(state));
            stateLabel.classList.remove("saving");
            stateLabel.classList.remove("save-error");
            stateLabel.innerHTML = "<i></i> Saved to this app";
            projectsDialog.close();
            renderAll();
            showToast("Project opened.");
          } catch (error) {
            console.error("Could not open Booking Studio project.", error);
            showToast(error.message || "Could not open this project.");
            button.disabled = false;
          }
        });
        list.append(button);
      });
    } catch (error) {
      console.error("Could not list Booking Studio projects.", error);
      list.replaceChildren(el("p", "projects-empty error", error.message || "Could not load saved projects."));
    }
  }

  function createProject() {
    const name = window.prompt("Name your new service page", "New service");
    if (!name?.trim()) return;
    const fresh = defaultState();
    fresh.service.name = name.trim().slice(0, 100);
    fresh.service.title = fresh.service.name;
    fresh.service.slug = fresh.service.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    state = fresh;
    projectGeneration += 1;
    selectedSlot = "";
    selectedField = null;
    projectsDialog.close();
    markDirty();
    renderAll();
  }

  function openFieldDialog(section, item) {
    selectedField = item ? { id: item.id } : null;
    const isNew = !item;
    const target = item
      ? clone(item)
      : section.type === "addons"
        ? field(`question_${crypto.randomUUID()}`, "New extra", "boolean", ["No", "Yes"], { icon: "✦" })
        : field(`question_${crypto.randomUUID()}`, "New question", "select", ["Option 1", "Option 2"]);
    document.querySelector("#field-dialog-title").textContent = isNew ? "Add a question" : "Edit question";
    document.querySelector("#field-section-id").value = section.id;
    document.querySelector("#field-id").value = target.id;
    document.querySelector("#field-label").value = target.label || "";
    document.querySelector("#field-help").value = target.help || "";
    document.querySelector("#field-type").value = ["select", "number", "text", "textarea", "boolean", "email"].includes(target.type) ? target.type : "text";
    document.querySelector("#field-options").value = (target.options || []).join("\n");
    document.querySelector("#field-required").checked = Boolean(target.required);
    document.querySelector("#field-add-on").checked = Boolean(target.icon);
    document.querySelector("#field-min").value = target.min ?? "";
    document.querySelector("#field-max").value = target.max ?? "";
    document.querySelector("#field-duplicate").hidden = isNew;
    document.querySelector("#field-delete").hidden = isNew;
    target.datasetNew = isNew ? "1" : "";
    target.parentSection = section.id;
    fieldDialog.dataset.target = JSON.stringify(target);
    toggleFieldOptions();
    fieldDialog.showModal();
  }

  function openSectionDialog(section = null) {
    document.querySelector("#section-dialog-title").textContent = section ? "Edit section" : "Add section";
    document.querySelector("#section-id").value = section?.id || "";
    document.querySelector("#section-title").value = section?.title || "";
    document.querySelector("#section-type").value = section?.type === "addons" ? "addons" : "questions";
    document.querySelector("#section-type").disabled = Boolean(section && !editableSectionTypes.has(section.type));
    document.querySelector("#section-delete").hidden = !section;
    sectionDialog.showModal();
  }

  function toggleFieldOptions() {
    const type = document.querySelector("#field-type").value;
    document.querySelector(".options-setting").classList.toggle("hidden", !["select", "boolean"].includes(type));
    document.querySelector(".numeric-settings").classList.toggle("hidden", type !== "number");
    document.querySelector("#field-add-on").closest("label").classList.toggle("hidden", type !== "boolean");
  }

  function saveField(event) {
    event.preventDefault();
    const target = JSON.parse(fieldDialog.dataset.target || "{}");
    const section = findSection(document.querySelector("#field-section-id").value);
    if (!section) return;
    const type = document.querySelector("#field-type").value;
    if (section.type === "addons" && type !== "boolean") {
      showToast("Add-on tile sections only support yes/no questions.");
      return;
    }
    const options = document.querySelector("#field-options").value.split("\n").map((option) => option.trim()).filter(Boolean);
    if (["select", "boolean"].includes(type) && !options.length) {
      showToast("Enter at least one option for this field.");
      return;
    }
    const min = document.querySelector("#field-min").value;
    const max = document.querySelector("#field-max").value;
    if (min !== "" && max !== "" && Number(min) > Number(max)) {
      showToast("The minimum must not exceed the maximum.");
      return;
    }
    const updated = {
      ...target,
      label: document.querySelector("#field-label").value.trim(),
      help: document.querySelector("#field-help").value.trim(),
      type,
      options: ["select", "boolean"].includes(type) ? options : [],
      required: document.querySelector("#field-required").checked,
      min: type === "number" && min !== "" ? Number(min) : null,
      max: type === "number" && max !== "" ? Number(max) : null,
      price: target.price ?? null,
      icon: type === "boolean" && document.querySelector("#field-add-on").checked ? target.icon || "✦" : null,
    };
    if (type !== "number" && updated.pricing?.type === "per_unit") {
      updated.pricing = { type: "none", rate: "" };
    }
    delete updated.datasetNew;
    delete updated.parentSection;
    const index = section.fields.findIndex((item) => item.id === target.id);
    if (index >= 0) section.fields[index] = updated;
    else section.fields.push(updated);
    fieldDialog.close();
    selectedField = { id: updated.id };
    markDirty();
    renderAll();
  }

  function saveSection(event) {
    event.preventDefault();
    const title = document.querySelector("#section-title").value.trim();
    if (!title) return;
    const sectionId = document.querySelector("#section-id").value;
    const type = document.querySelector("#section-type").value;
    const section = sectionId ? findSection(sectionId) : null;
    if (section) {
      if (type === "addons" && section.fields.some((item) => item.type !== "boolean")) {
        showToast("Convert the section fields to yes/no questions before using add-on tiles.");
        return;
      }
      section.title = title;
      if (editableSectionTypes.has(section.type)) {
        const previousType = section.type;
        section.type = type;
        if (previousType !== type) {
          section.fields.forEach((item) => {
            item.icon = type === "addons" ? item.icon || "✦" : null;
          });
        }
      }
    } else {
      state.sections.push({
        id: `section_${crypto.randomUUID()}`,
        title,
        type,
        fields: [],
      });
    }
    sectionDialog.close();
    markDirty();
    renderAll();
  }

  function deleteSection() {
    const id = document.querySelector("#section-id").value;
    if (state.sections.length <= 1) {
      showToast("Keep at least one section on the booking page.");
      return;
    }
    const section = findSection(id);
    if (!section || !window.confirm(`Delete “${section.title}” and its fields?`)) return;
    state.sections = state.sections.filter((item) => item.id !== id);
    sectionDialog.close();
    selectedField = null;
    markDirty();
    renderAll();
  }

  function duplicateField() {
    const target = JSON.parse(fieldDialog.dataset.target || "{}");
    const section = findSection(document.querySelector("#field-section-id").value);
    if (!section || !target.id) return;
    const index = section.fields.findIndex((item) => item.id === target.id);
    if (index < 0) return;
    const copy = clone(target);
    copy.id = `question_${crypto.randomUUID()}`;
    copy.label = `${copy.label} (copy)`.slice(0, 120);
    section.fields.splice(index + 1, 0, copy);
    fieldDialog.close();
    selectedField = { id: copy.id };
    markDirty();
    renderAll();
    showToast("Question duplicated.");
  }

  function deleteField() {
    const target = JSON.parse(fieldDialog.dataset.target || "{}");
    const section = findSection(document.querySelector("#field-section-id").value);
    if (!section || !target.id) return;
    const item = section.fields.find((entry) => entry.id === target.id);
    if (!item || !window.confirm(`Delete “${item.label}”?`)) return;
    section.fields = section.fields.filter((entry) => entry.id !== target.id);
    fieldDialog.close();
    selectedField = null;
    markDirty();
    renderAll();
  }

  function exportProject() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${state.service.slug || "booking-page"}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast("Project backup downloaded.");
  }

  function importProject(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const project = JSON.parse(String(reader.result));
        if (project?.version !== 1 || !project.service || !Array.isArray(project.sections)) throw new Error("This file is not a Booking Studio project.");
        project.service.projectId = null;
        state = project;
        state.service.availability = normalizeAvailability(state.service.availability);
        projectGeneration += 1;
        selectedSlot = "";
        selectedField = null;
        markDirty();
        renderAll();
        showToast("Project imported.");
      } catch (error) {
        console.error("Could not import Booking Studio project.", error);
        showToast(error.message || "The project file could not be opened.");
      }
    };
    reader.onerror = () => showToast("Could not read the selected file.");
    reader.readAsText(file);
  }

  sectionsRoot.addEventListener("click", (event) => {
    const add = event.target.closest("[data-add-field]");
    if (add) {
      const section = findSection(add.dataset.addField);
      if (section) openFieldDialog(section, null);
      return;
    }
    const edit = event.target.closest("[data-edit-section]");
    if (edit) {
      const section = findSection(edit.dataset.editSection);
      if (section) openSectionDialog(section);
      return;
    }
    const card = event.target.closest(".question-card");
    if (card && !previewMode && !event.target.closest("button, select, input, textarea")) {
      const section = findSection(card.dataset.sectionId);
      const item = section?.fields.find((entry) => entry.id === card.dataset.fieldId);
      if (section && item) openFieldDialog(section, item);
    }
    const addon = event.target.closest(".addon-card");
    if (addon && !previewMode) {
      const section = findSection(addon.dataset.sectionId);
      const item = section?.fields.find((entry) => entry.id === addon.dataset.fieldId);
      if (section && item) openFieldDialog(section, item);
      return;
    }
    if (addon && previewMode && event.target.tagName !== "INPUT") {
      const checkbox = addon.querySelector("input");
      checkbox.checked = !checkbox.checked;
      updateSummary();
    }
  });

  sectionsRoot.addEventListener("change", (event) => {
    if (event.target.matches(".live-control, .tile-checkbox")) updateSummary();
    if (event.target.matches(".tile-checkbox")) event.target.closest(".addon-card")?.classList.toggle("selected", event.target.checked);
    if (event.target.matches('input[name="payment-preview"]')) showToast("Payment methods are a visual placeholder in this prototype.");
  });
  sectionsRoot.addEventListener("input", (event) => {
    if (event.target.matches(".live-control")) updateSummary();
  });

  sectionsRoot.addEventListener("dragstart", (event) => {
    const section = event.target.closest(".canvas-section");
    const card = event.target.closest(".question-card");
    if (section && !event.target.closest(".question-card") && !previewMode) dragged = { type: "section", id: section.dataset.sectionId };
    else if (card && !previewMode) dragged = { type: "field", id: card.dataset.fieldId, sectionId: card.dataset.sectionId };
    if (dragged) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", dragged.id);
      (section || card).classList.add("dragging");
    }
  });
  sectionsRoot.addEventListener("dragover", (event) => {
    if (dragged && event.target.closest(".canvas-section, .question-card")) event.preventDefault();
  });
  sectionsRoot.addEventListener("drop", (event) => {
    if (!dragged) return;
    event.preventDefault();
    if (dragged.type === "section") {
      const target = event.target.closest(".canvas-section");
      if (!target || target.dataset.sectionId === dragged.id) return;
      const from = state.sections.findIndex((section) => section.id === dragged.id);
      const to = state.sections.findIndex((section) => section.id === target.dataset.sectionId);
      const [moved] = state.sections.splice(from, 1);
      state.sections.splice(to, 0, moved);
    } else {
      const target = event.target.closest(".question-card");
      if (!target || target.dataset.fieldId === dragged.id) return;
      const sourceSection = findSection(dragged.sectionId);
      const targetSection = findSection(target.dataset.sectionId);
      const from = sourceSection.fields.findIndex((item) => item.id === dragged.id);
      const [moved] = sourceSection.fields.splice(from, 1);
      const to = targetSection.fields.findIndex((item) => item.id === target.dataset.fieldId);
      targetSection.fields.splice(to, 0, moved);
    }
    dragged = null;
    markDirty();
    renderAll();
  });
  sectionsRoot.addEventListener("dragend", () => {
    dragged = null;
    sectionsRoot.querySelectorAll(".dragging").forEach((item) => item.classList.remove("dragging"));
  });

  sectionListRoot.addEventListener("click", (event) => {
    const jump = event.target.closest("[data-jump]");
    if (!jump) return;
    document.querySelector(`[data-section-id="${CSS.escape(jump.dataset.jump)}"].canvas-section`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  sectionListRoot.addEventListener("dragstart", (event) => {
    const row = event.target.closest(".section-row");
    if (!row) return;
    dragged = { type: "sidebar-section", id: row.dataset.sectionId };
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });
  sectionListRoot.addEventListener("dragover", (event) => {
    if (dragged?.type === "sidebar-section" && event.target.closest(".section-row")) event.preventDefault();
  });
  sectionListRoot.addEventListener("drop", (event) => {
    const target = event.target.closest(".section-row");
    if (!target || dragged?.type !== "sidebar-section" || target.dataset.sectionId === dragged.id) return;
    event.preventDefault();
    const from = state.sections.findIndex((section) => section.id === dragged.id);
    const to = state.sections.findIndex((section) => section.id === target.dataset.sectionId);
    const [moved] = state.sections.splice(from, 1);
    state.sections.splice(to, 0, moved);
    dragged = null;
    markDirty();
    renderAll();
  });
  sectionListRoot.addEventListener("dragend", () => {
    dragged = null;
    sectionListRoot.querySelectorAll(".dragging").forEach((item) => item.classList.remove("dragging"));
  });

  document.querySelectorAll(".sidebar-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".sidebar-tab").forEach((item) => item.classList.toggle("active", item === tab));
      ["sections", "pricing", "appearance"].forEach((panel) => {
        document.querySelector(`#${panel}-panel`).classList.toggle("hidden", tab.dataset.tab !== panel);
      });
    });
  });
  document.querySelector("#pricing-panel").addEventListener("input", (event) => {
    const pricing = state.service.pricing;
    if (event.target.id === "pricing-base-fee") pricing.baseFee = event.target.value;
    else if (event.target.id === "pricing-discount-value") pricing.discountValue = event.target.value;
    else if (event.target.id === "pricing-minimum") pricing.minimum = event.target.value;
    else if (event.target.dataset.priceRate) {
      const item = findField(event.target.dataset.priceRate);
      if (item) item.pricing = { ...(item.pricing || { type: "none" }), rate: event.target.value };
    } else return;
    markDirty();
    updateSummary();
  });
  document.querySelector("#pricing-panel").addEventListener("change", (event) => {
    const pricing = state.service.pricing;
    if (event.target.id === "pricing-currency") pricing.currency = event.target.value;
    else if (event.target.id === "pricing-discount-type") {
      pricing.discountType = event.target.value;
      if (event.target.value === "none") pricing.discountValue = "";
      renderPricingPanel();
    } else if (event.target.dataset.priceRule) {
      const item = findField(event.target.dataset.priceRule);
      if (item) item.pricing = { type: event.target.value, rate: item.pricing?.rate || "" };
    } else return;
    markDirty();
    updateSummary();
  });
  document.querySelector("#add-section").addEventListener("click", () => openSectionDialog());
  document.querySelector("#canvas-add-section").addEventListener("click", () => openSectionDialog());
  document.querySelector("#field-type").addEventListener("change", toggleFieldOptions);
  document.querySelector("#field-form").addEventListener("submit", saveField);
  document.querySelector("#field-duplicate").addEventListener("click", duplicateField);
  document.querySelector("#field-delete").addEventListener("click", deleteField);
  document.querySelector("#section-form").addEventListener("submit", saveSection);
  document.querySelector("#section-delete").addEventListener("click", deleteSection);
  document.querySelector("#save-button").addEventListener("click", () => saveDraft(true));
  document.querySelector("#preview-button").addEventListener("click", (event) => {
    previewMode = !previewMode;
    if (!previewMode && selectedHold) releaseAppointmentHold(false);
    canvas.classList.toggle("preview-mode", previewMode);
    event.currentTarget.textContent = previewMode ? "Edit page" : "Preview";
    renderCanvas();
    updateSummary();
  });
  document.querySelector("#settings-button").addEventListener("click", () => {
    document.querySelector("#setting-name").value = state.service.name;
    document.querySelector("#setting-title").value = state.service.title;
    document.querySelector("#setting-intro").value = state.service.intro;
    document.querySelector("#setting-slug").value = state.service.slug;
    document.querySelector("#setting-timezone").value = state.service.timezone;
    renderAvailabilitySettings();
    settingsDialog.showModal();
  });
  document.querySelector("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const timezone = document.querySelector("#setting-timezone").value.trim();
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      showToast("Enter a valid IANA business timezone, such as Europe/Berlin.");
      return;
    }
    const workingHours = {};
    document.querySelectorAll("[data-hours-enabled]").forEach((enabled) => {
      const day = enabled.dataset.hoursEnabled;
      if (!enabled.checked) {
        workingHours[day] = null;
        return;
      }
      workingHours[day] = {
        start: document.querySelector(`[data-hours-start="${day}"]`).value,
        end: document.querySelector(`[data-hours-end="${day}"]`).value,
      };
    });
    const availability = {
      ...normalizeAvailability(state.service.availability),
      mode: document.querySelector("#availability-verified").checked ? "verified" : "demo",
      durationMinutes: Number(document.querySelector("#availability-duration").value),
      bufferMinutes: Number(document.querySelector("#availability-buffer").value),
      capacity: Number(document.querySelector("#availability-capacity").value),
      holdMinutes: Number(document.querySelector("#availability-hold").value),
      workingHours,
      blackoutDates: document.querySelector("#availability-blackouts").value
        .split(/[\s,]+/).map((date) => date.trim()).filter(Boolean),
    };
    if (![15, 30, 45, 60, 90, 120, 180, 240, 360, 480].includes(availability.durationMinutes) ||
      !Number.isInteger(availability.bufferMinutes) || availability.bufferMinutes < 0 ||
      availability.bufferMinutes > 240 || !Number.isInteger(availability.capacity) ||
      availability.capacity < 1 || availability.capacity > 100 ||
      !Number.isInteger(availability.holdMinutes) || availability.holdMinutes < 1 ||
      availability.holdMinutes > 30 ||
      Object.values(workingHours).some((hours) => hours && (!hours.start || !hours.end || hours.start >= hours.end)) ||
      availability.blackoutDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date)) ||
      availability.blackoutDates.length > 366) {
      showToast("Check appointment length, capacity, hold time, working hours, and blackout dates.");
      return;
    }
    if (selectedHold) await releaseAppointmentHold(false);
    state.service.name = document.querySelector("#setting-name").value.trim();
    state.service.title = document.querySelector("#setting-title").value.trim();
    state.service.intro = document.querySelector("#setting-intro").value.trim();
    state.service.slug = document.querySelector("#setting-slug").value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    state.service.timezone = timezone;
    state.service.availability = availability;
    settingsDialog.close();
    markDirty();
    renderAll();
  });
  document.querySelector("#rename-service").addEventListener("click", () => document.querySelector("#settings-button").click());
  document.querySelector("#publish-button").addEventListener("click", async () => {
    if (state.service.published) {
      state.service.published = false;
      const saved = await saveDraft();
      renderAll();
      showToast(saved ? "The public booking page is unpublished." : "Could not unpublish the booking page.");
      return;
    }
    if (state.service.availability.mode !== "verified") {
      showToast("Verify the business hours in Settings before publishing.");
      return;
    }
    const saved = await saveDraft();
    if (!saved || !state.service.projectId) {
      showToast("Save the service before publishing.");
      return;
    }
    state.service.published = true;
    const published = await saveDraft();
    if (!published) {
      state.service.published = false;
      renderAll();
      showToast("The page could not be published. Check its URL and try again.");
      return;
    }
    renderAll();
    const pageUrl = `${location.origin}/book/${encodeURIComponent(state.service.slug)}`;
    document.querySelector("#publish-dialog-copy").textContent = `Your booking page is live at ${pageUrl}`;
    document.querySelector("#publish-dialog").showModal();
  });
  document.querySelector("#share-button").addEventListener("click", async () => {
    if (!state.service.published) {
      showToast("Publish the service page before sharing it.");
      return;
    }
    const pageUrl = `${location.origin}/book/${encodeURIComponent(state.service.slug)}`;
    try {
      await navigator.clipboard.writeText(pageUrl);
      showToast("Public booking link copied.");
    } catch (error) {
      console.error("Could not copy the public booking link.", error);
      showToast(pageUrl);
    }
  });
  document.querySelector("#more-button").addEventListener("click", (event) => {
    event.stopPropagation();
    let menu = document.querySelector("#project-menu");
    if (menu) {
      menu.remove();
      return;
    }
    menu = el("div", "project-menu");
    [
      ["Preview page", () => document.querySelector("#preview-button").click()],
      ["Service settings", () => document.querySelector("#settings-button").click()],
      ["Open saved project", openProjects],
      ["Download project backup", exportProject],
      ["Import project backup", () => document.querySelector("#import-file").click()],
      ["Reset to example project", () => {
        if (window.confirm("Replace this browser's saved project with the example?")) {
          const projectId = state.service.projectId;
          state = defaultState();
          state.service.projectId = projectId;
          projectGeneration += 1;
          selectedSlot = "";
          markDirty();
          renderAll();
        }
      }],
    ].forEach(([label, action]) => {
      const button = el("button", "", label);
      button.type = "button";
      button.addEventListener("click", () => {
        menu.remove();
        action();
      });
      menu.append(button);
    });
    event.currentTarget.parentElement.append(menu);
  });
  document.querySelector("#new-project").addEventListener("click", createProject);
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#project-menu, #more-button")) document.querySelector("#project-menu")?.remove();
  });
  document.querySelector("#import-file").addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    if (file) importProject(file);
    event.target.value = "";
  });
  document.querySelectorAll(".viewport-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".viewport-button").forEach((item) => item.classList.toggle("active", item === button));
      canvas.classList.toggle("mobile-viewport", button.dataset.viewport === "mobile");
    });
  });
  document.querySelector("#accent-color").value = state.service.accent || "#ffc928";
  document.querySelector("#accent-color").addEventListener("input", (event) => {
    state.service.accent = event.target.value;
    markDirty();
    renderAll();
  });
  document.querySelector("#page-background").value = state.service.background || "white";
  document.querySelector("#page-background").addEventListener("change", (event) => {
    state.service.background = event.target.value;
    markDirty();
    renderAll();
  });
  document.querySelector("#button-style").value = state.service.buttonStyle || "solid";
  document.querySelector("#button-style").addEventListener("change", (event) => {
    state.service.buttonStyle = event.target.value;
    markDirty();
    renderAll();
  });
  document.querySelector("#reset-appearance").addEventListener("click", () => {
    state.service.accent = "#ffc928";
    state.service.background = "white";
    state.service.buttonStyle = "solid";
    document.querySelector("#accent-color").value = state.service.accent;
    document.querySelector("#page-background").value = state.service.background;
    document.querySelector("#button-style").value = state.service.buttonStyle;
    markDirty();
    renderAll();
  });
  document.querySelector("#sidebar-close").addEventListener("click", () => document.body.classList.toggle("hide-sidebar"));
  document.querySelector("#summary-continue").addEventListener("click", () => {
    document.querySelector('[data-section-id="schedule"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast("Choose an available appointment in the live schedule below.");
  });
  document.querySelector("#book-now").addEventListener("click", confirmSelectedBooking);
  const logoutButton = document.querySelector("#logout-button");
  fetch("/api/auth/me").then((response) => response.json()).then((auth) => {
    logoutButton.hidden = !auth.email;
  }).catch((error) => console.error("Could not check administrator session.", error));
  logoutButton.addEventListener("click", async () => {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) {
      showToast("Could not sign out. Please try again.");
      return;
    }
    window.location.assign("/login.html");
  });

  renderAll();
})();
