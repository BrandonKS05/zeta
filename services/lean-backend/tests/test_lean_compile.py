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


def test_compile_lean_mathlib_requires_lake_project() -> None:
    settings = SimpleNamespace(
        lean_command="lean",
        lake_command="lake",
        lake_project_dir=None,
        require_lake_for_mathlib=True,
        lean_timeout_seconds=5.0,
        compiler_output_max_chars=20_000,
        lean_temp_dir=None,
        elan_home=None,
    )

    result = asyncio.run(compile_lean("import Mathlib.Data.Real.Basic\n#check (0 : Real)", settings=settings))

    assert result.success is False
    assert "LAKE_PROJECT_DIR" in result.stderr
    assert result.diagnostics
    assert "Mathlib" in result.diagnostics[0].message


def test_compile_lean_missing_lake_project_dir_is_clear(tmp_path: Path) -> None:
    missing_dir = tmp_path / "does-not-exist"
    settings = SimpleNamespace(
        lean_command="lean",
        lake_command="lake",
        lake_project_dir=str(missing_dir),
        require_lake_for_mathlib=True,
        lean_timeout_seconds=5.0,
        compiler_output_max_chars=20_000,
        lean_temp_dir=None,
        elan_home=None,
    )

    result = asyncio.run(compile_lean("def ok : Nat := 1", settings=settings))

    assert result.success is False
    assert "does not exist" in result.stderr
    assert result.diagnostics
    assert "LAKE_PROJECT_DIR" in result.diagnostics[0].message
