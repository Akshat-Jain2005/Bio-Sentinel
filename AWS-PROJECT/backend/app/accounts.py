"""Email/password accounts, stored in Amazon DynamoDB (single-table design:
``pk = USER#<email>``, ``sk = META``).

Passwords are never stored in the clear. Each record keeps a per-user random
salt and a PBKDF2-HMAC-SHA256 derivation of the password; verification is a
constant-time compare. DynamoDB is required — there is no in-memory fallback —
so register/login need the table to exist (real AWS or DynamoDB Local; tests
use moto). The boto3 resource is created lazily so importing this module never
touches the network and the app stays importable without AWS configured.
"""
import hashlib
import hmac
import json
import logging
import os
import secrets
import time

import boto3
from botocore.exceptions import ClientError

from . import config as C

log = logging.getLogger("bio.accounts")

_PBKDF2_ROUNDS = 600_000
_PBKDF2_ALGO = "pbkdf2_sha256"

_resource = None

_USERS_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".local_users.json"))


def _load_local_users() -> dict:
    try:
        if os.path.exists(_USERS_FILE):
            with open(_USERS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        log.warning("Could not read local users file: %s", e)
    return {}


def _save_local_users() -> None:
    try:
        with open(_USERS_FILE, "w", encoding="utf-8") as f:
            json.dump(_local_users, f, indent=2)
    except Exception as e:
        log.warning("Could not write local users file: %s", e)


_local_users = _load_local_users()



class AccountError(Exception):
    """Base class for account-store errors."""


class UserExists(AccountError):
    """Raised when registering an email that already has an account."""


def _table():
    global _resource
    if _resource is None:
        opts = {"region_name": C.AWS_REGION}
        if C.DDB_ENDPOINT_URL:
            opts["endpoint_url"] = C.DDB_ENDPOINT_URL
        _resource = boto3.resource("dynamodb", **opts)
    return _resource.Table(C.DDB_TABLE_NAME)


def _norm(email: str) -> str:
    return (email or "").strip().lower()


def _pk(email: str) -> str:
    return "USER#" + _norm(email)


def hash_password(password: str, *, salt: str | None = None, rounds: int = _PBKDF2_ROUNDS) -> dict:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), rounds)
    return {"pw_algo": _PBKDF2_ALGO, "pw_rounds": rounds, "pw_salt": salt, "pw_hash": dk.hex()}


def verify_password(record: dict, password: str) -> bool:
    """Constant-time check of ``password`` against a stored account ``record``."""
    if not record:
        return False
    try:
        rounds = int(record["pw_rounds"])
        salt = record["pw_salt"]
        expected = record["pw_hash"]
    except (KeyError, TypeError, ValueError):
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), rounds)
    return hmac.compare_digest(dk.hex(), expected)


def get_user(email: str):
    """Return the account record for ``email``, or None."""
    norm = _norm(email)
    try:
        r = _table().get_item(Key={"pk": _pk(norm), "sk": "META"})
        item = r.get("Item")
        return dict(item) if item else None
    except Exception as e:
        log.warning("DynamoDB get_user failed (%s): %s", email, e)
    if norm in _local_users:
        return _local_users[norm]
    # Check disk file
    disk_users = _load_local_users()
    if norm in disk_users:
        _local_users[norm] = disk_users[norm]
        return disk_users[norm]
    return None


def create_user(email: str, name: str, password: str, *, phone: str = "", alt_phone: str = "") -> dict:
    """Create a new member account. Raises UserExists if the email is taken."""
    email = _norm(email)
    item = {
        "pk": _pk(email), "sk": "META",
        "email": email, "name": (name or "").strip() or email,
        "created_at": int(time.time()),
        "email_verified": False, "operator_eligible": False,
        **hash_password(password),
    }
    if phone:
        item["phone"] = phone
    if alt_phone:
        item["alt_phone"] = alt_phone

    try:
        _table().put_item(Item=item, ConditionExpression="attribute_not_exists(pk)")
        return item
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise UserExists(email)
        log.warning("DynamoDB put_item failed, persisting to local store: %s", e)
    except Exception as e:
        log.warning("DynamoDB put_item failed, persisting to local store: %s", e)

    if email in _local_users:
        raise UserExists(email)
    _local_users[email] = item
    _save_local_users()
    return item


def upsert_google_user(email: str, name: str, subject: str = "", *, operator_eligible: bool = False) -> dict:
    """Create or update an account record for a user authenticated via Google."""
    email = _norm(email)
    existing = get_user(email)
    now = int(time.time())
    if existing:
        existing["last_login"] = now
        if name and (not existing.get("name") or existing.get("name") == email):
            existing["name"] = name
        if subject and not existing.get("google_sub"):
            existing["google_sub"] = subject
        existing["operator_eligible"] = bool(operator_eligible)
        if operator_eligible:
            existing["role"] = "operator"
        elif existing.get("role") == "operator":
            existing["role"] = "citizen"
        try:
            _table().put_item(Item=existing)
        except Exception as e:
            log.warning("DynamoDB update google user failed: %s", e)
        _local_users[email] = existing
        _save_local_users()
        return existing

    item = {
        "pk": _pk(email),
        "sk": "META",
        "email": email,
        "name": (name or "").strip() or email,
        "created_at": now,
        "last_login": now,
        "email_verified": True,
        "auth_provider": "google",
        "google_sub": subject,
        "role": "operator" if operator_eligible else "citizen",
        "operator_eligible": bool(operator_eligible),
    }
    try:
        _table().put_item(Item=item)
    except Exception as e:
        log.warning("DynamoDB put_item failed for google user, persisting to local store: %s", e)
    _local_users[email] = item
    _save_local_users()
    return item


def set_password(email: str, name: str, password: str, *, operator_eligible: bool = False) -> dict:
    """Bind a password to ``email`` (create or overwrite the record). Marks the
    email verified; set ``operator_eligible`` when the caller's ownership of an
    operator email has already been proven (e.g. via Google sign-in)."""
    email = _norm(email)
    existing = get_user(email) or {}
    item = {
        "pk": _pk(email), "sk": "META",
        "email": email, "name": (name or existing.get("name") or "").strip() or email,
        "created_at": existing.get("created_at", int(time.time())),
        "email_verified": True,
        "operator_eligible": bool(operator_eligible) or bool(existing.get("operator_eligible")),
        **hash_password(password),
    }
    try:
        _table().put_item(Item=item)
        return item
    except Exception as e:
        log.warning("DynamoDB set_password failed, persisting to local store: %s", e)
    _local_users[email] = item
    _save_local_users()
    return item


def create_staff(email: str, name: str, password: str, role: str):
    """Provision an invite-only operator or reporter account with a password and
    a fresh TOTP secret. Upserts (re-provisioning rotates the password + secret).
    Returns (record, secret); callers show the secret / otpauth URI once."""
    if role not in ("operator", "reporter"):
        raise AccountError("role must be 'operator' or 'reporter'")
    from . import totp
    email = _norm(email)
    existing = get_user(email) or {}
    secret = totp.generate_secret()
    item = {
        "pk": _pk(email), "sk": "META",
        "email": email, "name": (name or existing.get("name") or "").strip() or email,
        "created_at": existing.get("created_at", int(time.time())),
        "role": role, "totp_secret": secret, "email_verified": True, "operator_eligible": False,
        **hash_password(password),
    }
    try:
        _table().put_item(Item=item)
        return item, secret
    except Exception as e:
        log.warning("DynamoDB create_staff failed, persisting to local store: %s", e)
    _local_users[email] = item
    _save_local_users()
    return item, secret

