# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security → Report a vulnerability** on
https://github.com/harshil-1411/claude_plugin_video_studio (a private security advisory). Don't open
a public issue for a vulnerability. Include the plugin version (`.claude-plugin/plugin.json`), your
OS, `/video-studio:doctor` output and the smallest input that shows the problem.

You'll get an acknowledgement within a week. Fixes land on `main` and in the next release, with
credit if you want it.

## Supported versions

Only the latest release on `main` gets security fixes.

## Threat model

video-studio runs locally as a Claude Code plugin. Its engine is a bundled MCP server
(`dist/mcp.mjs`) that reads your sources and writes into your project folder.

- **Ingested content is untrusted data.** Documents, web pages, repositories, transcripts and video
  metadata are parsed, never executed. Repository scanning uses in-memory configuration only (no
  `repomix.config.*` or secretlint config files are evaluated). Secrets found in any source are
  replaced by `[REDACTED:<rule>]` in the ContentIR and the ingest cache.
- **Paths are confined to the project.** Footage, music, sound effects, logos, caption files, demo
  scripts and screenshot assets must resolve inside the project folder (symlinks resolved).
  Credential files (`~/.ssh`, `~/.aws`, `.env`, `*.pem`, …) are refused by `ingest`.
- **Network.** URL ingest refuses loopback, private and link-local addresses before every redirect
  and pins the connection to the checked address. `VS_ALLOW_PRIVATE_URLS=1` is a user-only override.
  Video URLs are handed to *your* `yt-dlp` with its config, cookies and exec hooks disabled.
- **External processes** (ffmpeg, whisper.cpp, yt-dlp, `say`, c2patool, Chrome for demo capture)
  are spawned with argument arrays, never a shell; text reaches ffmpeg through files or escaped
  filter options.
- **Spend and consent are enforced by the engine,** not by prompts: paid voices only when
  `policy.yaml` or you allow them, within spend limits; model downloads, demo capture and paid
  synthesis ask you through Claude Code's approval dialog (MCP elicitation) and are recorded in
  `project/consent.json`.
- **Keys** (`/plugin` → Configure) are stored by Claude Code in the OS credential store and reach only
  the MCP server's environment; they are never written to project files or logs.
- **Demo capture** records only a URL you started, only after your approval, stays on that origin,
  and blurs form inputs and any selectors you list.

Out of scope: vulnerabilities in ffmpeg, whisper.cpp, yt-dlp, Chrome or other tools you install,
and anything that requires an attacker to already control your machine or your project folder.
