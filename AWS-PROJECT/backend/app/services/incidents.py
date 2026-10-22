import math
import re
import time
from .. import config as C
from ..store import db
from . import notify, llm
from . import notify, toxicity
# pyrefly: ignore [missing-import]
from bio_sentinel_inference import STATION_METADATA

LEVEL_RANK = {"NORMAL": 0, "ELEVATED_LEVEL_1": 1, "WARNING_LEVEL_2": 2, "CRITICAL_LEVEL_3": 3}


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def nearest_station(lat, lng):
    best = min(C.STATION_COORDS.items(), key=lambda kv: haversine_km(lat, lng, *kv[1]))
    return best[0], haversine_km(lat, lng, *best[1])


def report_severity(r):
    pts = 0
    a, ph = r.get("ammonia_ppm"), r.get("ph")
    if a is not None:
        pts += 3 if a >= 3.0 else 2 if a >= 0.9 else 0
        if r.get("ph") is not None:  # heat-aware: warm, alkaline water makes the same ammonia deadlier
            temp = r.get("temperature_c") or C.DEFAULT_WATER_TEMP_C
            uia = toxicity.unionized_ammonia(a, r["ph"], temp)
            pts = max(pts, 3 if uia >= C.UIA_DANGER_MGL else 2 if uia >= C.UIA_WATCH_MGL else 0)
    if ph is not None and (ph < 6.5 or ph > 8.5):
        pts += 1
    pts += min(len(set(r.get("observations", [])) & C.BAD_OBSERVATIONS), 3)
    return "red" if pts >= 3 else "amber" if pts >= 1 else "green"


def report_weight(r):
    return 1.0 if r["reporter_type"] == "verified" else 0.5


def forecast_for(station_id, result=None):
    if result and result.get("arrival_forecast"):
        return result["arrival_forecast"]
    dist = STATION_METADATA.get(station_id, {}).get("distance_km", 0.0)
    # Delegate to the same velocity model used by the sensor path (15 mm/s = calm Yamuna baseline)
    from bio_sentinel_inference import estimate_river_velocity
    v, _ = estimate_river_velocity(15.0)
    return {
        "river_velocity_kmh": v,
        "distance_km": dist,
        "estimated_hours_to_wazirabad": round(dist / v, 1) if dist else 0.0,
        "predicted_intake_ammonia_ppm": None,
    }



def open_incident_for(station_id):
    for inc in db.incidents.values():
        if inc["station_id"] == station_id and inc["status"] in ("OPEN", "ACKNOWLEDGED"):
            return inc
    return None


def most_severe_within(station_id, window_s):
    """Most severe incident at a station with activity in the last window_s
    seconds, open or recently resolved. `last_seen` tracks the last unhealthy
    reading, so an incident whose last activity predates the window is treated
    as past and ignored (returns None). Used by the river-health map so its
    `hours` selector actually bounds which incidents colour each reach."""
    cutoff = time.time() - window_s
    recent = [i for i in db.incidents.values()
              if i["station_id"] == station_id and i.get("last_seen", 0) >= cutoff]
    return max(recent, key=lambda i: LEVEL_RANK.get(i["level"], 0), default=None)


def _static_operator_alert(station_id, level, anomaly_type, incident_id, hours):
    return (
        f"🚨 <b>BIO-SENTINEL RIVER DEFENSE ALERT</b>\n\n"
        f"<b>Station:</b> <code>{station_id}</code>\n"
        f"<b>Threat Level:</b> <b>{level}</b>\n"
        f"<b>Diagnosis:</b> {anomaly_type}\n"
        f"<b>Incident ID:</b> <code>{incident_id}</code>\n"
        f"<b>Plume Arrival:</b> ~{hours} hrs to Wazirabad Intake\n\n"
        f"⚠️ <i>Action: Review operator console and prepare intake gate actuation.</i>"
    )


_DOC_TAGS = re.compile(r"<!doctype|</?(?:html|head|body|style|script|div|p|span|ul|ol|li|br|table)\b", re.I)
_FENCE = re.compile(r"```[a-zA-Z]*\n?|```")


def _sanitize_telegram_html(msg):
    """Keep only Telegram-safe inline HTML. Strips markdown code fences and
    rejects any full-document / block-level markup (returns "" so the caller
    falls back to the static template rather than send unrenderable HTML)."""
    if not msg:
        return ""
    cleaned = _FENCE.sub("", msg).strip()
    if _DOC_TAGS.search(cleaned):
        return ""
    return cleaned


def _operator_alert_text(station_id, level, anomaly_type, incident_id, hours):
    """High-urgency Telegram SITREP for the Chief Engineer. Uses Bedrock when
    USE_AI_ALERTS is on and the call succeeds, else the static template."""
    if C.USE_AI_ALERTS:
        system_prompt = (
            "You are the Bio-Sentinel AI alerting the Chief Engineer. "
            "You output a single Telegram alert message and nothing else. "
            "Telegram supports ONLY these inline HTML tags: <b>, <i>, <code>, <a>. "
            "NEVER emit document tags (<!DOCTYPE>, <html>, <head>, <body>, "
            "<style>, <script>, <div>, <p>), CSS, or markdown code fences. "
            "Keep it under 500 characters."
        )
        user_prompt = (
            f"A river contamination incident has been detected.\n"
            f"Station: {station_id}\n"
            f"Threat level: {level}\n"
            f"Anomaly type: {anomaly_type}\n"
            f"Incident ID: {incident_id}\n"
            f"Estimated hours for the plume to reach the Wazirabad intake: {hours}\n\n"
            f"Write a short, high-urgency situation report. Use a few emojis and "
            f"only <b>/<i>/<code> for emphasis. Advise immediate review of the "
            f"operator console and the intake gates. Return only the message text."
        )
        msg = _sanitize_telegram_html(llm.invoke_claude(system_prompt, user_prompt))
        if msg and msg not in (llm.MOCK_RESPONSE, llm.FALLBACK_RESPONSE):
            return msg
    return _static_operator_alert(station_id, level, anomaly_type, incident_id, hours)


