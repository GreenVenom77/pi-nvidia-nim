#!/usr/bin/env node
// `npm run release -- 0.9.1`: check, bump, commit and tag. Pushing the tag is left to you
// (`git push --follow-tags`), which is what starts .github/workflows/release.yml.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, opts = {}) => (execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }) ?? "").trim();
const fail = (text) => {
  console.error(`release: ${text}`);
  process.exit(1);
};

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail("usage: npm run release -- <x.y.z[-pre]>");
if (run("git", ["status", "--porcelain"])) fail("working tree is not clean; commit or stash first.");
if (run("git", ["tag", "--list", `v${version}`])) fail(`tag v${version} already exists.`);

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const previous = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

try {
  run("node", ["scripts/release-notes.mjs", version]); // changelog section exists and is not empty
  run("npm", ["test"], { stdio: ["ignore", "ignore", "inherit"] });
} catch {
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version: previous }, null, 2)}\n`);
  fail("checks failed; package.json restored.");
}

run("git", ["add", "package.json"]);
run("git", ["commit", "-m", `release v${version}`]);
run("git", ["tag", "-a", `v${version}`, "-m", `v${version}`]);
console.log(`Tagged v${version} (was ${previous}). Publish with:\n  git push --follow-tags`);
