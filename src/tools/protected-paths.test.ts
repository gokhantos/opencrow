/**
 * Unit tests for isProtectedFile() and protectedFileReason().
 *
 * Lane: unit (*.test.ts) — no DB, no FS, pure logic.
 */
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { isProtectedFile, protectedFileReason } from "./protected-paths";

// Use a stable fake home so tests work regardless of the host HOME setting.
const FAKE_HOME = "/home/testuser";

describe("isProtectedFile", () => {
  // ── Exact-basename matches ────────────────────────────────────────────────

  describe("exact protected basenames", () => {
    const exactBasenames = [
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
    ];

    for (const name of exactBasenames) {
      it(`blocks ${name}`, () => {
        expect(isProtectedFile(`/some/dir/${name}`)).toBe(true);
      });

      it(`blocks ${name} (uppercase variant if different from lowercase)`, () => {
        // The list is compared case-insensitively, so ID_RSA should also match.
        expect(isProtectedFile(`/some/dir/${name.toUpperCase()}`)).toBe(true);
      });
    }
  });

  // ── Basename-pattern matches ───────────────────────────────────────────────

  describe("dotenv pattern (.env, .env.*, .env.local, etc.)", () => {
    it("blocks .env", () => {
      expect(isProtectedFile("/project/.env")).toBe(true);
    });

    it("blocks .env.local", () => {
      expect(isProtectedFile("/project/.env.local")).toBe(true);
    });

    it("blocks .env.production", () => {
      expect(isProtectedFile("/project/.env.production")).toBe(true);
    });

    it("blocks .env.staging", () => {
      expect(isProtectedFile("/project/.env.staging")).toBe(true);
    });

    it("does NOT block .envrc (no dot-env pattern match, not in exact list)", () => {
      // .envrc is not matched by the /^\.env(\..+)?$/i pattern (no dot after env)
      // and not in the exact basename list.
      expect(isProtectedFile("/project/.envrc")).toBe(false);
    });
  });

  describe("pem / key / certificate files", () => {
    it("blocks server.pem", () => {
      expect(isProtectedFile("/certs/server.pem")).toBe(true);
    });

    it("blocks server.key", () => {
      expect(isProtectedFile("/certs/server.key")).toBe(true);
    });

    it("blocks keystore.p12", () => {
      expect(isProtectedFile("/certs/keystore.p12")).toBe(true);
    });

    it("blocks archive.pfx", () => {
      expect(isProtectedFile("/certs/archive.pfx")).toBe(true);
    });

    it("blocks app.keystore", () => {
      expect(isProtectedFile("/android/app.keystore")).toBe(true);
    });

    it("blocks case-insensitive .PEM extension", () => {
      expect(isProtectedFile("/certs/server.PEM")).toBe(true);
    });
  });

  describe("SSH keypairs (basename pattern)", () => {
    it("blocks id_rsa.pub", () => {
      expect(isProtectedFile("/home/user/.ssh/id_rsa.pub")).toBe(true);
    });

    it("blocks id_ed25519.pub", () => {
      expect(isProtectedFile("/home/user/.ssh/id_ed25519.pub")).toBe(true);
    });

    it("blocks id_ecdsa.pub", () => {
      expect(isProtectedFile("/home/user/.ssh/id_ecdsa.pub")).toBe(true);
    });
  });

  // ── Path-segment matches ──────────────────────────────────────────────────

  describe("protected directory segments (.ssh, .aws, .gnupg)", () => {
    it("blocks any file under .ssh/", () => {
      expect(isProtectedFile("/home/user/.ssh/config")).toBe(true);
    });

    it("blocks any file under .aws/", () => {
      expect(isProtectedFile("/home/user/.aws/credentials")).toBe(true);
    });

    it("blocks any file under .gnupg/", () => {
      expect(isProtectedFile("/home/user/.gnupg/pubring.kbx")).toBe(true);
    });

    it("blocks .ssh anywhere in the path (not just root-level)", () => {
      expect(isProtectedFile("/var/backup/.ssh/id_rsa")).toBe(true);
    });

    it("blocks .aws anywhere in the path", () => {
      expect(isProtectedFile("/home/deploy/.aws/config")).toBe(true);
    });

    it("blocks segment case-insensitively (.SSH)", () => {
      expect(isProtectedFile("/home/user/.SSH/config")).toBe(true);
    });
  });

  // ── ~/.opencrow rules ──────────────────────────────────────────────────────

  describe("~/.opencrow secrets directory", () => {
    const home = process.env.HOME ?? FAKE_HOME;
    const ocHome = `${home}/.opencrow`;

    it("blocks files under secrets/ in opencrow home", () => {
      expect(isProtectedFile(`${ocHome}/secrets/anything.json`)).toBe(true);
    });

    it("blocks the secrets/ directory itself", () => {
      expect(isProtectedFile(`${ocHome}/secrets`)).toBe(true);
    });

    it("blocks files with 'token' in the name under opencrow home", () => {
      expect(isProtectedFile(`${ocHome}/github_token`)).toBe(true);
    });

    it("blocks files with 'secret' in the name under opencrow home", () => {
      expect(isProtectedFile(`${ocHome}/session_secret`)).toBe(true);
    });

    it("blocks files with 'credential' in the name under opencrow home", () => {
      expect(isProtectedFile(`${ocHome}/db_credential`)).toBe(true);
    });

    it("does NOT block harmless config files under opencrow home", () => {
      // A plain config file that has none of the protected keywords.
      expect(isProtectedFile(`${ocHome}/settings.json`)).toBe(false);
    });

    it("does NOT block the opencrow home directory itself for unrelated names", () => {
      expect(isProtectedFile(`${ocHome}/agents`)).toBe(false);
    });
  });

  // ── Allow normal files ────────────────────────────────────────────────────

  describe("allows normal, non-secret files", () => {
    it("allows README.md", () => {
      expect(isProtectedFile("/project/README.md")).toBe(false);
    });

    it("allows src/index.ts", () => {
      expect(isProtectedFile("/project/src/index.ts")).toBe(false);
    });

    it("allows package.json", () => {
      expect(isProtectedFile("/project/package.json")).toBe(false);
    });

    it("allows .env.example (not matched by pattern, it uses .env.* but wait — let's test the real pattern)", () => {
      // .env.example DOES match /^\.env(\..+)?$/i  → protected
      expect(isProtectedFile("/project/.env.example")).toBe(true);
    });

    it("allows some.csv", () => {
      expect(isProtectedFile("/data/some.csv")).toBe(false);
    });

    it("allows /tmp/output.txt", () => {
      expect(isProtectedFile("/tmp/output.txt")).toBe(false);
    });

    it("allows file named 'envfile' (no leading dot, no pattern match)", () => {
      expect(isProtectedFile("/project/envfile")).toBe(false);
    });

    it("allows a file named 'secrets.md' OUTSIDE the opencrow home", () => {
      // 'secrets.md' is not an exact basename, not a pattern match, not in .ssh/.aws/.gnupg,
      // and not inside the opencrow home — so it should pass.
      expect(isProtectedFile("/project/docs/secrets.md")).toBe(false);
    });
  });
});

