"""Tests for the Dashboard API Dream Worker proxy."""

import json
from unittest.mock import patch

from host_agent_client import (
    AgentHTTPError,
    AgentProtocolError,
    AgentTimeout,
    AgentUnavailable,
)


JOB_ID = "0123456789abcdef0123456789abcdef"


def _http_error(
    status: int,
    body: dict,
) -> AgentHTTPError:
    return AgentHTTPError(
        status,
        body.get(
            "error",
            f"Host agent returned HTTP {status}",
        ),
        json.dumps(body),
    )


def test_status_requires_auth(test_client):
    response = test_client.get(
        "/api/dream-worker/status",
    )

    assert response.status_code == 401


def test_submit_requires_auth(test_client):
    response = test_client.post(
        "/api/dream-worker/jobs",
        json={"prompt": "hello"},
    )

    assert response.status_code == 401


def test_status_proxies_worker_envelope(test_client):
    upstream = {
        "ok": True,
        "worker": {
            "machine": "WOLFSOUL-PRIME",
            "version": "0.8.0",
            "machineState": "INTERACTIVE",
        },
    }

    with patch(
        "routers.dream_worker.request_agent_json",
        return_value=upstream,
    ) as mocked:
        response = test_client.get(
            "/api/dream-worker/status",
            headers=test_client.auth_headers,
        )

    assert response.status_code == 200
    assert response.json() == upstream

    mocked.assert_called_once_with(
        "GET",
        "/v1/dream-worker/status",
        timeout=15,
    )


def test_submit_defaults_and_returns_202(test_client):
    upstream = {
        "ok": True,
        "job": {
            "id": JOB_ID,
            "state": "queued",
        },
    }

    with patch(
        "routers.dream_worker.request_agent_json",
        return_value=upstream,
    ) as mocked:
        response = test_client.post(
            "/api/dream-worker/jobs",
            headers=test_client.auth_headers,
            json={
                "prompt": "hello",
            },
        )

    assert response.status_code == 202
    assert response.json() == upstream

    mocked.assert_called_once_with(
        "POST",
        "/v1/dream-worker/jobs",
        payload={
            "prompt": "hello",
            "enableThinking": False,
            "maxTokens": 512,
        },
        timeout=15,
    )


def test_submit_preserves_options(test_client):
    upstream = {
        "ok": True,
        "job": {
            "id": JOB_ID,
            "state": "running",
        },
    }

    with patch(
        "routers.dream_worker.request_agent_json",
        return_value=upstream,
    ) as mocked:
        response = test_client.post(
            "/api/dream-worker/jobs",
            headers=test_client.auth_headers,
            json={
                "prompt": "reason about this",
                "enableThinking": True,
                "maxTokens": 2048,
            },
        )

    assert response.status_code == 202

    mocked.assert_called_once_with(
        "POST",
        "/v1/dream-worker/jobs",
        payload={
            "prompt": "reason about this",
            "enableThinking": True,
            "maxTokens": 2048,
        },
        timeout=15,
    )


def test_submit_rejects_non_object(test_client):
    response = test_client.post(
        "/api/dream-worker/jobs",
        headers=test_client.auth_headers,
        json=[
            "not",
            "an",
            "object",
        ],
    )

    assert response.status_code == 400


def test_submit_rejects_empty_prompt(test_client):
    response = test_client.post(
        "/api/dream-worker/jobs",
        headers=test_client.auth_headers,
        json={
            "prompt": "   ",
        },
    )

    assert response.status_code == 400


def test_submit_rejects_non_boolean_thinking(test_client):
    response = test_client.post(
        "/api/dream-worker/jobs",
        headers=test_client.auth_headers,
        json={
            "prompt": "hello",
            "enableThinking": "yes",
        },
    )

    assert response.status_code == 400


