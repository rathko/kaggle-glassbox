#!/usr/bin/env bun
// render-terminal: turn a captured terminal transcript into a static SVG "terminal window" for the docs.
// It draws the text exactly as given (no re-typing), so a README image stays a real run's output.
// usage: bun scripts/render-terminal.ts <transcript.txt> <out.svg> [--title "text"]
import { readFileSync, writeFileSync } from "node:fs";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** colour a line by what it is: stage headers, prompts, changes, passes */
function colour(line: string): string {
  if (line.startsWith("===")) return "#7dd3fc";
  if (line.startsWith("$ ")) return "#c4b5fd";
  if (/\*CHANGED\*/.test(line)) return "#fcd34d";
  if (/\bok\b|passed|resolved \(100|"resolved":2|every capture written|valid=2/.test(line)) return "#86efac";
  return "#e5e7eb";
}

export function renderTerminal(text: string, title: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const cw = 8.4, lh = 19, padX = 18, top = 46;
  const width = Math.max(720, Math.ceil(Math.max(...lines.map((l) => l.length)) * cw + padX * 2));
  const height = top + lines.length * lh + 18;
  const body = lines.map((l, i) =>
    `<text x="${padX}" y="${top + i * lh}" fill="${colour(l)}">${esc(l)}</text>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="14">
<rect width="${width}" height="${height}" rx="10" fill="#0b1020"/>
<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
<text x="${width / 2}" y="22" fill="#94a3b8" text-anchor="middle" font-size="12">${esc(title)}</text>
${body}
</svg>
`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const ti = args.indexOf("--title");
  const title = ti >= 0 ? args[ti + 1] ?? "" : "terminal";
  const pos = args.filter((_, i) => i !== ti && i !== ti + 1);
  if (pos.length !== 2) { console.error('usage: bun scripts/render-terminal.ts <transcript.txt> <out.svg> [--title "text"]'); process.exit(2); }
  writeFileSync(pos[1]!, renderTerminal(readFileSync(pos[0]!, "utf8"), title));
  console.log(`wrote ${pos[1]}`);
}
