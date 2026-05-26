// ============================================================
//  main.js — JobPort Frontend
//  Calls Flask backend → JSearch API (real live jobs)
//  Auth-protected Quick Apply with JWT
// ============================================================

// API_BASE_URL is defined in auth.js (loaded first)
const LOGO_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='8' fill='%23e2e8f0'/%3E%3Ctext x='50%25' y='55%25' font-size='18' text-anchor='middle' dominant-baseline='middle' fill='%2394a3b8' font-family='Arial'%3E🏢%3C/text%3E%3C/svg%3E";


// ─────────────────────────────────────────────
// 1. SEARCH JOBS
// ─────────────────────────────────────────────
async function searchJobs() {
    const query    = document.getElementById("job-title")?.value.trim()  ?? "";
    const location = document.getElementById("location")?.value.trim()   ?? "";
    const listEl   = document.getElementById("job-list");

    if (!query && !location) {
        showToast("Please enter a job title or location.", "warning");
        return;
    }

    listEl.innerHTML = `
        <div class="col-12 text-center py-5">
            <div class="spinner-border text-primary mb-3" role="status">
                <span class="visually-hidden">Searching…</span>
            </div>
            <p class="text-muted">Finding the best jobs for you…</p>
        </div>`;

    const params = new URLSearchParams();
    if (query)    params.append("query",    query);
    if (location) params.append("location", location);

    try {
        const res = await fetch(`${window.API_BASE_URL}/api/search?${params}`, {
            headers: { "Accept": "application/json" },
        });

        if (res.status === 429) throw new Error("Rate limit reached. Please wait and retry.");
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Server error (${res.status})`);
        }

        const data = await res.json();
        console.log("API response:", data); // debug
        const { jobs, count } = data;

        if (!jobs || jobs.length === 0) {
            listEl.innerHTML = `
                <div class="col-12">
                    <div class="alert alert-info text-center py-4">
                        <i class="bi bi-search fs-3 d-block mb-2"></i>
                        No jobs found for <strong>"${sanitize(query)}"</strong>.
                        <br><small>Try different keywords.</small>
                    </div>
                </div>`;
            return;
        }

        listEl.innerHTML = `
            <div class="col-12 mb-2">
                <p class="text-muted small">
                    <i class="bi bi-briefcase-fill text-primary me-1"></i>
                    Found <strong>${count}</strong> jobs for "<strong>${sanitize(query)}</strong>"
                    ${location ? `in <strong>${sanitize(location)}</strong>` : ""}
                </p>
            </div>
            ${jobs.map(createJobCard).join("")}`;

    } catch (err) {
        console.error("searchJobs:", err);
        listEl.innerHTML = `
            <div class="col-12">
                <div class="alert alert-danger">
                    <i class="bi bi-exclamation-triangle-fill me-2"></i>
                    <strong>Search failed.</strong> ${sanitize(err.message)}
                </div>
            </div>`;
    }
}


// ─────────────────────────────────────────────
// 2. QUICK APPLY (auth-protected)
// ─────────────────────────────────────────────
function applyToJob(jobTitle, applyLink) {
    const token = getToken();

    if (!token) {
        sessionStorage.setItem("jp_redirect", "/");
        sessionStorage.setItem("jp_pending_job", JSON.stringify({ jobTitle, applyLink }));
        showToast("Please log in to apply for jobs.", "warning");
        setTimeout(() => { window.location.href = "/login"; }, 1200);
        return;
    }

    // Open Modal
    document.getElementById("applyJobTitle").value = jobTitle;
    document.getElementById("applyLink").value = applyLink;
    document.getElementById("applyModalTitle").innerText = `Apply for ${jobTitle}`;
    
    // reset form
    document.getElementById("applyEducation").value = "";
    document.getElementById("applyProjects").value = "";
    
    const applyModal = new bootstrap.Modal(document.getElementById('applyModal'));
    applyModal.show();
}

// Handle apply form submission
document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("applyForm");
    if(form) {
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const jobTitle = document.getElementById("applyJobTitle").value;
            const applyLink = document.getElementById("applyLink").value;
            const education = document.getElementById("applyEducation").value;
            const projects = document.getElementById("applyProjects").value;
            
            const btn = document.getElementById("confirmApplyBtn");
            const originalText = btn.innerHTML;
            btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Submitting...`;
            btn.disabled = true;

            try {
                const res = await fetch(`${window.API_BASE_URL}/api/apply`, {
                    method:  "POST",
                    headers: {
                        "Content-Type":  "application/json",
                        "Authorization": `Bearer ${getToken()}`,
                    },
                    body: JSON.stringify({ job_title: jobTitle, education, projects }),
                });

                const data = await res.json();

                if (res.status === 201) {
                    showToast(`✅ Applied for "${jobTitle}" successfully!`, "success");
                    bootstrap.Modal.getInstance(document.getElementById('applyModal')).hide();
                    setTimeout(() => {
                        if (applyLink && applyLink !== "#") window.open(applyLink, "_blank");
                    }, 1500);
                } else if (res.status === 401) {
                    clearSession();
                    showToast("Session expired. Please log in again.", "warning");
                    setTimeout(() => { window.location.href = "/login"; }, 1500);
                } else if (res.status === 409) {
                    showToast(`⚠️ You already applied for "${jobTitle}".`, "warning");
                    bootstrap.Modal.getInstance(document.getElementById('applyModal')).hide();
                } else {
                    throw new Error(data.error || "Unexpected error.");
                }

            } catch (err) {
                console.error("applyToJob error:", err);
                showToast(`❌ ${err.message}`, "danger");
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        });
    }
});


