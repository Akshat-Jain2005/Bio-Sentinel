import time
from fastapi import APIRouter, Depends, HTTPException, Request
from .. import config as C
from ..auth import current_user, require_operator
from ..schemas import ReportIn, ReportReview, PhotoUploadIn
from bio_sentinel_inference import STATION_METADATA, evaluate_telemetry
from ..services import incidents, photos, toxicity
from ..store import db

router = APIRouter()


def _public(r):
    return {k: r[k] for k in ("id", "created_at", "lat", "lng", "location_label", "source_type",
                              "ammonia_ppm", "ph", "temperature_c", "observations", "note", "severity", "reporter_type", "status", "station_id") if k in r}


def get_operator_or_dev(user=Depends(current_user)):
    if user["role"] in ("operator", "reporter"):
        return user
    if C.DEV_MODE:
        return {"role": "operator", "name": "Console Operator", "id": "dev-op", "email": "operator@bio-sentinel.local"}
    return require_operator(user)


def sync_approved_report_to_station(rec):
    station_id = rec.get("station_id")
    if not station_id and "lat" in rec and "lng" in rec:
        near_sid, dist = incidents.nearest_station(rec["lat"], rec["lng"])
        if dist <= C.STATION_ATTACH_RADIUS_KM:
            station_id = near_sid

    if station_id and station_id not in STATION_METADATA:
        if f"STATION_{station_id}" in STATION_METADATA:
            station_id = f"STATION_{station_id}"

    if not station_id or station_id not in STATION_METADATA:
        return None

    ammonia = rec.get("ammonia_ppm")
    ph = rec.get("ph")
    temp = rec.get("temperature_c") or 28.0

    ammonia_val = float(ammonia) if ammonia is not None else 0.45
    ph_val = float(ph) if ph is not None else 7.4
    temp_val = float(temp)

    tox = toxicity.assess(ammonia_val, ph_val, temp_val)
    obs = rec.get("observations") or []
    has_visual_distress = any(o in obs for o in ("dead_fish", "foam", "dark_color", "oil_sheen"))

    if tox["band"] in ("HIGH", "CRITICAL") or has_visual_distress:
        vel = 24.5
        depth = 42.0
        erratic = 38.0
    else:
        vel = 15.2
        depth = 78.5
        erratic = 8.5

    telemetry_data = {
        "station_id": station_id,
        "timestamp": int(time.time()),
        "chemical": {
            "ammonia_ppm": ammonia_val,
            "ph": ph_val,
            "temperature_c": temp_val,
            "dissolved_oxygen_mgl": 4.5 if tox["band"] != "SAFE" else 6.8,
            "tds_mgl": 650.0 if tox["band"] != "SAFE" else 380.0,
        },
        "biological": {
            "avg_velocity_mms": vel,
            "avg_depth_cm": depth,
            "erratic_index": erratic,
        }
    }

    result = evaluate_telemetry(telemetry_data)
    result["toxicity"] = tox
    now = int(time.time())

    with db.lock:
        db.history[station_id].append({
            "timestamp": now,
            "received_at": now,
            **telemetry_data["chemical"],
            **telemetry_data["biological"],
            "threat_level": result["threat_level"],
            "cellular": "4G-LTE",
            "battery_percent": 95,
            "verified_by_report_id": rec["id"],
        })
        db.stations[station_id] = {
            "status": result["threat_level"],
            "last_telemetry": telemetry_data,
            "last_result": result,
            "toxicity": tox,
            "updated_at": now,
            "verified_report": rec["id"],
        }
        db.save()

    inc = incidents.on_telemetry(station_id, result, tox)
    return {
        "station_id": station_id,
        "threat_level": result["threat_level"],
        "incident_id": inc["id"] if inc and inc["status"] != "CLOSED" else None
    }


@router.post("/reports/upload-url")
def upload_url(body: PhotoUploadIn, request: Request, user=Depends(current_user)):
    if not C.REPORT_PHOTO_BUCKET:
        raise HTTPException(503, "Photo storage is not configured. Submit without a photo or try later.")
    ip = request.client.host if request.client else "unknown"
    if db.rate_limited(f"photo:{ip}", 5, 3600):
        raise HTTPException(429, "Too many photo uploads. Try again later.")
    return photos.upload(body.content_type)


