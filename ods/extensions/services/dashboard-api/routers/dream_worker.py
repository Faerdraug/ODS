"""Dashboard API proxy for the external Dream Worker."""

import asyncio
import json
import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from host_agent_client import (
    AgentHTTPError,
    AgentProtocolError,
    AgentTimeout,
    AgentUnavailable,
    request_json as request_agent_json,
)
from security import verify_api_key


logger = logging.getLogger(__name__)

router = APIRouter(tags=["dream-worker"])

_JOB_ID_RE = re.compile(r"^[0-9a-fA-F]{32}$")
_MAX_REQUEST_BODY_BYTES = 16 * 1024


def _validate_job_id(job_id: str) -> str:
    if _JOB_ID_RE.fullmatch(job_id) is None:
        raise HTTPException(
            status_code=404,
            detail="Dream Worker job not found.",
        )

    return job_id


def _proxy_agent(
    method: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout: float = 15,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "timeout": timeout,
    }

    if payload is not None:
        kwargs["payload"] = payload

    try:
        return request_agent_json(
            method,
            path,
            **kwargs,
        )
    except AgentHTTPError as exc:
        logger.info(
            "host-agent %s %s -> %s",
            method,
            path,
            exc.status_code,
        )

        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.detail,
        ) from exc
    except AgentTimeout as exc:
        logger.warning(
            "host-agent %s %s timed out",
            method,
            path,
        )

        raise HTTPException(
            status_code=504,
            detail="ODS host agent request timed out.",
        ) from exc
    except AgentUnavailable as exc:
        logger.warning(
            "host-agent %s %s unreachable: %s",
            method,
            path,
            exc,
        )

        raise HTTPException(
            status_code=503,
            detail="ODS host agent is not reachable.",
        ) from exc
    except AgentProtocolError as exc:
        logger.warning(
            "host-agent %s %s returned invalid JSON",
            method,
            path,
        )

        raise HTTPException(
            status_code=500,
            detail="ODS host agent returned an invalid response.",
        ) from exc


@router.get(
    "/api/dream-worker/status",
    dependencies=[Depends(verify_api_key)],
)
async def dream_worker_status() -> dict[str, Any]:
    return await asyncio.to_thread(
        _proxy_agent,
        "GET",
        "/v1/dream-worker/status",
    )


@router.post(
    "/api/dream-worker/jobs",
    dependencies=[Depends(verify_api_key)],
)
async def dream_worker_submit(
    request: Request,
):
    raw_body = bytearray()

    async for chunk in request.stream():
        raw_body.extend(chunk)

        if len(raw_body) > _MAX_REQUEST_BODY_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Request body is too large",
            )

    try:
        body = json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=400,
            detail="Request body must contain valid JSON",
        ) from exc

    if not isinstance(body, dict):
        raise HTTPException(
            status_code=400,
            detail="Request body must be a JSON object",
        )

    prompt = body.get("prompt")

    if not isinstance(prompt, str) or not prompt.strip():
        raise HTTPException(
            status_code=400,
            detail="prompt must be a non-empty string",
        )

    enable_thinking = body.get(
        "enableThinking",
        False,
    )

    if type(enable_thinking) is not bool:
        raise HTTPException(
            status_code=400,
            detail="enableThinking must be boolean",
        )

    max_tokens = body.get(
        "maxTokens",
        512,
    )

    if type(max_tokens) is not int or max_tokens < 1:
        raise HTTPException(
            status_code=400,
            detail="maxTokens must be a positive integer",
        )

    payload = {
        "prompt": prompt,
        "enableThinking": enable_thinking,
        "maxTokens": max_tokens,
    }

    result = await asyncio.to_thread(
        _proxy_agent,
        "POST",
        "/v1/dream-worker/jobs",
        payload=payload,
    )

    status_code = 200

    job = result.get("job")

    if isinstance(job, dict):
        state = str(job.get("state") or "")

        if state in {"queued", "running"}:
            status_code = 202

    return JSONResponse(
        status_code=status_code,
        content=result,
    )


@router.get(
    "/api/dream-worker/jobs/{job_id}",
    dependencies=[Depends(verify_api_key)],
)
async def dream_worker_get_job(
    job_id: str,
) -> dict[str, Any]:
    job_id = _validate_job_id(job_id)

    return await asyncio.to_thread(
        _proxy_agent,
        "GET",
        f"/v1/dream-worker/jobs/{job_id}",
    )


@router.post(
    "/api/dream-worker/jobs/{job_id}/cancel",
    dependencies=[Depends(verify_api_key)],
)
async def dream_worker_cancel(
    job_id: str,
) -> dict[str, Any]:
    job_id = _validate_job_id(job_id)

    return await asyncio.to_thread(
        _proxy_agent,
        "POST",
        f"/v1/dream-worker/jobs/{job_id}/cancel",
    )
