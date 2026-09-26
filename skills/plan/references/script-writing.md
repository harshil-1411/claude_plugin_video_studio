# Script writing

## Write for the ear

- One sentence, one thought. Aim for 6-12 words per sentence; never over 18.
- Subject-verb-object. Active voice. Contractions ("it's", "you'll").
- No parentheses, footnotes, semicolons or "e.g.". Spell out symbols the
  voice would stumble on: "claude, dash dash plugin dir, dot" for
  `claude --plugin-dir .`; "C I C D" for CI/CD (or add it to the brand's
  `language.terminology`).
- Numbers: short numbers are fine in voiceover ("27%" is read as
  "twenty-seven percent"). Keep long decimals, version strings and IDs on
  screen, not in the narration.
- Read every line aloud in your head. If you'd run out of breath, split it.
- Talk to one viewer ("you"), not "users" or "everyone".

## Pacing math

- Narration rate: **2.3-2.8 words per second** (≈ 140-170 wpm). Use 2.5 as
  the default; 2.3 for dense technical lines, 2.8 for punchy hooks/CTAs.
- `duration_sec ≈ words ÷ rate + 0.3` (breath and the cut), rounded to 0.5 s.
- Budget check: total words ≈ `target_duration_sec × 2.5` minus silent
  scenes. A 30 s video holds about 65-75 spoken words; 45 s about 100-110.
- Hook ≤ 3.5 s. First idea lands by ~5 s. CTA 3-5 s. End card 1.5-2.5 s, silent.
- Short-form (≤ 60 s): scenes of 2.5-8 s; change the visual every 2-4 s (a
  new line of text, a highlight, a `motion` pattern, a cut). Scenes over
  ~4 s need an internal change or a split (`storytelling.md`).
- Scene durations must sum to within ±10% of `target_duration_sec`.

## No voiceover (`voice.mode: "none"`)

Text-over-music reels (`text-over-music`, or any template with
`voice_mode: none` passed to `spec_scaffold`) have no speech:

- Every `voiceover` is `""` (the validator errors otherwise). The words live
  in `on_screen_text` or the deterministic props; do not repeat them in both.
- Budget on-screen words, not spoken ones: about **3 words per second after
  a 1 s settle** per scene (`spec_scaffold`'s `word_budget`; lint uses the
  same rule). A 3 s card holds about 6 words. Cut words before lengthening cards.
- One message per card, at most two short lines; the hook card readable in 2 s.
- Grounding is unchanged: a number or claim on screen still needs
  `claim_refs`.
- `captions.burn_in: false` (nothing to caption) and a music bed in
  `audio.music` (see `brief-and-spec-fields.md`), or the video is silent.

## One idea per scene

- Each scene makes exactly one point: one claim, one step, one example.
- If the voiceover contains "and also", "plus", or two facts from different
  evidence refs about different things, split it.
- The on-screen text (≤ 6 words) names that idea; it does not transcribe
  the voiceover.
- Order: follow the template's beats (e.g. hook → problem → point/demo →
  proof → CTA). Build the beat list first, then write scenes into it.
- Within the beats, escalate: least surprising point first, strongest last,
  then the payoff that answers the hook's question, then the CTA
  (`storytelling.md`).

## CTA rules

- Exactly one ask, matching the brief's `desired_action`.
- It comes after the payoff, never before the promised answer.
- Concrete verb + object: "Run the doctor", "Read the docs", "Try it
  locally". Not "Check it out!" or "Smash that like button".
- If the brand has `cta.allowed`, use one of those phrasings.
- The CTA must be something the viewer can do today. Never promise an
  unreleased feature as available.
- Show the exact command, URL or handle on screen; say a speakable form.

## Grounding rules

With `grounding: "strict"` (default):

- Every factual statement, number, name, comparison, capability claim or
  quote in `voiceover` or `on_screen_text` needs `claim_refs` with at least
  one ref copied exactly from the ContentIR: an `evidence[].ref`
  (e.g. `markdown:README.md#L3-L6`, `url:https://x.dev/post#install`,
  `repo:src/a.ts#L10-L20`) or a `claims[].id`.
- The line must say no more than the evidence: same number, same unit,
  same qualifier ("up to", "in our tests", "at p99"). Keep hedges.
- Do not combine two sources into a new conclusion neither states.
- Opinions and framing ("There's a better way") need no ref only when they
  contain no fact. If in doubt, cite or cut.
- Present tense only for what the source says works **today**. Planned or
  roadmap items must be phrased as future ("coming", "later phases").
- `claim_refs: []` is fine for pure CTA, end card or transition scenes.
- `loose`: cite numbers and named claims, framing may paraphrase.
  `off`: only for fiction or opinion pieces the user explicitly asked for.

## Banned hype words

Do not use these unless quoting a source verbatim (and even then, prefer not):

revolutionary, game-changing, game changer, groundbreaking, cutting-edge,
next-level, next-gen, disruptive, world-class, best-in-class, unparalleled,
unprecedented, seamless, seamlessly, effortless, effortlessly, magic,
magical, supercharge, turbocharge, 10x (unless sourced), blazing fast,
lightning fast, insane, mind-blowing, unleash, unlock the power, harness the
power, empower, synergy, leverage (as a verb), robust, state-of-the-art,
guaranteed, the ultimate, the only, the best, ever, simply, just (as in
"just do X"), literally, "in today's fast-paced world", "look no further".

Also add everything in the brand's `voice.avoid`, and respect
`claims.prohibited` (for example `unqualified_superlatives`).

## Final checklist per scene

1. One idea? 2. Speakable in its duration at 2.3-2.8 wps? 3. On-screen text
≤ 6 words and not a transcript? 4. Every fact has a real ref? 5. No hype
words, no provider or model names? 6. Tone matches the brief? 7. Does
something change on screen within 4 s? 8. Does it move the story (open,
escalate or close the loop)?
