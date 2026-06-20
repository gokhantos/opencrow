import type { NativePaths } from "./paths.ts";

export const QDRANT_VERSION = "v1.13.2";
export const QDRANT_SHA256_AARCH64 =
  "e78391ba0f337875687c4b112542cac291e17fc6ade326207ed3d7565baa35ca";

export function qdrantDownloadUrl(version: string, arch: "aarch64"): string {
  return `https://github.com/qdrant/qdrant/releases/download/${version}/qdrant-${arch}-apple-darwin.tar.gz`;
}

export function renderQdrantConfig(p: NativePaths): string {
  return `storage:
  storage_path: ${p.qdrantStorage}
service:
  host: 127.0.0.1
  http_port: 6333
`;
}
