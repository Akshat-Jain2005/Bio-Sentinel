import hashlib
import hmac
import logging
import secrets
import time
from functools import partial
from fastapi import Depends, Header, HTTPException
from . import config as C
from . import sessions

log = logging.getLogger("bio.auth")


def _short(token):
    return hashlib.sha256(token.encode()).hexdigest()[:8]


def _email_allowed(email, hosted_domain=None):
    """True when the verified email matches the operator allowlist by exact
    address or by domain (an allowlist entry beginning with '@')."""
    email = (email or "").lower()
    if not email or not C.OPERATOR_ALLOWLIST:
        return False
    if email in C.OPERATOR_ALLOWLIST:
        return True
    # A matching email suffix alone does not prove Workspace membership.
    domain = email.rsplit("@", 1)[-1]
    return hosted_domain == domain and "@" + domain in C.OPERATOR_ALLOWLIST


def _verify_google(token):
    """Verify a Google ID token against our client id. Returns the claims dict,
    or None if the token is invalid / libraries are unavailable."""
    try:
        from google.oauth2 import id_token as g_id_token
        from google.auth.transport import requests as g_requests
        info = g_id_token.verify_oauth2_token(
            token, partial(g_requests.Request(), timeout=5), C.GOOGLE_CLIENT_ID
        )
        if not isinstance(info.get("sub"), str) or not info["sub"]:
            return None
        return info
    except Exception:  # Never log tokens or token-derived exception messages.
        log.warning("Google ID token verification failed")
        return None


def _public():
    return {"role": "public", "name": "anonymous", "id": None, "email": None}


def account_identity(record):
    """Role dict for an email/password account record. A provisioned staff
    account carries its role (operator/reporter) directly — its session is only
    ever minted through the MFA staff sign-in, so the stored role is trusted.
    Otherwise it is a citizen member, which rises to operator only when the
    account is operator-eligible (a password was bound while the email's
    ownership was proven via Google) AND the email is still on the operator
    allowlist by exact address — domain allowlist entries rely on Google's
    verified hosted domain, which a password account cannot present."""
    email = (record.get("email") or "").lower()
    name = record.get("name") or email or "Member"
    role = record.get("role")
    if role in ("operator", "reporter"):
        return {"role": role, "name": name, "id": "user:" + email, "email": email}
    operator = (bool(record.get("operator_eligible")) and bool(record.get("email_verified"))
                and _email_allowed(email))
    return {"role": "operator" if operator else "authenticated",
            "name": name, "id": "user:" + email, "email": email}


def _resolve_session(token):
    """Resolve an email/password session token to its live account identity.
    Invalid, expired, or orphaned tokens resolve to the public identity."""
    payload = sessions.verify(token)
    if not payload:
        return _public()
    from . import accounts  # local import keeps boto3 out of module import
    record = accounts.get_user(payload["sub"])
    if not record:
        return _public()
    return account_identity(record)


def current_user(authorization: str = Header(default="")):
    if authorization.startswith("Bearer "):
        token = authorization[7:].strip()
        if C.DEV_MODE and token in C.OPERATOR_TOKENS:
            return {"role": "operator", "name": C.OPERATOR_TOKENS[token], "id": _short(token), "email": None}
        if C.DEV_MODE and token in C.REPORTER_TOKENS:
            return {"role": "reporter", "name": C.REPORTER_TOKENS[token], "id": _short(token), "email": None}
        # Email/password session token minted at /auth/login or /auth/register.
        if sessions.is_session_token(token):
            return _resolve_session(token)
        # Not a dev or session token: try Google when configured and the token looks like a JWT.
        if C.GOOGLE_CLIENT_ID and token.count(".") == 2:
            info = _verify_google(token)
            if info:
                email = (info.get("email") or "").strip().lower()
                name = info.get("name") or email or "Google account"
                subject = info.get("sub")
                if not isinstance(subject, str) or not subject:
                    return {"role": "public", "name": "anonymous", "id": None, "email": None}
                # Stable across email changes; distinct accounts cannot approve
                # as each other through truncated email hashes.
                identity = "google:" + subject
                domain = email.rsplit("@", 1)[-1]
                authoritative = domain == "gmail.com" or info.get("hd") == domain
                is_op = bool(info.get("email_verified") is True and authoritative and _email_allowed(email, info.get("hd")))
                
                # Auto-create or update user record in backend store
                from . import accounts
                try:
                    user_rec = accounts.upsert_google_user(email, name, subject, operator_eligible=is_op)
                    if user_rec and user_rec.get("role") in ("operator", "reporter"):
                        role = user_rec["role"]
                    elif is_op:
                        role = "operator"
                    else:
                        role = "authenticated"
                except Exception as e:
                    log.warning("Failed to persist google user: %s", e)
                    role = "operator" if is_op else "authenticated"

                return {"role": role, "name": name, "id": identity, "email": email}
    return _public()


def require_operator(user=Depends(current_user)):
    if user["role"] == "public":
        raise HTTPException(401, "Login required")
    if user["role"] not in ("operator", "reporter"):
        raise HTTPException(403, "Operator or verified reporter access only")
    return user


logger = logging.getLogger(__name__)


def generate_and_send_otp(email):
    from .services.alerts import send_email

    otp = f"{secrets.randbelow(1_000_000):06d}"
    body = (
        f"Your Bio-Sentinel verification code is: {otp}\n\n"
        f"This code expires in {C.OTP_TTL_S // 60} minutes.\n\n"
        "Best regards,\n"
        "The Bio-Sentinel Team\n"
        "Secure. Reliable. Protected."
    )
    if not send_email(email, "Your Bio-Sentinel verification code", body):
        logger.error("OTP dispatch failed for %s", email)
        return None
    logger.info("OTP issued for %s", email)
    return {"otp": otp, "expires_at": time.time() + C.OTP_TTL_S, "attempts": 0}


def verify_otp(stored_record, input_otp):
    if not stored_record or not stored_record.get("otp"):
        return False, "No OTP requested"
    if time.time() > stored_record.get("expires_at", 0):
        return False, "OTP expired"
    if stored_record.get("attempts", 0) >= C.OTP_MAX_ATTEMPTS:
        return False, "Maximum attempts exceeded"

    stored_record["attempts"] = stored_record.get("attempts", 0) + 1
    if hmac.compare_digest(str(stored_record["otp"]), (input_otp or "").strip()):
        stored_record["otp"] = None
        stored_record["expires_at"] = 0
        return True, "OTP verified"

    remaining = C.OTP_MAX_ATTEMPTS - stored_record["attempts"]
    if remaining <= 0:
        return False, "Maximum attempts exceeded"
    return False, f"Invalid OTP ({remaining} attempts remaining)"
