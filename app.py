"""
app.py — JobPort Backend
Stack  : Flask + JSearch API (RapidAPI) + Supabase Auth + bcrypt
Security: JWT tokens, bcrypt password hashing, input validation
"""

import hashlib
import os, re, logging, secrets
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import requests
import bcrypt
import jwt
import sqlite3
import pyotp
import smtplib
from authlib.integrations.flask_client import OAuth
from flask import Flask, jsonify, request, send_from_directory, url_for, session
from flask_cors import CORS
from supabase import create_client
from dotenv import load_dotenv

# ─────────────────────────────────────────────
# 0. BOOT
# ─────────────────────────────────────────────
load_dotenv()

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": os.getenv("ALLOWED_ORIGIN", "*")}})

# ─────────────────────────────────────────────
# 1. CONSTANTS
# ─────────────────────────────────────────────
RAPIDAPI_KEY       = os.getenv("RAPIDAPI_KEY", "")
RAPIDAPI_HOST      = "jsearch.p.rapidapi.com"
JSEARCH_URL        = "https://jsearch.p.rapidapi.com/search-v2"

SUPABASE_URL         = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# JWT secret — auto-generated if not set (use a fixed secret in production!)
JWT_SECRET    = os.getenv("JWT_SECRET", secrets.token_hex(32))
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_H  = 24   # token valid for 24 hours

EMAIL_REGEX    = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
PASSWORD_REGEX = re.compile(r"^.{8,}$")   # min 8 chars (extend as needed)

SMTP_HOST      = os.getenv("SMTP_HOST", "")
SMTP_PORT      = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME  = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD  = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM      = os.getenv("SMTP_FROM", SMTP_USERNAME or "noreply@jobport.local")
SMTP_USE_TLS   = os.getenv("SMTP_USE_TLS", "true").lower() == "true"
SMTP_USE_SSL   = os.getenv("SMTP_USE_SSL", "false").lower() == "true"
SMTP_TIMEOUT   = int(os.getenv("SMTP_TIMEOUT", "10"))

app.secret_key = JWT_SECRET

oauth = OAuth(app)
google = oauth.register(
    name='google',
    client_id=os.getenv('GOOGLE_CLIENT_ID'),
    client_secret=os.getenv('GOOGLE_CLIENT_SECRET'),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'}
)

# ─────────────────────────────────────────────
# 2. SUPABASE CLIENT
# ─────────────────────────────────────────────
def get_supabase():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        logger.warning("Supabase credentials missing.")
        return None
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

supabase = get_supabase()

# ─────────────────────────────────────────────
# 2.5 SQLITE FOR ALL DB NEEDS
# ─────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect("local_apps.db")
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  first_name TEXT,
                  last_name TEXT,
                  email TEXT UNIQUE,
                  password_hash TEXT,
                  totp_secret TEXT,
                  google_id TEXT,
                  reset_token TEXT,
                  reset_token_expires_at TEXT)''')
    try:
        c.execute("ALTER TABLE users ADD COLUMN totp_secret TEXT")
    except:
        pass
    try:
        c.execute("ALTER TABLE users ADD COLUMN google_id TEXT")
    except:
        pass
    try:
        c.execute("ALTER TABLE users ADD COLUMN reset_token TEXT")
    except:
        pass
    try:
        c.execute("ALTER TABLE users ADD COLUMN reset_token_expires_at TEXT")
    except:
        pass
    c.execute('''CREATE TABLE IF NOT EXISTS applications
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id TEXT,
                  user_email TEXT,
                  job_title TEXT,
                  education TEXT,
                  projects TEXT,
                  status TEXT DEFAULT 'Applied',
                  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    conn.commit()
    conn.close()

init_db()

