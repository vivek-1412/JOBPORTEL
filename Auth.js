// ============================================================
//  auth.js — JobPort Authentication
//  Handles Login, Signup, Logout, Session Management
//  Communicates with Flask backend for secure auth
// ============================================================

// Global config — accessible by main.js and resume.js
window.API_BASE_URL = window.location.origin;

let pending2faToken = null;
let pending2faRemember = false;

const twoFaModal = document.getElementById("twoFaModal");
if (twoFaModal) {
    twoFaModal.addEventListener("hidden.bs.modal", () => {
        pending2faToken = null;
        pending2faRemember = false;
        const codeEl = document.getElementById("two-fa-code");
        const errorEl = document.getElementById("two-fa-error");
        if (codeEl) codeEl.value = "";
        if (errorEl) {
            errorEl.classList.add("d-none");
            errorEl.textContent = "";
        }
    });
}

// ─────────────────────────────────────────────
// SESSION HELPERS
// Store JWT token in sessionStorage (cleared on tab close)
// For "remember me" → use localStorage
// ─────────────────────────────────────────────
function saveSession(token, user, remember = false) {
    const storage = remember ? localStorage : sessionStorage;
    storage.setItem("jp_token", token);
    storage.setItem("jp_user",  JSON.stringify(user));
}

function getToken() {
    return sessionStorage.getItem("jp_token") ||
           localStorage.getItem("jp_token")   || null;
}

function getUser() {
    const raw = sessionStorage.getItem("jp_user") ||
                localStorage.getItem("jp_user");
    return raw ? JSON.parse(raw) : null;
}

function clearSession() {
    sessionStorage.removeItem("jp_token");
    sessionStorage.removeItem("jp_user");
    localStorage.removeItem("jp_token");
    localStorage.removeItem("jp_user");
}

function isLoggedIn() {
    return !!getToken();
}

// Redirect away from auth pages if already logged in
function checkAuthRedirect() {
    if (isLoggedIn()) window.location.href = "/";
}


// ─────────────────────────────────────────────
// SHOW ALERT inside auth card
// ─────────────────────────────────────────────
function showAuthAlert(message, type = "danger") {
    const el = document.getElementById("auth-alert");
    if (!el) return;
    el.className     = `alert alert-${type}`;
    el.innerHTML     = message;
    el.style.display = "block";
    el.classList.remove("d-none");
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideAuthAlert() {
    const el = document.getElementById("auth-alert");
    if (el) { el.className = "alert d-none"; el.innerHTML = ""; }
}


// ─────────────────────────────────────────────
// SET BUTTON LOADING STATE
// ─────────────────────────────────────────────
function setButtonLoading(btnId, loading, label = "Submit") {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled  = loading;
    btn.innerHTML = loading
        ? `<span class="spinner-border spinner-border-sm me-2"></span>Please wait…`
        : label;
}


// ─────────────────────────────────────────────
// LOGIN HANDLER
// ─────────────────────────────────────────────
async function handleLogin() {
    hideAuthAlert();

    const email    = document.getElementById("login-email")?.value.trim().toLowerCase();
    const password = document.getElementById("login-password")?.value;
    const remember = document.getElementById("remember-me")?.checked;

    if (!email || !password) {
        showAuthAlert("Please fill in both email and password.");
        return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAuthAlert("Please enter a valid email address.");
        return;
    }

    pending2faRemember = !!remember;
    setButtonLoading("login-btn", true, "Sign In");

    try {
        const res = await fetch(`${window.API_BASE_URL}/api/auth/login`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ email, password }),
        });

        const data = await res.json();

        if (res.status === 200 && data.requires_2fa) {
            pending2faToken = data.temp_token;
            document.getElementById("two-fa-code").value = "";
            document.getElementById("two-fa-error").classList.add("d-none");
            hideAuthAlert();

            const modal = new bootstrap.Modal(document.getElementById("twoFaModal"));
            modal.show();
            return;
        }

        if (res.status === 200) {
            saveSession(data.token, data.user, remember);

            showAuthAlert(
                `<i class="bi bi-check-circle-fill me-2"></i>Welcome back, <strong>${data.user.first_name}</strong>! Redirecting…`,
                "success"
            );

            const redirect = sessionStorage.getItem("jp_redirect") || "/";
            sessionStorage.removeItem("jp_redirect");
            setTimeout(() => { window.location.href = redirect; }, 1200);
            return;
        }

        if (res.status === 401) {
            showAuthAlert("<i class='bi bi-exclamation-triangle-fill me-2'></i>Incorrect email or password.");
            return;
        }

        showAuthAlert(data.error || "Login failed. Please try again.");

    } catch (err) {
        console.error("Login error:", err);
        showAuthAlert("Cannot connect to server. Make sure Flask is running.");
    } finally {
        setButtonLoading("login-btn", false, "Sign In");
    }
}

