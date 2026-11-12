# ADR-NNNN — example: pre-registering a read with `src/preread/preread.ts`

> Template. Copy this file, fill in the prose sections, and keep the fenced `preread` block
> machine-readable — it is parsed by `parseDoc()`/`validate()` before the run it governs starts,
> and classified by `classify()` once the number comes in. Anything that isn't inside the fence is
> for humans only and is never read by code.

- **Status:** proposed
- **Hypothesis:** H-EXAMPLE — a short, falsifiable claim ("locating a file by grep before editing
  it reduces wasted edit turns on the cheap screening slate").
- **Design:** what you're actually running — the slate, the number of draws, what's being compared
  to what. Write this BEFORE the run, same as the bands below. If someone reads only this section
  and the preread block, they should be able to tell whether the claim held without asking you.

## Pre-registered read

```preread
{
  "hypothesis": "H-EXAMPLE",
  "metric": "resolved",
  "primary": "mean resolved tasks on the screening slate minus the baseline's mean, over 3 draws",
  "bands": [
    { "min": 1, "verdict": "supported", "label": "beats baseline by >=1 task on average — worth confirming on a bigger slate" },
    { "min": -1, "verdict": "measured-null", "label": "within noise of baseline" },
    { "min": null, "verdict": "refuted", "label": "worse than baseline by more than 1 task on average" }
  ],
  "void_if": "fewer than 3 draws completed, or a draw crashed before producing a score"
}
```

Notes on authoring a block like this one:

- **Exactly one `min: null` catch-all, and it must be the last band.** A value that doesn't land
  in any bounded band has to land somewhere, or the read has a gap a human can quietly fill in
  after seeing the number — which is the exact failure mode pre-registration exists to prevent.
- **Bands are evaluated top-down with `min` inclusive**, so list them in strictly descending
  order of `min`.
- **`verdict` is never `"confirmed"`.** `supported` means "this is worth spending a more expensive
  confirmation run on", not "ship it". Promotion to `confirmed` is a decision a human makes after
  reading a real result, not something a pre-registered band can grant itself.
- **`metric` and `hypothesis` are free text, validated against your own registries if you keep
  one** (pass the known-id / known-metric sets into `validate()` or `parseDoc()`). This module has
  no opinion on what hypotheses or metrics exist in your project.

## Outcome

Filled in after the run, from whatever `classify(bands, value)` returns — never edited to match a
number you'd have preferred.
