from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class SolveRequest(BaseModel):
    nl_input: str = Field(min_length=1)
    context: dict[str, Any] = Field(default_factory=dict)
    max_iters: int = Field(default=1, ge=1, le=5)


class GeneratedLean(BaseModel):
    code: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class Diagnostic(BaseModel):
    severity: Literal["error", "warning", "info", "unknown"]
    message: str
    line: int | None = None
    column: int | None = None
    file: str | None = None
    raw: str | None = None


class CompileResult(BaseModel):
    success: bool
    stdout: str = ""
    stderr: str = ""
    diagnostics: list[Diagnostic] = Field(default_factory=list)


class Interpretation(BaseModel):
    summary: str
    items: list[dict[str, Any]] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)


class SolveResponse(BaseModel):
    lean_code: str
    compile: CompileResult
    interpretation: Interpretation | None = None
    interpretation_error: str | None = None
