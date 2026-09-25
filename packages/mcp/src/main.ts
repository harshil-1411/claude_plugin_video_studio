import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdout belongs to the MCP transport. Route stray console output to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("video-studio engine MCP server running on stdio");
}

main().catch((err) => {
  console.error("video-studio engine failed to start:", err);
  process.exit(1);
});
