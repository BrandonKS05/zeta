from __future__ import annotations

import asyncio
import logging
import os
import re
import tempfile
from pathlib import Path

from .models import CompileResult, Diagnostic
from .settings import Settings, get_settings
from .utils import truncate_text

logger = logging.getLogger(__name__)

_DIAG_RE = re.compile(
    r"^(?P<file>.*?):(?P<line>\d+):(?P<column>\d+): (?P<severity>error|warning|info): (?P<message>.*)$"
)
_DIAG_NO_COL_RE = re.compile(
    r"^(?P<file>.*?):(?P<line>\d+): (?P<severity>error|warning|info): (?P<message>.*)$"
)
_MATHLIB_IMPORT_RE = re.compile(r"(?m)^\s*import\s+Mathlib(?:\.|$)")
_NO_DEFAULT_TOOLCHAIN_RE = re.compile(r"no default toolchain configured", re.IGNORECASE)


def parse_lean_diagnostics(output: str) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    active: Diagnostic | None = None

    for raw_line in output.splitlines():
        line = raw_line.rstrip()
        match = _DIAG_RE.match(line) or _DIAG_NO_COL_RE.match(line)

        if match:
            if active is not None:
                diagnostics.append(active)

            severity = match.group("severity")
            col_group = match.groupdict().get("column")
            active = Diagnostic(
                severity=severity,
                file=match.group("file") or None,
                line=int(match.group("line")),
                column=int(col_group) if col_group else None,
                message=match.group("message").strip(),
                raw=line,
            )
            continue

        if active is not None and line.startswith(" ") and line.strip():
            active.message = f"{active.message}\n{line.strip()}"
            active.raw = f"{active.raw}\n{line}" if active.raw else line
            continue

        if active is not None:
            diagnostics.append(active)
            active = None

    if active is not None:
        diagnostics.append(active)

    return diagnostics


def _extract_elan_command_candidates(*, elan_command: str, lean_command: str) -> list[str]:
    candidates: list[str] = []

    def _add(candidate: str | None) -> None:
        if not candidate:
            return
        value = candidate.strip()
        if value and value not in candidates:
            candidates.append(value)

    _add(elan_command)

    lean_path = Path(lean_command)
    if lean_path.name == "lean" and lean_path.parent.as_posix() not in {"", "."}:
        _add((lean_path.parent / "elan").as_posix())

    _add("/root/.elan/bin/elan")
    _add((Path.home() / ".elan" / "bin" / "elan").as_posix())
    return candidates


def _has_missing_default_toolchain_error(output: str, diagnostics: list[Diagnostic]) -> bool:
    if _NO_DEFAULT_TOOLCHAIN_RE.search(output):
        return True
    return any(_NO_DEFAULT_TOOLCHAIN_RE.search(item.message or "") for item in diagnostics)


async def _configure_default_elan_toolchain(
    *,
    elan_command: str,
    lean_command: str,
    default_toolchain: str,
    timeout_seconds: float,
    env: dict[str, str],
) -> tuple[bool, str | None]:
    candidates = _extract_elan_command_candidates(
        elan_command=elan_command,
        lean_command=lean_command,
    )
    errors: list[str] = []

    for candidate in candidates:
        command = [candidate, "default", default_toolchain]
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
        except FileNotFoundError:
            errors.append(f"{candidate}: command not found")
            continue

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=timeout_seconds
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            errors.append(
                f"{candidate}: timed out after {timeout_seconds:.1f}s while setting default toolchain"
            )
            continue

        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        if process.returncode == 0:
            return True, None

        detail = truncate_text((stderr or stdout).strip(), 300)
        if detail:
            errors.append(f"{candidate}: exited with status {process.returncode}: {detail}")
        else:
            errors.append(f"{candidate}: exited with status {process.returncode}")

    message = "; ".join(errors) if errors else "no elan command candidates were available"
    return False, message


