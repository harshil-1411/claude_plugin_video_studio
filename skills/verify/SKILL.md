---
name: verify
description: Verify that a video-studio spec is grounded in its sources - which ContentIR claims and evidence each scene cites, which key claims no scene covers, which scenes make statements without claim_refs, and unresolved refs - and fix what it finds by editing the spec. Use when the user runs /video-studio:verify, asks whether a video's claims are backed by the sources, or before rendering a video with grounding strict.
license: Apache-2.0
compatibility: Requires the video-studio plugin's bundled `engine` MCP server (Node.js 22.13+).
allowed-tools: mcp__plugin_video-studio_engine__verify Read Edit
---

# Verify claim coverage

Verify checks `project/video-spec.json` against the project's ContentIR
(`source/content-ir.json`): every scene's `claim_refs` must resolve to an
evidence ref or claim id, and scenes that state things must cite the evidence
for them. `grounding` in the spec sets how strict it is: `strict` makes an
uncited scene an error, `loose` a warning, `off` only lists it. CTA and end
card scenes need no refs; an uncited hook is always only a warning.

1. Use the project folder the user named, else the cwd (absolute path). It
   needs `project/video-spec.json`, and `source/content-ir.json` from ingest
   (without it nothing can be checked; under `strict` that is an error).
2. Call `mcp__plugin_video-studio_engine__verify {project_dir}`.
3. Report the status (`pass`, `warn`, `fail`), the coverage line (claims
   covered, evidence cited), then each finding as
   `severity id scene/claim: message`, followed by its `fix`.

## Fix loop (at most 3 passes)

Run this loop when verify returns errors, or warnings the user wants cleared:

1. Read `qa/verify.md` for the per-scene and per-claim tables. Apply each
   finding's `fix` to `project/video-spec.json`, editing only the fields it
   names and keeping every other value:
   - `ungrounded_scene`: add the evidence ref(s) that support the scene's
     text to its `claim_refs` (the fix suggests the nearest ones; open
     `source/content-ir.json` to confirm the span says what the scene says).
     If no span supports it, reword the voiceover or on-screen text to what
     the sources do say. Never add a ref that does not support the text.
   - `semantic` on `claim_refs.N`: replace the ref with the one the fix names
     (the nearest existing ref), or remove it.
   - `semantic` quantitative claim: cite the evidence for the number, or
     remove the number from the text.
   - `uncovered_key_claim`: cite the claim in the scene that says it, or ask
     the user whether to add a scene or drop the key message from the brief.
   - `no_content_ir` / `invalid_content_ir`: ask the user to run ingest on the
     sources (the ingest skill); do not invent evidence refs.
2. Verify again. Stop when there are no errors, after the third pass, or when
   a finding repeats unchanged after its fix: then show the remaining findings
   and ask the user how to proceed.

Do not change `grounding` to make findings go away unless the user asks for
it. Machine-readable results are in `qa/verify.json`.
