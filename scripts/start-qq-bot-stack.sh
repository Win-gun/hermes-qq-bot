#!/bin/zsh
# Runs from a per-user LaunchAgent after macOS login. The bridge itself has its
# own KeepAlive agent; this helper makes managed protocol containers available.

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

resource_dir="${HERMES_QQ_RESOURCE_ROOT:-${0:A:h:h}}"
if ! container_list=$(node --input-type=module -e '
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const { accountItems, registryConfig } = await import(pathToFileURL(process.argv[2]).href);
try {
  const config = registryConfig(JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
  const containers = accountItems(config)
    .filter((account) => account.managed !== false && account.protocolEnabled !== false)
    .map((account) => String(account.protocolContainer || account.snowlumaContainer || account.napcatContainer || "").trim())
    .filter(Boolean);
  process.stdout.write([...new Set(containers)].join("\n"));
} catch {
  process.stderr.write("account registry read failed\n");
  process.exit(1);
}
' "$project_dir/config.json" "$resource_dir/src/account-registry.js" 2>>"$log_file"); then
  log "could not read account registry; no containers were changed"
  exit 1
fi
protocol_containers=("${(@f)container_list}")
if [[ -z "$container_list" ]]; then
  log "no nonarchived managed protocol-enabled account is configured"
  /bin/launchctl kickstart "gui/$UID/$bridge_label" >/dev/null 2>&1 || log "could not ensure $bridge_label is running"
  exit 0
fi

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

for container in "${protocol_containers[@]}"; do
  if ! docker inspect "$container" >/dev/null 2>&1; then
    log "protocol container is missing: $container"
    continue
  fi
  docker update --restart unless-stopped "$container" >/dev/null 2>&1 || log "could not set restart policy for $container"
  docker start "$container" >/dev/null 2>&1 || log "could not start $container (it may already be running)"
  log "protocol container available: $container"
done

/bin/launchctl kickstart "gui/$UID/$bridge_label" >/dev/null 2>&1 || log "could not ensure $bridge_label is running"
log "bootstrap completed"