def test_submit_rejects_non_positive_max_tokens(test_client):
    response = test_client.post(
        "/api/dream-worker/jobs",
        headers=test_client.auth_headers,
        json={
            "prompt": "hello",
            "maxTokens": 0,
        },
    )

    assert response.status_code == 400


def test_get_job(test_client):
    upstream = {
        "ok": True,
        "job": {
            "id": JOB_ID,
            "state": "completed",
            "result": "done",
        },
    }

    with patch(
        "routers.dream_worker.request_agent_json",
        return_value=upstream,
    ) as mocked:
        response = test_client.get(
            f"/api/dream-worker/jobs/{JOB_ID}",
            headers=test_client.auth_headers,
        )

    assert response.status_code == 200
    assert response.json() == upstream

    mocked.assert_called_once_with(
        "GET",
        f"/v1/dream-worker/jobs/{JOB_ID}",
        timeout=15,
    )


def test_cancel_job(test_client):
    upstream = {
        "ok": True,
        "job": {
            "id": JOB_ID,
            "state": "cancelled",
        },
    }

    with patch(
        "routers.dream_worker.request_agent_json",
        return_value=upstream,
    ) as mocked:
        response = test_client.post(
            f"/api/dream-worker/jobs/{JOB_ID}/cancel",
            headers=test_client.auth_headers,
        )

    assert response.status_code == 200
    assert response.json() == upstream

    mocked.assert_called_once_with(
        "POST",
        f"/v1/dream-worker/jobs/{JOB_ID}/cancel",
        timeout=15,
    )


def test_invalid_job_id_is_rejected(test_client):
    response = test_client.get(
        "/api/dream-worker/jobs/not-a-job-id",
        headers=test_client.auth_headers,
    )

    assert response.status_code == 404


def test_agent_http_error_is_preserved(test_client):
    error = _http_error(
        404,
        {
            "error": "Job not found",
        },
    )

    with patch(
        "routers.dream_worker.request_agent_json",
        side_effect=error,
    ):
        response = test_client.get(
            f"/api/dream-worker/jobs/{JOB_ID}",
            headers=test_client.auth_headers,
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "Job not found"


def test_agent_unavailable_returns_503(test_client):
    with patch(
        "routers.dream_worker.request_agent_json",
        side_effect=AgentUnavailable(
            "connection refused"
        ),
    ):
        response = test_client.get(
            "/api/dream-worker/status",
            headers=test_client.auth_headers,
        )

    assert response.status_code == 503


def test_agent_timeout_returns_504(test_client):
    with patch(
        "routers.dream_worker.request_agent_json",
        side_effect=AgentTimeout(
            "timed out"
        ),
    ):
        response = test_client.get(
            "/api/dream-worker/status",
            headers=test_client.auth_headers,
        )

    assert response.status_code == 504


def test_agent_protocol_error_returns_500(test_client):
    with patch(
        "routers.dream_worker.request_agent_json",
        side_effect=AgentProtocolError(
            "invalid JSON"
        ),
    ):
        response = test_client.get(
            "/api/dream-worker/status",
            headers=test_client.auth_headers,
        )

    assert response.status_code == 500


def test_submit_rejects_malformed_json(test_client):
    headers = dict(test_client.auth_headers)
    headers["Content-Type"] = "application/json"

    response = test_client.post(
        "/api/dream-worker/jobs",
        headers=headers,
        content='{"prompt":',
    )

    assert response.status_code == 400
    assert (
        response.json()["detail"]
        == "Request body must contain valid JSON"
    )


def test_submit_rejects_oversized_body(test_client):
    headers = dict(test_client.auth_headers)
    headers["Content-Type"] = "application/json"

    oversized = (
        '{"prompt":"'
        + ("x" * (16 * 1024))
        + '"}'
    )

    response = test_client.post(
        "/api/dream-worker/jobs",
        headers=headers,
        content=oversized,
    )

    assert response.status_code == 413
    assert response.json()["detail"] == "Request body is too large"