// ─────────────────────────────────────────────
// 3. CARD RENDERER
// ─────────────────────────────────────────────
function createJobCard(job) {
    const location = [job.job_city, job.job_country].filter(Boolean).join(", ") || "Remote";

    const badgeMap = {
        "FULLTIME":   ["badge-fulltime",  "Full-Time"],
        "PARTTIME":   ["badge-parttime",  "Part-Time"],
        "CONTRACTOR": ["badge-contract",  "Contract"],
        "INTERN":     ["badge-intern",    "Internship"],
    };
    const [badgeClass, badgeLabel] = badgeMap[job.job_employment_type] || ["badge-intern", job.job_employment_type || ""];

    const postedDate = job.job_posted_at
        ? new Date(job.job_posted_at).toLocaleDateString("en-IN", {
            day: "numeric", month: "short", year: "numeric"
          })
        : null;

    const logoSrc   = job.employer_logo || LOGO_FALLBACK;
    const safeTitle = sanitize(job.job_title).replace(/'/g, "\\'");
    const safeLink  = sanitize(job.job_apply_link).replace(/'/g, "\\'");

    return `
        <div class="col-md-6 col-lg-4">
            <div class="card h-100 border-0 job-card">
                <div class="card-body d-flex flex-column p-4">

                    <div class="d-flex align-items-start gap-3 mb-3">
                        <img src="${logoSrc}" alt="${sanitize(job.employer_name)}"
                            class="job-logo" onerror="this.src='${LOGO_FALLBACK}'" />
                        <div class="overflow-hidden">
                            <div class="job-title" title="${sanitize(job.job_title)}">
                                ${sanitize(job.job_title)}
                            </div>
                            <div class="job-company">
                                <i class="bi bi-building me-1"></i>${sanitize(job.employer_name)}
                            </div>
                        </div>
                    </div>

                    <p class="job-location mb-2">
                        <i class="bi bi-geo-alt-fill text-danger me-1"></i>${sanitize(location)}
                    </p>

                    <div class="d-flex flex-wrap gap-2 mb-3">
                        ${badgeLabel ? `<span class="badge-type ${badgeClass}">${badgeLabel}</span>` : ""}
                        ${job.salary  ? `<span class="badge-salary">${sanitize(job.salary)}</span>` : ""}
                    </div>

                    <p class="job-desc flex-grow-1 mb-3">
                        ${sanitize(job.job_description) || "No description available."}
                    </p>

                    <div class="border-top pt-3 d-flex justify-content-between align-items-center">
                        ${postedDate
                            ? `<span class="job-date"><i class="bi bi-calendar3 me-1"></i>${postedDate}</span>`
                            : `<span></span>`}
                        <div class="d-flex gap-2">
                            <a href="${sanitize(job.job_apply_link)}" target="_blank"
                               rel="noopener noreferrer" class="btn-apply-ext">
                                Apply
                            </a>
                            <button class="btn-quick-apply apply-btn"
                                    onclick="applyToJob('${safeTitle}', '${safeLink}')">
                                <i class="bi bi-lightning-charge-fill"></i> Quick Apply
                            </button>
                        </div>
                    </div>

                </div>
            </div>
        </div>`;
}


// ─────────────────────────────────────────────
// 4. TOAST
// ─────────────────────────────────────────────
function showToast(message, type = "info") {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        container.className = "toast-container position-fixed bottom-0 end-0 p-3";
        container.style.zIndex = "1100";
        document.body.appendChild(container);
    }
    const el = document.createElement("div");
    el.className = `toast align-items-center text-bg-${type} border-0 rounded-3`;
    el.setAttribute("role", "alert");
    el.setAttribute("aria-atomic", "true");
    el.innerHTML = `
        <div class="d-flex">
            <div class="toast-body fw-semibold">${message}</div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto"
                    data-bs-dismiss="toast"></button>
        </div>`;
    container.appendChild(el);
    new bootstrap.Toast(el, { delay: 4500 }).show();
    el.addEventListener("hidden.bs.toast", () => el.remove());
}


// ─────────────────────────────────────────────
// 5. UTILITIES
// ─────────────────────────────────────────────
function sanitize(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

function setApplyButtons(disabled) {
    document.querySelectorAll(".apply-btn").forEach(btn => {
        btn.disabled  = disabled;
        btn.innerHTML = disabled
            ? `<span class="spinner-border spinner-border-sm"></span> Applying…`
            : `<i class="bi bi-lightning-charge-fill"></i> Quick Apply`;
    });
}

// Session helpers (mirrors auth.js)
function getToken() {
    return sessionStorage.getItem("jp_token") || localStorage.getItem("jp_token") || null;
}
function getUser() {
    const raw = sessionStorage.getItem("jp_user") || localStorage.getItem("jp_user");
    return raw ? JSON.parse(raw) : null;
}
function clearSession() {
    ["jp_token","jp_user"].forEach(k => {
        sessionStorage.removeItem(k);
        localStorage.removeItem(k);
    });
}

function quickSearch(term) {
    const input = document.getElementById("job-title");
    if (input) { input.value = term; searchJobs(); }
}


// ─────────────────────────────────────────────
// 6. BOOT
// ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    // Keyboard search
    ["job-title", "location"].forEach(id => {
        document.getElementById(id)?.addEventListener("keydown", e => {
            if (e.key === "Enter") searchJobs();
        });
    });

    // Update navbar based on login state
    if (typeof updateNavbar === "function") updateNavbar();

    // If user just logged in and had a pending job, auto-apply
    const pending = sessionStorage.getItem("jp_pending_job");
    if (pending && getToken()) {
        sessionStorage.removeItem("jp_pending_job");
        const { jobTitle, applyLink } = JSON.parse(pending);
        setTimeout(() => applyToJob(jobTitle, applyLink), 800);
    }
});

