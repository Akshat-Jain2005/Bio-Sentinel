import hmac
import logging
import re
import time
import requests
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from bio_sentinel_inference import STATION_METADATA, evaluate_telemetry
from .. import config as C
from ..auth import require_operator, current_user
from ..schemas import TelemetryPayload
from ..services import incidents, toxicity
from ..store import db

router = APIRouter()
log = logging.getLogger("bio.map")

# Only tile requests carry the Location key in the style descriptor; the backend
# proxies them so the key stays server-side. Sprites and glyphs are keyless/public.
_KEY_QS = re.compile(r"[?&]key=[^&]*")


def _als_base():
    return f"https://maps.geo.{C.AWS_REGION}.amazonaws.com"


@router.get("/auth/config")
def auth_config(response: Response):
    """Public: the Google OAuth client id the operator console signs in with.
    Served from the backend so the SPA needs no rebuild to pick up the id."""
    response.headers["Cache-Control"] = "no-store"
    return {"google_client_id": C.GOOGLE_CLIENT_ID, "dev_login_enabled": C.DEV_MODE,
            "password_login_enabled": bool(C.SESSION_SECRET),
            "registration_enabled": bool(C.SESSION_SECRET),
            "staff_login_enabled": bool(C.SESSION_SECRET)}


@router.get("/me")
def me(response: Response, user=Depends(current_user)):
    """Resolve the caller's identity and role for the console's auth state."""
    response.headers["Cache-Control"] = "no-store"
    return {"role": user["role"], "name": user["name"], "email": user.get("email"), "id": user["id"]}


@router.post("/telemetry")
def ingest_telemetry(payload: TelemetryPayload, x_api_key: str = Header(default="")):
    if C.SENSOR_API_KEY and not hmac.compare_digest(x_api_key, C.SENSOR_API_KEY):
        raise HTTPException(401, "Invalid sensor key")
    sid = payload.station_id
    if sid not in STATION_METADATA:
        raise HTTPException(404, "Unknown station")
    data = payload.model_dump()
    result = evaluate_telemetry(data)
    chem = data["chemical"]
    tox = toxicity.assess(chem["ammonia_ppm"], chem["ph"], chem["temperature_c"])
    result["toxicity"] = tox
    fc = result.get("arrival_forecast") or {}
    if fc.get("predicted_intake_ammonia_ppm") is not None:  # assumes today's heat and pH persist downstream
        fc["predicted_intake_unionized_mgl"] = round(
            fc["predicted_intake_ammonia_ppm"] * tox["unionized_fraction"], 4)
    now = int(time.time())
    with db.lock:
        db.history[sid].append({
            "timestamp": payload.timestamp, "received_at": now,
            **data["chemical"], **data["biological"], "threat_level": result["threat_level"],
        })
        db.stations[sid] = {"status": result["threat_level"], "last_telemetry": data,
                            "last_result": result, "toxicity": tox, "updated_at": now}
        db.save()
    inc = incidents.on_telemetry(sid, result, tox)
    return {**result, "incident_id": inc["id"] if inc and inc["status"] != "CLOSED" else None}


@router.get("/telemetry/{station_id}")
def telemetry_history(station_id: str, limit: int = 50):
    if station_id not in STATION_METADATA:
        raise HTTPException(404, "Unknown station")
    rows = list(db.history[station_id])[-max(1, min(limit, 200)):]
    return {"station_id": station_id, "readings": rows}


