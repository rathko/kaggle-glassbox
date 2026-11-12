# The paper's campaign: measured numbers, data release and reproduction

This is the campaign-specific half of the repository: what these instruments measured in one real Kaggle
coding-agent competition, the anonymised data behind the paper "Two Old GPUs and a Glass Box", and which
script recomputes which number. The tools themselves are documented in the [repository README](../../../README.md). Paths below are relative
to this competition's folder (`competitions/gemma4-swe-agent/`), except `src/` and `test/`, which are the toolkit
at the repository root; run the commands from the repository root.

## Measured in a real campaign

These numbers come from a Kaggle coding-agent competition's own evaluation campaign and are
reproduced from the anonymised aggregate data in [`data/`](../data/) — see
[Reproducing the paper's numbers](#reproducing-the-papers-numbers) below.

- **Re-score noise is about half of binomial sampling noise.** Scoring the exact same bytes
  twice gave a per-draw standard deviation of about **1.5 tasks**, against a **2.9**-task binomial
  standard deviation on the same n=58 slate. Many tasks always pass or always fail, so they add no
  re-score noise. It is still large enough that one upload can only show a large change.
- **Identical bytes drifted by about 2 solves between blocks**, on a 10-task local slate, against
  a **+1 solve** promotion bar. A change that cleared the bar on one block could plausibly have
  failed it on another, purely from re-run drift.
- **None of 5 cheap-stage positives was confirmed at a later, more expensive stage** in this
  campaign's funnel. A cheap PASS predicting a later PASS is exactly what a multi-stage funnel is
  *for* — and in this campaign's own history, it didn't happen once.
- **A 37% call-level edit-failure rate (36.1% over the released attempts in `data/attempts.csv`) implied only a 1-2% expected task-level gain** for fixing
  the dominant failure mode — a reminder that a loud, frequent *mechanism* failure doesn't
  necessarily translate into a correspondingly large *outcome* opportunity.
- **The flaky10 stage's own promotion history is indistinguishable from chance.** Across this
  campaign, **4 of 23** flaky10-stage ideas cleared the +1-solve promotion bar (17.4%) — squarely
  inside the **12.6-20.9%** false-pass rate `falsePassRate` predicts for a true-zero-effect idea at
  the 3-6 draws per arm this campaign actually used. A binomial upper tail puts the observed count
  at roughly a 6-in-10 chance under that null — not a surprising number, which is the same
  conclusion as the "none of 5 confirmed" bullet above, from an independent angle.

## Reproducing the paper's numbers

[`data/`](../data/) holds small, anonymised aggregate files — never prompts, task content, or
submission configs — built from the source campaign, with every variant identifier replaced by an
opaque `V##` id (the real mapping is not part of this repo). `scripts/reproduce-paper-numbers.ts`
reads them and recomputes the first three numbers above using the instruments in `src/`, so a reader
can check them independently of this README. The fourth bullet's 36.1% edit-failure rate comes from
`scripts/community-data.ts` over `data/attempts.csv`; its 37% headline and the 1-2% task-level sizing are
from the case study in [`docs/case-study-edit-fix.md`](case-study-edit-fix.md) and are not recomputed here.
The fifth (flaky10 pass rate) bullet is first
computed from a typed-in 4/23 count, and then again from `data/flaky10-decisions.json`, which holds
all 26 flaky10 reads (23 decided, 3 replications) with each read's own draw counts, control type
and verdict. The second computation gives every read its own null pass probability (a fixed
historical baseline keeps the sampling error of its own draws) and sums them: 4.07 expected null
passes under a normal model (SD 1.51; 90% range 1-7) and 4.38 under an exact per-task model (90%
range 2-8), against 4 observed (P(>= observed) 0.60 and 0.66) — 3.41 to 4.77 across the per-draw
SD's own 95% confidence interval, and 3.77 of 21 reads once the turn-0-crash reads are dropped. Dropping the 4 reads that replaced
a draw whose captures could not be matched (`replacedDraw` in the decision table) leaves 3.41
expected of 19 reads (90% range 1-6) against 3 observed. It
also predicts the platform re-score SD from per-task solve variances: a deterministic 1.68 tasks
for 58 tasks (against 1.46 observed and 2.88 under a binomial model), and a resampled median of
1.66 tasks (95% range 1.32-1.97), a little lower than the deterministic figure (Jensen's inequality
bounds the resampled mean below it, since the square root is concave; the median is lower empirically).

`scripts/gradeable.ts` sharpens that same prediction using `data/base-era-reference-fix.csv`,
which flags which of the 129 base-era tasks even have a reference fix that passes the local
grader: 100 do, and the other 29 were never solved by any draw, so leaving them in would dilute
the per-task average with zero-variance tasks. Restricted to those 100 gradeable tasks, the
resampled re-score SD rises to **1.90** tasks (95% range 1.62-2.15) — against **1.66** if the 29
never-gradeable tasks are counted. The same restriction predicts how many of a slate's tasks would
flip pass/fail between two identical re-runs of another team's agent on its own 66- and 117-task
sets: 8.3 and 14.6 predicted, against the 8 and 11 that team reported, and far below the 33 and 49
a binomial model would expect. This assumes their tasks have the same average p(1-p) as ours.
`scripts/aa-check.ts` runs the funnel's own A/A check: of 62 directed block-pair comparisons on the
3 packages nobody changed, 14 cleared the +1-solve promotion bar from drift alone, against **10.9**
expected under the measured per-draw SD — drift of that size is not something the +1 bar can tell
apart from noise.

`scripts/shared-baseline.ts` checks the dependence between reads. Three reads share one fixed baseline,
several reads share one same-block control, and one historical control reuses another read's arm draws.
Sharing only the fixed baseline leaves the null pass count at 4.07 (90% 1-7); sharing every reused draw set
keeps the mean at 4.07 and widens the range to 1-8 (P(4 or more) 0.58 instead of 0.59). The effect check,
with the same reuse and the between-block drift written into the covariance, gives Q = 21.0 on 21 df
(p 0.46), against 21.2 (p 0.45) treating the reads as independent.

Two refinements the paper's stated model leaves out, printed beside it: adding the between-block drift
(tau 0.41) to every control not drawn in the same block moves the expected null passes from 4.07 to 4.17
(3.88 without the two turn-0 crashes, against 3.77); and the power checks count only the 21 reads that ran,
because a crashed arm cannot pass at any effect (up to 12 of those 21 could carry a true +1 effect and
still leave 4 or fewer passes at least 5% likely).

```sh
bun competitions/gemma4-swe-agent/scripts/reproduce-paper-numbers.ts
```

| File | What it holds |
|---|---|
| `data/platform-history.csv` | date, anonymised variant, platform score, the integer task count `k` inferred from it (`score-quant`'s `inferK`, floor mode, out of n=58), and an id grouping the 4 identical-bytes re-upload pairs |
| `data/flaky10-drift.csv` | anonymised package, block index, mean solves per 10-task draw — the re-run drift data |
| `data/aa-study.csv` | the pre-registered A/A study: anonymised draw, resolved count (16 draws of one unchanged package) |
| `data/concordance-rows.json` | stage-pair rows (stage pair, anonymised variant, verdict from/to, effect sizes with n) from a real funnel concordance analysis, with paths, ADR names, hypothesis ids, and notes stripped |
| `data/flaky10-decisions.json` | one row per flaky10 read: anonymised package, block and comparator, draws per arm, control type (same-block, fixed baseline with its own n, or a historical mean), pass threshold, per-draw solve counts, effect, verdict, passed |
| `data/flaky10-task-outcomes.csv` | per-task x per-draw outcomes (`T###` task, `D###` draw, `K##` block) for the 162 draws behind those reads |
| `data/base-era-task-outcomes.csv` | per-task x per-draw outcomes of 35 draws on a 129-task and a 43-task slate (`F##` package family), for the task-heterogeneity and re-score SD estimate |
| `data/base-era-reference-fix.csv` | anonymised per-task flag: does the task's own reference fix pass the local grader, for the same 129-task base-era slate (100 of 129 do) — the gradeable-task filter `scripts/gradeable.ts` uses to keep never-solvable tasks from diluting the per-task variance estimate |
| `data/attempts.csv` | one row per (draw, task) for all 197 sealed draws above (3,985 rows): `anon_draw`, `group` (`V##` package or `F##` family), `slate`, `anon_task`, `resolved`, `tool_calls`, `llm_calls`, `wall_s`, `patch_bytes`, `stop` (`finished`, `call_limit`, `turn_limit`, `time_limit`, `context_limit`, `error`), and, where a full capture exists (1,888 rows), `completion_tokens`, `peak_prompt_tokens`, `edit_calls`, `edit_errors`. A `call_limit` stop is inferred from the package's own call cap; the harness records only timeouts and turn limits directly. For 1,194 attempts of some later packages only the outcome is released: their process columns are empty and `stop` is `withheld` |
| `data/task-solve-rates.csv` | per anonymised task: draws, solves, rate, and a class (`never`, `rare` < 0.2, `coin_flip`, `usual` > 0.8, `always`) |
| `data/interventions.csv` | every idea the campaign tested that did NOT work (76 rows: 64 interventions, 12 calibrations), with a lever family and its verdict (`refuted`, `measured-null`, `screen-failed`). Ideas on the line that currently works are withheld until the competition's main track closes; ideas tested on top of it call it only "a later baseline", and no row names a version label or a base setting. Rows are ordered by lever and verdict, not by date. The text column, `hypothesis_as_registered`, is each hypothesis as it was written BEFORE its test, so it reads as a claim; the verdict says the claim did not hold, so no row is a finding |
| `data/fork-ledger.csv` | one row per capture-fork experiment (66 experiments, 334 rollouts): kind (`selftest`, `ab`, `optimiser`, `screen`), the source run's anonymised package and task, the fork step, an opaque id for the variant under test, rollouts, resolved, and per-rollout replay fidelity (forced steps, forced steps whose tool output diverged from the capture, live steps, rollouts with zero divergence) |
| `data/task-sets.json` | the three task sets with anonymised ids: the local 129-task slate; fast-43 as strata (flaky / always / never-gradeable) with their population sizes, weights and the 129-equivalent estimator; flaky-10 with its selection rule and each task's draws, solve rate, package count, between-package variance and selection score |

[`docs/case-study-edit-fix.md`](case-study-edit-fix.md) is a worked example: eight fixes for one
failure mode, each screened against a pre-registered gate with the replay and fork instruments, none
passing.

`src/stats/chi-square.ts` and `src/stats/f-distribution.ts` are small CDF/quantile implementations (no
external stats dependency, same philosophy as `noise-floor.ts`'s closed-form normal CDF): the
former puts a 95% confidence interval on the re-score SD estimate, the latter backs the one-way
block-effect test (is there more spread between blocks of an unchanged package than sampling
alone predicts?). `src/stats/seeded-random.ts` is the one PRNG every permutation/resampling check in
`reproduce-paper-numbers.ts` draws from, so a fixed seed makes those numbers exactly reproducible,
not just approximately close.

## The per-attempt release

`scripts/community-data.ts` summarises `data/attempts.csv`; `scripts/community-data.test.ts` checks it row
for row against the two outcome files above (same 3,985 (draw, task) outcomes, same per-draw counts and
SD), recomputes `task-solve-rates.csv` from it, and scans every file in the repo for leaked ids, paths,
host names, and withheld material.

```sh
bun competitions/gemma4-swe-agent/scripts/community-data.ts
```

Over all 197 draws, 47.3% of attempts resolved. Over the 2,791 attempts whose process columns are released:
55.9% finished on their own, 32.1% used every tool call the package allowed, 5.8% hit the turn limit, and
5.7% hit the time limit (by test set, the time limit ranges from 2.8% to 9.2% and the call limit from 26% to
36%). Completion tokens track wall time almost perfectly within a draw (median Pearson r 0.97, interquartile
range 0.95-0.98, over 97 draws), but only weakly across draws (pooled r 0.24), because decode speed changed
between serving setups. Of the 6,905 `edit_file` calls with a captured result, 36.1% failed.

`scripts/aa-hindsight.ts` measures the +1 gate's false-pass rate directly, by splitting the draws of one
unchanged package into every possible 4-draw "baseline" and disjoint 3-draw "idea" (`src/noise-floor/aa-splits.ts`,
FP(4,3)). On the six unchanged packages with at least 7 flaky-10 draws it gives 13.3% to 22.5%, against
about 18-19% from a per-task model and a normal model. Splits share draws, so the uncertainty comes from the
draws. `bun competitions/gemma4-swe-agent/scripts/aa-interval-sim.ts --workers 48 --studies 20` simulates 960 A/A studies of 16 draws
under a per-task model (true FP 18.0%): the estimate is unbiased (mean 17.8%, Monte Carlo SE 0.1), a
jackknife SE matches its true spread (3.59 vs 3.58 points) but +/-1.96 SE covers only 87.8% (+/-1.1), and a
draw bootstrap covers 92.0% (+/-0.9) with its upper bound below the truth 7.8% of the time (resampled ties
shrink the baseline's SD).

The fork ledger holds every capture-fork rollout: 334 in 66 experiments, 283 of which replayed every
forced step identically (483 of 3,395 forced steps diverged overall). Its self-tests show both outcomes:
a 13-step fork replayed 13 of 13 tool outputs byte for byte (three rollouts), and a 42-step fork through
two context compactions diverged on 13 to 24 of its forced steps in each of its three logged tries. The
ledger records counts only, not causes. The campaign's own notes attribute that divergence to a random
sandbox temp path and to matching turns and compaction summaries by one shared ordinal; `fork-proxy.ts`
normalises such paths and matches each request kind by its own ordinal, and `test/integration` exercises
both. No clean rerun of the 42-step self-test is in the ledger.

## Paper figures and numbers -> scripts

| Paper item | Script | Data |
|---|---|---|
| Figure 1, score per upload with re-score band | `scripts/fig-score-timeline.ts` | `platform-history.csv` |
| Figure 7, every flaky-10 decision against its own null | `scripts/fig-decisions.ts` | `flaky10-decisions.json` |
| Re-score SD 1.46 tasks; 4 identical-bytes pairs | `scripts/reproduce-paper-numbers.ts` | `platform-history.csv` |
| Per-draw SD 1.51; 13-21% modelled false-pass rate; 4 of 23 promoted, 4.1 expected | `scripts/reproduce-paper-numbers.ts` | `flaky10-task-outcomes.csv`, `flaky10-decisions.json` |
| ~14 draws per idea for < 5% false passes | `src/stats/draws-needed.ts` | `flaky10-task-outcomes.csv` |
| A/A: 14 of 62 block comparisons cleared +1, 10.9 expected | `scripts/aa-check.ts` | `flaky10-drift.csv` |
| A/A by split enumeration: FP(4,3) 13-23% on 6 unchanged packages | `scripts/aa-hindsight.ts` | `flaky10-task-outcomes.csv` (+ `aa-study.csv` when present) |
| pre-registered A/A: one unchanged package, 16 draws, FP(4,3) 20.0% | `scripts/reproduce-paper-numbers.ts`, `scripts/aa-hindsight.ts` | `aa-study.csv` |
| Coverage of the A/A intervals (jackknife 87.8%, draw bootstrap 92.0%, 960 studies) | `scripts/aa-interval-sim.ts` | simulated |
| 0 of 5 cheap-stage positives confirmed later | `scripts/reproduce-paper-numbers.ts` (`cheapPositivesConfirmed`) | `concordance-rows.json` |
| Call limit vs time limit shares, tokens-to-time correlation, edit-failure rate | `scripts/community-data.ts` | `attempts.csv` |
| 334 fork rollouts; a 13 of 13 byte-identical self-test | `scripts/community-data.ts` (`summariseForks`) | `fork-ledger.csv` |
| Capture forks replay tool outputs byte for byte | `test/integration/capture-fork.test.ts` (mechanism, on a mock harness) | none |

The A/A-through-gate expectation is printed twice: the paper's normal model (10.9) and, with the continuity
correction for integer solve counts where ties pass, 12.1. Both sit below the observed 14 of 62, which are not
independent trials.

## Generalisation notes (how the tools differ from the campaign's own copies)

Every tool here started as a script inside one private campaign. The ports kept the technique and
removed the campaign: fixed paths, runner names, stage ladders, thresholds, hypothesis registries
and model-routing calls were either deleted or turned into flags and parameters.

- **Capture** (`wire-tap.ts`, `capture-compact.ts`): generic default port, upstream and relative log
  path; no task-id guessing from dataset-specific names (group by a task header, a `--group-by`
  regex, or content hash).
- **Replay** (`step-replay.ts`, `replay-states.ts`, `slip-logprobs.ts`): the states index, the prompt
  anchor, the slip pattern and the alternative token are all supplied by you, with no defaults that
  encode one model's tokenizer or one harness's tool schema.
- **Forking** (`fork-run.ts`): the one substantial redesign. The harness invocation is a
  `--harness-cmd` template, and result-file layout and outcome fields are flags.
- **Integrity** (`score-gate.ts`, `score-reader.ts`, `instrument-repair.ts`): campaign-specific
  estimators, fixed baselines and regeneration commands are gone; the gate-then-seal-then-print
  ordering is kept and works on any field names you give it.
- **Budget** (`cap-budget-projection.ts`, `rate-scaled-projection.ts`): every limit and reference
  cost is a flag or a parameter; the projection technique is a pure function.
- **Queue** (`preread.ts`, `stage-gate.ts`, `concordance.ts`): the stage ladder, its id thresholds,
  the metric vocabulary and the verdict vocabulary are caller-supplied; all file I/O moved out of
  the modules. The rules themselves (no gaps in pre-registered bands, a catch-all band last, a
  "confirmed" verdict is never assigned by a machine) are kept and explained from first principles.
- **Frontier analysis** (`analysis/`): one plain HTTP call to any OpenAI-compatible endpoint with no
  default host; no reference patch is read unless you supply one; campaign context is an optional
  `--context-file`. Its prompts are written for coding tasks; see the README.