async def compile_lean(code: str, *, settings: Settings | None = None) -> CompileResult:
    settings = settings or get_settings()
    lake_project_dir = getattr(settings, "lake_project_dir", None)
    require_lake_for_mathlib = bool(getattr(settings, "require_lake_for_mathlib", True))
    lean_temp_dir = getattr(settings, "lean_temp_dir", None)
    elan_home = getattr(settings, "elan_home", None)
    elan_command = str(getattr(settings, "elan_command", "elan"))
    auto_configure_elan_toolchain = bool(
        getattr(settings, "auto_configure_elan_toolchain", True)
    )
    elan_default_toolchain = str(getattr(settings, "elan_default_toolchain", "stable"))
    elan_toolchain_install_timeout_seconds = float(
        getattr(settings, "elan_toolchain_install_timeout_seconds", 180.0)
    )
    lean_timeout_seconds = float(getattr(settings, "lean_timeout_seconds", 15.0))
    compiler_output_max_chars = int(getattr(settings, "compiler_output_max_chars", 20_000))
    lean_command = str(getattr(settings, "lean_command", "lean"))
    lake_command = str(getattr(settings, "lake_command", "lake"))

    uses_mathlib = bool(_MATHLIB_IMPORT_RE.search(code))
    if uses_mathlib and not lake_project_dir and require_lake_for_mathlib:
        message = (
            "Generated Lean code imports Mathlib, but LAKE_PROJECT_DIR is not configured. "
            "Set LAKE_PROJECT_DIR to a Lake project with Mathlib installed."
        )
        diagnostic = Diagnostic(severity="error", message=message)
        return CompileResult(success=False, stdout="", stderr=message, diagnostics=[diagnostic])

    project_dir_path: Path | None = None
    if lake_project_dir:
        project_dir_path = Path(lake_project_dir)
        if not project_dir_path.exists():
            message = (
                f"LAKE_PROJECT_DIR does not exist: '{lake_project_dir}'. "
                "Create/bootstrap the Lake project before compiling."
            )
            diagnostic = Diagnostic(severity="error", message=message)
            return CompileResult(success=False, stdout="", stderr=message, diagnostics=[diagnostic])
        has_lake_file = (
            (project_dir_path / "lakefile.lean").exists()
            or (project_dir_path / "lakefile.toml").exists()
        )
        if not has_lake_file:
            message = (
                f"LAKE_PROJECT_DIR '{lake_project_dir}' is missing lakefile.lean/lakefile.toml. "
                "Initialize a Lake project there (for example using bootstrap_mathlib_project.sh)."
            )
            diagnostic = Diagnostic(severity="error", message=message)
            return CompileResult(success=False, stdout="", stderr=message, diagnostics=[diagnostic])

    temp_parent: Path | None = None
    if lean_temp_dir:
        temp_parent = Path(lean_temp_dir)
        temp_parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix="lean_compile_",
        dir=temp_parent.as_posix() if temp_parent else None,
    ) as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        main_file = tmp_dir / "Main.lean"
        main_file.write_text(code, encoding="utf-8")

        compile_attempts: list[tuple[list[str], str, str]] = []
        if project_dir_path:
            compile_attempts.append(
                (
                    [lake_command, "env", lean_command, str(main_file)],
                    project_dir_path.as_posix(),
                    "lake",
                )
            )
            # If Lake bootstrap/network state is unhealthy, allow non-Mathlib snippets to
            # fall back to plain `lean` so simple statements still compile.
            if not uses_mathlib:
                compile_attempts.append(
                    (
                        [lean_command, str(main_file)],
                        tmp_dir_str,
                        "standalone",
                    )
                )
        else:
            compile_attempts.append(([lean_command, str(main_file)], tmp_dir_str, "standalone"))

        env = os.environ.copy()
        if elan_home:
            env["ELAN_HOME"] = str(elan_home)

        last_result: CompileResult | None = None
        elan_bootstrap_attempted = False
        for attempt_index, (command, cwd, mode) in enumerate(compile_attempts, start=1):
            while True:
                logger.info(
                    "lean_compile_started attempt=%s/%s mode=%s command=%s cwd=%s code_chars=%s",
                    attempt_index,
                    len(compile_attempts),
                    mode,
                    " ".join(command),
                    cwd,
                    len(code),
                )

                try:
                    process = await asyncio.create_subprocess_exec(
                        *command,
                        cwd=cwd,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        env=env,
                    )
                except FileNotFoundError:
                    if attempt_index < len(compile_attempts):
                        logger.warning(
                            "lean_compile_command_missing mode=%s command=%s; trying fallback",
                            mode,
                            command[0],
                        )
                        break
                    message = (
                        f"Lean compiler command not found: '{command[0]}'. "
                        "Install Lean 4 (elan) or set LEAN_COMMAND/LAKE_COMMAND correctly."
                    )
                    diagnostic = Diagnostic(severity="error", message=message)
                    return CompileResult(success=False, stdout="", stderr=message, diagnostics=[diagnostic])

                try:
                    stdout_bytes, stderr_bytes = await asyncio.wait_for(
                        process.communicate(), timeout=lean_timeout_seconds
                    )
                except asyncio.TimeoutError:
                    process.kill()
                    await process.communicate()
                    if attempt_index < len(compile_attempts):
                        logger.warning(
                            "lean_compile_timeout mode=%s timeout=%ss; trying fallback",
                            mode,
                            lean_timeout_seconds,
                        )
                        break
                    timeout_message = f"Lean compile timed out after {lean_timeout_seconds:.1f}s"
                    diagnostic = Diagnostic(severity="error", message=timeout_message)
                    return CompileResult(
                        success=False,
                        stdout="",
                        stderr=timeout_message,
                        diagnostics=[diagnostic],
                    )

                stdout = stdout_bytes.decode("utf-8", errors="replace")
                stderr = stderr_bytes.decode("utf-8", errors="replace")

                logger.info(
                    "lean_compile_finished attempt=%s/%s mode=%s return_code=%s stdout_len=%s stderr_len=%s",
                    attempt_index,
                    len(compile_attempts),
                    mode,
                    process.returncode,
                    len(stdout),
                    len(stderr),
                )
                logger.debug("lean stdout full output: %s", stdout)
                logger.debug("lean stderr full output: %s", stderr)

                raw_output = f"{stderr}\n{stdout}".strip()
                diagnostics = parse_lean_diagnostics(raw_output)
                if process.returncode != 0 and not any(d.severity == "error" for d in diagnostics):
                    fallback_message = (stderr or stdout or "Lean compile failed with unknown error").strip()
                    diagnostics.append(
                        Diagnostic(
                            severity="error",
                            message=truncate_text(fallback_message, 500),
                            raw=truncate_text(fallback_message, 500),
                        )
                    )

                should_try_elan_bootstrap = (
                    process.returncode != 0
                    and auto_configure_elan_toolchain
                    and not elan_bootstrap_attempted
                    and _has_missing_default_toolchain_error(raw_output, diagnostics)
                )
                if should_try_elan_bootstrap:
                    elan_bootstrap_attempted = True
                    logger.warning(
                        "lean_compile_detected_no_default_toolchain mode=%s; attempting elan default %s",
                        mode,
                        elan_default_toolchain,
                    )
                    configured, elan_error = await _configure_default_elan_toolchain(
                        elan_command=elan_command,
                        lean_command=lean_command,
                        default_toolchain=elan_default_toolchain,
                        timeout_seconds=elan_toolchain_install_timeout_seconds,
                        env=env,
                    )
                    if configured:
                        logger.warning(
                            "lean_compile_elan_bootstrap_succeeded mode=%s; retrying compile",
                            mode,
                        )
                        continue

                    diagnostic_message = (
                        "Lean toolchain bootstrap failed while running "
                        f"`elan default {elan_default_toolchain}`: {elan_error}"
                    )
                    diagnostics.append(
                        Diagnostic(
                            severity="error",
                            message=truncate_text(diagnostic_message, 500),
                            raw=truncate_text(diagnostic_message, 500),
                        )
                    )

                success = process.returncode == 0 and not any(d.severity == "error" for d in diagnostics)
                result = CompileResult(
                    success=success,
                    stdout=truncate_text(stdout, compiler_output_max_chars),
                    stderr=truncate_text(stderr, compiler_output_max_chars),
                    diagnostics=diagnostics,
                )
                if success:
                    if mode == "standalone" and attempt_index > 1:
                        logger.warning(
                            "lean_compile_fallback_succeeded primary_failed=true uses_mathlib=%s",
                            uses_mathlib,
                        )
                    return result

                last_result = result
                if attempt_index < len(compile_attempts):
                    logger.warning(
                        "lean_compile_retrying_fallback previous_mode=%s return_code=%s uses_mathlib=%s",
                        mode,
                        process.returncode,
                        uses_mathlib,
                    )
                break

        if last_result is not None:
            return last_result

        message = "Lean compile failed: no compile attempts were executed."
        diagnostic = Diagnostic(severity="error", message=message)
        return CompileResult(success=False, stdout="", stderr=message, diagnostics=[diagnostic])
