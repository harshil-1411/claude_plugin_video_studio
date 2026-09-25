# Claude Code Plugin Format and Packaging (as of September 2026), for a "video-studio" plugin

Research date: 2026-09-25. Primary sources: the official Claude Code docs at code.claude.com, pulled as raw Markdown that day. The docs have been reorganized under `/docs/en/plugins/*`: `manifest-reference`, `components`, `marketplace-reference`, `cli-reference`, `publish`, `loading`, `install`, `host-marketplace`, `anthropic-marketplaces`. The old `/docs/en/plugins-reference` URL now serves the manifest reference. Many features have minimum versions (v2.1.1xx–v2.1.28x). They are noted where the docs give them.

Short URL keys used below:
- MANIFEST = https://code.claude.com/docs/en/plugins/manifest-reference
- COMPONENTS = https://code.claude.com/docs/en/plugins/components
- MKT = https://code.claude.com/docs/en/plugins/marketplace-reference
- CLI = https://code.claude.com/docs/en/plugins/cli-reference
- PUBLISH = https://code.claude.com/docs/en/plugins/publish
- SKILLS = https://code.claude.com/docs/en/skills
- AGENTS = https://code.claude.com/docs/en/sub-agents
- HOOKS = https://code.claude.com/docs/en/hooks
- SPEC = https://agentskills.io/specification

---

## 1. `.claude-plugin/plugin.json` schema and default directory layout

