# sample-runs

The runs `bun run dashboard` opens on. Each is a real run directory in the toolkit's [run layout](../../docs/guide.md#the-run-layout),
produced by the toolkit itself.

| run | what it is |
|---|---|
| `baseline-r1` to `-r4`, `candidate-r1` to `-r3` | one mock agent on 16 fake bug-fix tasks, captured through `wire-tap`, compacted, closed with `run-end` and read with `score-reader`. `baseline` and `candidate` are the same agent, so every gap between them is noise. `candidate-r3` is closed but not read, and `baseline-r4` is never closed: the dashboard hides both scores. `baseline-r1` also has a step-replay screen (`replay-check-first.jsonl`) and a fork screen (`forks/`) |
| `live-gemma4-qa` | a real run of [`examples/live-e2e/`](../live-e2e/) against Gemma 4 31B on vLLM: four tool-using arithmetic tasks, with a live step replay and a live fork |

Rebuild the mock runs (about a minute, no GPU or key; `live-gemma4-qa` is left alone):

```sh
bun run sample-runs
```

Behaviour and outcomes are seeded and come out the same each time. Timestamps and latencies are real, so they
differ.