@router.post("/reports", status_code=201)
def submit_report(body: ReportIn, request: Request, user=Depends(current_user)):
    if body.photo_key and (not C.REPORT_PHOTO_BUCKET or not photos.KEY.fullmatch(body.photo_key)):
        raise HTTPException(422, "Invalid report photo reference")
    verified = user["role"] in ("reporter", "operator")
    ip = request.client.host if request.client else "unknown"
    if not verified and db.rate_limited(f"report:{ip}", 5, 3600):
        raise HTTPException(429, "Too many reports. Try again later.")

    station_id = body.station_id
    if not station_id:
        near_sid, dist = incidents.nearest_station(body.lat, body.lng)
        if dist <= C.STATION_ATTACH_RADIUS_KM:
            station_id = near_sid

    rec = {
        "id": db.new_id("rep"), "created_at": time.time(), "status": "pending",
        "station_id": station_id,
        "reporter_type": "verified" if verified else "citizen",
        "reporter_name": user["name"] if verified else None,
        "lat": body.lat, "lng": body.lng, "location_label": body.location_label,
        "source_type": body.source_type, "ammonia_ppm": body.ammonia_ppm, "ph": body.ph, "temperature_c": body.temperature_c,
        "observations": [o for o in body.observations if o in C.ALLOWED_OBSERVATIONS],
        "note": body.note, "photo_key": body.photo_key,
    }
    rec["severity"] = incidents.report_severity(rec)
    with db.lock:
        db.reports[rec["id"]] = rec
        db.save()
        try:
            inc = incidents.on_report(rec)
        except Exception:
            inc = None
    return {**_public(rec), "status": rec["status"], "incident_id": inc["id"] if inc else None}


@router.get("/reports")
def approved_reports(limit: int = 50, include_pending: bool = False):
    allowed_statuses = ("approved", "pending") if include_pending else ("approved",)
    rows = [r for r in db.reports.values() if r["status"] in allowed_statuses]
    rows.sort(key=lambda r: -r["created_at"])
    return [_public(r) for r in rows[:max(1, min(limit, 200))]]


@router.get("/reports/pending")
def pending_reports(user=Depends(require_operator)):
    rows = [r for r in db.reports.values() if r["status"] == "pending"]
    rows.sort(key=lambda r: -r["created_at"])
    return [{**r, "photo_url": photos.review_url(r.get("photo_key"))} for r in rows]


@router.patch("/reports/{report_id}")
def review_report(report_id: str, body: ReportReview, user=Depends(get_operator_or_dev)):
    rec = db.reports.get(report_id)
    if not rec and body.fallback_report:
        fb = body.fallback_report
        sid = fb.get("station_id")
        if not sid and "lat" in fb and "lng" in fb:
            near_sid, dist = incidents.nearest_station(fb["lat"], fb["lng"])
            if dist <= C.STATION_ATTACH_RADIUS_KM:
                sid = near_sid
        rec = {
            "id": report_id,
            "created_at": fb.get("created_at") or time.time(),
            "status": "pending",
            "station_id": sid,
            "reporter_type": fb.get("reporter_type") or "verified",
            "reporter_name": user.get("name") if user else "Citizen",
            "lat": fb.get("lat", 28.99),
            "lng": fb.get("lng", 77.02),
            "location_label": fb.get("location_label") or "Field Observation",
            "source_type": fb.get("source_type") or "drain_outfall",
            "ammonia_ppm": fb.get("ammonia_ppm"),
            "ph": fb.get("ph"),
            "temperature_c": fb.get("temperature_c") or 28.0,
            "observations": fb.get("observations") or [],
            "note": fb.get("note") or "",
        }
        with db.lock:
            db.reports[report_id] = rec

    if not rec:
        raise HTTPException(404, "Report not found")
    rec["status"] = "approved" if body.action == "approve" else "rejected"
    sync_res = None
    if rec["status"] == "approved":
        sync_res = sync_approved_report_to_station(rec)
    db.save()
    db.log_audit(user["name"], f"REPORT_{rec['status'].upper()}", {"report_id": report_id, "note": body.note, "station_synced": bool(sync_res)}, user["id"])
    return {
        "id": report_id,
        "status": rec["status"],
        "station_id": sync_res["station_id"] if sync_res else rec.get("station_id"),
        "station_updated": bool(sync_res)
    }