describe("widened credential coverage (PR-2 hardening)", () => {
  const protectedLeaves = [
    "/project/.git-credentials",
    "/home/user/kubeconfig",
    "/project/tls.crt",
    "/project/server.cer",
    "/project/gcp-service-account.json",
    "/project/my_service_account.json",
  ];
  for (const p of protectedLeaves) {
    it(`protects ${p}`, () => {
      expect(isProtectedFile(p)).toBe(true);
    });
  }

  const protectedDirs = [
    join("/home/user", ".kube", "config"),
    join("/home/user", ".docker", "config.json"),
    "/run/secrets/db-password",
    "/var/run/secrets/kubernetes.io/serviceaccount/token",
  ];
  for (const p of protectedDirs) {
    it(`protects path under secret store ${p}`, () => {
      expect(isProtectedFile(p)).toBe(true);
    });
  }

  it("still allows ordinary cert-adjacent names without secret extensions", () => {
    expect(isProtectedFile("/project/certificate.md")).toBe(false);
    expect(isProtectedFile("/project/docker-compose.yml")).toBe(false);
  });
});

describe("protectedFileReason", () => {
  it("returns a human-readable error string containing the filename", () => {
    const reason = protectedFileReason("/home/user/.ssh/id_rsa");
    expect(reason).toContain("id_rsa");
    expect(reason).toContain("protected");
  });

  it("starts with 'Error:'", () => {
    const reason = protectedFileReason("/project/.env");
    expect(reason.startsWith("Error:")).toBe(true);
  });

  it("includes only the basename in the message (not the full path)", () => {
    const reason = protectedFileReason("/very/long/path/.pgpass");
    expect(reason).toContain(".pgpass");
    // The full path should not appear (the message is safe to surface in UI)
    expect(reason).not.toContain("/very/long/path");
  });
});