// ─────────────────────────────────────────────
// 7. DASHBOARDS LOGIC (User & HR)
// ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    const dashboardModalEl = document.getElementById('dashboardModal');
    if(dashboardModalEl) {
        dashboardModalEl.addEventListener('show.bs.modal', async () => {
            const token = getToken();
            if(!token) {
                showToast("Please log in first.", "warning");
                // prevent modal from opening if possible or just hide it
                setTimeout(() => bootstrap.Modal.getInstance(dashboardModalEl).hide(), 100);
                return;
            }
            
            const listEl = document.getElementById("applications-list");
            listEl.innerHTML = `<div class="col-12 text-center py-5"><div class="spinner-border text-primary" role="status"></div><p class="text-muted mt-2">Loading applications...</p></div>`;
            
            try {
                const res = await fetch(`${window.API_BASE_URL || ''}/api/applications`, { headers: { 'Authorization': `Bearer ${token}` } });
                const data = await res.json();
                
                if (!data.applications || data.applications.length === 0) {
                    listEl.innerHTML = `<div class="col-12 text-center text-muted py-5">No applications found.</div>`;
                    return;
                }

                listEl.innerHTML = data.applications.map(app => {
                    let badgeColor = app.status === 'Applied' ? 'bg-primary' : 
                                     app.status === 'Under Review' ? 'bg-warning text-dark' : 
                                     app.status === 'Interview' ? 'bg-info text-dark' : 
                                     app.status === 'Hired' ? 'bg-success' : 'bg-danger';
                    return `
                    <div class="col-md-6">
                        <div class="card h-100 border-0 shadow-sm job-card">
                            <div class="card-body p-4">
                                <h5 class="fw-bold mb-1">${sanitize(app.job_title)}</h5>
                                <p class="text-muted small mb-3">Applied on ${new Date(app.applied_at).toLocaleDateString()}</p>
                                <span class="badge ${badgeColor} px-3 py-2 rounded-pill fs-6">${sanitize(app.status)}</span>
                            </div>
                        </div>
                    </div>`;
                }).join('');
            } catch(e) {
                listEl.innerHTML = `<div class="col-12 text-danger text-center">Failed to load applications.</div>`;
            }
        });
    }

    const hrModalEl = document.getElementById('hrModal');
    if(hrModalEl) {
        hrModalEl.addEventListener('show.bs.modal', async () => {
            fetchHRApps();
        });
    }
});

