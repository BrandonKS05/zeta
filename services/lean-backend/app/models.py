from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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
        "highlight_resolution",
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


class HighlightSentence(BaseModel):
    model_config = ConfigDict(extra="ignore")

    sentence_id: str | None = None
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, ge=0)
    text: str | None = None

    @model_validator(mode="before")
    @classmethod
    def normalize_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        payload = dict(value)
        if "sentence_id" not in payload and "sentenceId" in payload:
            payload["sentence_id"] = payload.get("sentenceId")
        return payload


class HighlightChunk(BaseModel):
    model_config = ConfigDict(extra="ignore")

    chunk_id: str
    text: str = ""
    start: int = Field(default=0, ge=0)
    end: int | None = Field(default=None, ge=0)
    parent_id: str | None = None
    sentences: list[HighlightSentence] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def normalize_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        payload = dict(value)
        if "chunk_id" not in payload and "chunkId" in payload:
            payload["chunk_id"] = payload.get("chunkId")
        if "parent_id" not in payload and "parentId" in payload:
            payload["parent_id"] = payload.get("parentId")
        return payload


class HighlightResolveRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    chunks: list[HighlightChunk] = Field(default_factory=list, min_length=1)
    interpretation: Interpretation
    active_chunk_id: str = ""

    @model_validator(mode="before")
    @classmethod
    def normalize_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        payload = dict(value)
        if "active_chunk_id" not in payload and "activeChunkId" in payload:
            payload["active_chunk_id"] = payload.get("activeChunkId")
        return payload


class HighlightRange(BaseModel):
    chunk_id: str
    item_index: int = Field(ge=0)
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    start_in_chunk: int = Field(ge=0)
    end_in_chunk: int = Field(ge=0)
    text: str
    source: Literal[
        "latex_span",
        "latex_excerpt",
        "quoted_text",
        "replacement_text",
        "keyword",
        "llm",
    ]
    confidence: float = Field(ge=0.0, le=1.0)
    sentence_id: str | None = None


class HighlightItemResult(BaseModel):
    item_index: int = Field(ge=0)
    error: str
    resolved: bool
    ranges: list[HighlightRange] = Field(default_factory=list)
    reason: str | None = None


class HighlightResolveResponse(BaseModel):
    highlights: list[HighlightRange] = Field(default_factory=list)
    items: list[HighlightItemResult] = Field(default_factory=list)
    unresolved_items: list[int] = Field(default_factory=list)
    resolver: Literal["llm", "deterministic"] = "deterministic"
    resolver_error: str | None = None


class DashboardAdvice(BaseModel):
    status: Literal["ok", "warning", "error"] = "ok"
    headline: str
    messages: list[str] = Field(default_factory=list)
    next_actions: list[str] = Field(default_factory=list)


class SolveResponse(BaseModel):
    lean_code: str
    compile: CompileResult
    interpretation: Interpretation | None = None
    interpretation_error: str | None = None
    highlights: HighlightResolveResponse | None = None
    dashboard: DashboardAdvice | None = None
    pipeline: PipelineTrace | None = None
