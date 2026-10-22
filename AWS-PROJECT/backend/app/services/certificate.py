"""Certificate of Impact (PDF), generated after a verified payment.

Uses only reportlab's built-in fonts, so no font files are needed. Amounts are written as
"INR" because the built-in fonts have no rupee sign. Names that the built-in fonts cannot
print (for example Devanagari) fall back to "Valued Supporter".
"""
import hashlib
import hmac
import io
import os
from datetime import datetime, timedelta, timezone

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode import qr
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

from .. import config as C

NAVY, TEAL, INK = HexColor("#0C3572"), HexColor("#0A9488"), HexColor("#0A1428")
MUTED, TILE, TILE_LINE, ALERT = HexColor("#44516B"), HexColor("#F1F8F7"), HexColor("#CDE5E1"), HexColor("#C2410C")
LOGO = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "logo_shield.png")
IST = timezone(timedelta(hours=5, minutes=30))


def _sig(kind, payment_id):
    return hmac.new(C.CERT_SECRET.encode(), f"{kind}|{payment_id}".encode(), hashlib.sha256).hexdigest()


def download_token(payment_id):
    return _sig("token", payment_id)[:32]


def certificate_code(payment_id):
    h = _sig("cert", payment_id)[:12].upper()
    return f"BS-{h[:4]}-{h[4:8]}-{h[8:]}"


def token_ok(payment_id, token):
    return hmac.compare_digest(download_token(payment_id), token or "")


def safe_name(name):
    name = " ".join((name or "").split())[:60]
    try:
        name.encode("latin-1")
    except UnicodeEncodeError:
        return "Valued Supporter"
    return name or "Valued Supporter"


def impact_for(campaign_id, amount_inr):
    """Estimates from the campaign unit costs (INR 499 = 1,000 L; INR 199 = 30 days of upkeep)."""
    if campaign_id == "relief":
        litres = amount_inr * 1000 / 499
        litres = round(litres, -2) if litres >= 1000 else round(litres, -1)
        return f"About {int(litres):,} litres", "of verified tanker water"
    days = max(1, int(amount_inr / 199 * 30))
    if days >= 30:
        days = round(days / 5) * 5
    return f"About {days:,} days", "of biological monitoring at one sensor station"


def _txt(c, s, x, y, font, size, color, space=0, align="l"):
    """Draws text with optional letter spacing, then restores state so spacing never leaks."""
    w = stringWidth(s, font, size) + space * len(s)
    x = x - w / 2 if align == "c" else x - w if align == "r" else x
    c.saveState()
    c.setFillColor(color)
    t = c.beginText(x, y)
    t.setFont(font, size)
    t.setCharSpace(space)
    t.textOut(s)
    c.drawText(t)
    c.restoreState()


def _centered(c, text, y, font, size, color, space=0):
    _txt(c, text, c._pagesize[0] / 2, y, font, size, color, space, "c")


def _qr(c, url, x, y, size):
    widget = qr.QrCodeWidget(url, barFillColor=NAVY)
    b = widget.getBounds()
    d = Drawing(size, size, transform=[size / (b[2] - b[0]), 0, 0, size / (b[3] - b[1]), 0, 0])
    d.add(widget)
    renderPDF.draw(d, c, x, y)


