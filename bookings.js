const projectSelect = document.querySelector("#project-select");
const status = document.querySelector("#bookings-status");
const list = document.querySelector("#booking-list");

async function request(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text != null) item.textContent = text;
  return item;
}

function answersForBooking(project, booking) {
  const labels = new Map(project.sections.flatMap((section) =>
    (section.fields || []).map((field) => [field.id, field.label]),
  ));
  return Object.entries(booking.answers || {})
    .map(([id, value]) => `${labels.get(id) || id}: ${value}`)
    .join("\n");
}

async function loadBookings() {
  const projectId = projectSelect.value;
  list.replaceChildren();
  if (!projectId) {
    status.textContent = "Choose a service to view its bookings.";
    return;
  }
  status.textContent = "Loading bookings…";
  try {
    const [project, result] = await Promise.all([
      request(`/api/projects/${encodeURIComponent(projectId)}`),
      request(`/api/bookings?projectId=${encodeURIComponent(projectId)}`),
    ]);
    const bookings = result.bookings.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    status.textContent = bookings.length ? `${bookings.length} booking${bookings.length === 1 ? "" : "s"}` : "No bookings yet.";
    bookings.forEach((booking) => {
      const card = node("article", "booking-card");
      const top = node("div", "booking-card-top");
      const details = node("div");
      const date = new Intl.DateTimeFormat(undefined, {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: booking.appointment.timezone,
      }).format(new Date(booking.appointment.start));
      details.append(
        node("h2", "", `${project.service.name} · ${date}`),
        node("div", "booking-meta", `Booking ${booking.id} · ${formatMoney(booking.quote.totalMinor, booking.quote.currency)}`),
      );
      const badge = node("span", `booking-status${booking.status === "cancelled" ? " cancelled" : ""}`, booking.status);
      top.append(details, badge);
      card.append(top);
      const answers = answersForBooking(project, booking);
      if (answers) card.append(node("div", "booking-answers", answers));
      if (booking.status === "confirmed") {
        const cancel = node("button", "button quiet", "Cancel booking");
        cancel.type = "button";
        cancel.addEventListener("click", async () => {
          if (!window.confirm("Cancel this appointment and notify the customer?")) return;
          cancel.disabled = true;
          try {
            await request(`/api/bookings/${encodeURIComponent(booking.id)}/cancel`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId }),
            });
            await loadBookings();
          } catch (error) {
            status.textContent = error.message;
            cancel.disabled = false;
          }
        });
        card.append(cancel);
      }
      list.append(card);
    });
  } catch (error) {
    status.textContent = error.message;
  }
}

function formatMoney(minor, currency) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
}

projectSelect.addEventListener("change", loadBookings);
request("/api/projects")
  .then(({ projects }) => {
    projectSelect.replaceChildren(new Option("Select a service", ""));
    projects.forEach((project) => projectSelect.append(new Option(project.name, project.id)));
    if (!projects.length) {
      status.textContent = "Create a service in the editor first.";
      return;
    }
    const queryProjectId = new URLSearchParams(location.search).get("projectId");
    if (projects.some((project) => project.id === queryProjectId)) projectSelect.value = queryProjectId;
    else projectSelect.value = projects[0].id;
    loadBookings();
  })
  .catch((error) => { status.textContent = error.message; });
