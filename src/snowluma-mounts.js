import path from "node:path";

function hostDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[:\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`${label} must be an absolute host directory without mount delimiters`);
  }
  return path.normalize(value);
}

function volumeName(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(value)) {
    throw new TypeError(`${label} must be a named Docker volume`);
  }
  return value;
}

// Pure argv construction: no Docker, filesystem, environment or config access.
export function snowlumaMountArgs(files, volumes = null) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new TypeError("SnowLuma host directories are required");
  }
  const dataDir = hostDirectory(files.dataDir, "dataDir");
  const configDir = hostDirectory(files.configDir, "configDir");
  if (volumes !== null && (typeof volumes !== "object" || Array.isArray(volumes))) {
    throw new TypeError("SnowLuma volumes must be an object or null");
  }
  const gateway = volumes ? volumeName(volumes.snowlumaData, "snowlumaData") : dataDir;
  const mounts = [
    // 2.1.1 uses /app/data; older images and token reads use /app/snowluma-data.
    `${gateway}:/app/data`,
    `${gateway}:/app/snowluma-data`,
    `${path.join(dataDir, "hermes-task-uploads")}:/app/data/hermes-task-uploads`,
    `${configDir}:/app/config`
  ];
  if (volumes) {
    mounts.push(
      `${volumeName(volumes.appConfig, "appConfig")}:/app/.config`,
      `${volumeName(volumes.localShare, "localShare")}:/app/.local/share`
    );
  }
  return mounts.flatMap(mount => ["-v", mount]);
}
