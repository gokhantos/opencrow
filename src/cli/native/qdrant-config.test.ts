import { test, expect } from "bun:test";
import {
  QDRANT_VERSION,
  QDRANT_SHA256_AARCH64,
  qdrantDownloadUrl,
  renderQdrantConfig,
} from "./qdrant-config.ts";
import { nativePaths } from "./paths.ts";

test("pins qdrant to v1.13.2", () => {
  expect(QDRANT_VERSION).toBe("v1.13.2");
});

test("QDRANT_SHA256_AARCH64 is a 64-char lowercase hex string", () => {
  expect(QDRANT_SHA256_AARCH64).toMatch(/^[0-9a-f]{64}$/);
});

test("download URL targets the macOS aarch64 release archive", () => {
  const url = qdrantDownloadUrl(QDRANT_VERSION, "aarch64");
  expect(url).toBe(
    "https://github.com/qdrant/qdrant/releases/download/v1.13.2/qdrant-aarch64-apple-darwin.tar.gz",
  );
});

test("config binds loopback :6333 and points storage at the native dir", () => {
  const cfg = renderQdrantConfig(nativePaths("/Users/test"));
  expect(cfg).toContain("host: 127.0.0.1");
  expect(cfg).toContain("http_port: 6333");
  expect(cfg).toContain("storage_path: /Users/test/.opencrow/qdrant/storage");
});
