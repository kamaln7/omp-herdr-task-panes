#!/usr/bin/env bash
# Records demo.gif in a throwaway herdr session with throwaway omp/herdr settings.
# Your own omp/herdr config is not modified; the omp-demo herdr session is deleted before and after.
set -euo pipefail
cd "$(dirname "$0")"

export DEMO_DIR=/tmp/omp-herdr-demo
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR/work"

# herdr: copy of your config with the sidebar collapsed, used only by this session.
awk '{ print } /^\[ui\]$/ { print "sidebar_start_collapsed = true" }' ~/.config/herdr/config.toml >"$DEMO_DIR/herdr.toml"

# Forget the herdr/omp pane this script was launched from.
for v in $(compgen -v | grep -E '^(HERDR_|OMPCODE$)'); do unset "$v"; done

export HERDR_CONFIG_PATH="$DEMO_DIR/herdr.toml"
export PI_CONFIG_FILES="$PWD/omp.yml"
export EXT="$(cd .. && pwd)/index.ts"
export PI_CODING_AGENT_SESSION_DIR="$DEMO_DIR/sessions"

# Fresh session every take: herdr otherwise restores the previous take's panes and agents.
cleanup() { herdr session stop omp-demo >/dev/null 2>&1 || true; herdr session delete omp-demo >/dev/null 2>&1 || true; }
cleanup
trap cleanup EXIT
rm -rf frames
vhs demo.tape

# WebM from VHS's lossless frames (text + cursor layers): two-pass VP9 tuned for screen content.
# ~2.3x smaller than VHS's own WebM at the same CRF; one keyframe for the whole clip.
vp9=(-c:v libvpx-vp9 -crf 30 -b:v 0 -pix_fmt yuv420p -row-mt 1 -deadline good -cpu-used 1
	-tune-content screen -g 1000 -auto-alt-ref 1 -lag-in-frames 25 -an)
ffmpeg -loglevel error -y -framerate 20 -i frames/frame-text-%05d.png -framerate 20 -i frames/frame-cursor-%05d.png \
	-filter_complex "[0][1]overlay" -c:v ffv1 "$DEMO_DIR/master.mkv"
ffmpeg -loglevel error -y -i "$DEMO_DIR/master.mkv" "${vp9[@]}" -pass 1 -passlogfile "$DEMO_DIR/vp9" -f null /dev/null
ffmpeg -loglevel error -y -i "$DEMO_DIR/master.mkv" "${vp9[@]}" -pass 2 -passlogfile "$DEMO_DIR/vp9" demo.webm
rm -rf frames
