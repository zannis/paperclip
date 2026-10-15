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
// config. Installs need them, and they are not server secrets. This only
// keeps them when the run's env already carries them, and never when the
// value carries credentials: the guard cannot tell a merged server proxy
// from an operator who set the same credentialed proxy, so a sandbox that
// needs one must be given its own.
const SANDBOX_SETUP_ENV_SHARED_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "NPM_CONFIG_NOPROXY",
  "NPM_CONFIG_CAFILE",
  "NPM_CONFIG_STRICT_SSL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
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
    if (inheritedEnv[key] === value && !isSharedNetworkSetting(key, value)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

// A proxy value with userinfo (`user:pass@`), with or without a scheme, is a
// server credential, not a shared setting.
function isSharedNetworkSetting(key: string, value: string): boolean {
  return SANDBOX_SETUP_ENV_SHARED_KEYS.has(key.toUpperCase()) && !/^\s*(?:[a-z][a-z0-9+.-]*:\/\/)?[^/]*@/i.test(value);
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