def get_db():
    conn = sqlite3.connect("local_apps.db", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

# ─────────────────────────────────────────────
# 3. JWT HELPERS
# ─────────────────────────────────────────────
def create_token(user_id: str, email: str, mfa_verified: bool = True) -> str:
    payload = {
        "sub":          user_id,
        "email":        email,
        "mfa_verified": mfa_verified,
        "iat":          datetime.now(timezone.utc),
        "exp":          datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_H),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def get_current_user():
    """Extract and verify JWT from Authorization header."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth.split(" ", 1)[1]
    payload = verify_token(token)
    if not payload:
        return None
    if payload.get("mfa_verified", True) is False:
        return None
    return payload


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def send_reset_email(to_email: str, reset_url: str) -> bool:
    smtp_host = os.getenv("SMTP_HOST", "")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_username = os.getenv("SMTP_USERNAME", "")
    smtp_password = os.getenv("SMTP_PASSWORD", "")
    smtp_from = os.getenv("SMTP_FROM", smtp_username or "noreply@jobport.local")
    smtp_use_tls = os.getenv("SMTP_USE_TLS", "true").lower() == "true"
    smtp_use_ssl = os.getenv("SMTP_USE_SSL", "false").lower() == "true"
    smtp_timeout = int(os.getenv("SMTP_TIMEOUT", "10"))

    if not smtp_host:
        logger.warning("SMTP_HOST is not configured. Password reset email was not sent.")
        return False

    message = EmailMessage()
    message["Subject"] = "Reset your JobPort password"
    message["From"] = smtp_from
    message["To"] = to_email
    message.set_content(
        f"Hi,\n\n"
        f"You requested a password reset for your JobPort account.\n"
        f"Use the link below to set a new password:\n\n"
        f"{reset_url}\n\n"
        f"If you did not request this, you can ignore this email.\n"
    )

    server = None
    try:
        if smtp_use_ssl:
            server = smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=smtp_timeout)
        else:
            server = smtplib.SMTP(smtp_host, smtp_port, timeout=smtp_timeout)

        if smtp_use_tls and not smtp_use_ssl:
            server.starttls()

        if smtp_username and smtp_password:
            server.login(smtp_username, smtp_password)

        server.send_message(message)
        server.quit()
        return True
    except Exception as exc:
        logger.error("Password reset email send failed: %s", exc)
        try:
            if server is not None:
                server.quit()
        except Exception:
            pass
        return False


# ─────────────────────────────────────────────
# 4. BLUEPRINTS
# ─────────────────────────────────────────────
from resume_analyzer import resume_bp
app.register_blueprint(resume_bp)

# ─────────────────────────────────────────────
# 5. SERVE FRONTEND
# ─────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/login")
def login_page():
    return send_from_directory(".", "login.html")

@app.route("/signup")
def signup_page():
    return send_from_directory(".", "signup.html")

@app.route("/resume")
def resume_page():
    return send_from_directory(".", "resume.html")

@app.route("/reset-password")
def reset_password_page():
    return send_from_directory(".", "reset_password.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(".", filename)

# ─────────────────────────────────────────────
# 5. AUTH — POST /api/auth/signup
# ─────────────────────────────────────────────
@app.route("/api/auth/signup", methods=["POST"])
def signup():
    """
    Register a new user.
    """
    body       = request.get_json(silent=True) or {}
    first_name = body.get("first_name", "").strip()
    last_name  = body.get("last_name",  "").strip()
    email      = body.get("email",      "").strip().lower()
    password   = body.get("password",   "")

    if not first_name or not last_name:
        return jsonify({"error": "Full name is required."}), 400
    if not EMAIL_REGEX.match(email):
        return jsonify({"error": "Invalid email address."}), 400
    if not PASSWORD_REGEX.match(password):
        return jsonify({"error": "Password must be at least 8 characters."}), 400

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT id FROM users WHERE email=?", (email,))
        if c.fetchone():
            conn.close()
            return jsonify({"error": "An account with this email already exists."}), 409

        hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
        totp_secret = pyotp.random_base32()
        c.execute("INSERT INTO users (first_name, last_name, email, password_hash, totp_secret) VALUES (?, ?, ?, ?, ?)",
                  (first_name, last_name, email, hashed, totp_secret))
        user_id = c.lastrowid
        conn.commit()
        conn.close()

        token = create_token(str(user_id), email)
        logger.info("Signup: %r", email)
        return jsonify({
            "token": token,
            "totp_secret": totp_secret,
            "user":  {
                "id":         user_id,
                "first_name": first_name,
                "last_name":  last_name,
                "email":      email,
            }
        }), 201
    except Exception as exc:
        logger.error("Signup error: %s", exc)
        return jsonify({"error": "Signup failed. Please try again."}), 500


# ─────────────────────────────────────────────
# 6. AUTH — POST /api/auth/login
# ─────────────────────────────────────────────
@app.route("/api/auth/login", methods=["POST"])
def login():
    body     = request.get_json(silent=True) or {}
    email    = body.get("email",    "").strip().lower()
    password = body.get("password", "")

    if not email or not password:
        return jsonify({"error": "Email and password are required."}), 400

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT id, first_name, last_name, email, password_hash, totp_secret FROM users WHERE email=?", (email,))
        user_row = c.fetchone()
        conn.close()

        if not user_row:
            return jsonify({"error": "Invalid email or password."}), 401

        user = dict(user_row)
        # If user registered via Google only and has no password, deny standard login
        if not user.get("password_hash") or not bcrypt.checkpw(password.encode(), user["password_hash"].encode()):
            return jsonify({"error": "Invalid email or password."}), 401

        logger.info("Login pre-2FA: %r", email)

        if user.get("totp_secret"):
            temp_token = create_token(str(user["id"]), email, mfa_verified=False)
            return jsonify({
                "requires_2fa": True,
                "temp_token": temp_token
            }), 200

        token = create_token(str(user["id"]), email, mfa_verified=True)
        return jsonify({
            "token": token,
            "user":  {
                "id":         user["id"],
                "first_name": user["first_name"],
                "last_name":  user["last_name"],
                "email":      user["email"],
            }
        }), 200

    except Exception as exc:
        logger.error("Login error: %s", exc)
        return jsonify({"error": "Login failed. Please try again."}), 500


@app.route("/api/auth/forgot-password", methods=["POST"])
def forgot_password():
    body = request.get_json(silent=True) or {}
    email = body.get("email", "").strip().lower()

    if not EMAIL_REGEX.match(email):
        return jsonify({"error": "Please enter a valid email address."}), 400

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT id FROM users WHERE email=?", (email,))
        user_row = c.fetchone()

        if user_row:
            token = secrets.token_urlsafe(32)
            reset_url = f"{request.host_url}reset-password?token={token}"
            if not send_reset_email(email, reset_url):
                conn.close()
                return jsonify({"error": "Password reset email could not be sent right now."}), 503

            expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
            c.execute(
                "UPDATE users SET reset_token=?, reset_token_expires_at=? WHERE id=?",
                (hash_token(token), expires_at.isoformat(), user_row["id"]),
            )
            conn.commit()
            conn.close()
            return jsonify({
                "message": "If an account exists, a password reset link has been sent to your email."
            }), 200

        conn.close()
        return jsonify({
            "message": "If an account exists, a password reset link has been sent to your email."
        }), 200
    except Exception as exc:
        logger.error("Forgot password error: %s", exc)
        return jsonify({"error": "Unable to process password reset right now."}), 500


@app.route("/api/auth/reset-password", methods=["POST"])
def reset_password():
    body = request.get_json(silent=True) or {}
    token = body.get("token", "").strip()
    new_password = body.get("new_password", "")

    if not token or not new_password:
        return jsonify({"error": "Missing reset token or new password."}), 400

    if not PASSWORD_REGEX.match(new_password):
        return jsonify({"error": "Password must be at least 8 characters."}), 400

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute(
            "SELECT id, reset_token_expires_at FROM users WHERE reset_token=?",
            (hash_token(token),),
        )
        user_row = c.fetchone()

        if not user_row:
            conn.close()
            return jsonify({"error": "Reset link is invalid or has expired."}), 400

        expires_at = datetime.fromisoformat(user_row["reset_token_expires_at"])
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)

        if datetime.now(timezone.utc) > expires_at:
            conn.close()
            return jsonify({"error": "Reset link is invalid or has expired."}), 400

        hashed = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt(rounds=12)).decode()
        c.execute(
            "UPDATE users SET password_hash=?, reset_token=NULL, reset_token_expires_at=NULL WHERE id=?",
            (hashed, user_row["id"]),
        )
        conn.commit()
        conn.close()
        return jsonify({"message": "Password updated successfully."}), 200
    except Exception as exc:
        logger.error("Reset password error: %s", exc)
        return jsonify({"error": "Unable to reset password right now."}), 500


@app.route("/api/auth/verify-2fa", methods=["POST"])
def verify_2fa():
    body = request.get_json(silent=True) or {}
    temp_token = body.get("temp_token", "")
    code = body.get("code", "").strip()

    payload = verify_token(temp_token)
    if not payload:
        return jsonify({"error": "Session expired. Log in again."}), 401

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT * FROM users WHERE id=?", (payload["sub"],))
        user_row = c.fetchone()
        conn.close()

        if not user_row or not user_row["totp_secret"]:
            return jsonify({"error": "2FA not configured for this account."}), 400

        user = dict(user_row)
        totp = pyotp.TOTP(user["totp_secret"])
        if totp.verify(code):
            token = create_token(str(user["id"]), user["email"], mfa_verified=True)
            return jsonify({
                "token": token,
                "user": {
                    "id": user["id"],
                    "first_name": user["first_name"],
                    "last_name": user["last_name"],
                    "email": user["email"]
                }
            }), 200
        else:
            return jsonify({"error": "Invalid 2FA code."}), 401
    except Exception as exc:
        logger.error("2FA verify error: %s", exc)
        return jsonify({"error": "Verification failed."}), 500


# ─────────────────────────────────────────────
# 7. AUTH — GET /api/auth/me
# ─────────────────────────────────────────────
@app.route("/api/auth/me", methods=["GET"])
def get_me():
    """Return the currently logged-in user's profile."""
    payload = get_current_user()
    if not payload:
        return jsonify({"error": "Unauthorized."}), 401

    return jsonify({"user_id": payload["sub"], "email": payload["email"]}), 200


# ─────────────────────────────────────────────
# 8. ROUTE — GET /api/search  (JSearch proxy)
# ─────────────────────────────────────────────
def jsearch_headers():
    return {
        "x-rapidapi-key":  RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
        "Content-Type":    "application/json",
    }

def normalize_job(job):
    salary_min = job.get("job_min_salary")
    salary_max = job.get("job_max_salary")
    currency   = job.get("job_salary_currency", "")
    salary_str = ""
    if salary_min and salary_max:
        salary_str = f"{currency} {int(salary_min):,} – {int(salary_max):,}"
    elif salary_min:
        salary_str = f"{currency} {int(salary_min):,}+"
    return {
        "job_id":              job.get("job_id", ""),
        "job_title":           job.get("job_title", "Unknown Title"),
        "employer_name":       job.get("employer_name", "Unknown Company"),
        "employer_logo":       job.get("employer_logo"),
        "job_city":            job.get("job_city", ""),
        "job_country":         job.get("job_country", ""),
        "job_employment_type": job.get("job_employment_type", ""),
        "job_apply_link":      job.get("job_apply_link", "#"),
        "job_description":     (job.get("job_description") or "")[:300],
        "job_posted_at":       job.get("job_posted_at_datetime_utc", ""),
        "salary":              salary_str,
    }

@app.route("/api/search", methods=["GET"])
def search_jobs():
    if not RAPIDAPI_KEY:
        return jsonify({"error": "RAPIDAPI_KEY not configured."}), 503

    query    = request.args.get("query",    "").strip()
    location = request.args.get("location", "").strip()

    if not query:
        return jsonify({"error": "'query' parameter is required."}), 400

    full_query = f"{query} in {location}" if location else query

    try:
        resp = requests.get(
            JSEARCH_URL,
            headers=jsearch_headers(),
            params={"query": full_query, "num_pages": "1", "date_posted": "all"},
            timeout=10,
        )
        resp.raise_for_status()

        data_field = resp.json().get("data", {})
        if isinstance(data_field, dict):
            raw_jobs = data_field.get("jobs", [])
        else:
            raw_jobs = data_field if isinstance(data_field, list) else []

        jobs = [normalize_job(j) for j in raw_jobs]
        logger.info("GET /api/search → %d jobs", len(jobs))
        return jsonify({"jobs": jobs, "count": len(jobs)}), 200

    except requests.exceptions.Timeout:
        return jsonify({"error": "Job search timed out."}), 502
    except requests.exceptions.HTTPError as exc:
        code = exc.response.status_code if exc.response else 502
        if code == 429:
            return jsonify({"error": "Rate limit reached. Please retry."}), 429
        return jsonify({"error": f"API error ({code})."}), 502
    except Exception as exc:
        logger.error("search_jobs error: %s", exc)
        return jsonify({"error": "Unexpected error."}), 500


# ─────────────────────────────────────────────
# 9. ROUTE — POST /api/apply  (protected)
# ─────────────────────────────────────────────
@app.route("/api/apply", methods=["POST"])
def apply_to_job():
    """
    Save a job application.
    PROTECTED — requires valid JWT in Authorization header.
    """
    # Verify JWT
    payload = get_current_user()
    if not payload:
        return jsonify({"error": "Please log in to apply for jobs."}), 401

    body      = request.get_json(silent=True) or {}
    job_title = body.get("job_title", "").strip()
    education = body.get("education", "").strip()
    projects  = body.get("projects", "").strip()

    if not job_title:
        return jsonify({"error": "job_title is required."}), 400

    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT id FROM applications WHERE user_id=? AND job_title=?", (payload["sub"], job_title))
        if c.fetchone():
            conn.close()
            return jsonify({"error": "You already applied for this job."}), 409
            
        c.execute("INSERT INTO applications (user_id, user_email, job_title, education, projects) VALUES (?, ?, ?, ?, ?)",
                  (payload["sub"], payload["email"], job_title, education, projects))
        conn.commit()
        conn.close()

        # Backward compatibility with existing supabase
        if supabase:
            try:
                supabase.table("applications").insert({
                    "user_id":    payload["sub"],
                    "user_email": payload["email"],
                    "job_title":  job_title,
                }).execute()
            except Exception as e:
                logger.warning(f"Supabase sync failed (ignoring): {e}")

        logger.info("Apply: %r → %r", payload["email"], job_title)
        return jsonify({"message": "Application submitted successfully."}), 201

    except Exception as exc:
        logger.error("Apply error: %s", exc)
        return jsonify({"error": "Failed to save application."}), 500

# ─────────────────────────────────────────────
# 9.5 DASHBOARD ROUTES
# ─────────────────────────────────────────────
@app.route("/api/applications", methods=["GET"])
def get_user_applications():
    payload = get_current_user()
    if not payload:
        return jsonify({"error": "Please log in."}), 401
    
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT * FROM applications WHERE user_id=? ORDER BY applied_at DESC", (payload["sub"],))
        rows = c.fetchall()
        conn.close()
        return jsonify({"applications": [dict(r) for r in rows]}), 200
    except Exception as exc:
        logger.error("Get apps error: %s", exc)
        return jsonify({"error": "Failed to fetch applications."}), 500

@app.route("/api/hr/applications", methods=["GET"])
def get_all_applications():
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT * FROM applications ORDER BY applied_at DESC")
        rows = c.fetchall()
        conn.close()
        return jsonify({"applications": [dict(r) for r in rows]}), 200
    except Exception as exc:
        logger.error("HR apps error: %s", exc)
        return jsonify({"error": "Failed to fetch applications."}), 500

@app.route("/api/hr/applications/<int:app_id>/status", methods=["PUT"])
def update_application_status(app_id):
    body = request.get_json(silent=True) or {}
    status = body.get("status", "").strip()
    if not status:
        return jsonify({"error": "Status required."}), 400
        
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("UPDATE applications SET status=? WHERE id=?", (status, app_id))
        conn.commit()
        conn.close()
        return jsonify({"message": "Status updated."}), 200
    except Exception as exc:
        logger.error("HR update status error: %s", exc)
        return jsonify({"error": "Failed to update status."}), 500


# ─────────────────────────────────────────────
# ─────────────────────────────────────────────
# 10. GOOGLE OAUTH
# ─────────────────────────────────────────────
@app.route("/api/auth/google", methods=["GET"])
def google_oauth_url():
    """
    Returns the Google OAuth redirect URL.
    Frontend opens this URL to start Google login flow.
    """
    if not os.getenv("GOOGLE_CLIENT_ID") or not os.getenv("GOOGLE_CLIENT_SECRET"):
        return jsonify({"error": "Google Auth is not configured on the server."}), 503

    redirect_uri = os.getenv("GOOGLE_REDIRECT_URL") or url_for('google_auth_callback', _external=True)
    authorization = google.create_authorization_url(redirect_uri)
    state = authorization.get("state")
    session['oauth_state'] = state
    return jsonify({"url": authorization.get("url")}), 200


@app.route("/api/auth/google/callback")
def google_auth_callback():
    """
    Google redirects here after login.
    """
    try:
        state = session.pop('oauth_state', None)
        if state and request.args.get('state') != state:
            return jsonify({"error": "Invalid Google OAuth state."}), 400

        token = google.authorize_access_token()
        user_info = token.get('userinfo')
        if not user_info:
            return "Error fetching Google user profile", 400

        email = user_info['email']
        google_id = user_info['sub']
        first_name = user_info.get('given_name', '')
        last_name = user_info.get('family_name', '')

        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT id, first_name, last_name, email, totp_secret FROM users WHERE email=?", (email,))
        user_row = c.fetchone()

        if not user_row:
            c.execute("INSERT INTO users (first_name, last_name, email, password_hash, google_id) VALUES (?, ?, ?, ?, ?)",
                      (first_name, last_name, email, "", google_id))
            user_id = c.lastrowid
        else:
            user_id = user_row["id"]
            c.execute("UPDATE users SET google_id=? WHERE id=?", (google_id, user_id))
            first_name = user_row["first_name"]
            last_name = user_row["last_name"]

        conn.commit()
        conn.close()

        jwt_token = create_token(str(user_id), email, mfa_verified=True)

        return f"""
        <html><body><script>
        const user = {{ id: "{user_id}", first_name: "{first_name}", last_name: "{last_name}", email: "{email}" }};
        sessionStorage.setItem("jp_token", "{jwt_token}");
        sessionStorage.setItem("jp_user", JSON.stringify(user));
        window.location.href = "/";
        </script></body></html>
        """
    except Exception as exc:
        logger.error("Google OAuth callback error: %s", exc)
        return f"Google Login Failed: {str(exc)}", 500


# ─────────────────────────────────────────────
# 11. ERROR HANDLERS
# ─────────────────────────────────────────────
@app.errorhandler(404)
def not_found(_):
    return jsonify({"error": "Endpoint not found."}), 404

@app.errorhandler(405)
def method_not_allowed(_):
    return jsonify({"error": "HTTP method not allowed."}), 405

# ─────────────────────────────────────────────
# 11. ENTRY POINT
# ─────────────────────────────────────────────
if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", 5000)),
        debug=os.getenv("FLASK_DEBUG", "false").lower() == "true",
    )