def build_certificate(*, name, amount_inr, campaign_id, campaign_title, paid_at, code, verify_url, demo=False):
    buf = io.BytesIO()
    W, H = landscape(A4)
    c = canvas.Canvas(buf, pagesize=(W, H))
    c.setTitle("Bio-Sentinel Certificate of Impact")
    c.setAuthor("Bio-Sentinel")
    c.setSubject(f"Certificate {code}")

    # watermark shield
    logo = ImageReader(LOGO)
    lw, lh = logo.getSize()
    wm_w = 330
    c.saveState()
    c.setFillAlpha(0.05)
    c.drawImage(logo, (W - wm_w) / 2, (H - wm_w * lh / lw) / 2 - 10, wm_w, wm_w * lh / lw, mask="auto")
    c.restoreState()

    # frame: navy outer, teal inner, corner brackets
    c.setStrokeColor(NAVY); c.setLineWidth(3); c.rect(22, 22, W - 44, H - 44)
    c.setStrokeColor(TEAL); c.setLineWidth(0.8); c.rect(31, 31, W - 62, H - 62)
    c.setLineWidth(2.4)
    for x, y, dx, dy in ((40, 40, 1, 1), (W - 40, 40, -1, 1), (40, H - 40, 1, -1), (W - 40, H - 40, -1, -1)):
        c.line(x, y, x + 30 * dx, y); c.line(x, y, x, y + 30 * dy)

    # header: logo + wordmark (left), certificate number (right)
    h_logo = 46
    c.drawImage(logo, 62, H - 62 - h_logo, h_logo * lw / lh, h_logo, mask="auto")
    x0 = 62 + h_logo * lw / lh + 12
    c.setFont("Helvetica-Bold", 21); c.setFillColor(NAVY); c.drawString(x0, H - 84, "BIO-")
    c.setFillColor(TEAL); c.drawString(x0 + stringWidth("BIO-", "Helvetica-Bold", 21), H - 84, "SENTINEL")
    _txt(c, "DETECT \xb7 PROTECT \xb7 IMPROVE", x0, H - 98, "Helvetica", 7.5, MUTED, 2)
    _txt(c, "CERTIFICATE NO.", W - 62, H - 70, "Helvetica", 7.5, MUTED, 1.6, "r")
    _txt(c, code, W - 62, H - 86, "Courier-Bold", 12, NAVY, 0.6, "r")
    if demo:
        c.setStrokeColor(ALERT); c.setFillColor(ALERT); c.setLineWidth(1)
        c.roundRect(W - 62 - 156, H - 116, 156, 16, 3)
        _txt(c, "TEST PAYMENT - NO REAL FUNDS", W - 62 - 78, H - 111, "Helvetica-Bold", 7, ALERT, 0.8, "c")

    # title
    _centered(c, "CERTIFICATE OF IMPACT", H - 170, "Times-Bold", 40, NAVY, 4)
    c.setStrokeColor(TEAL); c.setLineWidth(1.4); c.line(W / 2 - 46, H - 184, W / 2 + 46, H - 184)
    c.setFillColor(TEAL); c.rect(W / 2 - 3, H - 187, 6, 6, fill=1, stroke=0)
    _centered(c, "THIS CERTIFICATE IS PROUDLY PRESENTED TO", H - 212, "Helvetica", 9.5, MUTED, 2.4)

    # donor name, auto-shrunk to fit
    name = safe_name(name)
    size = 38
    while stringWidth(name, "Times-BoldItalic", size) > 560 and size > 20:
        size -= 1
    _centered(c, name, H - 252, "Times-BoldItalic", size, INK)
    c.setStrokeColor(TEAL); c.setLineWidth(0.8); c.line(W / 2 - 230, H - 262, W / 2 + 230, H - 262)

    # body
    amt = f"INR {amount_inr:,}"
    _centered(c, f"in recognition of a contribution of {amt} to the", H - 290, "Helvetica", 12.5, MUTED)
    _centered(c, campaign_title, H - 310, "Helvetica-Bold", 15, NAVY)
    _centered(c, "helping protect people and rivers from the harm of polluted water.", H - 330, "Helvetica", 12.5, MUTED)

    # impact tiles
    big, small = impact_for(campaign_id, amount_inr)
    date_txt = datetime.fromtimestamp(paid_at, IST).strftime("%d %B %Y").lstrip("0")
    tiles = (("CONTRIBUTION", amt, "received and verified"), ("ESTIMATED IMPACT", big, small), ("DATE", date_txt, "Indian Standard Time"))
    tw, gap, th, TY = 214, 18, 70, 160
    x = (W - (3 * tw + 2 * gap)) / 2
    for label, value, sub in tiles:
        c.setFillColor(TILE); c.setStrokeColor(TILE_LINE); c.setLineWidth(0.8)
        c.roundRect(x, TY, tw, th, 6, fill=1, stroke=1)
        _txt(c, label, x + 14, TY + th - 17, "Helvetica-Bold", 7.5, TEAL, 1.6)
        vs = 17
        while stringWidth(value, "Helvetica-Bold", vs) > tw - 28 and vs > 10:
            vs -= 1
        _txt(c, value, x + 14, TY + th - 40, "Helvetica-Bold", vs, NAVY)
        ss = 8.5
        while stringWidth(sub, "Helvetica", ss) > tw - 28 and ss > 6:
            ss -= 0.5
        _txt(c, sub, x + 14, TY + 12, "Helvetica", ss, MUTED)
        x += tw + gap

    # footer: signature, QR, programme
    c.setStrokeColor(NAVY); c.setLineWidth(0.8)
    c.line(80, 114, 240, 114); c.line(W - 240, 114, W - 80, 114)
    _txt(c, "Bio-Sentinel Team", 160, 101, "Helvetica-Bold", 9.5, INK, 0.4, "c")
    _txt(c, "AWS Environmental Hackathon 2026", W - 160, 101, "Helvetica-Bold", 9.5, INK, 0.2, "c")
    _txt(c, "Issued digitally", 160, 90, "Helvetica", 7.5, MUTED, 0.4, "c")
    _txt(c, "Heat & Water Track", W - 160, 90, "Helvetica", 7.5, MUTED, 0.4, "c")
    _qr(c, verify_url, W / 2 - 27, 98, 54)
    _txt(c, "SCAN TO VERIFY", W / 2, 88, "Helvetica-Bold", 6.5, TEAL, 1.4, "c")
    _txt(c, verify_url.replace("https://", ""), W / 2, 76, "Courier", 7, MUTED, 0, "c")
    _txt(c, "This certificate acknowledges a contribution to a hackathon prototype campaign. It is not a tax receipt.",
         W / 2, 56, "Helvetica", 6.8, MUTED, 0.3, "c")
    c.showPage(); c.save()
    return buf.getvalue()
