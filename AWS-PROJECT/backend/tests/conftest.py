import os
import sys

os.environ["DEV_MODE"] = "1"
os.environ["USE_AWS_SNS"] = "0"  # keep SNS off during tests even if .env enables it
# Blank the SNS topic ARNs so publish_to_topic stays a no-op in tests (it records
# to db.outbox whenever an ARN is set, regardless of USE_AWS_SNS).
os.environ["SNS_TOPIC_ARN_OPERATORS"] = ""
os.environ["SNS_TOPIC_ARN_CITIZENS"] = ""
# Blank Razorpay keys so payments stay in mock mode and signatures use the dev
# secret, even when real test keys live in backend/.env.
os.environ["RAZORPAY_KEY_ID"] = ""
os.environ["RAZORPAY_KEY_SECRET"] = ""
os.environ["RAZORPAY_WEBHOOK_SECRET"] = ""
# Keep Google sign-in inert by default so tests don't depend on a real client id;
# the Google-auth test sets these explicitly via monkeypatch.
os.environ["GOOGLE_CLIENT_ID"] = ""
os.environ["OPERATOR_ALLOWLIST"] = ""
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.store import db

OP1 = {"Authorization": "Bearer dev-operator-1"}
OP2 = {"Authorization": "Bearer dev-operator-2"}
REPORTER = {"Authorization": "Bearer dev-reporter"}


@pytest.fixture(autouse=True)
def fresh_store(monkeypatch, tmp_path):
    from app import store
    monkeypatch.setattr(store, "_STORE_FILE", None)
    db.reset()
    from app import accounts
    monkeypatch.setattr(accounts, "_USERS_FILE", str(tmp_path / ".test_users.json"))
    monkeypatch.setattr(accounts, "_local_users", {})
    yield


@pytest.fixture
def client():
    return TestClient(app)


def telemetry(station="STATION_02_PANIPAT", toxic=False):
    bio = ({"avg_velocity_mms": 38.0, "avg_depth_cm": 12.0, "erratic_index": 90.0} if toxic
           else {"avg_velocity_mms": 15.0, "avg_depth_cm": 80.0, "erratic_index": 10.0})
    return {"station_id": station, "timestamp": 1728412800,
            "chemical": {"ammonia_ppm": 0.36, "ph": 7.4, "temperature_c": 32.0}, "biological": bio}


def subscribe_and_verify(client, phone="9876543210", ward="Civil Lines", language="en"):
    r = client.post("/subscribe", json={"phone": phone, "ward": ward, "language": language, "consent": True})
    code = r.json()["dev_otp"]
    return client.post("/subscribe/verify", json={"phone": phone, "code": code})