@router.get("/status")
def public_status():
    """Public dashboard data. No controls, no audit trail."""
    now = time.time()
    # Tally recent non-rejected community reports in the last 24h per station
    recent_reports_by_station = {}
    for r in db.reports.values():
        if r.get("status") == "rejected":
            continue
        if now - r.get("created_at", 0) > 86400:
            continue
        sid = r.get("station_id")
        if not sid and "lat" in r and "lng" in r:
            near_sid, dist = incidents.nearest_station(r["lat"], r["lng"])
            if dist <= C.STATION_ATTACH_RADIUS_KM:
                sid = near_sid
        if sid:
            recent_reports_by_station.setdefault(sid, []).append(r)

    stations = []
    for sid, meta in STATION_METADATA.items():
        s = db.stations.get(sid, {})
        tox = s.get("toxicity") or {}
        st_reports = recent_reports_by_station.get(sid, [])
        latest_rep = None
        if st_reports:
            st_reports.sort(key=lambda x: -x["created_at"])
            latest = st_reports[0]
            latest_rep = {
                "id": latest["id"],
                "created_at": latest["created_at"],
                "observations": latest.get("observations", []),
                "ammonia_ppm": latest.get("ammonia_ppm"),
                "ph": latest.get("ph"),
                "severity": latest.get("severity", "green"),
                "status": latest.get("status", "pending"),
            }

        stations.append({
            "station_id": sid, "name": meta["name"], "distance_km": meta["distance_km"], "status": s.get("status", "NORMAL"),
            "unionized_ammonia_mgl": tox.get("unionized_ammonia_mgl"),
            "toxicity_band": tox.get("band", "SAFE"),
            "coords": C.STATION_COORDS.get(sid),
            "updated_at": s.get("updated_at"),
            "community_reports_count": len(st_reports),
            "latest_report": latest_rep,
        })
    open_incs = [incidents.incident_view(i) for i in db.incidents.values() if i["status"] != "CLOSED"]
    top = max(open_incs, key=lambda i: incidents.LEVEL_RANK[i["level"]], default=None)
    summary = None
    if top:
        summary = {k: top[k] for k in ("station_id", "level", "anomaly_type", "confidence", "t_minus_seconds")}
    return {
        "overall": incidents.overall_status(),
        "stations": stations,
        "incident": summary,
        "intake_status": db.gate["intake_status"],
        "total_community_reports": sum(len(v) for v in recent_reports_by_station.values()),
        **incidents.deficit_view()
    }


@router.get("/stations")
def corridor(user=Depends(require_operator)):
    out = []
    for sid, meta in STATION_METADATA.items():
        s = db.stations.get(sid, {})
        out.append({"station_id": sid, "name": meta["name"], "distance_km": meta["distance_km"],
                    "coords": C.STATION_COORDS.get(sid), "status": s.get("status", "NORMAL"),
                    "last_telemetry": s.get("last_telemetry"), "last_result": s.get("last_result")})
    return {"stations": out, "gate_state": db.gate, **incidents.deficit_view(),
            "incidents": [incidents.incident_view(i) for i in db.incidents.values() if i["status"] != "CLOSED"]}


@router.get("/incidents")
def list_incidents(user=Depends(require_operator)):
    return [incidents.incident_view(i) for i in sorted(db.incidents.values(), key=lambda i: -i["opened_at"])]


@router.post("/incidents/{incident_id}/close")
def close(incident_id: str, user=Depends(require_operator)):
    inc = incidents.close_incident(incident_id, user["name"], user["id"])
    if not inc:
        raise HTTPException(404, "Incident not found or already closed")
    return incidents.incident_view(inc)


@router.get("/map-config")
def get_map_config(request: Request):
    """Client configuration for Amazon Location Service V2 map rendering.

    The API key is NEVER returned. style_url points at this backend's descriptor
    proxy, which injects the key server-side and rewrites tile URLs through the
    tile proxy, so the key never reaches the browser or any client."""
    base = str(request.base_url)  # e.g. http://host:port/
    return {
        "region": C.AWS_REGION,
        "style": C.LOCATION_MAP_STYLE,
        "style_url": f"{base}map/style/{C.LOCATION_MAP_STYLE}/descriptor",
    }


def _rewrite_tile_url(url, base):
    """Point a Location tiles template at our keyless tile proxy, preserving the
    {z}/{x}/{y} tokens and the tileset path (e.g. .../v2/tiles/vector.basemap/..)."""
    marker = "/v2/tiles/"
    path = url.split("?", 1)[0]
    idx = path.find(marker)
    if idx != -1:
        return f"{base}map/tiles/{path[idx + len(marker):]}"
    return _KEY_QS.sub("", url)


