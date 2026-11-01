from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .engine import ForecastEngine

engine = ForecastEngine()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class ForecastRequest(BaseModel):
    algorithm: str
    now: str
    target: str
    graphMinutes: int = Field(default=91, ge=1, le=91)


@app.get("/health")
def health() -> dict[str, object]:
    return engine.health()


@app.post("/v1/internal/forecast")
def forecast(request: ForecastRequest) -> dict[str, object]:
    try:
        return engine.forecast(request.algorithm, request.now, request.target, request.graphMinutes)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail="Forecast worker is temporarily unavailable.") from error


@app.get("/v1/internal/evaluation")
def evaluation() -> dict[str, object]:
    return engine.evaluation()
