import logging
import traceback
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from . import config as C
from .routers import accounts, monitoring, operator, payments, reports, subscribers, toxicity

log = logging.getLogger("bio.main")

app = FastAPI(
    title="Bio-Sentinel API",
    description="Daphnia biomonitoring, field reports, alerts and relief funding",
    version="2.0.0",
)
app.add_middleware(
    CORSMiddleware, allow_origins=C.CORS_ORIGINS, allow_credentials=False,
    allow_methods=["*"], allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    log.error("Unhandled error at %s: %s\n%s", request.url.path, exc, traceback.format_exc())
    return JSONResponse(
        status_code=500,
        content={"detail": f"Server error: {str(exc)}"}
    )


for r in (monitoring, reports, subscribers, payments, operator, toxicity, accounts):
    app.include_router(r.router)


@app.get("/")
def health():
    return {"service": "Bio-Sentinel Core Engine", "status": "ONLINE", "version": "2.0.0"}
