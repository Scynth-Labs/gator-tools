// Regenerates vector.json from the reference implementation. Run it only when
// deliberately changing the contract — the vector is meant to be frozen, and a
// regenerated vector nobody diffed proves nothing.
import { writeFileSync } from "node:fs";
import { canonicalize, contentId } from "./canonical.mjs";

const cases = [
  { name: "empty-object", value: {} },
  { name: "empty-array", value: [] },
  { name: "null", value: null },
  { name: "booleans", value: [true, false] },
  { name: "integers", value: { zero: 0, positive: 1234567890, negative: -42 } },
  { name: "key-order-is-not-input-order", value: { z: 1, a: 2, M: 3, b: 4, "10": 5, "2": 6 } },
  { name: "nested", value: { a: { empty: {}, nested: [1, 2, { k: "v" }] }, z: [[], [[]]] } },
  { name: "unicode-values", value: { text: "café — naïve", emoji: "🐊", cjk: "協調" } },
  { name: "unicode-keys", value: { "é": 1, z: 2, "🐊": 3 } },
  { name: "string-escapes", value: { s: "tab\there \"quoted\" back\\slash\nnewline" } },
  { name: "control-characters", value: { s: "" } },
  { name: "array-preserves-order", value: [3, 1, 2, { b: 1, a: 2 }] },
  { name: "deeply-nested", value: { a: { b: { c: { d: { e: [1, { f: null }] } } } } } },
];

const vector = {
  contract: "canonical-json",
  version: 1,
  description:
    "Frozen cases for the canonical JSON encoding and its SHA-256 content id. " +
    "An implementation is conformant when it reproduces `canonical` and `content_id` for every case.",
  rules: [
    "Object keys are sorted ascending by UTF-16 code unit; input order is irrelevant.",
    "Array order is significant and preserved.",
    "No insignificant whitespace: the separators are exactly ',' and ':'.",
    "Output is UTF-8; non-ASCII characters are emitted literally, never \\u-escaped.",
    "Control characters and quotes use the shortest JSON escape.",
    "Non-finite numbers (NaN, Infinity) have no canonical form and must be refused.",
    "content_id is 'sha256:' followed by the lowercase hex SHA-256 of the canonical UTF-8 bytes.",
  ],
  out_of_contract: {
    floating_point:
      "Whether a non-integer number is accepted is deliberately NOT frozen, and no case below contains one. " +
      "laicode refuses floats outright to avoid representation ambiguity; ai-cohort accepts finite ones. " +
      "Both remain conformant, because this contract covers only what they already agree on. " +
      "Freezing a float rule would change a published artifact in one project or the other, which is an ADR rather than a vector edit.",
  },
  cases: cases.map(({ name, value }) => ({
    name,
    value,
    canonical: canonicalize(value),
    content_id: contentId(value),
  })),
};

writeFileSync(new URL("./vector.json", import.meta.url), `${JSON.stringify(vector, null, 2)}\n`);
console.log(`vector.json written: ${vector.cases.length} cases`);
