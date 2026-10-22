"""
Tests for the plume ETA model improvements.

Covers:
  - estimate_river_velocity() clamping, monotonicity, uncertainty ratio
  - STATION_METADATA distances are strictly decreasing (physically plausible)
  - ST_02_PANIPAT distance is no longer the erroneous 18.5 km value
  - arrival_forecast exposes eta_range_hours
  - ETA shortens when the sensor reports faster fish movement
"""
import pytest
from bio_sentinel_inference import (
    STATION_METADATA,
    RIVER_V_MIN_KMH,
    RIVER_V_MAX_KMH,
    estimate_river_velocity,
    evaluate_telemetry,
)
from conftest import OP1, telemetry


# ── velocity helper ──────────────────────────────────────────────────────────

def test_velocity_clamps_to_minimum():
    v, _ = estimate_river_velocity(0.0)
    assert v == RIVER_V_MIN_KMH, "Dead-still sensor must clamp to physical floor"


def test_velocity_clamps_to_maximum():
    v, _ = estimate_river_velocity(999_999.0)
    assert v == RIVER_V_MAX_KMH, "Runaway sensor value must clamp to physical ceiling"


def test_velocity_is_monotone():
    """Higher fish velocity -> higher estimated river velocity (before clamping).
    Note: values < 167 mm/s all clamp to the floor; use values in the non-clamped
    range (167-2000 mm/s) to test monotonicity."""
    v_slow, _ = estimate_river_velocity(334.0)   # ~2 km/h river
    v_fast, _ = estimate_river_velocity(668.0)   # ~4 km/h river
    assert v_slow < v_fast


def test_uncertainty_is_30_pct():
    v, u = estimate_river_velocity(15.0)
    assert abs(u / v - 0.30) < 1e-9, "Uncertainty band must be exactly 30 %"


def test_uncertainty_positive_for_all_inputs():
    for mms in (0.0, 5.0, 15.0, 30.0, 999.0):
        _, u = estimate_river_velocity(mms)
        assert u > 0, f"Uncertainty must be positive at {mms} mm/s"


# ── station distance sanity ──────────────────────────────────────────────────

def test_station_distances_strictly_decreasing():
    """Each station must be further from Wazirabad than the next one downstream.

    River order: ST_01 -> ST_02 -> ST_03 -> ST_04 -> ST_05 (Wazirabad).
    Distances must be strictly decreasing.
    """
    ids = list(STATION_METADATA.keys())
    dists = [STATION_METADATA[s]["distance_km"] for s in ids]
    for i in range(len(dists) - 1):
        assert dists[i] > dists[i + 1], (
            f"Station order violated: {ids[i]} ({dists[i]} km) "
            f"is not further than {ids[i+1]} ({dists[i+1]} km)"
        )


def test_st02_panipat_distance_is_plausible():
    """ST_02 is physically near ST_01 (both in Panipat); the old 18.5 km value
    was wrong -- it was even closer than Palla (16.5 km), which is impossible."""
    dist = STATION_METADATA["STATION_02_PANIPAT"]["distance_km"]
    assert dist > 50.0, (
        f"ST_02_PANIPAT distance {dist} km is implausibly short; "
        "it should be close to ST_01 (~68 km), not near Palla (~16 km)"
    )


def test_wazirabad_is_zero():
    assert STATION_METADATA["STATION_05_WAZIRABAD"]["distance_km"] == 0.0


# ── ETA propagates into forecast ─────────────────────────────────────────────

def test_eta_range_present_in_result():
    t = telemetry("STATION_01_PANIPAT", toxic=True)
    r = evaluate_telemetry(t)
    fc = r["arrival_forecast"]
    assert "eta_range_hours" in fc, "arrival_forecast must include eta_range_hours"
    lo, hi = fc["eta_range_hours"]
    est = fc["estimated_hours_to_wazirabad"]
    assert lo <= est <= hi, (
        f"Point estimate {est} h must lie within range [{lo}, {hi}] h"
    )


def test_eta_range_is_ordered():
    """Lower bound must never exceed upper bound."""
    for sid in STATION_METADATA:
        r = evaluate_telemetry(telemetry(sid, toxic=False))
        lo, hi = r["arrival_forecast"]["eta_range_hours"]
        assert lo <= hi, f"ETA range inverted at {sid}: [{lo}, {hi}]"


def test_eta_uses_sensor_velocity(client):
    """Faster fish-school signal -> shorter estimated travel time to intake.
    Uses values well above the velocity floor (167 mm/s) so both readings
    produce distinct un-clamped velocities."""
    slow = telemetry()
    slow["biological"]["avg_velocity_mms"] = 334.0   # ~2 km/h river
    fast = telemetry()
    fast["biological"]["avg_velocity_mms"] = 668.0   # ~4 km/h river

    eta_slow = client.post("/telemetry", json=slow).json()["arrival_forecast"][
        "estimated_hours_to_wazirabad"
    ]
    eta_fast = client.post("/telemetry", json=fast).json()["arrival_forecast"][
        "estimated_hours_to_wazirabad"
    ]
    assert eta_fast < eta_slow, (
        f"Faster fish ({fast['biological']['avg_velocity_mms']} mm/s) should give "
        f"shorter ETA ({eta_fast} h) than slower fish ({eta_slow} h)"
    )


def test_velocity_uncertainty_surfaced(client):
    """velocity_uncertainty_kmh must be present and non-zero."""
    r = client.post("/telemetry", json=telemetry()).json()
    fc = r["arrival_forecast"]
    assert "velocity_uncertainty_kmh" in fc
    assert fc["velocity_uncertainty_kmh"] > 0
