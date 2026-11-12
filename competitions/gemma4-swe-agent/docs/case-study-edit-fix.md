# Case study: eight edit-failure fixes, screened before any scored run

A coding agent's `edit_file` tool calls failed often: in the baseline package's captures about a third of edit
calls were rejected, mostly because the model closed a string argument with the wrong token ("slip"), and after one
rejected call it usually repeated the identical call ("retry lock"). Eight candidate fixes were screened with the
replay and fork instruments in `src/replay/` before any of them was allowed near a scored run — seven through
next-call replay (`replay-states.ts`), and one (the write-file fallback, whose change spans multiple steps rather
than one decision point) through a fork screen. None passed.

Every count below is from the campaign ledger. "sel" and "conf" are the selection and confirmation halves; the
split unit is the run, so all resamples of one state stay in one half. Controls ran in the same round as the arms.

**Replay gate** (pre-registered before each round): candidate fail rate <= 0.5 x control in selection AND
<= control in confirmation, on at least one state type. A pass would only have earned a fork screen.

**State types.** *Entry*: a fresh `edit_file` call that succeeded in the baseline capture (48 sampled).
*Onset*: the captured request whose answer was a fresh slip (37 onsets). *Retry*: the first exchange after an
onset, when the model has just seen its call rejected.

| fix | what it changes | states | control | endpoint | result, candidate vs control (sel; conf) | verdict |
|---|---|---|---|---|---|---|
| write-file fallback | prompt: rewrite small files (<= 150 lines, 6000 B) whole; switch after a failed edit | fork screen: 8 failure forks (4 slip, 4 exact-match) + 2 regression forks, captured prefix forced at the first edit, live tools, 4 rollouts per fork per arm | baseline package on the same forks | resolved rollouts | failure forks 4/32 vs 3/32; regression forks 8/8 vs 8/8 | failed (gate: >= +4 of 32 on failure forks, <= 1 of 8 lost on regression forks) |
| recover rule | prompt: name the error, forbid repeating the call, prescribe a different next call | entry + retry, 2 resamples per state | baseline prompt | entry: escaped or slip; retry: verbatim repeat or slip | entry 6/48 vs 5/50; 2/43 vs 3/46. retry 27/36 vs 28/36; 23/30 vs 23/30 | no pass |
| fenced draft | prompt: draft the replacement in a fenced block while thinking, then copy it unchanged | as above | as above | as above | entry 5/47 vs 5/50; 1/43 vs 3/46. retry 26/35 vs 28/36; 25/30 vs 23/30 | no pass |
| fenced draft + recover | both prompts | as above | as above | as above | entry 5/49 vs 5/50; 2/41 vs 3/46. retry 29/36 vs 28/36; 23/28 vs 23/30 | no pass |
| temperature 0.7 | sampling (control 0.2) | onset + retry, 2 resamples | baseline prompt at 0.2 | onset: slip; retry: repeat or slip | onset 24/36 vs 24/36; 24/38 vs 30/38. retry 26/34 vs 24/34; 26/32 vs 26/32 | no pass |
| temperature 1.0 | sampling | as above | as above | as above | onset 16/36 vs 24/36; 24/38 vs 30/38. retry 25/34 vs 24/34; 24/32 vs 26/32 | no pass (onset sel 0.44, gate 0.33) |
| temperature 1.0 + top_k 64 | sampling | as above | as above | as above | onset 23/36 vs 24/36; 17/38 vs 30/38. retry 27/34 vs 24/34; 27/32 vs 26/32 | no pass |
| thinking off | no thinking at the edit step | entry + onset + retry; resamples per state not recorded | baseline, thinking on | as the state type | onset 28/40 vs 26/40; 21/34 vs 25/34. retry 30/36 vs 29/36; 22/30 vs 24/30. entry 8/48 vs 5/48; 5/45 vs 1/43 | no pass |

## What the screens did and did not show

- One prompt round had 20 request timeouts, all in treatment arms (5, 7 and 8 across the three prompt arms, 0 in
  control). They were not scored. Differential attrition cannot rescue a failed gate, but it is a cost signal.
- Replay measures one step, conditional on the baseline's own histories. It says nothing about loop escape or
  prevention; forks and live runs do.
- A failed halving gate does not exclude a smaller effect. The defensible statement is "these prompt and sampling
  arms did not halve the failure rate", not "prompt text cannot fix it".
- A logprob probe found the slip is a confident token-level preference (median probability of the wrong token
  about 0.93), which is consistent with prompt and sampling arms not moving it.
- The lane was then closed by a task-level check: the slip was worth about 1-2% of tasks (ceiling about 4%),
  below single-draw noise. That is the case for doing the sizing step (`src/noise-floor/`) before building fixes.
