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


class SemanticValidation(BaseModel):
    success: bool
    collapsed_to_false: bool = False
    declaration_name: str | None = None
    reasons: list[str] = Field(default_factory=list)


class PipelineStage(BaseModel):
    stage: Literal[
        "modal_generation",
        "lean_compile",
        "semantic_validation",
        "llm_interpretation",
    ]
    attempted: bool = True
    success: bool | None = None
    duration_ms: float | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class PipelineTrace(BaseModel):
    total_duration_ms: float | None = None
    stages: list[PipelineStage] = Field(default_factory=list)
    semantic: SemanticValidation | None = None


class InterpretationItem(BaseModel):
    error: str
    probable_cause: str | None = None
    suggested_fix: str | None = None
    source: Literal["latex", "lean", "both", "unknown"] = "unknown"
    latex_start: int | None = None
    latex_end: int | None = None
    latex_excerpt: str | None = None
    lean_line: int | None = None
    lean_column: int | None = None
    replacement: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class Interpretation(BaseModel):
    summary: str
    items: list[InterpretationItem] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)


class SolveResponse(BaseModel):
    lean_code: str
    compile: CompileResult
    interpretation: Interpretation | None = None
    interpretation_error: str | None = None
    pipeline: PipelineTrace | None = None
