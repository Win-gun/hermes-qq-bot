#!/bin/zsh
# Runs from a per-user LaunchAgent after macOS login. The bridge itself has its
# own KeepAlive agent; this helper only makes Docker/SnowLuma available first.

set -u

project_dir="${HERMES_QQ_HOME:-${0:A:h:h}}"
log_dir="$project_dir/logs"
log_file="$log_dir/startup-bootstrap.log"
bridge_label="com.codex.qq-hermes-onebot-bridge"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"

mkdir -p "$log_dir"

log() {
  print -r -- "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$log_file"
}

if ! command -v docker >/dev/null 2>&1; then
  log "docker command is unavailable; will retry on the next scheduled run"
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  log "Docker is not ready; requesting Docker Desktop startup"
  /usr/bin/open -gja Docker >/dev/null 2>&1 || log "could not launch Docker Desktop"

  docker_ready=false
  for _attempt in {1..60}; do
    if docker info >/dev/null 2>&1; then
      docker_ready=true
      break
    fi
    /bin/sleep 2
  done

  if [[ "$docker_ready" != true ]]; then
    log "Docker did not become ready within 120 seconds; will retry in five minutes"
    exit 0
  fi
fi

snowluma_containers=("${(@f)$(node -e '
const fs = require("fs");
const configPath = process.argv[1];
try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const accounts = [config.accounts?.primary, ...(config.accounts?.standbys || [])]
    .filter((account) => account && account.enabled !== false)
    .filter((account) => String(account.protocol || "napcat").toLowerCase() === "snowluma")
    .map((account, index) => String(account.protocolContainer || account.snowlumaContainer || (index === 0 ? "snowluma-primary" : `snowluma-standby-${index}`)).trim())
    .filter(Boolean);
  process.stdout.write([...new Set(accounts)].join("\n"));
} catch (error) {
  process.stderr.write(`config read failed: ${error.message}\\n`);
  process.exit(1);
}
' "$project_dir/config.json" 2>>"$log_file")}")

if (( ${#snowluma_containers[@]} == 0 )); then
  log "no enabled SnowLuma container is configured"
else
  for container in "${snowluma_containers[@]}"; do
    if ! docker inspect "$container" >/dev/null 2>&1; then
      log "SnowLuma container is missing: $container"
      continue
    fi
    docker update --restart unless-stopped "$container" >/dev/null 2>&1 || log "could not set restart policy for $container"
    docker start "$container" >/dev/null 2>&1 || log "could not start $container (it may already be running)"
    log "SnowLuma container available: $container"
  done
fi

/bin/launchctl kickstart "gui/$UID/$bridge_label" >/dev/null 2>&1 || log "could not ensure $bridge_label is running"
log "bootstrap completed"