def _raise(station_id, source, level, anomaly_type, forecast, report_id=None):
    now = int(time.time())
    created = False
    with db.lock:
        inc = open_incident_for(station_id)
        if inc is None:
            created = True
            inc = {
                "id": db.new_id("inc"), "station_id": station_id, "status": "OPEN",
                "level": level, "anomaly_type": anomaly_type, "sources": [],
                "report_ids": [], "opened_at": now, "last_seen": now,
                "forecast": forecast, "normal_streak": 0,
            }
            db.incidents[inc["id"]] = inc
        if source not in inc["sources"]:
            inc["sources"].append(source)
        if report_id and report_id not in inc["report_ids"]:
            inc["report_ids"].append(report_id)
        inc["last_seen"], inc["normal_streak"] = now, 0
        if LEVEL_RANK[level] > LEVEL_RANK[inc["level"]]:
            inc["level"], inc["anomaly_type"] = level, anomaly_type
    if created:
        db.log_audit("system", "INCIDENT_OPENED", {"incident_id": inc["id"], "station_id": station_id, "source": source})
        if db.rules["operator_telegram_on_incident"]:
            hours = forecast.get("estimated_hours_to_wazirabad", "N/A")
            msg = _operator_alert_text(station_id, level, anomaly_type, inc["id"], hours)
            notify.send_telegram(msg)
        notify.alert_operators(
            f"Bio-Sentinel: {level}",
            f"Incident {inc['id']}: {anomaly_type} detected at {station_id}. Threat level: {level}.",
        )
    return inc


def on_telemetry(station_id, result, tox=None):
    if result["anomaly_detected"] and LEVEL_RANK.get(result["threat_level"], 0) >= 2:
        return _raise(station_id, "sensor", result["threat_level"], result["anomaly_type"],
                      forecast_for(station_id, result))
    if tox and tox["band"] == "DANGEROUS":
        # Total ammonia may be under the legal limit, but heat and pH make it toxic.
        return _raise(station_id, "sensor", "WARNING_LEVEL_2", "HEAT_AMMONIA_TOXICITY",
                      forecast_for(station_id, result))
    inc = open_incident_for(station_id)
    if inc and result["threat_level"] == "NORMAL" and "reports" not in inc["sources"]:
        inc["normal_streak"] += 1
        if inc["normal_streak"] >= C.AUTOCLOSE_NORMAL_READINGS:
            close_incident(inc["id"], "system", None)
    return inc


def on_report(rep):
    if rep["severity"] != "red" or rep["status"] == "rejected":
        return None
    station_id, dist = nearest_station(rep["lat"], rep["lng"])
    existing = open_incident_for(station_id)
    if existing and dist <= C.STATION_ATTACH_RADIUS_KM:
        return _raise(station_id, "reports", existing["level"], existing["anomaly_type"],
                      existing["forecast"], rep["id"])
    now = time.time()
    weight = 0.0
    for other in db.reports.values():
        if other["status"] == "rejected" or other["severity"] != "red":
            continue
        if now - other["created_at"] > C.CLUSTER_WINDOW_S:
            continue
        if haversine_km(rep["lat"], rep["lng"], other["lat"], other["lng"]) <= C.CLUSTER_RADIUS_KM:
            weight += report_weight(other)
    if weight >= C.CLUSTER_MIN_WEIGHT:
        return _raise(station_id, "reports", "WARNING_LEVEL_2", "FIELD_REPORT_CLUSTER",
                      forecast_for(station_id), rep["id"])
    return None


def close_incident(incident_id, actor, actor_id):
    inc = db.incidents.get(incident_id)
    if not inc or inc["status"] == "CLOSED":
        return None
    inc["status"], inc["closed_at"] = "CLOSED", int(time.time())
    db.log_audit(actor, "INCIDENT_CLOSED", {"incident_id": incident_id}, actor_id)
    return inc


def confidence(inc):
    s = set(inc["sources"])
    if {"sensor", "reports"} <= s:
        return "CONFIRMED"
    if s == {"reports"}:
        return "UNVERIFIED_SEND_INSPECTOR"
    return "SENSOR_ALERT"


def incident_view(inc):
    hours = inc["forecast"].get("estimated_hours_to_wazirabad") or 0.0
    eta = inc["opened_at"] + int(hours * 3600)
    return {**inc, "confidence": confidence(inc), "eta_timestamp": eta,
            "t_minus_seconds": max(0, eta - int(time.time()))}


def overall_status():
    open_incs = [i for i in db.incidents.values() if i["status"] in ("OPEN", "ACKNOWLEDGED")]
    if db.gate["intake_status"] != "OPEN" or any(LEVEL_RANK[i["level"]] >= 3 for i in open_incs):
        return "ALERT"
    if open_incs or any(s.get("status", "NORMAL") != "NORMAL" for s in db.stations.values()):
        return "WATCH"
    return "NORMAL"


def deficit_view():
    on = db.gate["intake_status"] != "OPEN"
    return {
        "deficit_mgd": C.DEFICIT_MGD if on else 0,
        "rationing": [{"ward": w, "schedule": s} for w, s in C.WARD_SCHEDULES.items()] if on else [],
    }
