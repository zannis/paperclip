const REMOTE_EXECUTION_ENV_IDENTITY_KEYS = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "NVM_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);

function readEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string") return direct;
  const upper = key.toUpperCase();
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (candidateKey.toUpperCase() === upper && typeof candidateValue === "string") {
      return candidateValue;
    }
  }
  return undefined;
}

// Network settings an operator commonly sets both on the server and in agent
// config. Installs need them, and they are not server secrets.
const SANDBOX_SETUP_ENV_SHARED_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NPM_CONFIG_REGISTRY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

// Drops every key whose value is the one the server process inherited, so a
// caller that merged the host env into a sandbox env cannot ship host secrets
// into the sandbox. Values the run set or changed survive. Only for setup
// commands (installs, probes, file helpers), never for the agent launch: a
// launch credential may legitimately equal the host's.
export function sanitizeSandboxSetupEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(sanitizeRemoteExecutionEnv(env, inheritedEnv))) {
    if (inheritedEnv[key] === value && !SANDBOX_SETUP_ENV_SHARED_KEYS.has(key.toUpperCase())) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function sanitizeRemoteExecutionEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (!REMOTE_EXECUTION_ENV_IDENTITY_KEYS.has(normalizedKey)) {
      sanitized[key] = value;
      continue;
    }
    const inheritedValue = readEnvValueCaseInsensitive(inheritedEnv, key);
    if (typeof inheritedValue === "string" && inheritedValue === value) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
