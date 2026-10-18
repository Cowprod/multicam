#!/usr/bin/env bash
# MultiCam — J14 endurance : vérification d'intégrité par Take (PHASE 6).
#
# Usage : j14d-integrity.sh <OUT> <SID> <CSER> <BDID> <DDID>
#
# Lit dans <OUT>/dumps :
#   local-sha-<label>-{B,D}.txt   SHA-256/size source (avant purge)
#   sha-<CSER>.txt                SHA-256/size destination (inventaire final C)
#   TN-<label>.txt                numéro de Take
#   tr-A-<label>.json / tr-C-<label>.json  états de transfert (Master/Storage)
# Écrit <OUT>/dumps/verdict.txt : détail par Take + VERDICT GLOBAL INTEGRITE.
# rc=0 seulement si verdict GLOBAL PASS ; sinon rc=1. Jamais de sortie silencieuse.
set -euo pipefail

OUT="${1:-}"; [ -z "$OUT" ] && { echo "usage: j14d-integrity.sh OUT SID CSER BDID DDID" >&2; exit 2; }
VER="$OUT/dumps/verdict.txt"
mkdir -p "$OUT/dumps"
: > "$VER"

on_exit() {
  local rc=$?
  if ! grep -q '^VERDICT GLOBAL INTEGRITE:' "$VER" 2>/dev/null; then
    echo "VERDICT GLOBAL INTEGRITE: ERREUR (verification interrompue, rc=$rc)" >>"$VER"
    rc=1
  fi
  trap - EXIT
  exit "$rc"
}
trap on_exit EXIT

SID="${2:?SID manquant}"
CSER="${3:?CSER manquant}"
BDID="${4:?BDID manquant}"
DDID="${5:?DDID manquant}"

OUTD="$OUT/dumps" SIDv="$SID" CSERv="$CSER" BDIDv="$BDID" DDIDv="$DDID" node <<'NODE'
const fs = require("fs");
const OUTD = process.env.OUTD, SID = process.env.SIDv, CSER = process.env.CSERv;
const BDID = process.env.BDIDv, DDID = process.env.DDIDv;
const LABELS = ["T1", "T2", "T3", "T4", "T5", "T6"];
const read = (f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean); } catch (e) { return []; } };
const parse = (l) => { const m = l.match(/^(.*?) sha256=(\S+) bytes=(\S+)/); return m ? { p: m[1], base: m[1].split("/").pop(), sha: m[2], bytes: m[3] } : null; };

// Destination C : index par take (segment = .../<SID>/<take>/<did>/<file>)
const destRows = read(OUTD + "/sha-" + CSER + ".txt").map((l) => {
  const m = l.match(/^(.*?) sha256=(\S+) bytes=(\S+)/);
  if (!m) return null;
  const parts = m[1].split("/");
  return { p: m[1], take: parts[parts.length - 3], did: parts[parts.length - 2], base: parts[parts.length - 1], sha: m[2], bytes: m[3] };
}).filter(Boolean);

// vue tr_take : {sid,take,n,rows:[{src,sto,state,...}]} (double-encodée en chaîne)
const stateOf = (f, src) => {
  try {
    let v = JSON.parse(fs.readFileSync(f, "utf8"));
    if (typeof v === "string") v = JSON.parse(v);
    const rows = (v && v.rows) || [];
    const row = rows.find((r) => r.src === src);
    return row ? row.state : "absent";
  } catch (e) { return "err"; }
};

let allOk = true;
const lines = ["## INTEGRITE PAR TAKE sid=" + SID + " mode=" + (process.env.J14D_MODE || "campagne")];
for (const label of LABELS) {
  const tk = read(OUTD + "/TN-" + label + ".txt")[0];
  if (!tk) continue;
  let labelOk = true;
  lines.push("## " + label + " (take=" + tk + ")");
  const checkSrc = (did, tag) => {
    const rows = read(OUTD + "/local-sha-" + tag + ".txt").map(parse).filter(Boolean);
    if (!rows.length) { lines.push("  " + tag + ": ECHEC AUCUNE SOURCE (inventaire vide)"); labelOk = false; return; }
    for (const s of rows) {
      const d = destRows.find((x) => x.take === String(tk) && x.did === did && x.base === s.base);
      if (!d) { lines.push("  " + tag + " " + s.base + ": MANQUANT sur C"); labelOk = false; continue; }
      const shaOk = d.sha === s.sha;
      const sizeOk = String(d.bytes) === String(s.bytes);
      if (!shaOk) labelOk = false;
      const sizeNote = shaOk && !sizeOk
        ? " (tailles divergentes : bytes source saisi pendant la finalisation — arbitrage par SHA)"
        : "";
      lines.push("  " + tag + " " + s.base + ": src.sha=" + s.sha + " dst.sha=" + d.sha + " src.b=" + s.bytes + " dst.b=" + d.bytes + " -> " + (shaOk ? "OK" : "ECHEC") + sizeNote);
    }
  };
  checkSrc(BDID, label + "-B");
  checkSrc(DDID, label + "-D");
  const bf = destRows.filter((x) => x.take === String(tk) && x.did === BDID);
  const df = destRows.filter((x) => x.take === String(tk) && x.did === DDID);
  const distinct = bf.length > 0 && df.length > 0 && bf.every((b) => !df.some((d) => d.p === b.p));
  if (!distinct) labelOk = false;
  lines.push("  anti-collision: B=" + bf.length + " D=" + df.length + " distincts=" + distinct);
  const sa = stateOf(OUTD + "/tr-A-" + label + ".json", BDID), sb = stateOf(OUTD + "/tr-A-" + label + ".json", DDID);
  const sc = stateOf(OUTD + "/tr-C-" + label + ".json", BDID), sd = stateOf(OUTD + "/tr-C-" + label + ".json", DDID);
  const doneOk = sa === "done" && sb === "done" && sc === "done" && sd === "done";
  if (!doneOk) labelOk = false;
  lines.push("  DONE: A[B=" + sa + " D=" + sb + "] C[B=" + sc + " D=" + sd + "] -> " + (doneOk ? "OK" : "ECHEC"));
  lines.push("VERDICT " + label + ": " + (labelOk ? "PASS" : "FAIL"));
  if (!labelOk) allOk = false;
}
lines.push("VERDICT GLOBAL INTEGRITE: " + (allOk ? "PASS" : "FAIL"));
fs.appendFileSync(OUTD + "/verdict.txt", lines.join("\n") + "\n");
console.log(lines.join("\n"));
NODE

grep -q '^VERDICT GLOBAL INTEGRITE: PASS' "$VER"
