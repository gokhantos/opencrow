/**
 * Shared protected-file guard for the file-ops tools (read/write/edit).
 *
 * This is a CONTENT-CLASS deny check that runs IN ADDITION to the
 * allowedDirectories containment in path-utils. Containment limits *where* a
 * tool may operate; this limits *which credential/secret files* may ever be
 * touched even inside an allowed directory (an agent workspace can still hold a
 * checked-out repo with a committed `.env.example`, a generated `*.pem`, etc.).
 *
 * The boundary that actually stops shell-level exfiltration is the OS sandbox
 * (see ./sandbox.ts). This guard only covers the structured file-ops tools,
 * which never go through a shell.
 */
import { basename } from "node:path";
import { getHome } from "./path-utils";

/**
 * Exact basenames that are always credential/secret material regardless of
 * directory. Matched case-insensitively against the file's basename.
 */
const PROTECTED_BASENAMES: readonly string[] = [
  ".env",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "authorized_keys",
  "known_hosts",
  ".netrc",
  ".pgpass",
  ".npmrc",
  "credentials",
  ".htpasswd",
  // Git stored-credential file (cleartext https tokens).
  ".git-credentials",
  // Kubernetes cluster credentials.
  "kubeconfig",
];

/**
 * Basename patterns (case-insensitive). These catch families like `.env.local`,
 * `*.pem`, `*.key`, `id_rsa.pub`, service-account JSON, etc.
 */
const PROTECTED_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production, .env.foo
  /\.pem$/i, // *.pem
  /\.key$/i, // *.key
  /\.p12$/i, // *.p12 (PKCS#12)
  /\.pfx$/i, // *.pfx
  /\.crt$/i, // *.crt certificates
  /\.cer$/i, // *.cer certificates
  /\.keystore$/i, // java keystores
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, // ssh keypairs incl .pub
  // GCP/service-account-style credential JSON.
  /service[-_]?account.*\.json$/i,
  /.*service[-_]?account\.json$/i,
];

/**
 * Directory segments anywhere in the (resolved) path that mark a secret store.
 * We match on path segments so `~/.ssh/anything`, `~/.aws/credentials`, and the
 * opencrow secrets dir are all covered regardless of the leaf filename.
 */
const PROTECTED_DIR_SEGMENTS: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  // Kubernetes config dir (e.g. ~/.kube/config).
  ".kube",
  // Docker registry credentials dir (~/.docker/config.json holds auth tokens).
  ".docker",
];

/**
 * Absolute path prefixes that mark a secret store regardless of leaf name.
 * Matched as a path prefix (so `/run/secrets/db-password` is covered) — used
 * for multi-segment locations the single-segment check above cannot express.
 */
const PROTECTED_PATH_PREFIXES: readonly string[] = [
  "/run/secrets", // Docker/Kubernetes mounted secrets
  "/var/run/secrets", // Kubernetes service-account token mount
];

/**
 * Returns absolute paths of the app's OWN secret material that must be protected
 * by exact path (not just basename), so a renamed copy (e.g. `env.bak`) under
 * the app/home dirs is still covered. `.env` basenames are caught by pattern
 * already; this adds the resolved app working-dir `.env` and the opencrow home
 * config/secrets explicitly.
 */
function appEnvCandidates(): readonly string[] {
  const out: string[] = [`${process.cwd()}/.env`];
  try {
    const home = getHome();
    out.push(`${home}/.opencrow/.env`, `${home}/.opencrow/config.json`);
  } catch {
    // HOME unset — basename/pattern checks still apply.
  }
  return out;
}

function hasProtectedSegment(absPath: string): boolean {
  const lowerPath = absPath.toLowerCase();
  if (
    PROTECTED_PATH_PREFIXES.some(
      (p) => lowerPath === p || lowerPath.startsWith(`${p}/`),
    )
  ) {
    return true;
  }

  const segments = absPath.split("/").filter(Boolean);
  if (segments.some((seg) => PROTECTED_DIR_SEGMENTS.includes(seg.toLowerCase()))) {
    return true;
  }

  // The opencrow home holds operator secrets/tokens. Protect anything under
  // `~/.opencrow/secrets` and any `*token*`/`*secret*` leaf under `~/.opencrow`.
  try {
    const home = getHome();
    const ocHome = `${home}/.opencrow`;
    if (absPath === ocHome || absPath.startsWith(`${ocHome}/`)) {
      const rest = absPath.slice(ocHome.length + 1).toLowerCase();
      if (rest.startsWith("secrets/") || rest === "secrets") return true;
      const leaf = basename(absPath).toLowerCase();
      if (leaf.includes("token") || leaf.includes("secret") || leaf.includes("credential")) {
        return true;
      }
    }
  } catch {
    // HOME unset — fall through; basename checks still apply.
  }

  return false;
}

/**
 * True if `absPath` (an already-resolved absolute path) is credential/secret
 * material that the structured file-ops tools must never read, write, or edit.
 */
export function isProtectedFile(absPath: string): boolean {
  const leaf = basename(absPath);
  const leafLower = leaf.toLowerCase();

  if (PROTECTED_BASENAMES.includes(leafLower)) return true;
  if (PROTECTED_BASENAME_PATTERNS.some((re) => re.test(leaf))) return true;
  if (hasProtectedSegment(absPath)) return true;
  if (appEnvCandidates().includes(absPath)) return true;

  return false;
}

/** Human-readable reason string for a denied protected path. */
export function protectedFileReason(absPath: string): string {
  return `Error: ${basename(absPath)} is protected credential/secret material and cannot be accessed`;
}