def _scrub_key(obj):
    """Belt-and-braces: strip any ?key=/&key= query from every string left in the
    descriptor, so the key cannot leak even if Location adds it somewhere new."""
    key = C.LOCATION_API_KEY
    if not key:
        return
    items = obj.items() if isinstance(obj, dict) else enumerate(obj) if isinstance(obj, list) else ()
    for k, v in items:
        if isinstance(v, str):
            if key in v:
                obj[k] = _KEY_QS.sub("", v)
        elif isinstance(v, (dict, list)):
            _scrub_key(v)


@router.get("/map/style/{style}/descriptor")
def get_map_descriptor(style: str, request: Request):
    """Server-side proxy for the Location V2 style descriptor. Fetches it with
    the key, rewrites tile URLs through the keyless tile proxy, and strips any
    residual key before returning the style JSON to the client."""
    if not C.LOCATION_API_KEY:
        raise HTTPException(503, "Map service not configured")
    try:
        resp = requests.get(f"{_als_base()}/v2/styles/{style}/descriptor",
                            params={"key": C.LOCATION_API_KEY}, timeout=10)
    except requests.RequestException as exc:
        log.error("Location descriptor fetch failed: %s", exc)
        raise HTTPException(502, "Map descriptor upstream error")
    if resp.status_code == 403:
        raise HTTPException(502, "Map key lacks geo-maps permissions")
    if not resp.ok:
        raise HTTPException(502, f"Map descriptor upstream {resp.status_code}")

    descriptor = resp.json()
    base = str(request.base_url)
    for src in (descriptor.get("sources") or {}).values():
        if isinstance(src, dict) and isinstance(src.get("tiles"), list):
            src["tiles"] = [_rewrite_tile_url(u, base) for u in src["tiles"]]
    _scrub_key(descriptor)
    return descriptor


@router.get("/map/tiles/{tileset}/{z}/{x}/{y}")
def get_map_tile(tileset: str, z: int, x: int, y: int):
    """Server-side proxy for Location V2 vector tiles. The key is injected here
    and never exposed; clients fetch keyless tiles from this endpoint."""
    if not C.LOCATION_API_KEY:
        raise HTTPException(503, "Map service not configured")
    try:
        resp = requests.get(f"{_als_base()}/v2/tiles/{tileset}/{z}/{x}/{y}",
                            params={"key": C.LOCATION_API_KEY}, timeout=10)
    except requests.RequestException as exc:
        log.error("Location tile fetch failed: %s", exc)
        raise HTTPException(502, "Map tile upstream error")
    if not resp.ok:
        raise HTTPException(resp.status_code if resp.status_code in (403, 404) else 502,
                            "Map tile upstream error")
    # requests transparently decodes any gzip, so send decoded bytes without a
    # stale Content-Encoding; content-type is the vector-tile protobuf type.
    return Response(content=resp.content,
                    media_type=resp.headers.get("Content-Type", "application/x-protobuf"),
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/river-health/{stretch_id}")
def get_river_health_path(stretch_id: str = "yamuna-panipat",
                          hours: int = Query(default=24, ge=1, le=168)):
    """RFC 7946 GeoJSON FeatureCollection of river reaches between consecutive
    stations (hydrological order), each coloured by its upstream incident within
    the last `hours` hours (default 24, max 168).

    GIS note: STATION_COORDS are (lat, lng); GeoJSON requires [lng, lat], so
    every point is inverted to [coord[1], coord[0]]."""
    window_s = hours * 3600
    features = []
    stations = list(C.STATION_COORDS.keys())

    for i in range(len(stations) - 1):
        from_st, to_st = stations[i], stations[i + 1]
        from_lat, from_lng = C.STATION_COORDS[from_st]
        to_lat, to_lng = C.STATION_COORDS[to_st]

        inc = incidents.most_severe_within(from_st, window_s)
        if inc:
            lvl = inc.get("level", "NORMAL")
            status = "CRITICAL" if lvl == "CRITICAL_LEVEL_3" else "WARNING"
        else:
            status = "NORMAL"

        features.append({
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [[from_lng, from_lat], [to_lng, to_lat]],
            },
            "properties": {
                "stretch_id": stretch_id,
                "from_node": from_st,
                "to_node": to_st,
                "health_status": status,
                "incident_id": inc["id"] if inc else None,
                "threat_level": inc["level"] if inc else "NORMAL",
            },
        })

    return {"type": "FeatureCollection", "features": features}
