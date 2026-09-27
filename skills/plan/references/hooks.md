# Hook mechanisms

The hook is the first 1.5-3.5 s: one spoken line (≤ ~9 words) plus one
on-screen phrase. Its only job is to make the right viewer stay for the next
beat. Write at least three candidates with **different** mechanisms, then score.

The decision to stay is made in the first 1-2 s, so the specific part (the
promise, the tension or the number) goes first, not after a lead-in:
"Captions hide under the app UI" beats "So, let's talk about captions". A good
hook also opens the loop the payoff will close; note the question it raises
and make sure a later scene answers it (`storytelling.md`).

The examples below are illustrative patterns, not facts. Real hooks use only
facts found in the project's ContentIR.

## Recording a hook in the brief

`hook_candidates[].mechanism` accepts only these schema values:
`curiosity_gap`, `contrarian`, `contrarian_claim`, `statistic`, `question`,
`pain_point`, `promise`, `story`, `demo`, `pattern_interrupt`,
`before_after`, `mistake`.

| Mechanism (taxonomy) | Record as |
|---|---|
| Contrarian claim | `contrarian_claim` (`contrarian` is the older equivalent) |
| Question | `question` |
| Surprising stat | `statistic` |
| Before/after | `before_after` |
| Mistake | `mistake` |
| Curiosity gap | `curiosity_gap` |
| Direct promise | `promise` |
| Story open | `story` |
| Product shown working in the first seconds | `demo` |
| Visual/audio jolt that breaks the scroll | `pattern_interrupt` |

Prefer the template's `hook_mechanisms` (best first); `brief_validate`
warns when the chosen hook uses one the template does not list.

## Scoring rubric (0-10 each, stored in `scores`)

- `relevance`: speaks to this audience's goal or pain, not a generic one.
- `clarity`: understood on first hearing, no jargon the audience lacks.
- `curiosity`: opens a question the next scenes answer.
- `evidence_strength`: 9-10 quotes a sourced fact; 5-7 is a fair framing of
  sourced facts; ≤ 3 is unsupported. Never pick a ≤ 3 hook in strict mode.
- `visual_potential`: can be shown in one strong frame (text card, code,
  chart, before/after split, image).

Pick the highest total. Ties: evidence strength, then clarity.

## Hook-strength check: big, relatable, easy, new, safe

Run this on every candidate after the rubric. Start from the video's
**genuine content promise**, meaning what the video really delivers according to the
ContentIR. Then ask which of the five qualities the hook truly has. A hook
earns a quality only through that promise. Wording that sounds big or new
does not count.

| Quality | The hook has it when | It does not have it when |
|---|---|---|
| **Big** | the stake is large for this audience: time, money, risk or a real change in how they work, as the sources show it | the stake is inflated past the sources, or is large only for someone else |
| **Relatable** | the viewer recognises their own situation, pain or goal in the first line | it needs context the viewer lacks, or describes a niche they are not in |
| **Easy** | it is understood on one hearing, with one idea and no jargon the audience lacks | it needs a second read, stacks two numbers or opens with a lead-in |
| **New** | it tells this audience something they don't already assume: a sourced fact, a fresh angle, a result shown for the first time | it restates common knowledge, or claims novelty the product does not have |
| **Safe** | every word is true to the sources, fair to others and within the brand's rules and policy | it relies on an unverified claim, attacks a named competitor, makes a health, money or legal promise, or uses a banned phrase |

Rules:

- **Never invent data or claims to make a hook land.** Do not round a number
  up, add a statistic, imply a result the product has not shown or create a
  customer story to earn "big" or "new". If the genuine promise is modest,
  write a modest hook that is easy and relatable. That beats a big hook the
  video can't pay off.
- **Safe is a gate, not a score.** A candidate that isn't safe is dropped,
  whatever its total.
- **Note which qualities each candidate truly has.** Record them in the
  candidate's `scores` beside the rubric scores (0-10), for example
  `big: 7, relatable: 9, easy: 8, new: 4`. A candidate you keep is safe, so
  it has no `safe` score. When you show the candidates to the user, give one
  short reason per quality, for example "relatable: every reviewer hits
  this; new: only for non-engineers". Leave a quality low when the hook
  doesn't have it; don't round it up.
