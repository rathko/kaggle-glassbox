// safe-id: turning an id that came from data (a task id, a harness instance id) into one path component. Ids are
// usually tame ("django__django-11099"), but nothing stops one from being "a/b" or "../x", and joined into a path
// those write somewhere else entirely. A tame id passes through unchanged; anything else becomes a readable slug
// plus a short hash of the original, so two different unsafe ids can never land on the same name.

import { createHash } from "node:crypto";
import { relative, resolve, isAbsolute, sep } from "node:path";

const TAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Is `id` usable as one path component as it stands (no separators, no leading dot, no "..", 1-128 chars)? */
export const isSafeId = (id: string) => TAME.test(id) && !id.includes("..");

/** `id` unchanged when it is safe, else a slug of it plus "-" and the first 10 hex chars of its sha256. */
export function safeId(id: string): string {
  if (isSafeId(id)) return id;
  const slug = id.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "id";
  return `${slug}-${createHash("sha256").update(id).digest("hex").slice(0, 10)}`;
}

/** resolve(root, ...parts), refusing (throwing) unless the result stays strictly inside `root`. */
export function within(root: string, ...parts: string[]): string {
  const r = resolve(root), p = resolve(r, ...parts), rel = relative(r, p);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${p} is outside ${r}`);
  return p;
}
