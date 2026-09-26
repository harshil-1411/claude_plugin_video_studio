import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RenderJobManager } from "./render-jobs.js";
import { createServer } from "./server.js";

// stdout belongs to the MCP transport. Route stray console output to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

/** How long shutdown waits for a running render to unwind (children get SIGTERM, then SIGKILL after 2 s). */
const SHUTDOWN_WAIT_MS = 5000;

async function main(): Promise<void> {
  const jobs = new RenderJobManager();
  const server = createServer({ jobs });
  const transport = new StdioServerTransport();

  let stopping: Promise<void> | undefined;
  /**
   * Abort every render job (killing its ffmpeg/TTS children, releasing the render lock and removing
   * temp files), wait briefly for that, then exit. Without this, SIGTERM left an orphaned ffmpeg
   * writing into the project and a stale lock behind.
   */
  const shutdown = (why: string, code = 0): Promise<void> =>
    (stopping ??= (async () => {
      const active = jobs.activeJobs().length;
      if (active) console.error(`video-studio engine: ${why}; stopping ${active} render job(s)`);
      // Hard deadline in case something refuses to unwind.
      setTimeout(() => process.exit(code), SHUTDOWN_WAIT_MS + 3000).unref();
      try {
        await jobs.close(SHUTDOWN_WAIT_MS);
      } catch (e) {
        console.error(`video-studio engine: shutdown: ${e instanceof Error ? e.message : String(e)}`);
      }
      await server.close().catch(() => {});
      process.exit(code);
    })());

  process.once("SIGTERM", () => void shutdown("SIGTERM", 143));
  process.once("SIGINT", () => void shutdown("SIGINT", 130));
  process.once("SIGHUP", () => void shutdown("SIGHUP", 129));
  // The MCP client went away (stdin closed): nobody can poll the jobs any more.
  process.stdin.once("end", () => void shutdown("client disconnected"));
  process.stdin.once("close", () => void shutdown("client disconnected"));

  await server.connect(transport);
  console.error("video-studio engine MCP server running on stdio");
}

main().catch((err) => {
  console.error("video-studio engine failed to start:", err);
  process.exit(1);
});
