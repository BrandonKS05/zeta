from __future__ import annotations

import asyncio
import logging
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


async def compile_lean(code: str, *, settings: Settings | None = None) -> CompileResult:
    settings = settings or get_settings()

    with tempfile.TemporaryDirectory(prefix="lean_compile_") as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        main_file = tmp_dir / "Main.lean"
        main_file.write_text(code, encoding="utf-8")

        if settings.lake_project_dir:
            command = [settings.lake_command, "env", settings.lean_command, str(main_file)]
            cwd = settings.lake_project_dir
        else:
            command = [settings.lean_command, str(main_file)]
            cwd = tmp_dir_str

        logger.info(
            "lean_compile_started command=%s cwd=%s code_chars=%s",
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
            )
        except FileNotFoundError:
            message = (
                f"Lean compiler command not found: '{command[0]}'. "
                "Install Lean 4 (elan) or set LEAN_COMMAND/LAKE_COMMAND correctly."
            )
            diagnostic = Diagnostic(severity="error", message=message)
            return CompileResult(success=False, stdout="", stderr=message, diagnostics=[diagnostic])

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=settings.lean_timeout_seconds
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            timeout_message = (
                f"Lean compile timed out after {settings.lean_timeout_seconds:.1f}s"
            )
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
            "lean_compile_finished return_code=%s stdout_len=%s stderr_len=%s",
            process.returncode,
            len(stdout),
            len(stderr),
        )
        logger.debug("lean stdout full output: %s", stdout)
        logger.debug("lean stderr full output: %s", stderr)

        diagnostics = parse_lean_diagnostics(f"{stderr}\n{stdout}".strip())
        if process.returncode != 0 and not any(d.severity == "error" for d in diagnostics):
            fallback_message = (stderr or stdout or "Lean compile failed with unknown error").strip()
            diagnostics.append(
                Diagnostic(
                    severity="error",
                    message=truncate_text(fallback_message, 500),
                    raw=truncate_text(fallback_message, 500),
                )
            )

        success = process.returncode == 0 and not any(d.severity == "error" for d in diagnostics)

        return CompileResult(
            success=success,
            stdout=truncate_text(stdout, settings.compiler_output_max_chars),
            stderr=truncate_text(stderr, settings.compiler_output_max_chars),
            diagnostics=diagnostics,
        )
