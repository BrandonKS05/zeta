#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${1:-${LAKE_PROJECT_DIR:-/opt/lean-state/mathlib-project}}"
MATHLIB_GIT_URL="${MATHLIB_GIT_URL:-https://github.com/leanprover-community/mathlib4.git}"
MATHLIB_REVISION="${MATHLIB_REVISION:-}"
MATHLIB_BOOTSTRAP_TOOLCHAIN="${MATHLIB_BOOTSTRAP_TOOLCHAIN:-stable}"
MATHLIB_PREBUILD_MODULES="${MATHLIB_PREBUILD_MODULES:-Mathlib.Data.Real.Basic}"
CORRUPT_HEAD_PATTERN="could not resolve 'HEAD' to a commit"

if ! command -v lake >/dev/null 2>&1; then
  echo "lake command not found. Install Lean/Lake first." >&2
  exit 1
fi

if ! command -v lean >/dev/null 2>&1; then
  echo "lean command not found. Install Lean first." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git command not found. Install git in this runtime image first." >&2
  exit 1
fi

mkdir -p "${PROJECT_DIR}"
cd "${PROJECT_DIR}"

if [[ ! -f "lean-toolchain" ]]; then
  printf "%s\n" "${MATHLIB_BOOTSTRAP_TOOLCHAIN}" > lean-toolchain
fi

if [[ ! -f "lakefile.lean" && ! -f "lakefile.toml" ]]; then
  REV_SUFFIX=""
  if [[ -n "${MATHLIB_REVISION}" ]]; then
    REV_SUFFIX=" @ \"${MATHLIB_REVISION}\""
  fi
  cat > lakefile.lean <<EOF
import Lake
open Lake DSL

package «lean_backend_mathlib» where

require mathlib from git
  "${MATHLIB_GIT_URL}"${REV_SUFFIX}
EOF
fi

echo "Bootstrapping Lake project at ${PROJECT_DIR}"
run_lake_update() {
  local update_log
  update_log="$(mktemp)"
  if lake update 2>&1 | tee "${update_log}"; then
    rm -f "${update_log}"
    return 0
  fi

  if grep -q "${CORRUPT_HEAD_PATTERN}" "${update_log}"; then
    echo "Detected corrupt mathlib git checkout. Cleaning and retrying lake update..." >&2
    rm -rf .lake/packages/mathlib
    rm -f lake-manifest.json
    if lake update; then
      rm -f "${update_log}"
      return 0
    fi
  fi

  rm -f "${update_log}"
  return 1
}

run_lake_update
lake exe cache get

IFS=',' read -r -a modules <<< "${MATHLIB_PREBUILD_MODULES}"
for raw_module in "${modules[@]}"; do
  module="$(echo "${raw_module}" | xargs)"
  if [[ -z "${module}" ]]; then
    continue
  fi
  echo "Prebuilding module: ${module}"
  lake build "${module}"
done

cat > .bootstrap_probe.lean <<'EOF'
import Mathlib.Data.Real.Basic

#check (0 : Real)
EOF

lake env lean .bootstrap_probe.lean
rm -f .bootstrap_probe.lean

echo "Mathlib project is ready at ${PROJECT_DIR}"
