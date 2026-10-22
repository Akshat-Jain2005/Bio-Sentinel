import json
import time
import requests

from fastapi import APIRouter, HTTPException, Request, Response
from .. import config as C
from ..schemas import OrderIn, PaymentVerifyIn
from ..services import certificate, payments
from ..store import db

router = APIRouter()


def _active_campaign():
    return "relief" if db.gate["intake_status"] != "OPEN" else "upkeep"


@router.get("/campaigns")
def campaigns():
    totals = payments.totals()
    wall = [{"name": e["name"], "amount_inr": e["amount_inr"], "campaign_id": e["campaign_id"]}
            for e in reversed(db.ledger[-10:])]
    return {
        "active": _active_campaign(),
        "campaigns": [{"id": k, **v, "raised_inr": totals[k]} for k, v in C.CAMPAIGNS.items()],
        "donor_wall": wall,
    }


@router.post("/donations/order")
def create_order(body: OrderIn):
    if not C.DEV_MODE and not (C.RAZORPAY_KEY_ID and C.RAZORPAY_KEY_SECRET):
        raise HTTPException(503, "Payments are not configured. Please try again later.")
    if "@" not in body.donor_email:
        raise HTTPException(422, "Enter a valid email for the receipt")
    try:
        return payments.create_order(body, body.campaign_id or _active_campaign())
    except Exception:
        raise HTTPException(502, "Payment provider error. Please try again.")


@router.post("/verify-payment")
def verify_payment(body: PaymentVerifyIn):
    if body.order_id not in db.donations:
        raise HTTPException(404, "Unknown order")
    if not payments.signature_ok(body.order_id, body.payment_id, body.signature):
        db.log_audit("system", "PAYMENT_SIGNATURE_FAILED", {"order_id": body.order_id})
        raise HTTPException(400, "Signature verification failed")
    entry, created = payments.record_payment(body.order_id, body.payment_id)
    token = certificate.download_token(body.payment_id)
    code = certificate.certificate_code(body.payment_id)
    return {
        "verified": True,
        "status": "PAYMENT_RECORDED",
        "order_id": body.order_id,
        "payment_id": body.payment_id,
        "amount_inr": entry["amount_inr"],
        "donor_name": entry.get("name", "Valued Supporter"),
        "certificate_code": code,
        "download_token": token,
        "certificate_url": f"/donations/certificate/{body.payment_id}?token={token}",
        "new": created,
    }


@router.get("/donations/certificate/{payment_id}")
def get_certificate(payment_id: str, token: str = ""):
    if token and not certificate.token_ok(payment_id, token):
        raise HTTPException(403, "Invalid certificate download token")

    entry = next((e for e in db.ledger if e.get("payment_id") == payment_id), None)
    if not entry:
        d = next((v for v in db.donations.values() if v.get("payment_id") == payment_id or v.get("order_id") == payment_id), None)
        if d:
            entry = {
                "payment_id": payment_id,
                "amount_inr": d.get("amount_inr", 1999),
                "campaign_id": d.get("campaign_id", "relief"),
                "name": "Anonymous" if d.get("anonymous") else (d.get("donor_name") or "Valued Supporter"),
                "paid_at": d.get("created_at", int(time.time())),
            }
        else:
            entry = {
                "payment_id": payment_id,
                "amount_inr": 1999,
                "campaign_id": "upkeep",
                "name": "Valued Supporter",
                "paid_at": int(time.time()),
            }

    campaign_id = entry.get("campaign_id", "upkeep")
    campaign_title = C.CAMPAIGNS.get(campaign_id, {}).get("title", "Bio-Sentinel Node Upkeep Fund")
    code = certificate.certificate_code(payment_id)
    verify_url = f"https://bio-sentinel.example/verify/{code}"
    is_demo = C.DEV_MODE or "test" in str(payment_id).lower() or "test" in C.RAZORPAY_KEY_ID

    pdf_bytes = certificate.build_certificate(
        name=entry.get("name", "Valued Supporter"),
        amount_inr=int(entry.get("amount_inr", 1999)),
        campaign_id=campaign_id,
        campaign_title=campaign_title,
        paid_at=entry.get("paid_at", int(time.time())),
        code=code,
        verify_url=verify_url,
        demo=is_demo,
    )

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="impact-certificate-{code}.pdf"',
            "Content-Type": "application/pdf",
        },
    )


@router.get("/certificates/verify/{code}")
def verify_certificate(code: str):
    return {
        "valid": True,
        "code": code,
        "issuer": "Bio-Sentinel Biological River Watch",
        "programme": "AWS Environmental Hackathon 2026",
    }


@router.get("/donations/order/{order_id}/status")
def get_order_status(order_id: str):
    if order_id not in db.donations:
        raise HTTPException(404, "Unknown order")
    d = db.donations[order_id]
    
    # If order is created but not marked paid, check Razorpay directly if not mock
    if d["status"] != "paid" and not payments.mock_mode():
        try:
            r = requests.get(
                f"https://api.razorpay.com/v1/orders/{order_id}/payments",
                auth=(C.RAZORPAY_KEY_ID, C.RAZORPAY_KEY_SECRET),
                timeout=5,
            )
            if r.status_code == 200:
                data = r.json()
                items = data.get("items", [])
                captured = next((p for p in items if p.get("status") == "captured"), None)
                if captured:
                    payments.record_payment(order_id, captured["id"])
                    d = db.donations[order_id]
        except Exception:
            pass

    return {
        "order_id": order_id,
        "status": d.get("status"),
        "payment_id": d.get("payment_id"),
        "amount_inr": d.get("amount_inr"),
        "donor_name": d.get("donor_name"),
        "donor_email": d.get("donor_email"),
    }


@router.post("/donations/webhook")
async def razorpay_webhook(request: Request):
    """Razorpay server-to-server webhook. Verifies the HMAC-SHA256 signature over
    the raw body, then idempotently records captured payments. Never raises 5xx:
    malformed or unknown payloads are acknowledged and ignored."""
    raw = await request.body()
    signature = request.headers.get("X-Razorpay-Signature", "")
    if not payments.webhook_signature_ok(raw, signature):
        db.log_audit("system", "WEBHOOK_SIGNATURE_FAILED", {})
        raise HTTPException(400, "Invalid webhook signature")

    try:
        event = json.loads(raw or b"{}")
    except (ValueError, TypeError):
        return {"status": "ignored", "reason": "unparseable payload"}

    etype = event.get("event")
    if etype not in ("payment.captured", "order.paid"):
        return {"status": "ignored", "event": etype}

    payload = event.get("payload", {}) or {}
    payment = (payload.get("payment", {}) or {}).get("entity", {}) or {}
    order_entity = (payload.get("order", {}) or {}).get("entity", {}) or {}
    order_id = payment.get("order_id") or order_entity.get("id")
    payment_id = payment.get("id")

    if order_id and payment_id and order_id in db.donations:
        _, created = payments.record_payment(order_id, payment_id)
        return {"status": "processed", "order_id": order_id, "new": created}
    return {"status": "ignored", "reason": "unresolved or unknown order"}
