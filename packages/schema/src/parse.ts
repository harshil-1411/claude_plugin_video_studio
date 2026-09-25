import { parse as parseYaml } from "yaml";
import { z } from "zod";

export interface ParseIssue {
  /** Dotted path into the document, e.g. `scenes.2.duration_sec`; empty string for the root. */
  path: string;
  message: string;
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: ParseIssue[]; /** Human-readable multi-line summary. */ message: string };

/** Convert a zod error into flat `{path, message}` issues. */
export function formatIssues(error: z.ZodError): ParseIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join("."),
    message: issue.message,
  }));
}

function summarize(errors: ParseIssue[]): string {
  return errors.map((e) => `✖ ${e.message}${e.path ? `\n  → at ${e.path}` : ""}`).join("\n");
}

/** Validate an already-parsed value against a schema. */
export function parseValue<S extends z.ZodType>(schema: S, value: unknown): ParseResult<z.infer<S>> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  const errors = formatIssues(result.error);
  return { ok: false, errors, message: z.prettifyError(result.error) };
}

/**
 * Parse YAML or JSON text (JSON is valid YAML 1.2) and validate it against `schema`.
 * Never throws for bad input; syntax and validation problems are returned as issues.
 */
export function parseYamlOrJson<S extends z.ZodType>(schema: S, text: string): ParseResult<z.infer<S>> {
  let value: unknown;
  try {
    value = parseYaml(text, { prettyErrors: true, uniqueKeys: true });
  } catch (err) {
    const errors = [{ path: "", message: `syntax error: ${err instanceof Error ? err.message : String(err)}` }];
    return { ok: false, errors, message: summarize(errors) };
  }
  return parseValue(schema, value);
}
