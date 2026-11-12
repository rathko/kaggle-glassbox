// An example --classifier for src/replay/replay-states.ts: name the category of the model's next call.
// This one sorts calls of any tool set into "repeat" (the same arguments as the call being diagnosed),
// "malformed" (arguments that are not JSON), or the tool's own name.
//   bun src/replay/replay-states.ts ... --classifier examples/classify-next-call.ts
export default function classify(call: { function?: { name?: string; arguments?: string } } | undefined, onsetArgs: string): string {
  const name = call?.function?.name;
  if (!name) return "no-call";
  if (onsetArgs && call!.function!.arguments === onsetArgs) return "repeat";
  try { JSON.parse(call!.function!.arguments ?? ""); } catch { return "malformed"; }
  return name;
}
