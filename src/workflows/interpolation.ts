const TEMPLATE_RE = /\{\{(\w+)\.(\w+)\}\}/g;

/**
 * Interpolate `{{nodeId.field}}` placeholders in a template string.
 * If the stored output for nodeId is a plain string and field is "output",
 * the raw string is used directly. Otherwise the field is looked up on the
 * object.
 */
export function interpolate(
  template: string,
  outputs: ReadonlyMap<string, unknown>,
): string {
  return template.replace(TEMPLATE_RE, (_match, nodeId: string, field: string) => {
    const value = outputs.get(nodeId);
    if (value === undefined || value === null) return "";

    if (typeof value === "string") {
      return field === "output" ? value : "";
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const fieldVal = obj[field];
      if (fieldVal === undefined || fieldVal === null) return "";
      if (typeof fieldVal === "string") return fieldVal;
      return JSON.stringify(fieldVal);
    }

    return String(value);
  });
}

/**
 * Deep-walk all string values in an object and interpolate them.
 */
export function interpolateObject(
  obj: unknown,
  outputs: ReadonlyMap<string, unknown>,
): unknown {
  if (typeof obj === "string") {
    return interpolate(obj, outputs);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => interpolateObject(item, outputs));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateObject(val, outputs);
    }
    return result;
  }

  return obj;
}
