// ============================================================
//  resume.js — Resume Analyzer Frontend Logic
//  JobPort | Bootstrap 5 | Connects to Flask /api/analyze
// ============================================================

// API_BASE_URL is defined in auth.js
const LOGO_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='44' height='44' viewBox='0 0 44 44'%3E%3Crect width='44' height='44' rx='8' fill='%23e2e8f0'/%3E%3Ctext x='50%25' y='55%25' font-size='18' text-anchor='middle' dominant-baseline='middle' fill='%2394a3b8' font-family='Arial'%3E🏢%3C/text%3E%3C/svg%3E";
const MAX_SIZE_MB   = 5;

let selectedFile = null;


// ─────────────────────────────────────────────
// 1. FILE SELECTION & DRAG-DROP
// ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    const dropZone  = document.getElementById("drop-zone");
    const fileInput = document.getElementById("resume-file");

    if (typeof updateNavbar === "function") updateNavbar();

    // Click anywhere on drop zone to open file picker
    dropZone.addEventListener("click", (e) => {
        if (!e.target.closest("button")) fileInput.click();
    });

    // File selected via picker
    fileInput.addEventListener("change", () => {
        if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
    });

    // Drag events
    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("dragover");
    });

    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        const file = e.dataTransfer.files[0];
        if (file) handleFileSelect(file);
    });
});


