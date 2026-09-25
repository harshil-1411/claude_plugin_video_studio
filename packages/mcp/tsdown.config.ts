import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "tsdown";

// The ingestion package imports only `searchFiles` from repomix. repomix's barrel
// (`repomix` → lib/index.js) also pulls in its CLI, tree-sitter (wasm), tiktoken,
// worker pools and the jiti config loader: ~7 MB of code we never call and must
// never run. Alias the barrel to the single file-search module instead.
const repomixLib = dirname(createRequire(join(import.meta.dirname, "../ingestion/package.json")).resolve("repomix"));

// Single-file ESM bundle of the engine MCP server at <repo>/dist/mcp.mjs.
// Everything (workspace packages, MCP SDK, zod, yaml) is inlined; only node:* builtins stay external.
export default defineConfig({
  entry: { mcp: "src/main.ts" },
  outDir: "../../dist",
  format: "esm",
  platform: "node",
  target: "node22",
  fixedExtension: true,
  clean: false,
  dts: false,
  sourcemap: false,
  hash: false,
  deps: {
    alwaysBundle: [/.*/],
    neverBundle: [/^node:/],
    onlyBundle: false,
  },
  alias: { repomix: join(repomixLib, "core/file/fileSearch.js") },
  outputOptions: { codeSplitting: false },
});
