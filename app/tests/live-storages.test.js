/* MultiCam — J09-09c : zone Storage sous la mosaïque Master (lecture seule).
 *
 * Maquette validée ui/08-live-recording §3 : pendant REC, sous la mosaïque, on
 * affiche UNIQUEMENT les Storage sélectionnés pour CE Take — nom, état, espace
 * libre, type réseau. Pas de transfert, pas d'anciens Takes, pas de
 * réplication, pas d'action.
 *
 * SOURCE DE VÉRITÉ : `take.storages` (le plan, ordre du Take) + télémétrie
 * (freeBytes/netType) + connectivité WS (liveness) + noms des participants du
 * plan. Aucune seconde vérité : la liste ne se recompose jamais à partir d'un
 * autre critère, donc une déconnexion ne la réordonne pas.
 *
 * Règle ABSENCE ≠ ZÉRO : freeBytes absent → « — », jamais « 0 o ».
 */

const h = require("./harness.js");

function register(h) {
  const { describe, it, createEnv, loadAll, fakeDom } = h;

  function eq(actual, want, msg) {
  if (actual !== want) {
    throw new Error((msg || "valeur inattendue")
      + " — attendu " + JSON.stringify(want) + ", obtenu " + JSON.stringify(actual));
  }
}

const SID = "SIDSTOR01";
const A = "aaaaaaaa-0000-0000-0000-00000000000a";      /* Capture A */
const B = "bbbbbbbb-0000-0000-0000-00000000000b";      /* Capture B */
const C = "cccccccc-0000-0000-0000-00000000000c";      /* Capture C, non sélectionnée */
const STO = "storage-aaaa";                            /* Storage 1 */
const STO2 = "storage-bbbb";                           /* Storage 2 */
const LOCAL = "dddddddd-0000-0000-0000-000000000001";  /* Master local */

function env() {
  const e = createEnv({ fakeClock: false });
  loadAll(e, ["state/take-model.js", "ui/live.js"]);
  return { e, screen: e.window.MultiCamLiveScreen, tm: e.window.MultiCamTakeModel };
}

/* Un Take de CE plan, sous la forme canonique du modèle (sanitizeTake). */
function takeT(storages, captures, over) {
  return env().tm.sanitizeTake(Object.assign({
    takeNumber: 9,
    captures: captures || [],
    storages: storages || [],
    settings: {},
    captureOverrides: {}
  }, over || {}));
}

/* Contexte de rendu : toutes les données sont des FAITS injectés (le code
 * réel vient de main.js, une lecture par révision). */
function rec(over) {
  return Object.assign({
    take: null,
    telemetry: {},
    liveness: {},
    names: {},
    localDid: ""
  }, over || {});
}

/* Un snapshot de télémétrie « mesuré » au format du store de supervision. */
function entry(over) {
  const tele = Object.assign({
    batteryLevel: 71, batteryCharging: true,
    freeBytes: null, totalBytes: null,
    netType: "wifi"
  }, over || {});
  return { telemetry: tele, atMs: 1000 };
}

describe("J09-09c · Storages sélectionnés pour CE Take (zone Master)", () => {
  it("A. aucun Storage sélectionné → aucune ligne Storage", () => {
    const { screen } = env();
    const r = rec({ take: takeT([], [A]) });
    const rows = screen.storagesOf(r);
    eq(rows.length, 0, "pas de ligne sans sélection");
    const v = screen.view({}, r);
    eq(v.hasStorages, false, "zone absente proprement, pas de placeholder");
  });

  it("B. un Storage sélectionné → une ligne avec le bon nom", () => {
    const { screen } = env();
    const r = rec({
      take: takeT([STO], []),
      names: { [STO]: "Dock Alfa" },
      liveness: { [STO]: true }
    });
    const rows = screen.storagesOf(r);
    eq(rows.length, 1, "une seule ligne");
    eq(rows[0].deviceId, STO, "identifié par deviceId");
    eq(rows[0].deviceName, "Dock Alfa", "le nom vient du plan, pas du deviceId");
    eq(rows[0].state, "connected", "en ligne et sans alerte → connecté");
  });

  it("C. deux Storage → ordre conforme au plan (déconnexion ne réordonne pas)", () => {
    const { screen } = env();
    /* Le plan du Take (storages déjà sous forme canonique : triées). STO est la
     * PREMIÈRE du plan mais DÉCONNECTÉE : elle doit rester en première ligne. */
    const t = takeT([STO2, STO], []);
    const r = rec({
      take: t,
      liveness: { [STO2]: true },       /* STO2 est en ligne… */
      names: { [STO]: "Dock Alfa", [STO2]: "Dock Bêta" }
    });
    const plan = t.storages.slice();
    eq(plan.length, 2, "deux Storage au plan");
    const rows = screen.storagesOf(r);
    eq(rows.map((x) => x.deviceId).join(","), plan.join(","),
      "la liste suit l'ordre du plan, pas la connectivité");
    eq(rows[0].state, "deconnected", "le premier du plan est déconnecté et reste premier");
    eq(rows[1].state, "connected", "le second du plan est en ligne");
    eq(rows[0].deviceName, "Dock Alfa");
    eq(rows[1].deviceName, "Dock Bêta");
  });

  it("D. freeBytes connu → valeur affichée (formatée)", () => {
    const { screen } = env();
    const r = rec({
      take: takeT([STO], []),
      telemetry: { [STO]: entry({ freeBytes: 8791234567 }) },
      liveness: { [STO]: true }
    });
    const row = screen.storagesOf(r)[0];
    eq(row.freeKnown, true, "donnée mesurée");
    eq(row.freeBytes, 8791234567, "valeur conservée");
    /* Même constante d'affichage que la vignette et la vue détaillée
     * (fmtBytes partagé dans live.js) : séparateur "." et unités [o,Ko,Mo,Go,To]. */
    eq(row.freeText, "8.8 Go", "format humain, pas un nombre brut");
  });

  it("E. freeBytes inconnu → « — », jamais 0", () => {
    const { screen } = env();
    const r0 = rec({ take: takeT([STO], []), liveness: { [STO]: true } });
    const row0 = screen.storagesOf(r0)[0];
    eq(row0.freeKnown, false, "jamais mesuré");
    eq(row0.freeBytes, null, "absence ≠ 0");
    eq(row0.freeText, "—", "« — », jamais « 0 o »");

    const r1 = rec({
      take: takeT([STO], []),
      telemetry: { [STO]: entry({ freeBytes: 0 }) },
      liveness: { [STO]: true }
    });
    const row1 = screen.storagesOf(r1)[0];
    eq(row1.freeKnown, true, "0 réel est une donnée, pas une absence");
    eq(row1.freeText, "0 o", "0 réel s'affiche 0");
    eq(row1.freeLow, true, "0 octet libres → sous le seuil");
    eq(row1.state, "warning", "espace critique → warning");
  });

  it("F. netType wifi → Wi-Fi", () => {
    const { screen } = env();
    const r = rec({
      take: takeT([STO], []),
      telemetry: { [STO]: entry({ netType: "wifi" }) },
      liveness: { [STO]: true }
    });
    const row = screen.storagesOf(r)[0];
    eq(row.netType, "wifi");
    eq(row.netLabel, "Wi-Fi");
  });

  it("G. netType ethernet → Ethernet", () => {
    const { screen } = env();
    const r = rec({
      take: takeT([STO], []),
      telemetry: { [STO]: entry({ netType: "ethernet" }) },
      liveness: { [STO]: true }
    });
    const row = screen.storagesOf(r)[0];
    eq(row.netType, "ethernet");
    eq(row.netLabel, "Ethernet");
  });

  it("H. Storage déconnecté → reste dans la liste avec état déconnecté", () => {
    const { screen } = env();
    const r = rec({
      take: takeT([STO], []),
      /* pas de liveness : le Storage n'est pas joignable. */
      telemetry: { [STO]: entry({ freeBytes: 8791234567, netType: "wifi" }) },
      names: { [STO]: "Dock Alfa" }
    });
    const rows = screen.storagesOf(r);
    eq(rows.length, 1, "reste sélectionné au plan → toujours listé");
    eq(rows[0].connected, false);
    eq(rows[0].state, "deconnected", "l'état dit la connectivité, rien de plus");
    eq(rows[0].stateLabel, "Déconnecté");
    eq(rows[0].freeText, "8.8 Go", "l'espace connu reste affiché — la donnée n'est pas une panne");
  });

  it("I. device non sélectionné comme Storage → absent", () => {
    const { screen } = env();
    const r = rec({
      take: takeT([STO], [A]),
      names: { [STO]: "Dock", [C]: "Cam C" },
      liveness: { [C]: true },
      telemetry: { [C]: entry({ freeBytes: 999999999 }) }
    });
    const rows = screen.storagesOf(r);
    eq(rows.length, 1, "seul le Storage du plan est listé");
    eq(rows[0].deviceId, STO, "C a télémetrie ET connectivité mais n'est pas au plan");
  });

  it("J. une Capture ne doit jamais apparaître dans la liste Storage", () => {
    const { screen } = env();
    /* Même pathologique : A est dans les deux listes. La zone Storage ne doit
     * montrer QUE le rôle Storage — une Capture ne s'y glisse jamais. */
    const r = rec({
      take: takeT([A, STO], [A]),
      names: { A: "Cam A", [STO]: "Dock" },
      liveness: { [A]: true, [STO]: true }
    });
    const rows = screen.storagesOf(r);
    eq(rows.length, 1, "la capture est filtrée même si elle est techniquement sélectionnée en Storage");
    eq(rows[0].deviceId, STO);
  });

  it("K. aucune régression mosaïque Capture", () => {
    const { screen } = env();
    const r = rec({
      take: takeT([STO], [A, B]),
      telemetry: { [STO]: entry({ netType: "ethernet" }) },
      liveness: { [STO]: true, [A]: true, [B]: true },
      names: { [STO]: "Dock", [A]: "Cam A", [B]: "Cam B" }
    });
    function slot(did, name) {
      return {
        sessionId: SID, take: 9, deviceId: did, deviceName: name,
        isLocal: false, status: "REC", displayState: "REC",
        lastFrame: null, lastFrameSeq: 0, lastFrameAt: 0,
        telemetry: null, telemetryAt: 0, connected: true
      };
    }
    const v = screen.view({
      sessionId: SID, takeNumber: 9, order: [A, B],
      slots: [slot(A, "Cam A"), slot(B, "Cam B")]
    }, r);
    eq(v.tiles.length, 2, "la mosaïque reste intacte");
    eq(v.tiles.map((t) => t.deviceId).join(","), A + "," + B, "ordre des vignettes inchangé");
    eq(v.gridClass, "live-grid cols-2", "géométrie inchangée à 2 Captures");
    const stoRows = v.storages;
    eq(stoRows.length, 1, "la zone Storage coexiste avec la mosaïque");
    eq(stoRows[0].deviceId, STO);
    const tilesIds = v.tiles.map((t) => t.deviceId);
    eq(tilesIds.indexOf(STO), -1, "le Storage ne crée jamais de vignette");
    eq(stoRows.filter((s) => s.deviceId === A || s.deviceId === B).length, 0,
      "aucune Capture ne fuit dans la zone Storage");
  });

  it("DOM. la zone se masque sans Storage et se remplit avec", () => {
    const e = createEnv({ fakeClock: false });
    loadAll(e, ["state/take-model.js", "ui/live.js"]);
    const dom = fakeDom(["liveGrid", "liveStores", "liveStoreList"]);
    e.document = dom;
    const screen = e.window.MultiCamLiveScreen;
    const modelView = { slots: [], order: [], sessionId: SID, takeNumber: 9 };

    /* sans Storage : zone masquée, aucune ligne. */
    screen.render(modelView, rec({ take: takeT([], []) }));
    const stores = dom.getElementById("liveStores");
    const list = dom.getElementById("liveStoreList");
    if (!stores.classList.contains("d-none")) throw new Error("zone Storage visible sans sélection");
    if (list._kids.length !== 0) throw new Error("des lignes Storage sans sélection");

    /* avec un Storage : zone visible, une ligne avec nom + libellés. */
    screen.render(modelView, rec({
      take: takeT([STO], []),
      telemetry: { [STO]: entry({ freeBytes: 8791234567, netType: "wifi" }) },
      liveness: { [STO]: true },
      names: { [STO]: "Dock Alfa" }
    }));
    if (stores.classList.contains("d-none")) throw new Error("zone masquée alors qu'un Storage est au plan");
    if (list._kids.length !== 1) throw new Error("attendu une ligne, obtenu " + list._kids.length);
    const row = list._kids[0];
    const name = row.querySelector(".lv-store-name");
    if (!name || name.textContent !== "Dock Alfa") throw new Error("nom non peint dans la ligne");
    const state = row.querySelector(".lv-store-state");
    if (!state || state.textContent !== "Connecté") throw new Error("état non peint");
    const free = row.querySelector(".lv-store-free");
    if (!free || free.dataset.known !== "true") throw new Error("known non peint");
    if (!free || free.textContent !== "8.8 Go") throw new Error("espace libre non peint");
    const net = row.querySelector(".lv-store-net");
    if (!net || net._kids.length !== 2) throw new Error("réseau non structuré");
    if (net._kids[1].textContent !== "Wi-Fi") throw new Error("réseau non peint");
  });
});
}

module.exports = { register };