- A strong hook usually has **at least three** of big, relatable, easy and
  new, and is always safe. With fewer than three, try another mechanism
  before settling. If none gets there, choose the most honest candidate and
  say so in the brief's assumptions.

---

## Contrarian claim
- **When**: the audience holds a common belief the sources genuinely
  challenge. Needs a source-backed reason in the next beat.
- **Pattern**: "Stop <common practice>. <Better alternative>." / "<Belief> is wrong."
- **Technical**: "Stop writing video prompts. Compile your docs instead."
- **Non-technical**: "Budgets don't fail in January. They fail in March."
- **Anti-patterns**: contrarian for its own sake; attacking a named competitor;
  a claim the body never proves.

## Question
- **When**: the audience already asks this question; the video answers it
  in full.
- **Pattern**: "Why does <familiar pain> happen?" / "What if <outcome>?"
- **Technical**: "Why is your search missing obvious results?"
- **Non-technical**: "Why do houseplants die in winter?"
- **Anti-patterns**: yes/no questions the viewer answers "no" to;
  "Did you know...?"; questions the video never answers.

## Surprising stat
- **When**: the sources contain a striking, specific number. Requires a
  `claim_refs` entry on the hook scene.
- **Pattern**: "<Number> <unit> <surprising consequence>."
- **Technical**: "Query latency dropped 27% with one setting."
- **Non-technical**: "One in three returns starts with the wrong size."
- **Anti-patterns**: rounding or inflating the number; stats without a
  source; stacking two numbers in one line.

## Before/after
- **When**: the change is visual (UI, output, code size, a workflow).
- **Pattern**: "<Before state>. <After state>." with a split-screen visual.
- **Technical**: "Forty lines of setup. Now it's one command."
- **Non-technical**: "Same room, same budget, twice the light."
- **Anti-patterns**: staged or exaggerated "before"; an "after" the
  product cannot do today.

## Mistake
- **When**: the audience makes a common, costly mistake the sources address.
- **Pattern**: "You're probably <mistake>." / "The #1 mistake with <X>."
- **Technical**: "Your migration has no rollback. That's a bet."
- **Non-technical**: "You're watering your plants on a schedule."
- **Anti-patterns**: shaming; "#1" without evidence it is the top mistake.

## Curiosity gap
- **When**: there is a genuine payoff later in the video worth waiting for.
- **Pattern**: "<Surprising outcome>. Here's how." / "The reason is <not what you think>."
- **Technical**: "This plugin needs no LLM API key. Here's why."
- **Non-technical**: "Chefs salt pasta water for a reason nobody mentions."
- **Anti-patterns**: clickbait the payoff doesn't honor; withholding the
  point until the last second.

## Direct promise
- **When**: the viewer's goal is practical and the video delivers it.
  Strong default for tutorials and launches.
- **Pattern**: "<Outcome> in <time/steps>." / "Point it at <input>. Get <output>."
- **Technical**: "Point it at a README. Get a video plan back."
- **Non-technical**: "Three steps to a calmer inbox."
- **Anti-patterns**: promising results, speed or money the sources don't
  support; "guaranteed", "instantly".

## Story open
- **When**: the source contains a real narrative (incident, migration,
  customer journey). Needs the story in the evidence.
- **Pattern**: "<Time/place>, <character> <tension>."
- **Technical**: "Six months ago we moved 40 services off MySQL."
- **Non-technical**: "The bakery ran out of flour at 6 a.m."
- **Anti-patterns**: invented characters or events; slow scene-setting;
  a story that never connects to the point.

## General anti-patterns (any mechanism)

- Greetings, logos or "In this video..." before the hook.
- Two ideas in the hook.
- Hype words (see `script-writing.md`), emojis read aloud, all-caps shouting.
- A hook whose on-screen text just repeats the voiceover word for word.
- A promise, question or number the video never pays off.
- Borrowing another creator's words or format verbatim.