### Takeaway
`plugin.json` lives at `<plugin-root>/.claude-plugin/plugin.json`. It is optional, and `name` (kebab-case) is its only required field. Every other component goes at the plugin root, not inside `.claude-plugin/`. The default directories are `skills/<name>/SKILL.md`, `commands/*.md` (legacy), `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `bin/`, `output-styles/`, `workflows/`, `themes/`, `monitors/monitors.json` and `settings.json`. Manifest keys either replace, add to, or merge with these defaults.

### Cited Findings
- The manifest is optional. Without it, Claude Code loads the components it finds in the standard layout, and the name comes from the marketplace entry or the directory name. Save it at `.claude-plugin/plugin.json`, and put every other file (`skills/`, `commands/`, `hooks/`...) at the plugin root, not inside `.claude-plugin/` — [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- Top-level fields (only `name` is required):
  - `$schema`: ignored at load
  - `name`: kebab-case. No spaces, `@`, `:` or path separators. Every component is namespaced under it.
  - `displayName`: UI label. May contain spaces.
  - `version`: a string, not checked against semver. Setting it pins users to that version until you change it.
  - `description`
  - `author`: an object with required `name`, plus optional `email` and `url`
  - `homepage`: must parse as a URL, or the plugin fails to load
  - `repository`: not validated
  - `license`: SPDX identifier
  - `keywords`: string array
  - `metadata`: free-form, v2.1.222+
  - `defaultEnabled`: defaults to true
  - `dependencies`
  - `settings`: only `agent` and `subagentStatusLine` take effect
  - `userConfig`
  - `channels`
  - `skills`
  - `commands`
  - `agents`
  - `hooks`
  - `mcpServers`
  - `lspServers`
  - `outputStyles`
  - `workflows`
  - `experimental`: `themes`, `monitors`, `evals`

  Source: [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- Full example manifest from the docs, which "passes validation":
  ```json
  {
    "name": "deploy-tools", "displayName": "Deploy Tools", "version": "1.2.0",
    "description": "...", "author": {"name": "Example Team","email":"dev@example.com","url":"https://example.com"},
    "homepage": "https://example.com/docs/deploy-tools", "repository": "https://github.com/example/deploy-tools",
    "license": "MIT", "keywords": ["deployment","ci"], "defaultEnabled": true,
    "dependencies": ["secrets-vault"], "metadata": {"catalogId":"cat-123"},
    "skills": ["./extra-skills/"],
    "commands": {"status":{"source":"./commands/status.md","description":"..."},"about":{"content":"...","description":"..."}},
    "agents": ["./agents/reviewer.md"], "hooks": "./config/extra-hooks.json",
    "mcpServers": {"deploy-api":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js"]}},
    "lspServers": "./.lsp.json", "outputStyles": "./styles/",
    "experimental": {"themes":"./themes/","monitors":"./config/monitors.json"},
    "userConfig": {"api_token":{"type":"string","title":"API token","description":"...","sensitive":true}}
  }
  ```
  Source: [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- Unknown top-level keys are stripped: the plugin still loads, and `validate` warns. Unknown keys inside `userConfig` options, `channels` entries, `lspServers` configs or `monitors` entries are errors, and the plugin does not load — [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- Path rules:
  - Every component path is relative to the plugin root and must start with `./`. `commands/foo.md` fails validation.
  - `skills` also accepts `"."`, but only on v2.1.221+. Use `"./"` for older clients.
  - Paths must stay inside the plugin root (no `..`) and must exist.

  Source: [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- How each key combines with its default location:
  - **Replace** the default: `commands`, `agents`, `outputStyles`, `workflows`, `experimental.themes`, `experimental.monitors`. For example, setting `commands` stops the scan of `commands/`.
  - **Add to** the default: `skills`.
  - **Merge** with the default file: `hooks` with `hooks/hooks.json`, `mcpServers` with `.mcp.json`, `lspServers` with `.lsp.json`.
  - `agents` entries must be `.md` files. Directories are not accepted.

  Source: [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- Standard layout table:

  | Location | Contents |
  | :--- | :--- |
  | `.claude-plugin/plugin.json` | Manifest |
  | `skills/` | One `<name>/SKILL.md` per skill. A root `SKILL.md` with no `skills/` loads as a single skill. |
  | `commands/` | Flat `.md` files. "Prefer `skills/` for new plugins." |
  | `agents/` | Subfolders become part of the agent name |
  | `hooks/hooks.json` | Hook configuration |
  | `.mcp.json` | MCP servers |
  | `.lsp.json` | LSP servers |
  | `output-styles/` | Output styles |
  | `workflows/` | Workflow `.js` files |
  | `themes/` | Theme JSON files |
  | `monitors/monitors.json` | Monitors array |
  | `bin/` | Executables |
  | `settings.json` | `agent` and `subagentStatusLine` defaults |

  Source: [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- A `CLAUDE.md` at the plugin root is NOT loaded as context, and `validate` warns about it. Put instructions in a skill instead — [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- `commands` as an object map: each key becomes `/<plugin>:<key>`. Each value sets exactly one of `source` or `content`, plus optional `description`, `argumentHint`, `model` and `allowedTools` — [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- `mcpServers` accepts:
  - a `.json` path
  - an inline map
  - a `.mcpb` or `.dxt` bundle path or https URL, extracted to `.mcpb-cache/`
  - an array of these

  `.mcp.json` loads first, and later names replace earlier ones. Tools from a plugin MCP server are named `mcp__plugin_<plugin>_<server>__<tool>`. Sources: [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference); [COMPONENTS](https://code.claude.com/docs/en/plugins/components)
- `experimental.monitors`: background processes with the fields `name`, `command`, `description` and `when` (`"always"` or `"on-skill-invoke:<skill>"`). They run only in interactive sessions — [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- `claude plugin init <name> [--with skills agents hooks mcp lsp output-style channel]` scaffolds a plugin at `~/.claude/skills/<name>/`, which loads as `<name>@skills-dir` — [CLI](https://code.claude.com/docs/en/plugins/cli-reference)

### Inferences
- Recommended video-studio layout, using defaults only:
  ```
  video-studio/
  ├── .claude-plugin/plugin.json
  ├── .claude-plugin/marketplace.json   (optional: self-hosted marketplace)
  ├── skills/<skill>/SKILL.md (+ references/, scripts/, assets/)
  ├── agents/*.md
  ├── hooks/hooks.json
  ├── bin/video-studio
  ├── scripts/
  └── README.md
  ```
- If we set `"agents"` or `"commands"` in the manifest, the default folders stop being scanned. Omitting those keys is simplest.

### Gaps
- I did not fetch the published JSON Schema URL for `$schema`. Anthropic's example `plugin.json` files may reference one.

---

## 2. `bin/`, PATH, and environment variables

### Takeaway
Files in `<plugin>/bin/` are appended to the Bash tool's `PATH` while the plugin is enabled, so Claude can call `video-studio ...` as a bare command. They come after the user's PATH, so a plugin cannot shadow system commands. There are three path variables: `${CLAUDE_PLUGIN_ROOT}` (changes on update), `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`, persistent) and `${CLAUDE_PROJECT_DIR}`. **None of these are in the environment of Bash tool commands.** They are substituted inline in skill, agent and command Markdown instead. Also, a plugin with a top-level `bin/` cannot be installed on claude.ai or Cowork.

### Cited Findings
- Files in `bin/` at the plugin root are on the PATH of the Bash tool's shell while the plugin is enabled. Plugin `bin/` directories come after the user's own PATH entries, so a plugin can't shadow `git`, `ls` and so on. Example: `bin/hello-plugin`, made executable with `chmod +x` — [COMPONENTS](https://code.claude.com/docs/en/plugins/components)
- "claude.ai and Cowork don't install a plugin that has a top-level `bin/` directory, including one you distribute through claude.ai organization settings." — [COMPONENTS](https://code.claude.com/docs/en/plugins/components)
- For claude.ai-synced marketplaces, the error message starts with "Plugin contains a top-level bin/ directory". The docs' advice is to keep executables in another directory such as `scripts/` and reference them as `${CLAUDE_PLUGIN_ROOT}/scripts/<name>` — [host-marketplace](https://code.claude.com/docs/en/plugins/host-marketplace)
- The three path variables:
  - `${CLAUDE_PLUGIN_ROOT}` is the absolute path of the installed version. It changes on update, so don't write state there.
  - `${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/<id>/`. It is created on first reference and kept across updates. `<id>` is the plugin id with every character other than `[A-Za-z0-9_-]` replaced by `-`, so `my-plugin@my-marketplace` becomes `my-plugin-my-marketplace`. It is deleted when you uninstall from the last scope, unless you pass `--keep-data`.
  - `${CLAUDE_PROJECT_DIR}` is the project root.

  Source: [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- Where each variable resolves and what is exported to the process:

  | Component | Resolves in | Exported to the process |
  | :--- | :--- | :--- |
  | Hook commands | `command` and `args` | `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_OPTION_<KEY>` |
  | MCP stdio servers | `command`, `args`, `env` | `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` |
  | Skill, command and agent Markdown | Anywhere in the body | Not applicable (inline substitution) |

  "The variables aren't present in the environment of commands Claude runs through the Bash tool, in the main session or in a subagent." — [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- In plugin skills, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_SKILL_DIR}` are substituted both in the Markdown body and in Bash rules in `allowed-tools`. That lets a skill run a bundled script with no permission prompt, e.g. `allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)` — [SKILLS](https://code.claude.com/docs/en/skills)
- Documented pattern for installing dependencies: a `SessionStart` hook diffs `package.json` into `${CLAUDE_PLUGIN_DATA}` and runs `npm install` there. For marketplace installs, Claude Code auto-installs eligible Node.js package dependencies when caching — [COMPONENTS](https://code.claude.com/docs/en/plugins/components)
- On Windows, substituted paths use forward slashes — [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)

### Inferences
- The `bin/video-studio` CLI should not rely on `CLAUDE_PLUGIN_ROOT` or `CLAUDE_PLUGIN_DATA` being set when Claude calls it via Bash. Two options:
  - Resolve its own location (e.g. `$(dirname "$(realpath "$0")")`) and use a fixed data dir such as `~/.claude/plugins/data/video-studio-<marketplace>/`.
  - Have skills pass paths explicitly, e.g. `video-studio render --data "${CLAUDE_PLUGIN_DATA}"`, since the skill body gets substituted.
- If Cowork/claude.ai distribution matters, provide a variant without `bin/`: put the CLI under `scripts/` and call it through `${CLAUDE_PLUGIN_ROOT}/scripts/video-studio` from skills. Otherwise ship `bin/` for Claude Code CLI only.

### Gaps
- The docs don't say whether `bin/` executables must be committed with the executable bit, or whether Claude Code chmods them. Assume `chmod +x` must be committed (`git update-index --chmod=+x`).

---

## 3. SKILL.md frontmatter, `$ARGUMENTS`, namespacing, commands vs skills

### Takeaway
Every SKILL.md frontmatter field is optional; `description` is the one recommended. Claude Code supports:
- Invocation and routing: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `paths`
- Tools: `allowed-tools`, `disallowed-tools`
- Model and execution: `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `shell`
- Metadata: `metadata`, `license`, `compatibility`

Plugin skills are invoked as `/<plugin>:<skill-dir-or-name>`, for example `/video-studio:render`. "Custom commands have been merged into skills": `commands/` is legacy, and skills are preferred.

### Cited Findings
- "Custom commands have been merged into skills." `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way. Skills add a directory for supporting files, invocation-control frontmatter, and auto-loading — [SKILLS](https://code.claude.com/docs/en/skills)
- Plugin commands are "the older format, and skills supersede them for new work... Keep `commands/` for files you're moving over." Command files take the same frontmatter as skills, except `name` and `paths`. `commands/db/migrate.md` becomes `/my-plugin:db:migrate` — [COMPONENTS](https://code.claude.com/docs/en/plugins/components); [SKILLS](https://code.claude.com/docs/en/skills)
- Frontmatter fields:

  | Field | What it does |
  | :--- | :--- |
  | `name` | Display name. In plugins it sets the last command segment. |
  | `description` | Recommended. Falls back to the first body line. Combined with `when_to_use`, it is truncated at **1,536 chars** in the skill listing. |
  | `when_to_use` | Extra triggering context |
  | `argument-hint` | E.g. `[issue-number]` |
  | `arguments` | Named positional args, as a space-separated string or YAML list |
  | `disable-model-invocation` | Default false. Stops Claude auto-loading the skill and blocks preloading it into subagents. |
  | `user-invocable` | Default true. False hides the skill from the `/` menu. |
  | `allowed-tools` | Pre-approves tools for the invoking turn only. Space- or comma-separated string, or YAML list. |
  | `disallowed-tools` | Removes tools while the skill is active |
  | `model` | For the rest of the turn, or the forked model with `context: fork`. `inherit` is allowed. |
  | `effort` | `low`, `medium`, `high`, `xhigh`, `max` |
  | `context` | `fork` runs the skill in a subagent |
  | `agent` | Subagent type used with `context: fork` |
  | `background` | Used with fork. Default true. v2.1.218+. |
  | `hooks` | Registered on invoke and kept for the session. Supports `once`. |
  | `paths` | Globs that gate auto-activation |
  | `shell` | `bash` or `powershell` |
  | `metadata` | Free-form map |
  | `license` | Accepted, no effect |
  | `compatibility` | Up to 500 chars. Accepted, no effect. |

  Unknown fields are ignored silently. Booleans also accept yes/no/on/off/1/0 (v2.1.218+). Source: [SKILLS](https://code.claude.com/docs/en/skills)
- Portability constraint: claude.ai uploads, the Skills API and `package_skill.py` accept ONLY `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`. Any other field is a hard error ("Unexpected key(s) in SKILL.md frontmatter: argument-hint..."). Inside Claude Code plugins, all fields work — [SKILLS](https://code.claude.com/docs/en/skills)
- The Agent Skills open spec requires `name` and `description`:
  - `name`: 1–64 characters, lowercase a–z, 0–9 and hyphens, no leading, trailing or double hyphen, and it must match the parent directory.
  - `description`: 1–1024 characters.
  - `metadata` is a string-to-string map.
  - `allowed-tools` is space-separated and marked experimental.

  Source: [SPEC](https://agentskills.io/specification)
- Command names:
  - `my-plugin/skills/review/SKILL.md` → `/my-plugin:review`. With `name: fancy` → `/my-plugin:fancy`.
  - The bare `/fancy` also works unless another command already uses the name.
  - A plugin-root `SKILL.md` uses frontmatter `name`, falling back to the directory name. Always set `name` there, or a marketplace install names the skill after its cache directory.
  - On v2.1.246+ the prefix isn't doubled if `name` already has it. v2.1.216–245 doubled it.

  Sources: [SKILLS](https://code.claude.com/docs/en/skills); [COMPONENTS](https://code.claude.com/docs/en/plugins/components)
- String substitutions:
  - `$ARGUMENTS` is the full string as typed. If no placeholder receives the arguments, they are appended as `ARGUMENTS: <value>`.
  - `$ARGUMENTS[N]` and `$N` are 0-based and use shell-style quoting, so `/s "hello world" x` gives `$0` = `hello world`.
  - `$name` refers to a declared `arguments` entry. A missing named argument becomes an empty string, while a missing indexed one stays literal.
  - Other variables: `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}` (the skill's own subdirectory), `${CLAUDE_PROJECT_DIR}` (v2.1.196+), and `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` (plugin skills only).
  - Escape a literal `$1` as `\$1`.

  Source: [SKILLS](https://code.claude.com/docs/en/skills)
- Dynamic context injection with `` !`command` `` and ```` ```! ```` blocks is supported. The `shell` field picks the interpreter — [SKILLS](https://code.claude.com/docs/en/skills)
- Once invoked, the rendered SKILL.md stays in the conversation across turns and is not re-read. The `allowed-tools` grant clears on the next user message — [SKILLS](https://code.claude.com/docs/en/skills)

### Inferences
- For video-studio skills that should also work on claude.ai, keep frontmatter to the six spec fields, make `name` match the directory, and keep `description` under 1024 chars. Plugin-only skills can use `argument-hint`, `disable-model-invocation` and `context: fork`.
- Use `disable-model-invocation: true` for side-effectful workflows such as "render/publish". Use `user-invocable: false` for background knowledge skills such as style guides.

### Gaps
- None major.

---

## 4. Subagent format (`agents/*.md`)

### Takeaway
Agent files are Markdown with YAML frontmatter; the body is the system prompt. `name` and `description` are required. Field names are camelCase. Plugin agents ignore `permissionMode`, `hooks`, `mcpServers` and `initialPrompt`. They are namespaced as `<plugin>:<name>`, and subfolders add segments.

### Cited Findings
- Full field list:

  | Field | Notes |
  | :--- | :--- |
  | `name` | Required. Cannot contain `:` (v2.1.218+). |
  | `description` | Required |
  | `tools` | Comma string or YAML list. Inherits all tools if omitted. |
  | `disallowedTools` | |
  | `model` | `sonnet`, `opus`, `haiku`, `fable`, a full ID like `claude-opus-5-5`, or `inherit` |
  | `permissionMode` | |
  | `maxTurns` | |
  | `skills` | Preloads the full skill content |
  | `mcpServers` | |
  | `hooks` | |
  | `memory` | `user`, `project` or `local` |
  | `background` | |
  | `omitClaudeMd` | v2.1.271+ |
  | `effort` | |
  | `isolation` | `worktree` |
  | `color` | red, blue, green, yellow, purple, orange, pink or cyan |
  | `initialPrompt` | |
  | `experimental.cacheTtl` | `5m` or `1h` |

  Unknown fields are ignored silently. Source: [AGENTS](https://code.claude.com/docs/en/sub-agents)
- Plugin agents support `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `omitClaudeMd`, `isolation` (`"worktree"` only), `color` and `experimental.cacheTtl`. They ignore `permissionMode`, `hooks`, `mcpServers` and `initialPrompt` for security reasons, so add hooks and MCP at plugin level instead. A plugin agent whose frontmatter fails to parse still loads, named after the file, with the description "Agent from my-plugin plugin" — [COMPONENTS](https://code.claude.com/docs/en/plugins/components); [AGENTS](https://code.claude.com/docs/en/sub-agents)
- Naming examples:
  - `agents/security-reviewer.md` → `my-plugin:security-reviewer`. Invoke it with `@agent-my-plugin:security-reviewer`.
  - `agents/review/security.md` → `my-plugin:review:security`.
  - Frontmatter `name` replaces only the file segment.
  - Files listed via the manifest `agents` key drop the subfolder segments.

  Sources: [COMPONENTS](https://code.claude.com/docs/en/plugins/components); [AGENTS](https://code.claude.com/docs/en/sub-agents)
- Plugin agents have the lowest precedence of all scopes (5) — [AGENTS](https://code.claude.com/docs/en/sub-agents)
- Example:
  ```markdown
  ---
  name: security-reviewer
  description: Reviews code changes for security issues. Use after edits to authentication or input handling.
  model: sonnet
  ---
  You are a security reviewer...
  ```
  Source: [COMPONENTS](https://code.claude.com/docs/en/plugins/components)
- A plugin can make one of its agents the main-thread agent through `settings.json` at the plugin root, e.g. `{"agent": "security-reviewer"}`. User settings override it — [COMPONENTS](https://code.claude.com/docs/en/plugins/components)

### Inferences
- Video-studio subagents (e.g. `scriptwriter`, `storyboarder`, `render-qa`) should set `tools` explicitly and use `skills:` to preload relevant plugin skills. They cannot rely on per-agent hooks or MCP.

### Gaps
- None.

---

## 5. Hooks

### Takeaway
A plugin declares hooks in `hooks/hooks.json`, under a top-level `"hooks"` key. The shape matches `settings.json`: event → array of matcher groups → `hooks` array of handlers. It can also declare hooks through the manifest `hooks` key, and the two merge. Plugin hooks register on session load and fire regardless of whether the plugin's skills are used. There are five handler types: `command`, `http`, `mcp_tool`, `prompt` and `agent`.

### Cited Findings
- Hook events: `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd` — [HOOKS](https://code.claude.com/docs/en/hooks)
- Example plugin `hooks/hooks.json`:
  ```json
  {"hooks":{"PostToolUse":[{"matcher":"Write|Edit","hooks":[{"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/scripts/format.sh\""}]}]}}
  ```
  "A plugin's hooks don't wait for one of the plugin's skills or commands to be used." Source: [COMPONENTS](https://code.claude.com/docs/en/plugins/components)
- Common handler fields:
  - `type` (required)
  - `if`: a permission-rule filter such as `"Bash(git *)"`, evaluated on tool events only
  - `timeout` in seconds. Defaults: 600 for command, http and mcp_tool; 30 for prompt; 60 for agent. Command, http and mcp_tool drop to 30 on UserPromptSubmit and to 10 on MessageDisplay.
  - `statusMessage`
  - `once`: honored only in skill frontmatter
  - Command hooks also take `args` and `async`.

  Source: [HOOKS](https://code.claude.com/docs/en/hooks)
- Exec form vs shell form:
  - With `args` present, the hook runs in exec form: no shell, `command` is resolved on PATH, and each arg is passed verbatim. This is recommended whenever a path placeholder is used. Example: `{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/format.js","--fix"]}`.
  - Without `args`, the hook runs in shell form (`sh -c`), and placeholders must be double-quoted.

  Source: [HOOKS](https://code.claude.com/docs/en/hooks)
- `${user_config.*}` is substituted only in exec-form plugin hooks. A shell-form hook that references it fails; since v2.1.207 shell-form no longer substitutes it. Shell-form hooks read `$CLAUDE_PLUGIN_OPTION_<KEY>` instead — [HOOKS](https://code.claude.com/docs/en/hooks)
- To match the plugin's own MCP tools, use the full name `mcp__plugin_<plugin>_<server>__<tool>`. A server name alone never matches — [COMPONENTS](https://code.claude.com/docs/en/plugins/components)
- Plugin hooks also run inside subagents. Tool events carry `agent_id` and `agent_type` — [HOOKS](https://code.claude.com/docs/en/hooks)
- Enterprise `allowManagedHooksOnly` blocks plugin hooks unless the plugin is force-enabled in managed settings — [HOOKS](https://code.claude.com/docs/en/hooks)
- Exit code 2 on `PreToolUse` blocks the tool call. `PermissionRequest` doesn't honor exit code 2 — [HOOKS](https://code.claude.com/docs/en/hooks)

### Inferences
- Possible video-studio hooks:
  - `SessionStart` to install dependencies or check that ffmpeg is present
  - `PostToolUse` with matcher `Bash` and `if: "Bash(video-studio *)"` to post-process renders
- Use exec form with `${CLAUDE_PLUGIN_ROOT}` in `args`.

### Gaps
- I did not extract the full per-event JSON input and output schema. See HOOKS for each event if needed.

---

## 6. Marketplaces, install commands, validation, submission

### Takeaway
A marketplace is `.claude-plugin/marketplace.json`, with required `name`, `owner` and `plugins[]`. Each entry needs `name` and `source`. A single repo can hold both `plugin.json` and a `marketplace.json` whose entry has `"source": "./"`. Users run `/plugin marketplace add owner/repo`, then `/plugin install video-studio@<marketplace>`. `claude plugin validate [--strict] [--json] <path>` is the authoritative check. Public listing goes through the community marketplace submission forms. The official marketplace does not take form submissions, which conflicts with the official repo's README.

### Cited Findings
- `marketplace.json` top-level fields:
  - Required: `name`, `owner` (`name` required; `email` and `url` optional), `plugins`.
  - Optional: `$schema`, `description` (validate warns if missing), `version`, `metadata.description`, `metadata.version`, `metadata.pluginRoot` (v2.1.239+), `forceRemoveDeletedPlugins`, `allowCrossMarketplaceDependenciesOn`, `renames` (v2.1.193+).
  - Unknown keys are ignored, and `validate` warns.

  Source: [MKT](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Reserved marketplace names include `claude-plugins-official`, `claude-code-plugins`, `anthropic-plugins`, `agent-skills`, `claude-community`, `inline`, `builtin`, `skills-dir`, `synced`, `npm`, `github`, and names starting with `claudeai-`. Names that imitate an official marketplace are rejected — [MKT](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Plugin entry fields:
  - Required: `name`, `source`.
  - Optional: `description`, `version` (`plugin.json` wins and validate warns), `category`, `tags`, `strict` (default true), `relevance`, `dependencies`, `defaultEnabled`, `displayName`, `metadata`, `headers`, `headersHelper`.
  - An entry also accepts every `plugin.json` field.

  Source: [MKT](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Plugin source types:
  - A relative path starting with `./`
  - `{"source":"github","repo":"owner/repo","ref","sha"}`
  - `url` (any git)
  - `git-subdir` (`url`, `path`, `ref`, `sha`)
  - `npm` (`package`, `version`, `registry`; no install scripts are run)
  - `archive`
  - `command`

  Source: [MKT](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Strict mode:
  - With `plugin.json` present and `strict: true`, the entry's component fields are appended to the manifest.
  - With `strict: false`, any entry component field is a conflict ("has conflicting manifests").
  - With no `plugin.json`, the entry is the manifest.

  Source: [MKT](https://code.claude.com/docs/en/plugins/marketplace-reference)
- Single-repo self-marketplace:
  ```json
  {"name":"your-marketplace","owner":{"name":"Your Name"},"plugins":[{"name":"deploy-helper","source":"./"}]}
  ```
  Keep the entry name the same as the `plugin.json` name. Source: [PUBLISH](https://code.claude.com/docs/en/plugins/publish)
- Install commands:
  - In a session: `/plugin marketplace add owner/repo`, which also accepts `#ref`, a git URL, a `./local` path or an https `marketplace.json` URL. Then `/plugin install name@marketplace`, which opens the details panel to choose a scope.
  - From the shell: `claude plugin marketplace add ...` and `claude plugin install name@mkt [--scope user|project|local] [--config KEY=VALUE]`.
  - One-step: `/plugin install name --marketplace owner/repo` (v2.1.275+).

  Sources: [install](https://code.claude.com/docs/en/plugins/install); [PUBLISH](https://code.claude.com/docs/en/plugins/publish)
- Other CLI subcommands: `init`, `install`, `uninstall` (`--keep-data`), `enable`, `disable`, `update`, `list [--json]`, `details`, `prune`, `eval`, `eval init`, `tag` (creates `{name}--v{version}`), `validate`, and `marketplace add|list|remove|update`. `claude plugins` is an alias — [CLI](https://code.claude.com/docs/en/plugins/cli-reference)
- `claude plugin validate <path> [--strict] [--json]`:
  - It validates `marketplace.json` if present, otherwise `plugin.json`, otherwise the component directories.
  - Exit codes: 0 means passed (possibly with warnings), 1 means failed (or warnings under `--strict`), 2 means the validator itself errored.
  - Run from a marketplace directory, it does not check the plugins' skill, agent or hook files. Validate each plugin directory separately.

  Source: [CLI](https://code.claude.com/docs/en/plugins/cli-reference)
- Test locally without installing: `claude --plugin-dir ./video-studio`, which also accepts a `.zip`, or `--plugin-url <zip-url>`. The plugin loads as `<name>@inline`, and `/reload-plugins` reloads it — [CLI](https://code.claude.com/docs/en/plugins/cli-reference)
- Pre-release checklist:
  - Choose a permanent kebab-case name.
  - Either bump `version` on every release, or omit it so the git SHA is used.
  - Run `claude plugin validate --strict`.
  - Install from a local marketplace.
  - Fill in `description`, `author`, `homepage`, `repository` and a README.
  - Optionally run `claude plugin eval`.

  Source: [PUBLISH](https://code.claude.com/docs/en/plugins/publish)
- If `version` is set but not bumped, `claude plugin update` prints "already at the latest version" and users keep the old copy — [PUBLISH](https://code.claude.com/docs/en/plugins/publish)
- Submission routes:
  - The community marketplace (`anthropics/claude-plugins-community`, installed as `@claude-community`) takes submissions through claude.ai/admin-settings/directory/submissions/plugins/new, which needs a Team or Enterprise org and the Directory permission, or through platform.claude.com/plugins/submit for individuals. Listings are pinned to a commit SHA.
  - "The official marketplace, `claude-plugins-official`, doesn't take submissions through these forms. If you work with an Anthropic partner contact, ask them about an official-marketplace listing."

  Source: [PUBLISH](https://code.claude.com/docs/en/plugins/publish). **Contradicted by** the [claude-plugins-official README](https://github.com/anthropics/claude-plugins-official), which says "Third-party partners can submit plugins... use the plugin directory submission form (https://clau.de/plugin-directory-submission)". That repo has `/plugins` (Anthropic-maintained) and `/external_plugins` (third-party).
- Plugin names in a marketplace are immutable slugs. Use `displayName` to relabel, and the `renames` map for unavoidable renames — [claude-plugins-official README](https://github.com/anthropics/claude-plugins-official); [PUBLISH](https://code.claude.com/docs/en/plugins/publish)

### Inferences
- The realistic path for video-studio is to self-host (GitHub repo with `.claude-plugin/marketplace.json`) and optionally submit to the community marketplace through the Console form. An official-marketplace listing appears to need a partner relationship. The docs are newer and more specific than the README, so they probably reflect current policy.
- Add `claude plugin validate --strict .` to CI.

### Gaps
- I did not find published review criteria (quality or security bar) for community submissions, beyond "must meet quality and security standards".

---

## 7. userConfig, settings and secrets

### Takeaway
Declare `userConfig` in `plugin.json`, and Claude Code prompts the user in the `/plugin` UI on install or enable. A field marked `sensitive: true` (for example an API key) is masked and stored in the OS secure credential store. Non-sensitive values go under `pluginConfigs` in `settings.json`. Hooks read values as `CLAUDE_PLUGIN_OPTION_<KEY>`. MCP and LSP configs, exec-form hook args, and skill or agent content read them as `${user_config.KEY}`; skill and agent content gets non-sensitive values only.

### Cited Findings
- Each `userConfig` option is a strict object:
  - Required: `type` (`string`, `number`, `boolean`, `directory` or `file`), `title`, `description`.
  - Optional: `required`, `default`, `options` (a string picker, v2.1.271+; older clients cannot load the plugin), `multiple`, `sensitive`, and `min`/`max` for numbers.
  - Keys use `[A-Za-z0-9_]` and must not start with a digit.

  Source: [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- Storage: non-sensitive values go to `pluginConfigs` in the user's `settings.json`. Sensitive values go to the platform secure credential store. Options also appear in `/config`, except sensitive and multiple options (v2.1.269+) — [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- Where values reach a component:
  - `${user_config.KEY}` works in MCP and LSP config, exec-form hook `args`, and skill and agent content. In skill and agent content, sensitive values become a placeholder.
  - `CLAUDE_PLUGIN_OPTION_<KEY>` is exported to hook processes.
  - Shell-form hooks, monitor commands and MCP `headersHelper` reject `${user_config.*}`.
  - Monitors don't receive option environment variables.

  Source: [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- When the dialog appears: only in the interactive `/plugin` UI, on install, on `/plugin install`, on enable from the Installed tab, or on `/plugin configure <plugin>@<marketplace>`. `claude plugin install` from the shell never prompts. Use `--config KEY=VALUE` there — [COMPONENTS](https://code.claude.com/docs/en/plugins/components)
- Plugin `settings` or `settings.json` only affects `agent` and `subagentStatusLine`; other keys are dropped — [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)

### Inferences
- The Bash tool does not receive `CLAUDE_PLUGIN_OPTION_*`, which is only exported to hooks, and sensitive values are not substituted into skill text. So the `bin/video-studio` CLI cannot read an API key (e.g. ElevenLabs or OpenAI TTS) from userConfig directly. Options:
  - A `SessionStart` hook that reads `$CLAUDE_PLUGIN_OPTION_<KEY>` and writes it to a 0600 file under `${CLAUDE_PLUGIN_DATA}` for the CLI to read. This is a workaround; weigh the security trade-off.
  - Have the CLI read a standard env var or its own config file.
  - Wrap the API in a plugin MCP server, whose `env` can use `${user_config.api_key}`. This is the documented, secure path.

### Gaps
- The docs don't describe any direct mechanism for exposing userConfig values to Bash-tool commands. This inference is based on the "where each variable resolves" table.

---

## 8. SKILL.md size and best practices

### Takeaway
Keep SKILL.md under 500 lines, and the body under about 5,000 tokens. The description, which is always loaded, should say what the skill does and when to use it, with the key use case first. Move detail into `references/`, `scripts/` and `assets/`, reference those files one level deep from SKILL.md, and state in SKILL.md when to load each one.

### Cited Findings
- Tip from the docs: "Keep `SKILL.md` under 500 lines. Move detailed reference material to separate files." Reference supporting files from SKILL.md so Claude knows what each contains and when to load it. Scripts are "executed, not loaded" — [SKILLS](https://code.claude.com/docs/en/skills)
- The body stays in context across turns once loaded, so "every line is a recurring token cost". State what to do rather than narrate — [SKILLS](https://code.claude.com/docs/en/skills)
- The description plus `when_to_use` is truncated at 1,536 characters in the listing, so put the key use case first — [SKILLS](https://code.claude.com/docs/en/skills)
- Progressive disclosure in three tiers: metadata of about 100 tokens is loaded at startup, instructions under about 5,000 tokens load on activation, and resources load as needed. Use the `scripts/`, `references/` and `assets/` directories. Keep references one level deep. Validate with `skills-ref validate ./my-skill` — [SPEC](https://agentskills.io/specification)
- Measuring and tuning: `claude plugin eval` runs prompts with and without the plugin to test triggering and delegation. The skill-creator skill supports evals — [AGENTS](https://code.claude.com/docs/en/sub-agents); [SKILLS](https://code.claude.com/docs/en/skills)

### Inferences
- Structure each video-studio skill as a concise SKILL.md: a workflow checklist plus pointers such as "for caption styles read references/captions.md". Put bulky specs (codec presets, template schemas) in `references/`. Deterministic operations belong in the `bin/` CLI or in `scripts/`.

### Gaps
- I did not fetch the separate "skill authoring best practices" page on docs.claude.com. The guidance above comes from the Claude Code skills page and the agentskills.io spec.

---

### Notable recent changes and deprecations
- Commands have been merged into skills. `commands/` is legacy — [SKILLS](https://code.claude.com/docs/en/skills)
- Top-level `themes` and `monitors` keys still load, with warnings. Move them under `experimental` — [MANIFEST](https://code.claude.com/docs/en/plugins/manifest-reference)
- Since v2.1.207, shell-form hooks no longer substitute `${user_config.*}` — [HOOKS](https://code.claude.com/docs/en/hooks)
- Since v2.1.218, agent names containing `:` are rejected — [AGENTS](https://code.claude.com/docs/en/sub-agents)
- Skill-name prefix doubling was fixed in v2.1.246 — [SKILLS](https://code.claude.com/docs/en/skills)
- The official marketplace no longer takes form submissions. Use the community marketplace instead — [PUBLISH](https://code.claude.com/docs/en/plugins/publish)
