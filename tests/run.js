#!/usr/bin/env node
"use strict";

/*
 * Runs the whole test suite under Node (GitHub Actions: `node tests/run.js`).
 * No dependencies. Exits 1 if any test fails.
 *
 * The suite never touches the real data/ or mirror/ folders or the real
 * Discord - see tests/lib/harness.js. Without Node, use tests/run-local.ps1.
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const ENV = {
  isNode: true,
  crypto: require("crypto"),
  Buffer,
  sources: {
    update: read("scripts", "update.js"),
    mirror: read("mirror", "index.js"),
    config: read("config.json"),
  },
  fixtures: { v10: JSON.parse(read("tests", "fixtures", "v1.0-boards.json")) },
};

const T = new Function("ENV", read("tests", "lib", "harness.js"))(ENV);
const only = process.argv[2]; // optional: run only the case files whose name contains this
for (const file of fs.readdirSync(path.join(__dirname, "cases")).filter((f) => f.endsWith(".js")).sort()) {
  if (only && !file.includes(only)) continue;
  new Function("T", read("tests", "cases", file))(T);
}

T.run().then(
  (result) => {
    console.log(T.report(result));
    process.exit(result.failed === 0 ? 0 : 1);
  },
  (e) => {
    console.error("The test runner itself crashed:", e);
    process.exit(2);
  }
);
