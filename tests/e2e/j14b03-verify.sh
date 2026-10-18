#!/usr/bin/env bash
# MultiCam — J14-B03 : vérification d'intégrité source→destination (PHASE 5).
#
# Usage : j14b03-verify.sh <OUT> <BDID> <DDID> <SID> <T1> <T2>
#
# Compare, par source (B, D) et par Take, le SHA-256/size source (dumps/local-sha-*
# ou manifeste) avec la destination C (dumps/dest-sha-*-C.txt), contrôle
# l'anti-collision (sous-dossier par source) et écrit dumps/verdict.txt.
#
# Garantie anti-clôture-trompeuse : quoi qu'il arrive (erreur de variable sous
# `set -u`, erreur Node, échec de comparaison), dumps/verdict.txt contient à la
# fin UNE ligne `VERDICT GLOBAL: PASS|FAIL|ERREUR` et le code de sortie est
# non nul sauf verdict PASS explicite. Aucune sortie silencieuse.
set -euo pipefail

OUT="${1:-}"
if [ -z "$OUT" ]; then
  echo "usage: j14b03-verify.sh OUT BDID DDID SID T1 T2" >&2
  exit 2
fi

VER="$OUT/dumps/verdict.txt"
mkdir -p "$OUT/dumps"
: > "$VER"

# Piège installé AVANT toute validation de variable : une erreur `set -u` doit
# laisser VERDICT GLOBAL: ERREUR (et rc != 0), jamais un verdict.txt vide.
on_exit() {
  local rc=$?
  if ! grep -q '^VERDICT GLOBAL:' "$VER" 2>/dev/null; then
    echo "VERDICT GLOBAL: ERREUR (verification interrompue avant verdict, rc=$rc)" >>"$VER"
    rc=1
  fi
  trap - EXIT
  exit "$rc"
}
trap on_exit EXIT

BDID="${2:?BDID manquant}"
DDID="${3:?DDID manquant}"
SID="${4:?SID manquant}"
T1="${5:?T1 manquant}"
T2="${6:?T2 manquant}"

verify_take() {
  local take="$1" label="$2"
  OUTD="$OUT/dumps" TAKEv="$take" LABELv="$label" \
    BDIDv="$BDID" DDIDv="$DDID" SIDv="$SID" node <<'NODE'
const fs = require("fs");
const OUTD = process.env.OUTD, TAKE = process.env.TAKEv, LABEL = process.env.LABELv;
const BDID = process.env.BDIDv, DDID = process.env.DDIDv, SID = process.env.SIDv;
const read = (f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean); } catch (e) { return []; } };
const parse = (l) => { const m = l.match(/^(.*?) sha256=(\S+) bytes=(\S+)/); return m ? { p: m[1], base: m[1].split("/").pop(), sha: m[2], bytes: m[3] } : null; };
function srcOf(did, tag) {
  let s = read(OUTD + "/local-sha-" + tag + ".txt").map(parse).filter(Boolean);
  let k = "local";
  if (!s.length) { s = read(OUTD + "/manifest-" + tag + ".txt").map(parse).filter(Boolean); k = "manifest"; }
  return { did: did, k: k, rows: s };
}
const dst = read(OUTD + "/dest-sha-" + LABEL + "-C.txt").map(parse).filter(Boolean);
const B = srcOf(BDID, LABEL + "-B"), D = srcOf(DDID, LABEL + "-D");
let ok = true;
const lines = ["## " + LABEL + " (take=" + TAKE + ") sid=" + SID];
lines.push("destination C fichiers: " + dst.length);
function cmp(S, t) {
  lines.push(t + " (" + S.k + "): " + S.rows.length + " segment(s)");
  if (!S.rows.length) { ok = false; lines.push("  -> ECHEC: AUCUNE SOURCE"); return; }
  S.rows.forEach((s) => {
    const d = dst.find((x) => x.p.includes("/" + S.did + "/") && x.base === s.base);
    if (!d) { ok = false; lines.push("  " + s.base + " src.sha=" + s.sha + " -> MANQUANT sur C"); return; }
    const same = d.sha === s.sha && String(d.bytes) === String(s.bytes);
    if (!same) ok = false;
    lines.push("  " + s.base + ": src.sha=" + s.sha + " dst.sha=" + d.sha + " src.b=" + s.bytes + " dst.b=" + d.bytes + " -> " + (same ? "OK" : "ECHEC"));
  });
}
cmp(B, "B"); cmp(D, "D");
const bf = dst.filter((x) => x.p.includes("/" + BDID + "/")), df = dst.filter((x) => x.p.includes("/" + DDID + "/"));
const distinct = bf.length > 0 && df.length > 0 && bf.every((b) => !df.some((d) => d.p === b.p));
if (!distinct) ok = false;
lines.push("anti-collision: B.files=" + bf.length + " D.files=" + df.length + " chemins_distincts=" + distinct);
lines.push("VERDICT " + LABEL + ": " + (ok ? "PASS" : "FAIL"));
fs.appendFileSync(OUTD + "/verdict.txt", lines.join("\n") + "\n");
console.log(lines.join("\n"));
NODE
}

verify_take "$T1" "T1"
verify_take "$T2" "T2"

if grep -q 'VERDICT T1: FAIL' "$VER" || grep -q 'VERDICT T2: FAIL' "$VER" \
  || ! grep -q 'VERDICT T1:' "$VER" || ! grep -q 'VERDICT T2:' "$VER"; then
  G=FAIL
else
  G=PASS
fi
echo "VERDICT GLOBAL: $G" >>"$VER"
[ "$G" = "PASS" ]
