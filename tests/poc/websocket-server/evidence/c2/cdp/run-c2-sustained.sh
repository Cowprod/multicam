#!/bin/bash
# MultiCam POC — C2 patched — sustained test (C2-12).
# Assumes run-c2.sh "base" completed and the C->A, A->B, B->C ring is ACTIVE.
# Enables heartbeat every 2s on all three servers, runs >= 10 minutes, collects statistics.
#
# v2 (final qualification): the anomaly scan operates on the LOG DELTA recorded at
# sustained start, so intentional disconnect/close markers from the base phase
# (C2-07 onClose, C2-08 client CLOSE) cannot pollute the C2-12 result.
set -u

EVIDENCE="${EVIDENCE:-/Volumes/SSD1TO/testia/openCode/multicam/tests/poc/websocket-server/evidence/c2}"
CDPJS="$EVIDENCE/cdp/cdp.js"
RUN="$EVIDENCE/run"
SUSTAIN="$RUN/sustained-C2-12.log"
P_A=9223; P_B=9224; P_C=9225
MARK=()  # per-port watermark of consumed log length at sustained start

evalc() { node "$CDPJS" "$1" "$2" | tr -d '"'; }
click() { node "$CDPJS" "$1" "document.getElementById('$2').click(); 'clicked'" >/dev/null; }
status() { node "$CDPJS" "$1" "document.getElementById('$2').textContent" | tr -d '"'; }

marklog() { MARK[$1]=$(node "$CDPJS" "$1" "document.getElementById('log').textContent.length"); }

anom_delta() { # $1=port : count anomaly markers in the log delta
  local len full m tail
  len=$(node "$CDPJS" "$1" "document.getElementById('log').textContent.length")
  full=$(node "$CDPJS" "$1" "document.getElementById('log').textContent")
  m=${MARK[$1]:-0}
  [ "$m" -gt "$len" ] && m=0
  tail=${full:$m}
  printf '%s' "$tail" | grep -cE "ERROR|onFailure|client CLOSE|onClose|onerror" || true
}

echo "=== C2-12 sustained run start $(date -u +%FT%TZ) ===" | tee -a "$SUSTAIN"
marklog $P_A; marklog $P_B; marklog $P_C
click $P_A heartbeat; click $P_B heartbeat; click $P_C heartbeat
echo "server-status A=$(status $P_A server-status) B=$(status $P_B server-status) C=$(status $P_C server-status)" | tee -a "$SUSTAIN"

T0=$(date +%s)
echo "sleeping 600s (10 min) ..." | tee -a "$SUSTAIN"
sleep 600
T1=$(date +%s)
DUR=$((T1 - T0))
echo "duration = ${DUR}s" | tee -a "$SUSTAIN"

for spec in "A:$P_A" "B:$P_B" "C:$P_C"; do
  r=${spec%%:*}; p=${spec##*:}
  echo "--- device $r ---" | tee -a "$SUSTAIN"
  echo "server-stats: $(status $p server-stats)" | tee -a "$SUSTAIN"
  echo "client-ish : $(status $p send-status)" | tee -a "$SUSTAIN"
  echo "client-status: $(status $p client-status)" | tee -a "$SUSTAIN"
done

# anomalies scan (delta only)
HAS_ERR=0
for p in $P_A $P_B $P_C; do
  e=$(anom_delta $p)
  echo "device port $p anomaly-marker-lines (delta): $e" | tee -a "$SUSTAIN"
  [ "$e" != "0" ] && HAS_ERR=1
done

echo "=== statistics (approximate) ===" | tee -a "$SUSTAIN"
for spec in "A:$P_A" "B:$P_B" "C:$P_C"; do
  r=${spec%%:*}; p=${spec##*:}
  ss=$(status $p server-stats)
  cs=$(status $p send-status)
  hb=$(evalc $p "document.getElementById('log').textContent" | grep -c "rx hb " || true)
  echo "$r: $ss | $cs | log hb-rx-lines=$hb" | tee -a "$SUSTAIN"
done
if [ "$HAS_ERR" = "0" ]; then
  echo "C2-12 PASS (no disconnects/errors over ${DUR}s)" | tee -a "$SUSTAIN"
else
  echo "C2-12 CHECK — anomaly markers found, review $SUSTAIN" | tee -a "$SUSTAIN"
fi
echo "=== C2-12 sustained run end $(date -u +%FT%TZ) ===" | tee -a "$SUSTAIN"