let allApps = [];
async function fetchHRApps() {
    const listEl = document.getElementById("hr-apps-list");
    listEl.innerHTML = `<tr><td colspan="5" class="text-center py-5 text-muted"><div class="spinner-border text-primary mb-2" role="status"></div><br>Loading...</td></tr>`;
    try {
        const res = await fetch(`${window.API_BASE_URL || ''}/api/hr/applications`);
        const data = await res.json();
        if(!data.applications || !data.applications.length) {
            listEl.innerHTML = `<tr><td colspan="5" class="text-center py-5 text-muted">No applications found.</td></tr>`;
            return;
        }
        allApps = data.applications;
        renderHRApps();
    } catch(e) {
        listEl.innerHTML = `<tr><td colspan="5" class="text-center py-5 text-danger">Error loading applications.</td></tr>`;
    }
}

function renderHRApps() {
    const listEl = document.getElementById("hr-apps-list");
    listEl.innerHTML = allApps.map(app => {
        let badgeColor = app.status === 'Applied' ? 'bg-primary' : 
                         app.status === 'Under Review' ? 'bg-warning text-dark' : 
                         app.status === 'Interview' ? 'bg-info text-dark' : 
                         app.status === 'Hired' ? 'bg-success' : 'bg-danger';
        return `
        <tr>
            <td class="px-4 py-3">
                <div class="fw-semibold">${sanitize(app.user_email.split('@')[0])}</div>
                <div class="text-muted small">${sanitize(app.user_email)}</div>
            </td>
            <td class="py-3 fw-medium">${sanitize(app.job_title)}</td>
            <td class="py-3">
                <button class="btn btn-sm btn-outline-secondary rounded-pill px-3" onclick="viewDetails(${app.id})">
                    <i class="bi bi-eye me-1"></i> View Details
                </button>
            </td>
            <td class="py-3"><span class="badge ${badgeColor} px-2 py-1 rounded-pill">${sanitize(app.status)}</span></td>
            <td class="px-4 py-3 text-end">
                <select class="form-select form-select-sm d-inline-block w-auto rounded-pill" onchange="updateStatus(${app.id}, this.value)">
                    <option value="Applied" ${app.status === 'Applied' ? 'selected' : ''}>Applied</option>
                    <option value="Under Review" ${app.status === 'Under Review' ? 'selected' : ''}>Under Review</option>
                    <option value="Interview" ${app.status === 'Interview' ? 'selected' : ''}>Interview</option>
                    <option value="Hired" ${app.status === 'Hired' ? 'selected' : ''}>Hired</option>
                    <option value="Rejected" ${app.status === 'Rejected' ? 'selected' : ''}>Rejected</option>
                </select>
            </td>
        </tr>`;
    }).join('');
}

function viewDetails(id) {
    const app = allApps.find(a => a.id === id);
    if(app) {
        document.getElementById('m-job').innerText = app.job_title;
        document.getElementById('m-email').innerText = app.user_email;
        document.getElementById('m-edu').innerText = app.education || 'No details provided.';
        document.getElementById('m-proj').innerText = app.projects || 'No projects provided.';
        new bootstrap.Modal(document.getElementById('detailsModal')).show();
    }
}

async function updateStatus(id, newStatus) {
    try {
        const res = await fetch(`${window.API_BASE_URL || ''}/api/hr/applications/${id}/status`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({status: newStatus})
        });
        if(res.ok) {
            const app = allApps.find(a => a.id === id);
            if(app) app.status = newStatus;
            renderHRApps();
            showToast("Status updated successfully", "success");
        } else {
            showToast("Failed to update status", "danger");
        }
    } catch(e) {
        console.error(e);
        showToast("Error updating status", "danger");
    }
}