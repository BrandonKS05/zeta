from __future__ import annotations

import json
import sys
from pathlib import Path

import requests

import run_eval_suite as suite


class _FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"status={self.status_code}")

    def json(self) -> dict:
        return self._payload


def test_load_cases(tmp_path: Path) -> None:
    cases_path = tmp_path / "cases.json"
    cases_path.write_text(json.dumps([{"id": "a", "text": "t"}]), encoding="utf-8")
    cases = suite._load_cases(cases_path)
    assert len(cases) == 1
    assert cases[0]["id"] == "a"


def test_print_summary_handles_missing_response(capsys) -> None:
    rows = [
        {"case_id": "ok", "response": {"status": "ok", "is_valid_lean": True, "latency_ms": 10}},
        {"case_id": "missing", "response": None, "error": None},
        {"case_id": "error", "error": "boom"},
    ]
    suite._print_summary(rows)
    output = capsys.readouterr().out
    assert "cases=3" in output
    assert "REQUEST_ERROR -> boom" in output


def test_post_async_and_poll_success(monkeypatch) -> None:
    def fake_post(*args, **kwargs):  # noqa: ANN002, ANN003
        return _FakeResponse({"call_id": "abc123", "status": "pending"})

    calls = {"polls": 0}

    def fake_get(*args, **kwargs):  # noqa: ANN002, ANN003
        calls["polls"] += 1
        if calls["polls"] == 1:
            return _FakeResponse({"status": "pending", "call_id": "abc123"})
        return _FakeResponse({"status": "completed", "call_id": "abc123", "result": {"status": "ok"}})

    monkeypatch.setattr(suite.requests, "post", fake_post)
    monkeypatch.setattr(suite.requests, "get", fake_get)

    result, error = suite._post_async_and_poll(
        base_url="https://example.modal.run",
        api_key=None,
        case_payload={"text": "x"},
        submit_timeout_seconds=10,
        poll_interval_seconds=0.0,
        max_poll_seconds=5,
    )
    assert error is None
    assert result == {"status": "ok"}


def test_main_writes_report(monkeypatch, tmp_path: Path) -> None:
    cases_path = tmp_path / "cases.json"
    cases_path.write_text(
        json.dumps(
            [
                {"id": "c1", "text": "For all n, n=n", "imports": ["Std"]},
                {"id": "c2", "text": "For all x, x=x", "imports": ["Std"]},
            ]
        ),
        encoding="utf-8",
    )
    results_dir = tmp_path / "results"

    def fake_post(*args, **kwargs):  # noqa: ANN002, ANN003
        return _FakeResponse(
            {
                "status": "ok",
                "is_valid_lean": True,
                "latency_ms": 7,
                "statement_type": "∀ n : Nat, n = n",
            }
        )

    monkeypatch.setattr(suite.requests, "post", fake_post)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "run_eval_suite.py",
            "--base-url",
            "https://example.modal.run",
            "--cases-file",
            str(cases_path),
            "--results-dir",
            str(results_dir),
        ],
    )

    suite.main()

    reports = list(results_dir.glob("eval-*.json"))
    assert len(reports) == 1
    report_payload = json.loads(reports[0].read_text(encoding="utf-8"))
    assert report_payload["total_cases"] == 2
    assert len(report_payload["rows"]) == 2
    assert report_payload["rows"][0]["response"]["status"] == "ok"

