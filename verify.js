const button = document.querySelector("#verify-button");
const status = document.querySelector("#verify-status");
const token = new URLSearchParams(location.search).get("token") || "";

button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Verifying sign-in…";
  try {
    const response = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "This sign-in link has expired.");
    location.assign("/");
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
