/**
 * Safe condition evaluator — no eval(), no new Function().
 * Supports simple comparisons joined by && or ||.
 *
 * Supported operators: == != > < >= <=
 * Supported operand types: string literals ("..."), number literals,
 *   boolean literals (true/false), dot-path references (a.b.c)
 */

type Operator = "==" | "!=" | ">" | "<" | ">=" | "<=";

interface Comparison {
  readonly left: string;
  readonly op: Operator;
  readonly right: string;
}

const OPERATORS: readonly Operator[] = [">=", "<=", "!=", "==", ">", "<"];
const OPERATOR_RE = />=|<=|!=|==|>|</;

function resolveOperand(
  raw: string,
  context: Record<string, unknown>,
): unknown {
  const trimmed = raw.trim();

  // String literal
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  // Boolean literal
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Dot-path reference
  const parts = trimmed.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseComparison(expr: string): Comparison {
  const match = expr.match(OPERATOR_RE);
  if (!match || match.index === undefined) {
    throw new Error(`Invalid expression — no operator found: "${expr}"`);
  }

  const op = match[0] as Operator;
  if (!OPERATORS.includes(op)) {
    throw new Error(`Unsupported operator: "${op}"`);
  }

  const left = expr.slice(0, match.index);
  const right = expr.slice(match.index + op.length);
  return { left, op, right };
}

function evalComparison(
  comparison: Comparison,
  context: Record<string, unknown>,
): boolean {
  const left = resolveOperand(comparison.left, context);
  const right = resolveOperand(comparison.right, context);

  switch (comparison.op) {
    case "==": return left == right; // intentional loose equality for flexibility
    case "!=": return left != right;
    case ">": return (left as number) > (right as number);
    case "<": return (left as number) < (right as number);
    case ">=": return (left as number) >= (right as number);
    case "<=": return (left as number) <= (right as number);
  }
}

/**
 * Evaluate a boolean condition expression against a context object.
 * Supports && and || combinators.
 */
export function evaluateCondition(
  expression: string,
  context: Record<string, unknown>,
): boolean {
  const trimmed = expression.trim();

  // Handle || first (lower precedence)
  if (trimmed.includes("||")) {
    const parts = trimmed.split("||");
    return parts.some((part) => evaluateCondition(part.trim(), context));
  }

  // Handle &&
  if (trimmed.includes("&&")) {
    const parts = trimmed.split("&&");
    return parts.every((part) => evaluateCondition(part.trim(), context));
  }

  // Single comparison
  const comparison = parseComparison(trimmed);
  return evalComparison(comparison, context);
}
