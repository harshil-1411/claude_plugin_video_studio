# Storytelling for short videos

A short video keeps its viewer when every few seconds give a reason to see the
next few. These rules turn the template's beats into an arc. They never
override grounding: tension, surprise and payoff come from facts in the
ContentIR, not from invented stakes.

## The arc in six moves

1. **Hook (0–2 s).** Open with the most specific thing you have: a promise
   ("Point it at a README, get a plan"), a tension ("Your captions hide under
   the app"), or a surprising, sourced number. No greeting, no logo, no
   "in this video". See `hooks.md` for mechanisms.
2. **Open a loop (by ~40% of the runtime).** Right after the hook, raise
   one question the viewer now wants answered: why does this happen, what is
   the fix, how did they do it. Record that scene as `question`, `problem`,
   `contrarian_claim` or `story`.
3. **Escalate.** Order the middle points from least to most surprising, so
   each beat raises the stakes a little. Put the strongest point last.
4. **Payoff.** Close the loop you opened: answer the question, show the
   result, reveal the number. Make it a scene of its own (`payoff`,
   `result`, `reveal`, or `loop_back` when it hands the viewer back to the
   opening).
5. **Callback.** In the payoff, echo the hook's words or image ("Remember
   the captions under the app? Now they sit above it."). This tells the
   viewer the promise was kept, and on a looping reel it makes the replay
   seamless.
6. **CTA (one action).** Only after the payoff. One verb, one object, one
   thing to do today (`script-writing.md`, CTA rules).

Lint checks the skeleton of this arc (`story_structure`): a tension scene
early on, and a payoff as the last scene before the CTA or end card.

## One idea per scene, a change every 2–4 s

- Each scene carries one idea. If a line needs "and also", split the scene.
- Something on screen should change every 2–4 s: a cut, a new line of text,
  a highlight, a motion. A 6 s scene needs an internal change (a second
  text line, a `punch` on the number, a `push_in`), or it should be two
  scenes.
- Vary the kind of change (a pattern interrupt): do not use the same
  transition and motion five times in a row. Switch the `deterministic.kind`
  (text card, then chart, then code), the motion, or the transition.

## Mapping to spec fields

| Story move | `purpose` | Typical `motion.pattern` | Transition in |
|---|---|---|---|
| Hook | `hook` | `punch` (a number or word landing) or `push_in` | none (first scene) |
| Open loop | `question`, `problem`, `contrarian_claim`, `story` | `push_in` (lean in) or `hold` | `cut` or `whip` |
| Context, steps | `context`, `point`, `step`, `demo`, `comparison` | `drift` (calm), `reveal` (each new idea) | `cut`, `slide` |
| Escalation peak | `proof`, `point` | `punch` | `cut` (a blending transition hides the pop) |
| Payoff | `payoff`, `result`, `reveal` | `pull_out` (show the whole) or `reveal` | `crossfade` or `zoom` with `pull_out`; `cut` with `reveal` |
| Loop point | `loop_back` | match the hook's motion | `cut` |
| CTA / end card | `cta`, `end_card` | `hold` (let it be read) | `fade_black` or `crossfade` |

`scene.motion` is `{pattern, intensity?}`. The patterns:

- `push_in`: slow zoom towards the centre; focus, emphasis.
- `pull_out`: slow zoom out; context, showing the whole picture.
- `punch`: a quick scale pop on the first beat; a stat or a key word landing.
- `reveal`: the frame wipes in from one side; a new idea arriving.
- `drift`: a slow sideways pan; calm b-roll, ambient scenes.
- `hold`: deliberately still; let a line or a CTA breathe.

`intensity` is `subtle`, `normal` (default) or `strong`. Keep `strong` for
one or two moments per video; used everywhere it stops being a change.
Transitions are `cut`, `crossfade`, `fade_black`, `slide`, `zoom` and
`whip`; plain cuts are the default rhythm, and the others mark a shift.

## Retention checks (before validating)

Read the storyboard as a viewer who is about to scroll away:

- **Second 3:** Has the hook made a specific promise or raised a question?
  If the first 3 s could open any video on the topic, rewrite the hook.
- **Midpoint:** Is there still an unanswered question, or a stronger point
  still to come? If the best point is already spent, move it later.
- **Before the CTA:** Has the loop from the start been closed on screen?
  If not, add or sharpen the payoff scene.
- **Every scene:** does something change within 4 s?

## Anti-patterns

- Tension the video never resolves, or a payoff that is weaker than the hook.
- Invented stakes ("everyone is getting this wrong") the sources do not back.
- Saving the answer for the last second so the CTA arrives before the payoff.
- Two CTAs, or a CTA before the payoff.
- Constant `strong` motion and flashy transitions on every cut.
