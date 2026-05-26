"""
resume_analyzer.py — Resume Analysis Route Extension
Add this to your existing app.py or run standalone.
Stack: Flask + pdfminer.six + python-docx + Google Gemini AI + JSearch
"""

import os
import io
import re
import json
import logging
import requests

from flask import Blueprint, request, jsonify
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

# ── Blueprint (attach to your existing Flask app) ──
resume_bp = Blueprint("resume", __name__)

# ── Constants ──
MAX_FILE_SIZE_MB  = 5
MAX_FILE_SIZE_B   = MAX_FILE_SIZE_MB * 1024 * 1024
ALLOWED_EXTS      = {".pdf", ".docx", ".doc", ".txt"}

GEMINI_API_KEY    = os.getenv("GEMINI_API_KEY", "")
GEMINI_URL        = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"

RAPIDAPI_KEY      = os.getenv("RAPIDAPI_KEY", "")
RAPIDAPI_HOST     = "jsearch.p.rapidapi.com"
JSEARCH_URL       = "https://jsearch.p.rapidapi.com/search-v2"


# ════════════════════════════════════════════════
# TEXT EXTRACTORS
# ════════════════════════════════════════════════

def extract_pdf(file_bytes: bytes) -> str:
    from pdfminer.high_level import extract_text_to_fp
    from pdfminer.layout import LAParams
    output = io.StringIO()
    extract_text_to_fp(
        io.BytesIO(file_bytes),
        output,
        laparams=LAParams(),
        output_type="text",
        codec="utf-8",
    )
    return output.getvalue().strip()


def extract_docx(file_bytes: bytes) -> str:
    from docx import Document
    doc = Document(io.BytesIO(file_bytes))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    # Also grab text from tables
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                if cell.text.strip():
                    paragraphs.append(cell.text.strip())
    return "\n".join(paragraphs)


def extract_txt(file_bytes: bytes) -> str:
    for encoding in ("utf-8", "latin-1", "cp1252"):
        try:
            return file_bytes.decode(encoding).strip()
        except UnicodeDecodeError:
            continue
    return file_bytes.decode("utf-8", errors="replace").strip()


def extract_text(filename: str, file_bytes: bytes) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".pdf":
        return extract_pdf(file_bytes)
    elif ext in (".docx", ".doc"):
        return extract_docx(file_bytes)
    elif ext == ".txt":
        return extract_txt(file_bytes)
    else:
        raise ValueError(f"Unsupported file type: {ext}")


# ════════════════════════════════════════════════
# GEMINI AI ANALYSIS
# ════════════════════════════════════════════════

ANALYSIS_PROMPT = """
You are an expert ATS (Applicant Tracking System) resume reviewer and career coach.

Analyze the resume text below and return a JSON object with EXACTLY these fields:
{{
  "score": <integer 0-100, ATS compatibility score>,
  "score_label": <"Poor" | "Fair" | "Good" | "Excellent">,
  "feedback": [
    "<specific actionable bullet point 1>",
    "<specific actionable bullet point 2>",
    "<specific actionable bullet point 3>",
    "<specific actionable bullet point 4>",
    "<specific actionable bullet point 5>"
  ],
  "strengths": [
    "<strength 1>",
    "<strength 2>",
    "<strength 3>"
  ],
  "suggested_templates": {{
    "primary": "<Chronological | Functional | Hybrid | Creative>",
    "reason": "<one sentence why this template fits>",
    "alternatives": ["<template2>", "<template3>"]
  }},
  "search_keywords": "<3-5 top technical skills as a comma-separated string, e.g. Python, React, AWS>",
  "job_titles": ["<best matching job title 1>", "<best matching job title 2>"],
  "experience_level": "<Entry | Mid | Senior | Lead | Executive>"
}}

IMPORTANT:
- Return ONLY the JSON object, no markdown, no explanation, no code fences.
- Make feedback specific and actionable, not generic.
- search_keywords must be technical skills only (not soft skills).

Resume text:
{resume_text}
"""


def analyze_with_gemini(resume_text: str) -> dict:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set in .env")

    # Truncate very long resumes to avoid token limits
    truncated = resume_text[:8000] if len(resume_text) > 8000 else resume_text

    prompt = ANALYSIS_PROMPT.format(resume_text=truncated)

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature":     0.2,
            "maxOutputTokens": 1024,
        },
    }

    response = requests.post(
        f"{GEMINI_URL}?key={GEMINI_API_KEY}",
        json=payload,
        timeout=30,
    )
    response.raise_for_status()

    raw = response.json()
    text = raw["candidates"][0]["content"]["parts"][0]["text"].strip()

    # Strip any accidental markdown fences
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$",          "", text).strip()

    return json.loads(text)


