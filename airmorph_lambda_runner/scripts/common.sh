#!/usr/bin/env bash
set -euo pipefail

runner_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

load_case_config() {
  local root
  root="$(runner_root)"
  set -a
  # shellcheck source=/dev/null
  source "$root/case_config.env"
  set +a
}

activate_conda_env() {
  load_case_config
  if ! command -v conda >/dev/null 2>&1; then
    echo "conda is required. On Lambda Labs, use an image with Miniconda/Anaconda or install Miniconda first." >&2
    exit 1
  fi
  local conda_base
  conda_base="$(conda info --base)"
  # shellcheck source=/dev/null
  source "$conda_base/etc/profile.d/conda.sh"
  conda activate "$CONDA_ENV"
}

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing required file: $path" >&2
    exit 1
  fi
}
