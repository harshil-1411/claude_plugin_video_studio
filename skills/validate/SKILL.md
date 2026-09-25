---
name: validate
description: Validate a video-studio VideoSpec (video-spec.json) against the schema and semantic rules, and explain each error with a concrete fix. Use when the user runs /video-studio:validate, after writing or editing a spec, or before rendering.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+).
allowed-tools: mcp__plugin_video-studio_engine__spec_validate mcp__plugin_video-studio_engine__schema_get Read
---

# Validate a VideoSpec

1. Work out what to validate:
   - A project folder (contains `project/project.json`): pass `project_dir`.
     The tool reads `project/video-spec.json` and cross-checks
     `source/content-ir.json` if present.
   - A single spec file: pass `spec_path`, plus `content_ir_path` if the user
     has a ContentIR to check evidence refs against.
   - If the user gave no path, use the current working directory as `project_dir`.
   Always pass absolute paths.
2. Call `mcp__plugin_video-studio_engine__spec_validate`.
3. If `ok` is true, say so in one line and mention any warnings briefly.
4. If `ok` is false, list each error as `path: message` and propose the fix.
   Stages mean:
   - `syntax`: the file is not valid JSON/YAML.
   - `schema`: a field is missing, mistyped or out of range. Call
     `mcp__plugin_video-studio_engine__schema_get` with `name: "video-spec"` if you
     need the exact field definitions.
   - `semantic`: cross-field rules, such as scene durations summing to within 10%
     of `target_duration_sec`, unique scene ids, `motion_graphic` scenes needing
     `deterministic` props, no provider or model names in `visual_requirements`,
     and evidence refs that exist in the ContentIR.
5. Offer to apply the fixes. If the user agrees, edit the spec, then validate again
   until it passes.

Scenes declare capabilities, never provider or model names; routing picks the provider.
