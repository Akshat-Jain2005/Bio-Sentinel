from fastapi.testclient import TestClient
from app.main import app
from app import config as C
from app.services import photos, payments, notify

client = TestClient(app)


def test_photo_upload_requires_config(monkeypatch):
    monkeypatch.setattr(C, "REPORT_PHOTO_BUCKET", "")
    assert client.post('/reports/upload-url', json={"content_type": "image/jpeg"}).status_code == 503


def test_photo_upload_bounded_and_private(monkeypatch):
    monkeypatch.setattr(C, "REPORT_PHOTO_BUCKET", "private-reports")
    calls = []

    class S3:
        def generate_presigned_post(self, **kwargs):
            calls.append(kwargs)
            return {"url": "https://example.invalid", "fields": {"key": kwargs["Key"]}}

    monkeypatch.setattr(photos, "client", lambda: S3())
    result = client.post('/reports/upload-url', json={"content_type": "image/png"})
    assert result.status_code == 200
    assert result.json()['photo_key'].endswith('.png')
    assert calls[0]['ExpiresIn'] == 300
    assert ['content-length-range', 1, 5 * 1024 * 1024] in calls[0]['Conditions']
    assert 'acl' not in calls[0]['Fields']
    assert client.post('/reports/upload-url', json={"content_type": "text/html"}).status_code == 422


def test_unconfigured_production_services_fail_closed(monkeypatch):
    monkeypatch.setattr(C, "DEV_MODE", False)
    monkeypatch.setattr(C, "RAZORPAY_KEY_ID", "")
    monkeypatch.setattr(C, "RAZORPAY_KEY_SECRET", "")
    monkeypatch.setattr(C, "RAZORPAY_WEBHOOK_SECRET", "")
    monkeypatch.setattr(C, "USE_AWS_SNS", False)
    assert client.post('/donations/order', json={"amount_inr": 499, "donor_email": "test@example.com"}).status_code == 503
    assert not payments.signature_ok('order', 'payment', '')
    assert not payments.webhook_signature_ok(b'{}', 'forged')
    assert client.post('/subscribe', json={"phone": "9876543210", "ward": "Civil Lines", "consent": True}).status_code == 503


def test_failed_sms_does_not_claim_otp_sent(monkeypatch):
    monkeypatch.setattr(notify, 'send_sms', lambda *args: False)
    result = client.post('/subscribe', json={"phone": "9876543210", "ward": "Civil Lines", "consent": True})
    assert result.status_code == 502


def test_station_report_updates_dashboard_status():
    from app.store import db
    db.reset()

    # Initial status
    s0 = client.get('/status').json()
    assert s0['total_community_reports'] == 0
    st0 = next(s for s in s0['stations'] if s['station_id'] == 'STATION_03_SONIPAT')
    assert st0['community_reports_count'] == 0
    assert st0['latest_report'] is None

    # Submit report for Sonipat station
    res = client.post('/reports', json={
        "lat": 28.99,
        "lng": 77.02,
        "station_id": "STATION_03_SONIPAT",
        "location_label": "Sonipat Drain",
        "source_type": "drain_outfall",
        "ammonia_ppm": 2.5,
        "observations": ["foam", "dark_color"],
        "note": "Industrial froth observed near drain"
    })
    assert res.status_code == 201
    rep = res.json()
    assert rep['station_id'] == 'STATION_03_SONIPAT'
    assert rep['status'] == 'pending'

    # Check that GET /status is updated immediately
    s1 = client.get('/status').json()
    assert s1['total_community_reports'] == 1
    st1 = next(s for s in s1['stations'] if s['station_id'] == 'STATION_03_SONIPAT')
    assert st1['community_reports_count'] == 1
    assert st1['latest_report'] is not None
    assert st1['latest_report']['id'] == rep['id']
    assert "foam" in st1['latest_report']['observations']
    assert st1['latest_report']['status'] == 'pending'

    # GET /reports default returns only approved
    assert client.get('/reports').json() == []
    # GET /reports?include_pending=true returns it
    pending = client.get('/reports?include_pending=true').json()
    assert len(pending) == 1
    assert pending[0]['id'] == rep['id']

    # Station has no telemetry yet
    t0 = client.get('/telemetry/STATION_03_SONIPAT').json()
    assert len(t0['readings']) == 0

    # Approve report: this should sync data to Sonipat station
    patch_res = client.patch(f"/reports/{rep['id']}", json={"action": "approve"})
    assert patch_res.status_code == 200
    patch_data = patch_res.json()
    assert patch_data['status'] == 'approved'
    assert patch_data['station_updated'] is True
    assert patch_data['station_id'] == 'STATION_03_SONIPAT'

    # Now GET /telemetry/STATION_03_SONIPAT has the approved reading
    t1 = client.get('/telemetry/STATION_03_SONIPAT').json()
    assert len(t1['readings']) == 1
    sample = t1['readings'][0]
    assert sample['ammonia_ppm'] == 2.5
    assert sample['verified_by_report_id'] == rep['id']

    # Now GET /status shows the station with active updated_at and evaluated status
    s2 = client.get('/status').json()
    st2 = next(s for s in s2['stations'] if s['station_id'] == 'STATION_03_SONIPAT')
    assert st2['updated_at'] is not None
    assert st2['status'] != 'AWAITING_TELEMETRY'
    assert st2['toxicity_band'] in ('ELEVATED', 'HIGH', 'CRITICAL')

    # Now GET /reports default includes the approved report
    assert len(client.get('/reports').json()) == 1

    # Test server-restart resiliency with fallback_report
    db.reports.clear()
    assert len(db.reports) == 0
    res_fallback = client.patch("/reports/rep_reloaded", json={
        "action": "approve",
        "fallback_report": {
            "id": "rep_reloaded",
            "station_id": "STATION_03_SONIPAT",
            "ammonia_ppm": 0.13,
            "ph": 5.0,
            "observations": ["foam", "dark_color"]
        }
    })
    assert res_fallback.status_code == 200
    assert res_fallback.json()["status"] == "approved"
    assert res_fallback.json()["station_updated"] is True
    t2 = client.get('/telemetry/STATION_03_SONIPAT').json()
    assert any(r["ammonia_ppm"] == 0.13 for r in t2["readings"])