# ════════════════════════════════════════════════
# JSEARCH JOB FETCH
# ════════════════════════════════════════════════

def fetch_matching_jobs(keywords: str, count: int = 6) -> list:
    if not RAPIDAPI_KEY:
        return []

    try:
        resp = requests.get(
            JSEARCH_URL,
            headers={
                "x-rapidapi-key":  RAPIDAPI_KEY,
                "x-rapidapi-host": RAPIDAPI_HOST,
                "Content-Type":    "application/json",
            },
            params={
                "query":       keywords,
                "num_pages":   "1",
                "date_posted": "all",
            },
            timeout=10,
        )
        resp.raise_for_status()

        data_field = resp.json().get("data", {})
        raw_jobs   = data_field.get("jobs", []) if isinstance(data_field, dict) else data_field

        jobs = []
        for job in raw_jobs[:count]:
            salary_min = job.get("job_min_salary")
            salary_max = job.get("job_max_salary")
            currency   = job.get("job_salary_currency", "")
            salary_str = ""
            if salary_min and salary_max:
                salary_str = f"{currency} {int(salary_min):,}–{int(salary_max):,}"

            jobs.append({
                "job_title":           job.get("job_title", ""),
                "employer_name":       job.get("employer_name", ""),
                "employer_logo":       job.get("employer_logo"),
                "job_city":            job.get("job_city", ""),
                "job_country":         job.get("job_country", ""),
                "job_employment_type": job.get("job_employment_type", ""),
                "job_apply_link":      job.get("job_apply_link", "#"),
                "job_description":     (job.get("job_description") or "")[:200],
                "salary":              salary_str,
            })
        return jobs

    except Exception as exc:
        logger.warning("JSearch fetch failed: %s", exc)
        return []


# ════════════════════════════════════════════════
# ROUTE — POST /api/analyze
# ════════════════════════════════════════════════

@resume_bp.route("/api/analyze", methods=["POST"])
def analyze_resume():
    """
    Accepts a resume file, extracts text, runs AI analysis,
    and returns matching jobs.

    Form data:
        file  — resume file (.pdf / .docx / .doc / .txt)

    Returns 200:
    {
        "score":               85,
        "score_label":         "Good",
        "feedback":            [...],
        "strengths":           [...],
        "suggested_templates": {...},
        "search_keywords":     "Python, FastAPI, AWS",
        "job_titles":          [...],
        "experience_level":    "Mid",
        "matching_jobs":       [...]
    }
    """
    # ── File presence check ──
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded. Please select a resume file."}), 400

    file = request.files["file"]

    if not file.filename:
        return jsonify({"error": "No file selected."}), 400

    # ── Extension check ──
    ext = os.path.splitext(secure_filename(file.filename))[1].lower()
    if ext not in ALLOWED_EXTS:
        return jsonify({
            "error": f"Invalid file format '{ext}'. Allowed: PDF, DOCX, DOC, TXT."
        }), 415

    # ── Size check ──
    file_bytes = file.read()
    if len(file_bytes) > MAX_FILE_SIZE_B:
        return jsonify({
            "error": f"File too large. Maximum size is {MAX_FILE_SIZE_MB} MB."
        }), 413

    # ── Text extraction ──
    try:
        resume_text = extract_text(file.filename, file_bytes)
    except Exception as exc:
        logger.error("Text extraction failed: %s", exc)
        return jsonify({"error": f"Could not read file: {str(exc)}"}), 422

    if len(resume_text.strip()) < 50:
        return jsonify({
            "error": "Resume appears to be empty or unreadable. Please try a different file."
        }), 422

    # ── AI analysis ──
    try:
        analysis = analyze_with_gemini(resume_text)
    except json.JSONDecodeError:
        return jsonify({"error": "AI returned invalid response. Please try again."}), 502
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503
    except Exception as exc:
        logger.error("Gemini error: %s", exc)
        return jsonify({"error": "AI analysis failed. Please try again later."}), 502

    # ── Fetch matching jobs ──
    keywords     = analysis.get("search_keywords", "")
    matching_jobs = fetch_matching_jobs(keywords) if keywords else []

    logger.info(
        "Resume analyzed — score=%s keywords=%r jobs=%d",
        analysis.get("score"), keywords, len(matching_jobs)
    )

    return jsonify({**analysis, "matching_jobs": matching_jobs}), 200