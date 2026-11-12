# gemma4-swe-agent

The anonymised data and the scripts behind the paper **"Two Old GPUs and a Glass Box"**: a Gemma 4 coding
agent built for a Kaggle SWE-bench-style competition on two RTX 3090s. The measurement toolkit itself lives at
the [repository root](../../README.md); this folder holds only what is specific to that campaign.

| folder | contents |
|---|---|
| [`data/`](data/) | anonymised aggregate data: per-attempt rows, re-run drift, flaky-10 decisions, the fork ledger, the task sets, the ideas that did not work, the pre-registered A/A study |
| [`scripts/`](scripts/) | the scripts that recompute every number and figure in the paper from `data/`, with their tests |
| [`docs/`](docs/) | [what was measured and how to reproduce it](docs/paper-reproduction.md), and a [worked case study](docs/case-study-edit-fix.md) |

Reproduce every noise number in the paper, from the repository root:

```sh
bun competitions/gemma4-swe-agent/scripts/reproduce-paper-numbers.ts   # or: bun run paper-numbers
bun competitions/gemma4-swe-agent/scripts/community-data.ts            # the per-attempt and fork-ledger numbers
bun competitions/gemma4-swe-agent/scripts/aa-hindsight.ts              # the A/A false-pass rate by split enumeration
```

The table in [docs/paper-reproduction.md](docs/paper-reproduction.md#reproducing-the-papers-numbers) maps each
paper number and figure to the script and data file it comes from.

No agent code, prompts, task content or the configuration that scored best is here. Ideas on the line that
currently works are withheld until the competition's main track closes.

A new competition gets a sibling folder under [`competitions/`](../), with the same `data/`, `scripts/` and
`docs/` shape, and uses the toolkit at the root unchanged.
