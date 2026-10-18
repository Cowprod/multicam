/* MultiCam J14-B03 — test du harnais de vérification (tests/e2e/j14b03-verify.sh).
 *
 * Régression directe du défaut d'audit « tag: unbound variable » : une erreur de
 * variable (set -u) ne doit JAMAIS produire une clôture trompeuse. Le script doit
 * toujours laisser une ligne `VERDICT GLOBAL: PASS|FAIL|ERREUR` explicite dans
 * dumps/verdict.txt, avec code de sortie non nul sauf PASS explicite.
 *
 * Zéro device : fixtures synthétiques dans un tmpdir, bash + node suffisent. */

"use strict";

const path = require("path");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const VERIFY = path.resolve(__dirname, "../../tests/e2e/j14b03-verify.sh");
const HARNESS = path.resolve(__dirname, "../../tests/e2e/j14b03-multicapture.sh");

const BDID = "19848326-0070-44cb-8de3-0d0d4ec7eb19";
const DDID = "d618012d-c15b-4a08-8097-88e75f126cd4";
const SID = "session-fixture";
const SRC = (take, sha, bytes) =>
  "/sdcard/Android/data/fr.emmanuel.multicam/files/MultiCam/" + SID + "/" + take + "/videoTmp.mp4 sha256=" + sha + " bytes=" + bytes;
const DST = (take, did, sha, bytes) =>
  "/sdcard/Android/data/fr.emmanuel.multicam/files/MultiCam/" + SID + "/" + take + "/" + did + "/videoTmp.mp4 sha256=" + sha + " bytes=" + bytes;

function makeFixture(opts) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "j14b03-verify-"));
  const dir = path.join(out, "dumps");
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, lines) => fs.writeFileSync(path.join(dir, name), lines.join("\n") + "\n");
  const mk = (take, label, shaB, shaD) => {
    put("local-sha-" + label + "-B.txt", [SRC(take, shaB, 100)]);
    put("local-sha-" + label + "-D.txt", [SRC(take, shaD, 200)]);
    put("dest-sha-" + label + "-C.txt", [
      DST(take, BDID, opts.bad === label + "-B" ? "0".repeat(64) : shaB, 100),
      DST(take, DDID, shaD, 200),
    ]);
  };
  mk(1, "T1", "a".repeat(64), "b".repeat(64));
  mk(2, "T2", "c".repeat(64), "d".repeat(64));
  if (opts.dropDest) {
    const f = path.join(dir, "dest-sha-T2-C.txt");
    fs.writeFileSync(f, DST(2, BDID, "c".repeat(64), 100) + "\n");
  }
  return out;
}

function run(out, args) {
  const r = spawnSync("bash", [VERIFY].concat(args || [out, BDID, DDID, SID, "1", "2"]), {
    encoding: "utf8",
    timeout: 30000,
  });
  const verdict = (() => {
    try { return fs.readFileSync(path.join(out, "dumps", "verdict.txt"), "utf8"); } catch (e) { return ""; }
  })();
  return { status: r.status, verdict: verdict, stderr: String(r.stderr || "") };
}

function cleanup(out) {
  try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

module.exports.register = function (h) {
const describe = h.describe;
const it = h.it;
describe("J14-B03 — harnais verify (aucune clôture trompeuse)", function () {
  it("fixtures valides -> VERDICT GLOBAL: PASS, code 0", function () {
    const out = makeFixture({});
    try {
      const r = run(out);
      assert.strictEqual(r.status, 0, "rc=" + r.status + " " + r.stderr);
      assert.ok(/VERDICT T1: PASS/.test(r.verdict), "T1 PASS absent");
      assert.ok(/VERDICT T2: PASS/.test(r.verdict), "T2 PASS absent");
      assert.ok(/VERDICT GLOBAL: PASS/.test(r.verdict), "GLOBAL PASS absent");
    } finally { cleanup(out); }
  });

  it("SHA destination corrompu -> VERDICT GLOBAL: FAIL, code non nul", function () {
    const out = makeFixture({ bad: "T1-B" });
    try {
      const r = run(out);
      assert.notStrictEqual(r.status, 0, "un échec ne doit pas sortir 0");
      assert.ok(/VERDICT T1: FAIL/.test(r.verdict), "T1 FAIL absent");
      assert.ok(/VERDICT GLOBAL: FAIL/.test(r.verdict), "GLOBAL FAIL absent");
      assert.ok(!/VERDICT GLOBAL: PASS/.test(r.verdict), "PASS trompeur");
    } finally { cleanup(out); }
  });

  it("destination manquante (collision absente) -> FAIL explicite", function () {
    const out = makeFixture({ dropDest: true });
    try {
      const r = run(out);
      assert.notStrictEqual(r.status, 0, "un échec ne doit pas sortir 0");
      assert.ok(/VERDICT GLOBAL: FAIL/.test(r.verdict), "GLOBAL FAIL absent");
      assert.ok(!/VERDICT GLOBAL: PASS/.test(r.verdict), "PASS trompeur");
    } finally { cleanup(out); }
  });

  it("erreur de variable (set -u) -> VERDICT GLOBAL: ERREUR, jamais de sortie silencieuse", function () {
    const out = makeFixture({});
    try {
      const r = run(out, [out]); // BDID/DDID/SID/T1/T2 absents -> ${2:?} sous set -u
      assert.notStrictEqual(r.status, 0, "erreur de variable ne doit pas sortir 0");
      assert.ok(r.verdict.length > 0, "verdict.txt ne doit pas rester vide");
      assert.ok(/VERDICT GLOBAL: ERREUR/.test(r.verdict), "ligne ERREUR attendue : " + r.verdict);
      assert.ok(!/VERDICT GLOBAL: PASS/.test(r.verdict), "PASS trompeur malgré l'erreur");
      assert.ok(!/VERDICT T[12]: PASS/.test(r.verdict), "PASS partiel trompeur malgré l'erreur");
    } finally { cleanup(out); }
  });

  it("harnais principal et verify : syntaxe bash valide", function () {
    [HARNESS, VERIFY].forEach(function (f) {
      const r = spawnSync("bash", ["-n", f], { encoding: "utf8", timeout: 15000 });
      assert.strictEqual(r.status, 0, "bash -n " + f + " : " + r.stderr);
    });
  });
});
};
