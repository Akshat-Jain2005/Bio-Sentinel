"""Store with local disk persistence in development.
Every method here maps to a DynamoDB table in production:
telemetry, reports, incidents, subscribers, campaigns (ledger), alerts, audit."""
import json
import logging
import os
import threading
import time
import uuid
from collections import defaultdict, deque

log = logging.getLogger("bio.store")

_STORE_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".local_store.json"))


class Store:
    def __init__(self):
        self.reset()
        self._load()

    def reset(self):
        self.lock = threading.RLock()
        self.history = defaultdict(lambda: deque(maxlen=200))
        self.stations = {}
        self.reports = {}
        self.incidents = {}
        self.subscribers = {}
        self.otps = {}
        self.donations = {}
        self.ledger = []
        self.alerts = {}
        self.audit = []
        self.outbox = []
        self.rate = defaultdict(list)
        self.gate = {"intake_status": "OPEN", "last_actuation_timestamp": None}
        self.rules = {
            "operator_telegram_on_incident": True,
            "sms_on_shutdown": True,
            "all_clear_on_restore": True,
        }

    def _load(self):
        if not _STORE_FILE or not os.path.exists(_STORE_FILE):
            return
        try:
            with open(_STORE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            with self.lock:
                for sid, rows in data.get("history", {}).items():
                    self.history[sid] = deque(rows, maxlen=200)
                self.stations = data.get("stations", {})
                self.reports = data.get("reports", {})
                self.incidents = data.get("incidents", {})
                if "gate" in data:
                    self.gate = data["gate"]
        except Exception as e:
            log.warning("Could not read local store file: %s", e)

    def save(self):
        if not _STORE_FILE:
            return
        try:
            with self.lock:
                data = {
                    "history": {sid: list(rows) for sid, rows in self.history.items()},
                    "stations": self.stations,
                    "reports": self.reports,
                    "incidents": self.incidents,
                    "gate": self.gate,
                }
            with open(_STORE_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            log.warning("Could not write local store file: %s", e)

    def new_id(self, prefix):
        return f"{prefix}_{uuid.uuid4().hex[:8]}"

    def log_audit(self, actor, action, detail=None, actor_id=None):
        entry = {
            "audit_id": uuid.uuid4().hex[:8],
            "timestamp": int(time.time()),
            "actor": actor,
            "actor_id": actor_id,
            "action": action,
            "detail": detail or {},
        }
        with self.lock:
            self.audit.append(entry)
        return entry

    def rate_limited(self, key, limit, window_s):
        now = time.time()
        with self.lock:
            recent = [t for t in self.rate[key] if now - t < window_s]
            if len(recent) >= limit:
                self.rate[key] = recent
                return True
            recent.append(now)
            self.rate[key] = recent
            return False

    def put_otp(self, key, data):
        with self.lock:
            self.otps[key] = data

    def get_otp(self, key):
        with self.lock:
            return self.otps.get(key)


db = Store()
