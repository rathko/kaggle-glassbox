// Re-score SD over the tasks whose reference fix passes the local grader. A task whose reference fix
// fails can never be solved locally, so it adds zero variance and dilutes the per-task average.

export interface GradeableSummary {
  tasks: number;
  referenceFails: number;
  referenceFailsEverSolved: number;
  sdAll: number;
  sdGradeable: number;
  meanVarGradeable: number;
}

/** Unbiased per-task Bernoulli variance k(n-k)/(n(n-1)) from repeated draws of one task. */
function taskVariance(outcomes: number[]): number {
  const n = outcomes.length;
  if (n < 2) return 0;
  const k = outcomes.reduce((a, b) => a + b, 0);
  return (k * (n - k)) / (n * (n - 1));
}

/** outcomes: anon task -> resolved flags over draws; referencePasses: anon task -> 1 if the reference fix passes. */
export function gradeableRescoreSd(outcomes: Map<string, number[]>, referencePasses: Map<string, number>, nTasks: number): GradeableSummary {
  const all: number[] = [];
  const gradeable: number[] = [];
  let referenceFails = 0;
  let referenceFailsEverSolved = 0;
  for (const [task, xs] of outcomes) {
    const v = taskVariance(xs);
    all.push(v);
    const pass = referencePasses.get(task);
    if (pass === undefined) throw new Error(`no reference-fix flag for ${task}`);
    if (pass === 1) gradeable.push(v);
    else {
      referenceFails++;
      if (xs.some((x) => x === 1)) referenceFailsEverSolved++;
    }
  }
  if (gradeable.length === 0) throw new Error("no gradeable tasks");
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  return {
    tasks: all.length,
    referenceFails,
    referenceFailsEverSolved,
    sdAll: Math.sqrt(nTasks * mean(all)),
    sdGradeable: Math.sqrt(nTasks * mean(gradeable)),
    meanVarGradeable: mean(gradeable),
  };
}

/** Expected number of tasks that flip between two independent re-runs: sum of 2 p(1-p). */
export function expectedFlips(meanTaskVariance: number, nTasks: number): number {
  return 2 * meanTaskVariance * nTasks;
}

/** Expected flips between two re-runs under a binomial model at the pair's mean solve rate. */
export function binomialFlips(solvedA: number, solvedB: number, nTasks: number): number {
  const p = (solvedA + solvedB) / (2 * nTasks);
  return 2 * p * (1 - p) * nTasks;
}
