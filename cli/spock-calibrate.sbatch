#!/bin/bash
# cli/spock-calibrate.sbatch — calibrat3 command line as a Slurm job (CPU only).
#
#   sbatch -p all --cpus-per-task 16 --mem 12G --time 2:00:00 \
#       ~/calibrat3/cli/spock-calibrate.sbatch <session-folder> <calibration.toml> [calibrate.mjs options...]
#
# Writes <calibration.toml>, plus <calibration>.calibrat3.json (a session the app can open)
# and <calibration>.report.json next to it. Needs Node >= 20 on PATH (see README.md,
# "On a Slurm cluster") and ffmpeg (module load ffmpeg/6.1).
#SBATCH --job-name=calibrat3
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=12G
#SBATCH --time=02:00:00
#SBATCH --output=calibrat3-%j.log
set -euo pipefail

if [ $# -lt 2 ]; then
    echo "usage: sbatch [slurm options] $0 <session-folder> <calibration.toml> [calibrate.mjs options...]" >&2
    exit 2
fi
SESSION="$1"; OUT="$2"; shift 2

module load ffmpeg/6.1 2>/dev/null || echo "module load ffmpeg/6.1 failed; using $(command -v ffmpeg || echo 'no ffmpeg')" >&2
[ -d "$HOME/opt" ] && for d in "$HOME"/opt/node-v*/bin; do [ -x "$d/node" ] && PATH="$d:$PATH"; done
command -v node >/dev/null || { echo "node not found: install Node >= 20 (see README.md)" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# sbatch copies the script to a spool directory: find calibrate.mjs from the submit directory too.
CLI="$HERE/calibrate.mjs"
[ -f "$CLI" ] || CLI="${CALIBRAT3:-$HOME/calibrat3}/cli/calibrate.mjs"
STEM="${OUT%.toml}"

echo "node $(node --version), $(ffmpeg -version | head -1), ${SLURM_CPUS_PER_TASK:-?} CPUs, host $(hostname)"
node "$CLI" "$SESSION" --out "$OUT" --session-out "$STEM.calibrat3.json" --report "$STEM.report.json" "$@"
