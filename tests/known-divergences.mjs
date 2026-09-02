#!/usr/bin/env node
// Pins the divergences the canonical-json contract deliberately does not cover.
//
// A gap that is only described in prose gets fixed by accident, and then two
// projects disagree about whether a digest changed on purpose. Each divergence
// below is asserted to still exist. When one is genuinely fixed, this test
// fails — which is the point: closing a gap must be a deliberate act that
// updates CONTRACT.md and the vector together, not a silent improvement.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { canonicalize } from "../contracts/canonical-json/canonical.mjs";

const CONTRACTS = new URL("../contracts/canonical-json/", import.meta.url).pathname;

function python(source) {
  const result = spawnSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(CONTRACTS)})\n${source}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

// JavaScript sorts object keys by UTF-16 code unit, which RFC 8785 (JSON
// Canonicalization Scheme) mandates. Python's sort_keys=True sorts by codepoint.
// The two agree for every key below U+10000 and disagree above it: U+1D11E is
// one code unit 0xD834 in UTF-16, which is below U+FEFF, but a codepoint
// 0x1D11E, which is above it.
//
// Consequence: an object carrying both an astral-plane key and a BMP key at or
// above U+E000 canonicalizes to different bytes, and therefore to a different
// SHA-256, in the two implementations — silently, with no error on either side.
test("astral-plane keys still order differently in the two implementations", () => {
  const document = JSON.parse('{"\\uFEFF":1,"\\uD834\\uDD1E":2}');

  const javascript = canonicalize(document);
  const result = python(
    "import json\n" +
    "from canonical import canonical_json_bytes\n" +
    'print(canonical_json_bytes(json.loads(\'{"\\uFEFF":1,"\\U0001D11E":2}\')).decode())',
  );

  assert.notEqual(
    javascript,
    result,
    "the astral key ordering divergence appears to be fixed — update CONTRACT.md, " +
      "add the case to vector.json, and confirm every consuming project moves together",
  );
  assert.match(javascript, /^\{"\u{1D11E}":2,/u, "JavaScript orders the astral key first, by UTF-16 code unit");
  assert.match(result, /^\{"\uFEFF":1,/u, "Python orders the BMP key first, by codepoint");
});

// laicode refuses every non-integer number to avoid representation ambiguity;
// ai-cohort accepts finite ones. Both are conformant because no vector case
// contains a float. This asserts the reference implementations still reflect
// that split, so the contract's stated reason stays true.
test("the reference implementations still differ on floats by design", () => {
  assert.equal(canonicalize({ n: 0.5 }), '{"n":0.5}', "the JavaScript reference accepts finite floats");

  const accepted = python(
    "from canonical import canonical_json_bytes\n" +
    "print(canonical_json_bytes({'n': 0.5}).decode())",
  );
  assert.equal(accepted, '{"n":0.5}', "the Python reference also accepts them; only laicode's own encoder refuses");
});
