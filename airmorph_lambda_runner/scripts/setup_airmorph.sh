#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/common.sh
source "$root/scripts/common.sh"
load_case_config

cd "$root"

if ! command -v conda >/dev/null 2>&1; then
  echo "conda is required before setup can continue." >&2
  exit 1
fi

conda_base="$(conda info --base)"
# shellcheck source=/dev/null
source "$conda_base/etc/profile.d/conda.sh"

if ! conda env list | awk '{print $1}' | grep -qx "$CONDA_ENV"; then
  conda create -y -n "$CONDA_ENV" python=3.10
fi
conda activate "$CONDA_ENV"

python -m pip install --upgrade pip setuptools wheel
python -m pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url "$PYTORCH_INDEX_URL"

if [[ ! -d "$AIRMORPH_DIR/.git" ]]; then
  git clone "$AIRMORPH_REPO_URL" "$AIRMORPH_DIR"
fi

cd "$AIRMORPH_DIR"
git fetch --all --tags
git checkout "$AIRMORPH_REF"
python -m pip install -r requirements.txt
python -m pip install gdown

python - <<'PY'
import torch
import SimpleITK as sitk
print("torch", torch.__version__)
print("cuda available", torch.cuda.is_available())
if torch.cuda.is_available():
    print("gpu", torch.cuda.get_device_name(0))
print("SimpleITK", sitk.Version_VersionString())
PY
