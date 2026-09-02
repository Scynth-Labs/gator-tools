#!/usr/bin/env node
// Parse every JavaScript file under the given roots and fail on the first
// syntax error. Generalised from ai-cohort's scripts/check-source.js, which
// hardcoded its own three directories.
//
//   node check-syntax.mjs                 # defaults to src scripts test
//   node check-syntax.mjs src lib         # explicit roots
//
// It is a gate, not a linter: it answers "does this parse", which is the one
// question worth asking before every other check runs.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["src", "scripts", "test"];
const EXTENSIONS = [".js", ".mjs", ".cjs"];
const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function javascriptFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && EXTENSIONS.some((e) => entry.name.endsWith(e)) ? [path] : [];
  });
}

const files = roots.flatMap(javascriptFiles).sort();
if (!files.length) {
  process.stderr.write(`No JavaScript found under: ${roots.join(", ")}\n`);
  process.exit(1);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
}
process.stdout.write(`${files.length} files parsed\n`);
