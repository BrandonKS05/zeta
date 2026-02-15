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


def test_compile_lean_falls_back_to_standalone_when_lake_fails_for_non_mathlib(
    tmp_path: Path,
) -> None:
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

    fake_lake = tmp_path / "fake_lake.sh"
    fake_lake.write_text(
        "#!/usr/bin/env bash\n"
        "echo \"info: lean_backend_mathlib: no previous manifest, creating one from scratch\" >&2\n"
        "echo \"info: mathlib: cloning https://github.com/leanprover-community/mathlib4.git\" >&2\n"
        "echo \"error: external command 'git' exited with code 255\" >&2\n"
        "exit 1\n",
        encoding="utf-8",
    )
    fake_lake.chmod(0o755)

    project_dir = tmp_path / "lake-project"
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "lakefile.lean").write_text(
        "import Lake\n"
        "open Lake DSL\n"
        "package lean_backend_mathlib\n",
        encoding="utf-8",
    )

    settings = SimpleNamespace(
        lean_command=str(fake_lean),
        lake_command=str(fake_lake),
        lake_project_dir=str(project_dir),
        require_lake_for_mathlib=True,
        lean_timeout_seconds=5.0,
        compiler_output_max_chars=20_000,
        lean_temp_dir=None,
        elan_home=None,
    )

    result = asyncio.run(compile_lean("def ok : Nat := 1", settings=settings))

    assert result.success is True
    assert result.stderr == ""
    assert result.diagnostics == []


def test_compile_lean_does_not_fallback_to_standalone_for_mathlib_inputs(tmp_path: Path) -> None:
    fake_lean = tmp_path / "fake_lean.sh"
    fake_lean.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    fake_lean.chmod(0o755)

    fake_lake = tmp_path / "fake_lake.sh"
    fake_lake.write_text(
        "#!/usr/bin/env bash\n"
        "echo \"info: lean_backend_mathlib: no previous manifest, creating one from scratch\" >&2\n"
        "echo \"info: mathlib: cloning https://github.com/leanprover-community/mathlib4.git\" >&2\n"
        "echo \"error: external command 'git' exited with code 255\" >&2\n"
        "exit 1\n",
        encoding="utf-8",
    )
    fake_lake.chmod(0o755)

    project_dir = tmp_path / "lake-project"
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "lakefile.lean").write_text(
        "import Lake\n"
        "open Lake DSL\n"
        "package lean_backend_mathlib\n",
        encoding="utf-8",
    )

    settings = SimpleNamespace(
        lean_command=str(fake_lean),
        lake_command=str(fake_lake),
        lake_project_dir=str(project_dir),
        require_lake_for_mathlib=True,
        lean_timeout_seconds=5.0,
        compiler_output_max_chars=20_000,
        lean_temp_dir=None,
        elan_home=None,
    )

    result = asyncio.run(
        compile_lean("import Mathlib.Data.Real.Basic\n#check (0 : Real)", settings=settings)
    )

    assert result.success is False
    assert "external command 'git' exited with code 255" in result.stderr


def test_compile_lean_bootstraps_elan_default_toolchain_on_missing_default(tmp_path: Path) -> None:
    marker = tmp_path / "toolchain_ready"

    fake_lean = tmp_path / "fake_lean.sh"
    fake_lean.write_text(
        "#!/usr/bin/env bash\n"
        f"marker=\"{marker.as_posix()}\"\n"
        "if [ ! -f \"$marker\" ]; then\n"
        "  echo 'error: no default toolchain configured. run `elan default stable` to install & configure the latest Lean 4 stable release.' >&2\n"
        "  exit 1\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    fake_lean.chmod(0o755)

    fake_elan = tmp_path / "fake_elan.sh"
    fake_elan.write_text(
        "#!/usr/bin/env bash\n"
        f"marker=\"{marker.as_posix()}\"\n"
        "if [ \"$1\" = \"default\" ] && [ \"$2\" = \"stable\" ]; then\n"
        "  touch \"$marker\"\n"
        "  exit 0\n"
        "fi\n"
        "echo \"unexpected elan args: $*\" >&2\n"
        "exit 1\n",
        encoding="utf-8",
    )
    fake_elan.chmod(0o755)

    settings = SimpleNamespace(
        lean_command=str(fake_lean),
        lake_command="lake",
        elan_command=str(fake_elan),
        lake_project_dir=None,
        auto_configure_elan_toolchain=True,
        elan_default_toolchain="stable",
        elan_toolchain_install_timeout_seconds=5.0,
        lean_timeout_seconds=5.0,
        compiler_output_max_chars=20_000,
        lean_temp_dir=None,
        elan_home=None,
    )

    result = asyncio.run(compile_lean("def ok : Nat := 1", settings=settings))

    assert marker.exists()
    assert result.success is True
    assert result.stderr == ""
    assert result.diagnostics == []
