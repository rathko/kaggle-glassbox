// seeded-random: deterministic PRNG for the permutation/resampling tests in
// `reproduce-paper-numbers.ts`. A Monte Carlo check that gives a different answer on every run is
// useless as a "reproduce this paper number" artifact, so every stochastic function in this repo
// takes a fixed default seed and nothing here ever reads from `Math.random`.
//
// PURE, no I/O.

/** mulberry32: a small, fast, good-enough-for-simulation seeded PRNG (not cryptographic). Same
 *  algorithm as the private reference analysis this repo reproduces — not the same seed or call
 *  order, so the exact permutation sequence differs, but the method is identical. Returns a
 *  generator function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle, in place, using the given generator. Pulled out as its own export
 *  because every permutation test in this repo needs "shuffle this array with my seeded rand"
 *  and a hand-rolled loop at each call site is an easy place to introduce an off-by-one bias. */
export function shuffleInPlace<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}
