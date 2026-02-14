from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from app.lean_compile import compile_lean


def test_compile_lean_success_with_fake_compiler(tmp_path: Path) -> None:
    fake_lean = tmp_path / "fake_lean.sh"
    fake_lean.write_text(
        "#!/usr/bin/env bash\n"
        "file=\"$1\"\n"
        "if grep -q BROKEN \"$file\"; then\n"
        "  echo \"$file:2:9: error: unknown constant 'Foo'\" >&2\n"
        "  exit 1\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    fake_lean.chmod(0o755)

    settings = SimpleNamespace(
        lean_command=str(fake_lean),
        lake_command="lake",
        lake_project_dir=None,
        lean_timeout_seconds=5.0,
        compiler_output_max_chars=20_000,
    )

    result = asyncio.run(compile_lean("def ok : Nat := 1", settings=settings))

    assert result.success is True
    assert result.stderr == ""
    assert result.diagnostics == []


def test_compile_lean_failure_with_fake_compiler(tmp_path: Path) -> None:
    fake_lean = tmp_path / "fake_lean.sh"
    fake_lean.write_text(
        "#!/usr/bin/env bash\n"
        "file=\"$1\"\n"
        "if grep -q BROKEN \"$file\"; then\n"
        "  echo \"$file:2:9: error: unknown constant 'Foo'\" >&2\n"
        "  exit 1\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    fake_lean.chmod(0o755)

    settings = SimpleNamespace(
        lean_command=str(fake_lean),
        lake_command="lake",
        lake_project_dir=None,
        lean_timeout_seconds=5.0,
        compiler_output_max_chars=20_000,
    )

    result = asyncio.run(compile_lean("-- BROKEN\ndef bad : Nat := 1", settings=settings))

    assert result.success is False
    assert "unknown constant" in result.stderr
    assert len(result.diagnostics) == 1
    assert result.diagnostics[0].line == 2
    assert result.diagnostics[0].column == 9
