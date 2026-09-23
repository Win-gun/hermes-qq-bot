#!/usr/bin/env bash
set -euo pipefail

ROOT="${HERMES_QQ_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CONTAINER_NAME="${NAPCAT_CONTAINER_NAME:-napcat}"
DEVICE_ENV="$ROOT/napcat/device.env"

if [[ -f "$DEVICE_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DEVICE_ENV"
  set +a
fi

IMAGE="${NAPCAT_IMAGE:-mlikiowa/napcat-docker:latest}"
STABLE_HOSTNAME="${NAPCAT_STABLE_HOSTNAME:-qq-hermes-napcat}"
STABLE_MAC_ADDRESS="${NAPCAT_STABLE_MAC_ADDRESS:-}"

mkdir -p "$ROOT/napcat/config" "$ROOT/napcat/plugins" "$ROOT/napcat/QQ"
if [[ -n "${NAPCAT_STABLE_MACHINE_ID:-}" ]]; then
  STABLE_MACHINE_ID="$NAPCAT_STABLE_MACHINE_ID"
elif [[ -s "$ROOT/napcat/machine-id" ]]; then
  STABLE_MACHINE_ID="$(<"$ROOT/napcat/machine-id")"
else
  STABLE_MACHINE_ID="$(openssl rand -hex 16)"
fi
printf '%s\n' "$STABLE_MACHINE_ID" > "$ROOT/napcat/machine-id"
chmod 600 "$ROOT/napcat/machine-id"

ENV_FILE="$(mktemp)"
cleanup() {
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  docker inspect "$CONTAINER_NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' > "$ENV_FILE"
else
  echo "ERROR: container '$CONTAINER_NAME' does not exist, cannot preserve ACCOUNT/NAPCAT_QUICK_PASSWORD_MD5 env." >&2
  echo "Create it once with the required env vars, or recreate from a saved env file manually." >&2
  exit 1
fi

if [[ "${NAPCAT_DISABLE_PASSWORD_FALLBACK:-0}" == "1" || "${NAPCAT_DISABLE_PASSWORD_FALLBACK:-}" == "true" ]]; then
  FILTERED_ENV_FILE="$(mktemp)"
  grep -v -E '^(NAPCAT_QUICK_PASSWORD_MD5|NAPCAT_PASSWORD|PASSWORD)=' "$ENV_FILE" > "$FILTERED_ENV_FILE" || true
  mv "$FILTERED_ENV_FILE" "$ENV_FILE"
fi

docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true

run_args=(
  run -d
  --name "$CONTAINER_NAME"
  --restart always
  --hostname "$STABLE_HOSTNAME"
  --env-file "$ENV_FILE"
  -p 6099:6099
  -v "$ROOT/napcat/config:/app/napcat/config"
  -v "$ROOT/napcat/plugins:/app/napcat/plugins"
  -v "$ROOT/napcat/QQ:/app/.config/QQ"
  -v "$ROOT/napcat/machine-id:/etc/machine-id:ro"
  -v "$ROOT/napcat/machine-id:/var/lib/dbus/machine-id:ro"
)

if [[ -n "$STABLE_MAC_ADDRESS" ]]; then
  run_args+=(--mac-address "$STABLE_MAC_ADDRESS")
fi

run_args+=("$IMAGE")

docker "${run_args[@]}"

echo "NapCat recreated with stable device identity:"
echo "  image=$IMAGE"
echo "  hostname=$STABLE_HOSTNAME"
echo "  machine_id=stored-in-user-state"
echo "  mac_address=${STABLE_MAC_ADDRESS:-docker-default}"
if [[ "${NAPCAT_DISABLE_PASSWORD_FALLBACK:-0}" == "1" || "${NAPCAT_DISABLE_PASSWORD_FALLBACK:-}" == "true" ]]; then
  echo "  password_fallback=disabled"
fi