function handleFileSelect(file) {
    const allowed = [".pdf", ".docx", ".doc", ".txt"];
    const ext     = "." + file.name.split(".").pop().toLowerCase();
    const errorEl = document.getElementById("upload-error");

    // Validate extension
    if (!allowed.includes(ext)) {
        showUploadError(`Invalid format "${ext}". Please upload PDF, DOCX, DOC, or TXT.`);
        return;
    }

    // Validate size
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        showUploadError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_SIZE_MB} MB.`);
        return;
    }

    // Clear any previous error
    errorEl.classList.add("d-none");
    selectedFile = file;

    // Show file preview
    document.getElementById("drop-content").classList.add("d-none");
    document.getElementById("file-preview").classList.remove("d-none");
    document.getElementById("file-name").textContent = file.name;
    document.getElementById("file-size").textContent = formatFileSize(file.size);

    const dropZone = document.getElementById("drop-zone");
    dropZone.classList.remove("dragover");
    dropZone.classList.add("has-file");

    // Enable analyze button
    document.getElementById("analyze-btn").disabled = false;
}


function clearFile() {
    selectedFile = null;
    document.getElementById("resume-file").value = "";
    document.getElementById("drop-content").classList.remove("d-none");
    document.getElementById("file-preview").classList.add("d-none");
    document.getElementById("drop-zone").classList.remove("has-file");
    document.getElementById("analyze-btn").disabled = true;
    document.getElementById("upload-error").classList.add("d-none");
}


function showUploadError(msg) {
    const el = document.getElementById("upload-error");
    el.innerHTML = `<i class="bi bi-exclamation-triangle-fill me-2"></i>${msg}`;
    el.classList.remove("d-none");
}

function formatFileSize(bytes) {
    if (bytes < 1024)        return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
}


// ─────────────────────────────────────────────
// 2. ANALYZE RESUME
// ─────────────────────────────────────────────
async function analyzeResume() {
    if (!selectedFile) return;

    // Hide results, show loading
    document.getElementById("results-section").classList.add("d-none");
    document.getElementById("loading-section").classList.remove("d-none");
    document.getElementById("analyze-btn").disabled = true;

    // Animate loading bar with fake progress steps
    animateLoadingBar([
        { pct: 20,  text: "Extracting resume content…",        delay: 0    },
        { pct: 45,  text: "Sending to AI for analysis…",       delay: 1500 },
        { pct: 70,  text: "Calculating ATS score…",            delay: 4000 },
        { pct: 88,  text: "Fetching matching job listings…",   delay: 7000 },
        { pct: 96,  text: "Almost done…",                      delay: 10000 },
    ]);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
        const res = await fetch(`${window.API_BASE_URL}/api/analyze`, {
            method: "POST",
            body:   formData,
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || `Server error (${res.status})`);
        }

        // Success — render results
        document.getElementById("loading-section").classList.add("d-none");
        renderResults(data);
        document.getElementById("results-section").classList.remove("d-none");
        document.getElementById("results-section").scrollIntoView({ behavior: "smooth" });

    } catch (err) {
        document.getElementById("loading-section").classList.add("d-none");
        showUploadError(`Analysis failed: ${err.message}`);
        document.getElementById("analyze-btn").disabled = false;
        window.scrollTo({ top: 0, behavior: "smooth" });
    }
}


function animateLoadingBar(steps) {
    const bar  = document.getElementById("loading-bar");
    const text = document.getElementById("loading-text");
    steps.forEach(({ pct, text: label, delay }) => {
        setTimeout(() => {
            bar.style.width   = pct + "%";
            text.textContent  = label;
        }, delay);
    });
}


// ─────────────────────────────────────────────
// 3. RENDER RESULTS
// ─────────────────────────────────────────────
function renderResults(data) {
    renderScore(data.score, data.score_label);
    renderSkills(data.search_keywords, data.job_titles);
    renderFeedback(data.feedback);
    renderStrengths(data.strengths);
    renderTemplates(data.suggested_templates);
    renderMatchingJobs(data.matching_jobs, data.search_keywords);

    // Experience level
    const lvlEl = document.getElementById("experience-level");
    if (data.experience_level) {
        lvlEl.textContent = `Experience: ${data.experience_level} Level`;
    }
}


// ── Score ──
function renderScore(score, label) {
    const num    = parseInt(score) || 0;
    const circle = document.getElementById("score-circle");
    const bar    = document.getElementById("score-bar");
    const badge  = document.getElementById("score-badge");
    const pctEl  = document.getElementById("score-pct");

    // Determine color class
    let cls = "score-poor";
    if (num >= 80) cls = "score-excellent";
    else if (num >= 60) cls = "score-good";
    else if (num >= 40) cls = "score-fair";

    // Animate number
    animateCounter(document.getElementById("score-number"), 0, num, 1500);

    // Animate circle (conic-gradient via CSS var)
    circle.className = `score-circle mx-auto mb-3 ${cls}`;
    setTimeout(() => {
        circle.style.setProperty("--pct", `${num}%`);
    }, 100);

    // Progress bar
    setTimeout(() => {
        bar.style.width = num + "%";
        bar.className   = `progress-bar rounded-pill ${cls}`;
    }, 200);

    pctEl.textContent  = num + "%";
    badge.textContent  = label || (num >= 80 ? "Excellent" : num >= 60 ? "Good" : num >= 40 ? "Fair" : "Poor");
    badge.className    = `badge rounded-pill px-3 py-2 fs-6 ${cls}`;
}


function animateCounter(el, from, to, duration) {
    const start = performance.now();
    function update(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        el.textContent = Math.round(from + (to - from) * progress);
        if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
}


// ── Skills & Titles ──
function renderSkills(keywords, jobTitles) {
    const kwWrap    = document.getElementById("keywords-wrap");
    const titleWrap = document.getElementById("job-titles-wrap");
    const kwDisplay = document.getElementById("keywords-display");

    kwWrap.innerHTML    = "";
    titleWrap.innerHTML = "";

    if (keywords) {
        kwDisplay.textContent = keywords;
        keywords.split(",").map(k => k.trim()).filter(Boolean).forEach(skill => {
            kwWrap.innerHTML += `<span class="skill-badge">${sanitize(skill)}</span>`;
        });
    }

    (jobTitles || []).forEach(title => {
        titleWrap.innerHTML += `<span class="title-badge">${sanitize(title)}</span>`;
    });
}


// ── Feedback ──
function renderFeedback(feedback) {
    const el = document.getElementById("feedback-list");
    el.innerHTML = "";
    (feedback || []).forEach(item => {
        el.innerHTML += `<li>${sanitize(item)}</li>`;
    });
    if (!feedback?.length) {
        el.innerHTML = `<li>No specific issues found — great resume!</li>`;
    }
}


// ── Strengths ──
function renderStrengths(strengths) {
    const el = document.getElementById("strengths-list");
    el.innerHTML = "";
    (strengths || []).forEach(item => {
        el.innerHTML += `<li>${sanitize(item)}</li>`;
    });
    if (!strengths?.length) {
        el.innerHTML = `<li>Upload a more detailed resume to see your strengths.</li>`;
    }
}


// ── Templates ──
function renderTemplates(templates) {
    if (!templates) return;

    const reasonEl = document.getElementById("template-reason");
    reasonEl.textContent = templates.reason || "";

    // Highlight the recommended template card
    const primary = (templates.primary || "").toLowerCase();
    const cardMap  = {
        chronological: "tpl-chronological",
        functional:    "tpl-functional",
        hybrid:        "tpl-hybrid",
        combo:         "tpl-hybrid",
        creative:      "tpl-functional",
    };

    // Reset all
    Object.values(cardMap).forEach(id => {
        document.getElementById(id)?.classList.remove("recommended");
    });

    const recommended = cardMap[primary];
    if (recommended) {
        document.getElementById(recommended)?.classList.add("recommended");
    }
}


// ── Matching Jobs ──
function renderMatchingJobs(jobs, keywords) {
    const listEl  = document.getElementById("matched-jobs-list");
    const countEl = document.getElementById("jobs-count");

    listEl.innerHTML = "";

    if (!jobs || jobs.length === 0) {
        listEl.innerHTML = `
            <div class="col-12">
                <div class="alert alert-info">
                    <i class="bi bi-info-circle me-2"></i>
                    No matching jobs found right now. Try searching manually with your skills.
                </div>
            </div>`;
        countEl.textContent = "0";
        return;
    }

    countEl.textContent = jobs.length;
    listEl.innerHTML    = jobs.map(createJobCard).join("");
}


function createJobCard(job) {
    const location = [job.job_city, job.job_country].filter(Boolean).join(", ") || "Remote";
    const logo     = job.employer_logo || LOGO_FALLBACK;

    const badgeMap = {
        FULLTIME:   ["#dbeafe", "#1e40af", "Full-Time"],
        PARTTIME:   ["#cffafe", "#0e7490", "Part-Time"],
        CONTRACTOR: ["#fef9c3", "#854d0e", "Contract"],
        INTERN:     ["#f1f5f9", "#475569", "Internship"],
    };
    const [bg, color, label] = badgeMap[job.job_employment_type] || ["#f1f5f9", "#475569", job.job_employment_type || ""];

    return `
    <div class="col-md-6 col-lg-4">
        <div class="matched-job-card">
            <div class="d-flex align-items-start gap-3 mb-3">
                <img src="${logo}" alt="${sanitize(job.employer_name)}"
                     class="matched-job-logo"
                     onerror="this.src='${LOGO_FALLBACK}'"/>
                <div class="overflow-hidden">
                    <div class="fw-bold text-truncate" style="font-size:.93rem;"
                         title="${sanitize(job.job_title)}">${sanitize(job.job_title)}</div>
                    <div class="text-muted small">
                        <i class="bi bi-building me-1"></i>${sanitize(job.employer_name)}
                    </div>
                </div>
            </div>
            <p class="small text-secondary mb-2">
                <i class="bi bi-geo-alt-fill text-danger me-1"></i>${sanitize(location)}
            </p>
            ${label ? `<span class="badge rounded-pill mb-2"
                style="background:${bg};color:${color};border:1px solid ${color}33;font-size:.73rem;">
                ${label}</span>` : ""}
            <p class="small text-secondary flex-grow-1 mb-3"
               style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">
                ${sanitize(job.job_description) || "No description available."}
            </p>
            <div class="mt-auto d-flex gap-2">
                <a href="${sanitize(job.job_apply_link)}" target="_blank"
                   rel="noopener noreferrer"
                   class="btn btn-primary btn-sm rounded-3 w-100">
                    <i class="bi bi-box-arrow-up-right me-1"></i>Apply Now
                </a>
            </div>
        </div>
    </div>`;
}


// ─────────────────────────────────────────────
// 4. RESET
// ─────────────────────────────────────────────
function resetAnalyzer() {
    clearFile();
    document.getElementById("results-section").classList.add("d-none");
    document.getElementById("loading-bar").style.width = "0%";
    window.scrollTo({ top: 0, behavior: "smooth" });
}


// ─────────────────────────────────────────────
// 5. UTILS
// ─────────────────────────────────────────────
function sanitize(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

// ─────────────────────────────────────────────
// 6. RESUME BUILDER LOGIC
// ─────────────────────────────────────────────
function updateResumePreview() {
    document.getElementById("pv-name").innerText = document.getElementById("rb-name").value || "Your Name";
    document.getElementById("pv-contact").innerText = document.getElementById("rb-contact").value || "email@example.com | 123-456-7890";
    document.getElementById("pv-summary").innerText = document.getElementById("rb-summary").value || "Your summary goes here...";
    document.getElementById("pv-exp").innerText = document.getElementById("rb-exp").value || "- Your experience";
    document.getElementById("pv-skills").innerText = document.getElementById("rb-skills").value || "Skill 1, Skill 2";

    const tpl = document.getElementById("rb-template").value;
    const pane = document.getElementById("rb-preview-pane");

    pane.className = "bg-white p-4 shadow-sm flex-grow-1"; // reset
    if(tpl === "modern") {
        pane.style.borderTop = "8px solid var(--primary)";
        pane.style.borderLeft = "none";
        pane.style.fontFamily = "'Inter', sans-serif";
    } else if (tpl === "classic") {
        pane.style.borderTop = "1px solid #ccc";
        pane.style.borderLeft = "none";
        pane.style.fontFamily = "Georgia, serif";
    } else if (tpl === "creative") {
        pane.style.borderTop = "none";
        pane.style.borderLeft = "8px solid var(--accent)";
        pane.style.fontFamily = "'Inter', sans-serif";
    }
}