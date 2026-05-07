#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/common.sh
source "$root/scripts/common.sh"
load_case_config
activate_conda_env

cd "$root"
checkpoint_dir="$root/$AIRMORPH_DIR/checkpoints"
mkdir -p "$checkpoint_dir"

expected=(
  airway_model1.pth
  airway_model2.pth
  airway_model3.pth
  break1.ckpt
  wingsnet.ckpt
  airway_cls.ckpt
)

missing=()
for name in "${expected[@]}"; do
  [[ -f "$checkpoint_dir/$name" ]] || missing+=("$name")
done

if [[ ${#missing[@]} -eq 0 ]]; then
  echo "AirMorph checkpoints already present."
  exit 0
fi

echo "Attempting checkpoint download with gdown..."
python -m gdown --folder "https://drive.google.com/drive/folders/${CHECKPOINTS_DRIVE_FOLDER_ID}?usp=sharing" -O "$checkpoint_dir" --remaining-ok || true

for name in "${expected[@]}"; do
  if [[ ! -f "$checkpoint_dir/$name" ]]; then
    found="$(find "$checkpoint_dir" -type f -name "$name" | head -n 1 || true)"
    if [[ -n "$found" ]]; then
      cp "$found" "$checkpoint_dir/$name"
    fi
  fi
done

still_missing=()
for name in "${expected[@]}"; do
  [[ -f "$checkpoint_dir/$name" ]] || still_missing+=("$name")
done

if [[ ${#still_missing[@]} -gt 0 ]]; then
  echo "Could not locate all AirMorph checkpoints." >&2
  printf 'Missing: %s\n' "${still_missing[@]}" >&2
  echo "Place them in $checkpoint_dir and rerun ./scripts/run_all.sh" >&2
  exit 1
fi

echo "AirMorph checkpoints ready in $checkpoint_dir"
