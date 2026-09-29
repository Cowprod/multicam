/* MultiCam — runner de tests (J09). Zéro dépendance : `node tests/run.js`.
 * Usage : node tests/run.js [filtre] */

"use strict";

const fs = require("fs");
const path = require("path");
const h = require("./harness.js");

const filter = process.argv[2] || "";
const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => !filter || f.indexOf(filter) >= 0)
  .sort();

files.forEach((f) => {
  const mod = require(path.join(__dirname, f));
  if (typeof mod.register === "function") mod.register(h);
  else console.log("!! " + f + " n'exporte pas register()");
});

(async function main() {
  let pass = 0;
  const failures = [];
  for (const s of h.suites) {
    console.log("\n\x1b[1m" + s.name + "\x1b[0m");
    for (const t of s.tests) {
      try {
        await t.fn();
        pass += 1;
        console.log("  \x1b[32m✓\x1b[0m " + t.name);
      } catch (e) {
        failures.push({ suite: s.name, test: t.name, err: e });
        console.log("  \x1b[31m✗\x1b[0m " + t.name);
        console.log("      " + String(e && e.message).split("\n").join("\n      "));
      }
    }
  }
  console.log("\n" + "-".repeat(60));
  console.log(pass + " passed, " + failures.length + " failed");
  if (failures.length) process.exitCode = 1;
})();
