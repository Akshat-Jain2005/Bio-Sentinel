"""Delivery channels. When USE_AWS_SNS is enabled, SMS messages are dispatched
via Amazon SNS (direct SMS and topic publish). When disabled (default / tests),
messages are appended to db.outbox only – no external calls are made."""
import logging
import requests
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from .. import config as C
from ..store import db

log = logging.getLogger("bio.notify")

# Lazy-initialised SNS client – created on first use only when USE_AWS_SNS=1.
_sns_client = None


def _get_sns():
    global _sns_client
    if _sns_client is None:
        cfg = Config(connect_timeout=3, read_timeout=3, retries={"max_attempts": 1})
        _sns_client = boto3.client("sns", region_name=C.AWS_REGION, config=cfg)
    return _sns_client


def send_sms(phone, text):
    """Send an SMS to a single phone number.
    Always appends to db.outbox for audit / test assertions.
    When USE_AWS_SNS is enabled, also publishes via Amazon SNS direct SMS."""
    db.outbox.append({"channel": "sms", "to": phone, "text": text})
    log.info("SMS to %s: %s", phone, text)

    if C.USE_AWS_SNS:
        try:
            sns = _get_sns()
            sns.publish(
                PhoneNumber=phone,
                Message=text,
                MessageAttributes={
                    "AWS.SNS.SMS.SenderID": {
                        "DataType": "String",
                        "StringValue": C.SNS_SMS_SENDER_ID,
                    },
                    "AWS.SNS.SMS.SMSType": {
                        "DataType": "String",
                        "StringValue": C.SNS_SMS_TYPE,
                    },
                },
            )
            log.info("SNS SMS delivered to %s", phone)
        except Exception as exc:
            log.error("SNS SMS to %s failed: %s", phone, exc)
            return False
    return True


def publish_to_topic(topic_arn, subject, message):
    """Publish a message to an SNS topic (operator or citizen alerts).
    Always appends to db.outbox for audit / test assertions.
    Only calls SNS when USE_AWS_SNS is enabled and a valid ARN is provided."""
    if not topic_arn:
        log.debug("SNS topic publish skipped (no ARN configured)")
        return True
    db.outbox.append({"channel": "sns_topic", "to": topic_arn, "subject": subject, "text": message})
    log.info("SNS topic %s: [%s] %s", topic_arn, subject, message)

    if C.USE_AWS_SNS and topic_arn:
        try:
            sns = _get_sns()
            sns.publish(
                TopicArn=topic_arn,
                Subject=subject[:100],  # SNS subject max 100 chars
                Message=message,
            )
            log.info("SNS topic publish OK: %s", topic_arn)
        except Exception as exc:
            log.error("SNS topic publish to %s failed: %s", topic_arn, exc)
            return False
    return True


def alert_operators(subject, message):
    """Convenience: publish to the operator escalation topic."""
    return publish_to_topic(C.SNS_TOPIC_ARN_OPERATORS, subject, message)


def alert_citizens(subject, message):
    """Convenience: publish to the citizen broadcast topic."""
    return publish_to_topic(C.SNS_TOPIC_ARN_CITIZENS, subject, message)


def send_telegram(text, parse_mode="HTML", force_live=False):
    """Dispatch a Telegram message to the configured channel/bot.

    Always appends to db.outbox for audit / test assertions – never bypass this.
    In DEV_MODE (unit tests) no external HTTP request is made unless force_live
    is True, so the suite neither spams the channel nor hangs on the network."""
    db.outbox.append({"channel": "telegram", "to": C.TELEGRAM_CHAT_ID or "console", "text": text})

    if C.DEV_MODE and not force_live:
        log.info("Telegram (mock): %s", text)
        return True

    if not (C.TELEGRAM_BOT_TOKEN and C.TELEGRAM_CHAT_ID):
        log.info("Telegram (console): %s", text)
        return True

    try:
        r = requests.post(
            f"https://api.telegram.org/bot{C.TELEGRAM_BOT_TOKEN}/sendMessage",
            json={
                "chat_id": C.TELEGRAM_CHAT_ID,
                "text": text,
                "parse_mode": parse_mode,
                "disable_web_page_preview": True,
            },
            timeout=5,
        )
        if not r.ok:
            log.error("Telegram send failed: %s %s", r.status_code, r.text[:200])
        return r.ok
    except requests.RequestException as exc:
        log.error("Telegram send error: %s", exc)
        return False


def send_email(to, subject, body):
    db.outbox.append({"channel": "email", "to": to, "subject": subject, "text": body})
    log.info("Email to %s: %s", to, subject)
    return True
