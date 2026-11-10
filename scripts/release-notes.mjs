#!/usr/bin/env node
// Print the CHANGELOG.md section for a version. Fails (non-zero) unless package.json has that exact
// version and the changelog has a non-empty "## <version>" section, so a bad tag never becomes a release.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("usage: release-notes.mjs <version>");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (pkg.version !== version) {
  console.error(`Tag/version ${version} does not match package.json version ${pkg.version}.`);
  process.exit(1);
}

const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
const start = lines.findIndex((line) => line.trim() === `## ${version}`);
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version}" section.`);
  process.exit(1);
}
let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
if (end === -1) end = lines.length;
const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) {
  console.error(`CHANGELOG.md section "## ${version}" is empty.`);
  process.exit(1);
}
console.log(body);
