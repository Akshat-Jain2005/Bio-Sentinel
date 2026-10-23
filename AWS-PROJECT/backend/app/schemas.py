import re
from typing import List, Literal, Optional
from pydantic import BaseModel, Field, field_validator

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ChemicalTelemetry(BaseModel):
    ammonia_ppm: float
    ph: float
    temperature_c: float


class BiologicalTelemetry(BaseModel):
    avg_velocity_mms: float
    avg_depth_cm: float
    erratic_index: float


class TelemetryPayload(BaseModel):
    station_id: str
    timestamp: int
    chemical: ChemicalTelemetry
    biological: BiologicalTelemetry


class ReportIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    location_label: str = Field(default="", max_length=120)
    source_type: Literal["river", "drain_outfall", "tap", "tanker"]
    ammonia_ppm: Optional[float] = Field(default=None, ge=0, le=50)
    ph: Optional[float] = Field(default=None, ge=0, le=14)
    temperature_c: Optional[float] = Field(default=None, ge=0, le=60)
    observations: List[str] = []
    note: str = Field(default="", max_length=500)
    photo_key: Optional[str] = None
    station_id: Optional[str] = None


class ReportReview(BaseModel):
    action: Literal["approve", "reject"]
    note: str = Field(default="", max_length=200)
    fallback_report: Optional[dict] = None


class PhotoUploadIn(BaseModel):
    content_type: Literal["image/jpeg", "image/png", "image/webp"]


class SubscribeIn(BaseModel):
    phone: str
    ward: str = Field(min_length=2, max_length=60)
    language: Literal["en", "hi", "both"] = "en"
    alert_types: List[Literal["pollution", "rationing", "all_clear"]] = ["pollution", "rationing", "all_clear"]
    consent: bool
    direct: bool = False


class OtpVerifyIn(BaseModel):
    phone: str
    code: str


class StopIn(BaseModel):
    phone: str


class OrderIn(BaseModel):
    amount_inr: int = Field(ge=10, le=500000)
    campaign_id: Optional[Literal["upkeep", "relief"]] = None
    tier_id: Optional[str] = None
    donor_name: str = Field(default="", max_length=80)
    donor_email: str = Field(max_length=120)
    anonymous: bool = False


class PaymentVerifyIn(BaseModel):
    order_id: str
    payment_id: str
    signature: str


class GateIn(BaseModel):
    action: Literal["SHUTDOWN", "DIVERT_BYPASS", "RESTORE"]
    rationale: str = Field(min_length=3, max_length=300)


class AlertIn(BaseModel):
    wards: List[str]
    channels: List[Literal["sms", "telegram"]] = ["sms"]
    message: str = Field(min_length=3, max_length=300)


class RulesIn(BaseModel):
    operator_telegram_on_incident: Optional[bool] = None
    sms_on_shutdown: Optional[bool] = None
    all_clear_on_restore: Optional[bool] = None


class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=6, max_length=200)
    phone: Optional[str] = None
    alt_phone: Optional[str] = None

    @field_validator("email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address")
        return v


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200)

    @field_validator("email")
    @classmethod
    def _lower_email(cls, v: str) -> str:
        return v.strip().lower()


class SetPasswordIn(BaseModel):
    password: str = Field(min_length=8, max_length=200)


class StaffLoginIn(BaseModel):
    role: Literal["operator", "reporter"]
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=6, max_length=12)

    @field_validator("email")
    @classmethod
    def _lower_email(cls, v: str) -> str:
        return v.strip().lower()


class EmailOtpIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: Optional[Literal["operator", "reporter", "citizen"]] = None

    @field_validator("email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address")
        return v


class EmailOtpVerifyIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    code: str = Field(min_length=4, max_length=10)

    @field_validator("email")
    @classmethod
    def _lower_email(cls, v: str) -> str:
        return v.strip().lower()