async function submit2FA() {
    const codeEl = document.getElementById("two-fa-code");
    const errorEl = document.getElementById("two-fa-error");
    const code = codeEl?.value.trim();

    if (!pending2faToken) {
        showAuthAlert("Your session expired. Please log in again.");
        return;
    }
    if (!code || !/^\d{6}$/.test(code)) {
        errorEl.classList.remove("d-none");
        errorEl.textContent = "Enter the 6-digit code from your authenticator app.";
        return;
    }

    errorEl.classList.add("d-none");
    const verifyBtn = document.querySelector("#twoFaModal .btn-primary");
    const originalText = verifyBtn?.innerHTML || "Verify";
    if (verifyBtn) {
        verifyBtn.disabled = true;
        verifyBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Verifying…`;
    }

    try {
        const res = await fetch(`${window.API_BASE_URL}/api/auth/verify-2fa`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ temp_token: pending2faToken, code }),
        });

        const data = await res.json();

        if (res.status === 200) {
            saveSession(data.token, data.user, pending2faRemember);
            pending2faToken = null;
            pending2faRemember = false;
            bootstrap.Modal.getInstance(document.getElementById("twoFaModal"))?.hide();
            showAuthAlert(
                `<i class="bi bi-check-circle-fill me-2"></i>Two-factor verification complete. Welcome back, <strong>${data.user.first_name}</strong>!`,
                "success"
            );

            const redirect = sessionStorage.getItem("jp_redirect") || "/";
            sessionStorage.removeItem("jp_redirect");
            setTimeout(() => { window.location.href = redirect; }, 1200);
            return;
        }

        errorEl.classList.remove("d-none");
        errorEl.textContent = data.error || "Unable to verify the code.";
    } catch (err) {
        console.error("2FA verification error:", err);
        errorEl.classList.remove("d-none");
        errorEl.textContent = "Unable to verify the code right now. Please try again.";
    } finally {
        if (verifyBtn) {
            verifyBtn.disabled = false;
            verifyBtn.innerHTML = originalText;
        }
    }
}


// ─────────────────────────────────────────────
// SIGNUP HANDLER
// ─────────────────────────────────────────────
async function handleSignup() {
    hideAuthAlert();

    const firstName = document.getElementById("first-name")?.value.trim();
    const lastName  = document.getElementById("last-name")?.value.trim();
    const email     = document.getElementById("signup-email")?.value.trim().toLowerCase();
    const password  = document.getElementById("signup-password")?.value;
    const confirm   = document.getElementById("confirm-password")?.value;
    const agreed    = document.getElementById("agree-terms")?.checked;

    // Validation
    if (!firstName || !lastName) {
        showAuthAlert("Please enter your full name."); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAuthAlert("Please enter a valid email address."); return;
    }
    if (password.length < 8) {
        showAuthAlert("Password must be at least 8 characters."); return;
    }
    if (password !== confirm) {
        showAuthAlert("Passwords do not match."); return;
    }
    if (!agreed) {
        showAuthAlert("Please accept the Terms of Service to continue."); return;
    }

    setButtonLoading("signup-btn", true, "Create Account");

    try {
        const res = await fetch(`${window.API_BASE_URL}/api/auth/signup`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ first_name: firstName, last_name: lastName, email, password }),
        });

        const data = await res.json();

        if (res.status === 201) {
            // Auto-login after signup
            saveSession(data.token, data.user, false);
            showAuthAlert(
                `<i class="bi bi-check-circle-fill me-2"></i>Account created! Welcome, <strong>${data.user.first_name}</strong>! Redirecting…`,
                "success"
            );
            setTimeout(() => { window.location.href = "/"; }, 1400);

        } else if (res.status === 409) {
            showAuthAlert("An account with this email already exists. <a href='/login' class='alert-link'>Sign in instead</a>.");
        } else {
            showAuthAlert(data.error || "Signup failed. Please try again.");
        }

    } catch (err) {
        console.error("Signup error:", err);
        showAuthAlert("Cannot connect to server. Make sure Flask is running.");
    } finally {
        setButtonLoading("signup-btn", false, "Create Account");
    }
}


// ─────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────
function logout() {
    clearSession();
    window.location.href = "/login";
}


// ─────────────────────────────────────────────
// GOOGLE LOGIN
// ─────────────────────────────────────────────
async function loginWithGoogle() {
    const btn = event?.currentTarget;

    if (btn) {
        btn.disabled  = true;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Redirecting…`;
    }

    try {
        const res = await fetch(`${window.API_BASE_URL}/api/auth/google`);
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || "Google login is not configured yet.");
        }

        if (!data.url) {
            throw new Error("No OAuth URL returned from the server.");
        }

        sessionStorage.setItem("jp_redirect", "/");
        window.location.href = data.url;

    } catch (err) {
        console.error("Google OAuth error:", err);
        showAuthAlert(
            `<i class="bi bi-google me-2"></i>
             <strong>Google sign-in failed:</strong> ${err.message}`,
            "danger"
        );

        if (btn) {
            btn.disabled  = false;
            btn.innerHTML = `<img src="https://www.google.com/favicon.ico" width="18" class="me-2" alt="Google"> Continue with Google`;
        }
    }
}


