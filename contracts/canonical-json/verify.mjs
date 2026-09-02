#!/usr/bin/env node
// Check a JavaScript implementation against the frozen canonical-json vector.
//
//   node verify.mjs ../../path/to/module.mjs
//   node verify.mjs ./impl.js --canonical canonicalize --digest receiptDigest
//
// The digest export may return bare hex or a "sha256:"-prefixed id; both are
// accepted, because that prefix is a presentation choice and not part of the
// bytes being attested. Everything else must match exactly.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (!args.length) {
  process.stderr.write("usage: verify.mjs <module> [--canonical NAME] [--digest NAME]\n");
  process.exit(2);
}

function option(name, fallback) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
}

const modulePath = args[0];
const canonicalName = option("canonical", "canonicalize");
const digestName = option("digest", "contentId");

const vector = JSON.parse(readFileSync(new URL("./vector.json", import.meta.url), "utf8"));
const module = await import(pathToFileURL(resolve(modulePath)).href);

const canonical = module[canonicalName];
const digest = module[digestName];
if (typeof canonical !== "function") {
  process.stderr.write(`${modulePath} exports no function named ${canonicalName}\n`);
  process.exit(2);
}

function hexOf(value) {
  return String(value).replace(/^sha256:/, "");
}

let failures = 0;
for (const testCase of vector.cases) {
  try {
    const produced = canonical(testCase.value);
    if (produced !== testCase.canonical) {
      failures += 1;
      process.stderr.write(`FAIL ${testCase.name}\n  expected ${testCase.canonical}\n  produced ${produced}\n`);
      continue;
    }
    if (typeof digest === "function") {
      const produced = hexOf(digest(testCase.value));
      const expected = hexOf(testCase.content_id);
      if (produced !== expected) {
        failures += 1;
        process.stderr.write(`FAIL ${testCase.name} digest\n  expected ${expected}\n  produced ${produced}\n`);
      }
    }
  } catch (error) {
    failures += 1;
    process.stderr.write(`FAIL ${testCase.name} threw: ${error.message}\n`);
  }
}

if (failures) {
  process.stderr.write(`\n${failures} of ${vector.cases.length} cases failed\n`);
  process.exit(1);
}
process.stdout.write(`canonical-json v${vector.version}: ${vector.cases.length} cases reproduced by ${modulePath}\n`);
