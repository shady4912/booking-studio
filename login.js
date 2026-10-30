const form = document.querySelector("#login-form");
const status = document.querySelector("#login-status");
const passwordField = document.querySelector("#password");
const submitButton = form.querySelector('button[type="submit"]');
const emailLinkToggle = document.querySelector("#email-link-toggle");
let useEmailLink = false;

if (new URLSearchParams(location.search).get("error") === "expired") {
  status.textContent = "That sign-in link expired or was already used. Request a new one.";
}

emailLinkToggle.addEventListener("click", () => {
  useEmailLink = !useEmailLink;
  passwordField.hidden = useEmailLink;
  passwordField.required = !useEmailLink;
  passwordField.previousElementSibling.hidden = useEmailLink;
  submitButton.textContent = useEmailLink ? "Email me a sign-in link" : "Sign in";
  emailLinkToggle.textContent = useEmailLink
    ? "Use a password instead"
    : "Use an email sign-in link instead";
  status.textContent = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  emailLinkToggle.disabled = true;
  status.textContent = useEmailLink ? "Sending sign-in link…" : "Signing in…";
  try {
    const response = await fetch(useEmailLink ? "/api/auth/request-link" : "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(useEmailLink
        ? { email: form.email.value }
        : { email: form.email.value, password: passwordField.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not sign in.");
    if (useEmailLink) {
      status.textContent = result.message;
      return;
    }
    location.assign("/");
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    emailLinkToggle.disabled = false;
  }
});
