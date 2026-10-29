const form = document.querySelector("#login-form");
const status = document.querySelector("#login-status");
if (new URLSearchParams(location.search).get("error") === "expired") {
  status.textContent = "That sign-in link expired or was already used. Request a new one.";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  status.textContent = "Sending sign-in link…";
  try {
    const response = await fetch("/api/auth/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.email.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not send sign-in link.");
    status.textContent = result.message;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
