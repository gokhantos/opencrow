import { getDb } from "./db";

export interface WorkflowNode {
  readonly id: string;
  readonly type: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly data: Record<string, unknown>;
}

export interface WorkflowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
}

export interface WorkflowViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly viewport: WorkflowViewport;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function rowToWorkflow(r: Record<string, unknown>): Workflow {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    nodes: (r.nodes_json as WorkflowNode[]) ?? [],
    edges: (r.edges_json as WorkflowEdge[]) ?? [],
    viewport: (r.viewport_json as WorkflowViewport) ?? { x: 0, y: 0, zoom: 1 },
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

export async function getAllWorkflows(): Promise<Workflow[]> {
  const db = getDb();
  const rows =
    (await db`SELECT * FROM workflows ORDER BY updated_at DESC`) as Array<
      Record<string, unknown>
    >;
  return rows.map(rowToWorkflow);
}

export async function getWorkflowById(id: string): Promise<Workflow | null> {
  const db = getDb();
  const rows =
    (await db`SELECT * FROM workflows WHERE id = ${id}`) as Array<
      Record<string, unknown>
    >;
  return rows.length > 0 ? rowToWorkflow(rows[0]!) : null;
}

export interface CreateWorkflowInput {
  readonly name: string;
  readonly description?: string;
  readonly nodes?: readonly WorkflowNode[];
  readonly edges?: readonly WorkflowEdge[];
  readonly viewport?: WorkflowViewport;
}

export async function createWorkflow(
  input: CreateWorkflowInput,
): Promise<Workflow> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const nodes = JSON.stringify(input.nodes ?? []);
  const edges = JSON.stringify(input.edges ?? []);
  const viewport = JSON.stringify(input.viewport ?? { x: 0, y: 0, zoom: 1 });
  const description = input.description ?? "";

  const rows = (await db`INSERT INTO workflows (
    name, description, nodes_json, edges_json, viewport_json, created_at, updated_at
  ) VALUES (
    ${input.name}, ${description}, ${nodes}::jsonb, ${edges}::jsonb, ${viewport}::jsonb, ${now}, ${now}
  ) RETURNING *`) as Array<Record<string, unknown>>;

  return rowToWorkflow(rows[0]!);
}

export interface UpdateWorkflowInput {
  readonly name?: string;
  readonly description?: string;
  readonly nodes?: readonly WorkflowNode[];
  readonly edges?: readonly WorkflowEdge[];
  readonly viewport?: WorkflowViewport;
}

export async function updateWorkflow(
  id: string,
  input: UpdateWorkflowInput,
): Promise<Workflow | null> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Resolve the final values to persist, merging with the existing row so
  // every column is always present in a single fully-parameterized UPDATE.
  const existing = await getWorkflowById(id);
  if (!existing) return null;

  const name = input.name !== undefined ? input.name : existing.name;
  const description =
    input.description !== undefined ? input.description : existing.description;
  const nodes = JSON.stringify(
    input.nodes !== undefined ? input.nodes : existing.nodes,
  );
  const edges = JSON.stringify(
    input.edges !== undefined ? input.edges : existing.edges,
  );
  const viewport = JSON.stringify(
    input.viewport !== undefined ? input.viewport : existing.viewport,
  );

  const rows = (await db`
    UPDATE workflows
    SET
      name         = ${name},
      description  = ${description},
      nodes_json   = ${nodes}::jsonb,
      edges_json   = ${edges}::jsonb,
      viewport_json = ${viewport}::jsonb,
      updated_at   = ${now}
    WHERE id = ${id}
    RETURNING *
  `) as Array<Record<string, unknown>>;

  return rows.length > 0 ? rowToWorkflow(rows[0]!) : null;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const db = getDb();
  const result = await db`DELETE FROM workflows WHERE id = ${id}`;
  return (result as { count?: number }).count !== undefined
    ? (result as { count: number }).count > 0
    : (result as unknown[]).length > 0;
}
