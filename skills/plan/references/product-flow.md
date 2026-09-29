# Product in use

A product video earns its seconds by showing the product doing its job. A
reel of landing-page claims, feature cards and stats tells the viewer what
to think; a reel of the product in use lets them see it and decide. This
reference is for the product templates (`product-demo`, `product-ui`,
`devtool-launch`, `product-launch`, `product-hero`) and the `launch` skill.

## 1. Answer the rubric from the source

Answer every line from the ContentIR (`source_summary`, then
`source_section` for the parts you use). Do not ask the user for any of it;
a line the source cannot answer is a gap you report, not a question. Keep
each answer short and keep its evidence ref.

| Question | What a good answer looks like |
|---|---|
| **What is it?** | One sentence, no adjectives: "A CLI that turns a folder of SQL files into a typed client." |
| **Who is it for, and what does it do for them?** | A person and a change: "Backend developers stop hand-writing query types." |
| **The strongest claim** | Quoted verbatim from the source, with its evidence ref. Not a paraphrase, not a superlative. |
| **The visual hook** | The one frame that makes someone stop: the moment it works, a before/after, a surprising output. |
| **The real UI to show** | Which screen, command or output is the product: a screenshot asset id, a file in the repo, or the running app. |
| **The flow** | 2–3 steps: **entry** (where the user starts) → **key action** (the one thing they do) → **result** (what they get), each with an evidence ref. |
| **Tone preset** | The nearest id in `research-specs/tones.yaml`, from the source's register and the user's direction. |
| **Post caption** | One line, specific: what it is and the result, in the product's own words. |

Write the flow into the brief as `product_flow: [{step, evidence_ref}]`
(2–4 steps) and the preset as `tone_preset`. The other answers feed
`key_messages`, the hook candidates and `publish.<target>.post_caption`.

## 2. The flow is the centrepiece

- The template's `step` / `demo` beats are the flow scenes: one step per
  scene, in order, entry first. The hook may open on the result (the
  visual hook), but the middle of the video walks the flow.
- Each flow scene shows the step happening on the real product and cites
  that step's `evidence_ref` in `claim_refs`.
- **At most one landing-page or stat card**, and only as a frame around
  the flow (a setup before it or a proof after it), never instead of it. A
  second card is a scene that should have been a step.
- On-screen words name the action or the result ("Paste the URL",
  "Typed client in 0.4 s"), not the category ("Powerful automation").
- No generic SaaS lines. Lint's `cliche` list (`research-specs/cliches.yaml`)
  is the floor; "all-in-one", "for teams of every size" and the like are
  just as empty.

## 3. How to show it, in order of preference

1. **A recording of the real app.** If the user has started their app, a
   `demo` recording of its URL (see the `demo` skill) in `screen_capture`
   scenes, one span per step. The plugin never starts the app: ask for the
   URL once and move on if there is none. A clip the user supplies works
   the same way.
2. **Real screenshots from the source.** Images the ingest found (README
   images, docs pages, `render_js` screenshots of a URL) in `screenshot`
   or `split_screen` scenes with one callout on the control that matters.
   Asset ids only; never mock up a screen that does not exist.
3. **A `motion` page rebuilt from the product's own look.** Copy the
   repo's CSS, fonts and images into `motion/<scene id>/` and rebuild the
   one screen the step needs, with the step's real labels and output (from
   the source, verbatim). Everything stays local: remote `url()` and
   `@import` are blocked by the page's CSP. Follow `code-motion.md`.
4. **Kinetic type.** Only when there is nothing to show (a library with no
   UI and no output worth reading). Then the words are the product's own
   commands and results, not claims about it.

Terminal output and code count as real UI for a developer tool: the
command and its output from the repo, at most about 8 lines on screen.

## 4. Storyboard lines: weak and good

Examples for invented products.

| Weak | Good | Why |
|---|---|---|
| "Meet Parcelnote: shipping, reimagined." (title card) | Recording: a tracking number pasted into Parcelnote's search bar; the delivery map fills in. | Shows the entry step instead of naming the category. |
| "Save hours every week" (stat card) | `screen_capture` span: the "Export all" button, then the finished CSV in the downloads bar. | The result is visible; the viewer draws the conclusion. |
| Three feature cards: "Fast · Secure · Simple" | Three scenes: open the inbox → drag a thread to "Later" → the thread comes back at 9:00. | Entry → key action → result, one per scene. |
| "The best way to write migrations" | Terminal: `drift plan` prints the three pending changes; `drift apply` prints "3 applied". | Real commands and output from the repo, verbatim. |
| Hero stat "10x faster", then the logo | One stat after the flow, cited: "Builds in 1.8 s (benchmark in README)". | One stat, framing the flow, with its ref. |
