// Reference implementation of the canonical-json contract. See CONTRACT.md.
//
// Canonical form: keys sorted by UTF-16 code unit, no insignificant whitespace,
// UTF-8 output, non-finite numbers refused. The digest is SHA-256 over those
// bytes. Two independently written implementations — ai-cohort's receipt.js and
// laicode's canonical.py — already agree byte for byte on every case in
// vector.json; this file exists so a third does not have to guess.
import { createHash } from "node:crypto";

export class CanonicalError extends TypeError {}

export function canonicalize(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) throw new CanonicalError("non-finite numbers have no canonical form");
    return JSON.stringify(value);
  }
  if (type === "undefined") throw new CanonicalError("undefined has no canonical form");
  if (type !== "object") throw new CanonicalError(`${type} has no canonical form`);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalError(`${value.constructor?.name || "non-plain object"} has no canonical form`);
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

export function contentId(value) {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}
