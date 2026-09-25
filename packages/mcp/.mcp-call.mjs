// usage: node mcp-call.mjs <bundle> '<json array of [tool, args]>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [bundle, calls] = process.argv.slice(2);
const c = new Client({ name: "loop", version: "0" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [bundle], stderr: "ignore", env: { ...process.env } }));
for (const [name, args] of JSON.parse(calls)) {
  const r = await c.callTool({ name, arguments: args });
  console.log(`--- ${name}${r.isError ? " (ERROR)" : ""}\n${r.content[0].text.split("\n").slice(0, 12).join("\n")}`);
}
await c.close();
