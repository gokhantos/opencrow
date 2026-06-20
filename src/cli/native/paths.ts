import path from "node:path";

export const QDRANT_LABEL = "com.opencrow.qdrant";
export const MEM0_LABEL = "com.opencrow.mem0";
export const NEO4J_LABEL = "com.opencrow.neo4j";

export type NativePaths = {
  readonly root: string;
  readonly bin: string;
  readonly qdrantBinary: string;
  readonly qdrantStorage: string;
  readonly qdrantConfig: string;
  readonly mem0Dir: string;
  readonly mem0AppDir: string;
  readonly mem0Kuzu: string;
  readonly mem0EnvFile: string;
  readonly neo4jDir: string;
  readonly logDir: string;
};

export function nativePaths(home: string): NativePaths {
  const root = path.join(home, ".opencrow");
  return {
    root,
    bin: path.join(root, "bin"),
    qdrantBinary: path.join(root, "bin", "qdrant"),
    qdrantStorage: path.join(root, "qdrant", "storage"),
    qdrantConfig: path.join(root, "qdrant", "config.yaml"),
    mem0Dir: path.join(root, "mem0"),
    mem0AppDir: path.join(root, "mem0", "app"),
    mem0Kuzu: path.join(root, "mem0", "kuzu"),
    mem0EnvFile: path.join(root, "mem0", "mem0.env"),
    neo4jDir: path.join(root, "neo4j"),
    logDir: path.join(root, "logs"),
  };
}
