#!/usr/bin/env bash
# A local Jitsi for development and the browser test suite.
#
#   deploy/jitsi-local/jitsi-local.sh up      # download (once), configure, start
#   deploy/jitsi-local/jitsi-local.sh down    # stop
#   deploy/jitsi-local/jitsi-local.sh reset   # stop and delete its state
#
# It runs the official docker-jitsi-meet release pinned below, with JWT auth
# and the settings LiveDeck's server signs tokens for (server/.env.example,
# "Option B"). The release and its state live in ~/.cache/livedeck-jitsi
# (JITSI_LOCAL_HOME to move it): on a Linux filesystem, because prosody's
# account files do not survive a Windows-mounted drive under WSL.
#
# THE ADVERTISED ADDRESS
# ----------------------
# The video bridge must advertise an address the browser can send UDP to.
# Chrome never uses loopback for WebRTC, so 127.0.0.1 does not work. The
# default is this machine's first address (`hostname -I`): the LAN address
# on Linux, the WSL VM's address under WSL, which Windows browsers reach.
# Override with JITSI_ADVERTISE_IP.
#
# The JWT secret here is for this local stack only; it is never deployed.
set -euo pipefail

RELEASE=stable-11248
HOME_DIR="${JITSI_LOCAL_HOME:-$HOME/.cache/livedeck-jitsi}"
RELEASE_DIR="$HOME_DIR/$RELEASE"
CONFIG_DIR="$HOME_DIR/config"
PUBLIC_URL="${JITSI_PUBLIC_URL:-https://localhost:8443}"
APP_ID=livedeck
APP_SECRET="${JITSI_APP_SECRET:-livedeck-local-jitsi-secret-0123456789}"
ADVERTISE_IP="${JITSI_ADVERTISE_IP:-$(hostname -I | awk '{print $1}')}"

compose() {
  (cd "$RELEASE_DIR" && docker compose --project-name livedeck-jitsi "$@")
}

download() {
  [ -f "$RELEASE_DIR/docker-compose.yml" ] && return
  mkdir -p "$RELEASE_DIR"
  echo "Downloading docker-jitsi-meet $RELEASE…"
  curl -fsSL "https://github.com/jitsi/docker-jitsi-meet/archive/refs/tags/$RELEASE.tar.gz" \
    | tar xz -C "$RELEASE_DIR" --strip-components=1
}

configure() {
  local env="$RELEASE_DIR/.env"
  cp "$RELEASE_DIR/env.example" "$env"
  (cd "$RELEASE_DIR" && bash gen-passwords.sh >/dev/null)
  cat >> "$env" <<CONF
CONFIG=$CONFIG_DIR
PUBLIC_URL=$PUBLIC_URL
HTTPS_PORT=${PUBLIC_URL##*:}
JVB_ADVERTISE_IPS=$ADVERTISE_IP
ENABLE_AUTH=1
ENABLE_GUESTS=0
AUTH_TYPE=jwt
JWT_APP_ID=$APP_ID
JWT_APP_SECRET=$APP_SECRET
JWT_ACCEPTED_ISSUERS=$APP_ID
JWT_ACCEPTED_AUDIENCES=jitsi
XMPP_MODULES=presence_identity
ENABLE_LETSENCRYPT=0
CONF
  # The containers write as uid 1000; give them their storage up front.
  mkdir -p "$CONFIG_DIR"
  docker run --rm -v "$CONFIG_DIR:/cfg" alpine:3.20 sh -c \
    'mkdir -p /cfg/web /cfg/transcripts /cfg/prosody/config /cfg/prosody/prosody-plugins-custom /cfg/jicofo /cfg/jvb /cfg/storage/web /cfg/storage/prosody /cfg/storage/jicofo /cfg/storage/jvb && chmod -R 777 /cfg'
}

wait_ready() {
  # Ready means the web server answers AND the conference focus has logged
  # in and found the video bridge; before that, every join times out.
  for _ in $(seq 1 90); do
    if curl -skf -o /dev/null "$PUBLIC_URL/libs/lib-jitsi-meet.min.js" \
      && compose logs jicofo 2>/dev/null | grep -q 'Added new videobridge'; then
      echo "Jitsi is up at $PUBLIC_URL (bridge advertises $ADVERTISE_IP)."
      echo "Server env: JITSI_PUBLIC_URL=$PUBLIC_URL JITSI_DOMAIN=meet.jitsi JITSI_APP_ID=$APP_ID JITSI_APP_SECRET=$APP_SECRET"
      return
    fi
    sleep 2
  done
  echo "Jitsi did not come up; see: docker compose --project-name livedeck-jitsi logs" >&2
  exit 1
}

case "${1:-up}" in
  up)
    download
    configure
    compose up -d
    wait_ready
    ;;
  down)
    [ -d "$RELEASE_DIR" ] && compose down
    ;;
  reset)
    [ -d "$RELEASE_DIR" ] && compose down -v
    docker run --rm -v "$HOME_DIR:/h" alpine:3.20 rm -rf /h/config
    ;;
  *)
    echo "usage: $0 up|down|reset" >&2
    exit 2
    ;;
esac