// ─────────────────────────────────────────────
// PASSWORD STRENGTH METER
// ─────────────────────────────────────────────
function checkPasswordStrength(password) {
    const bar   = document.getElementById("strength-bar");
    const label = document.getElementById("strength-label");
    if (!bar || !label) return;

    let score = 0;
    if (password.length >= 8)                    score++;
    if (/[A-Z]/.test(password))                  score++;
    if (/[0-9]/.test(password))                  score++;
    if (/[^A-Za-z0-9]/.test(password))           score++;

    const levels = [
        { width: "0%",   color: "",          text: "" },
        { width: "25%",  color: "bg-danger",  text: "Weak" },
        { width: "50%",  color: "bg-warning", text: "Fair" },
        { width: "75%",  color: "bg-info",    text: "Good" },
        { width: "100%", color: "bg-success", text: "Strong 💪" },
    ];

    const level = levels[score];
    bar.style.width = level.width;
    bar.className   = `progress-bar ${level.color}`;
    label.textContent = level.text;
    label.style.color = score <= 1 ? "#dc2626"
                      : score === 2 ? "#d97706"
                      : score === 3 ? "#0891b2"
                      : "#16a34a";
}


// ─────────────────────────────────────────────
// TOGGLE PASSWORD VISIBILITY
// ─────────────────────────────────────────────
function togglePassword(inputId, btn) {
    const input = document.getElementById(inputId);
    const icon  = btn.querySelector("i");
    if (input.type === "password") {
        input.type   = "text";
        icon.className = "bi bi-eye-slash";
    } else {
        input.type   = "password";
        icon.className = "bi bi-eye";
    }
}


// ─────────────────────────────────────────────
// UPDATE NAVBAR based on login state (call on index.html)
// ─────────────────────────────────────────────
function updateNavbar() {
    const navActions = document.getElementById("nav-actions");
    if (!navActions) return;

    const hrLink = `<a href="#" class="text-white small me-3 text-decoration-none opacity-75 hover-opacity-100" data-bs-toggle="modal" data-bs-target="#hrModal">HR Portal</a>`;

    const user = getUser();
    if (user) {
        navActions.innerHTML = hrLink + `
            <div class="dropdown">
                <button class="btn btn-outline-light btn-sm rounded-pill px-3 dropdown-toggle"
                        type="button" data-bs-toggle="dropdown">
                    <i class="bi bi-person-circle me-1"></i>${user.first_name}
                </button>
                <ul class="dropdown-menu dropdown-menu-end">
                    <li><a class="dropdown-item" href="#" data-bs-toggle="modal" data-bs-target="#dashboardModal"><i class="bi bi-file-earmark-text me-2"></i>My Applications</a></li>
                    <li><hr class="dropdown-divider"></li>
                    <li><a class="dropdown-item text-danger" href="#" onclick="logout()"><i class="bi bi-box-arrow-right me-2"></i>Logout</a></li>
                </ul>
            </div>`;
    } else {
        navActions.innerHTML = hrLink + `
            <a href="/login"  class="btn btn-outline-light btn-sm rounded-pill px-3">Login</a>
            <a href="/signup" class="btn btn-primary btn-sm rounded-pill px-3">Sign Up</a>`;
    }
}