/* MultiCam J05 — décision 31.2 : dans le workflow d'ajout d'un device, la
 * capability technique interne `controller` ne doit PAS être exposée.
 *
 *   - carte « Disponibles sur le LAN »  : `capture · storage` uniquement ;
 *   - popup « Ajouter un device »       : uniquement Capture + Storage, et
 *     aucune occurrence de `controller` (ni dans les choix, ni dans la ligne
 *     d'information des skills annoncées).
 *
 * `controller` reste une donnée : la table de découverte le conserve et le
 * payload `addMember` continue de transmettre les skills annoncées telles
 * quelles (le modèle en a besoin pour valider les rôles). Le filtrage est
 * donc strictement un filtre d'AFFICHAGE.
 *
 * Test de rendu réel (pas de grep de source) : `ui/session.js` est chargé
 * dans un contexte `vm` avec un DOM minimal, puis l'écran 03 est réellement
 * rendu (show → render → renderAvailable) et la popup réellement ouverte via
 * la délégation de clic. Aucune dépendance ajoutée (pas de jsdom).
 *
 * Usage :  node ui/lan-skills-display.test.js
 */

"use strict";

const path = require("path");
const fs = require("fs");
const vm = require("vm");

const APP = path.resolve(__dirname, "../../../app/www/js");
const SRC = {
  names: fs.readFileSync(path.join(APP, "ui/names.js"), "utf8"),
  model: fs.readFileSync(path.join(APP, "state/session-model.js"), "utf8"),
  screen: fs.readFileSync(path.join(APP, "ui/session.js"), "utf8")
};

let failures = 0;
function check(cond, label) {
  console.log((cond ? "ok" : "FAIL") + " — " + label);
  if (!cond) failures++;
}

/* ---------------- DOM minimal (suffisant au rendu de l'écran 03) --------- */

const IDS = [
  "deviceNameSession", "sessionName", "sessionBadge", "sessionPin", "sessionMeta",
  "membersCount", "membersList", "availableList", "availableCount",
  "renameButton", "actionsArea", "sessionNameRow", "sessionNameForm",
  "sessionNameInput", "renameCancel", "renameSave", "closeButton",
  "prepareTakeButton", "memberModal", "mmTitle", "mmDeviceName", "mmDeviceMeta",
  "mmRoles", "mmSave", "mmSaveLabel", "mmRemove", "mmHint", "mmClose", "mmCancel",
  "toast"
];

function makeEl(id) {
  const el = {
    id: id,
    _html: "",
    textContent: "",
    className: "",
    value: "",
    disabled: false,
    _attrs: {},
    _classes: new Set(),
    _handlers: {},
    classList: {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      contains: (c) => el._classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !el._classes.has(c) : !!on;
        if (want) el._classes.add(c); else el._classes.delete(c);
        return want;
      }
    },
    addEventListener: (type, fn) => { (el._handlers[type] = el._handlers[type] || []).push(fn); },
    getAttribute: (k) => (el._attrs[k] === undefined ? null : el._attrs[k]),
    setAttribute: (k, v) => { el._attrs[k] = v; },
    focus: () => {},
    click: () => (el._handlers.click || []).forEach((fn) => fn({ target: el }))
  };
  Object.defineProperty(el, "innerHTML", { get() { return el._html; }, set(v) { el._html = v; } });
  return el;
}

function harness(peers, session) {
  const els = {};
  IDS.forEach((id) => { els[id] = makeEl(id); });

  /* Cases cochées de la popup, pilotées par le test. */
  const dom = {
    checkedRoles: [],
    els: els,
    bodyHandlers: [],
    getElementById: (id) => els[id] || null,
    /* pas de backdrop dans le harnais : l'UI réelle l'a, le test non pertinent */
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === "#mmRoles input[type=checkbox]:checked") {
        return dom.checkedRoles.map((r) => ({ getAttribute: () => r }));
      }
      return [];
    },
    body: {
      addEventListener: (type, fn) => { if (type === "click") dom.bodyHandlers.push(fn); }
    }
  };
  /* clic délégué sur la carte LAN : cible `.member-add` du device demandé */
  dom.clickAdd = (deviceId) => {
    dom.bodyHandlers.forEach((fn) => fn({
      target: {
        closest: (sel) => (sel === ".member-add"
          ? { getAttribute: (k) => (k === "data-device" ? deviceId : null) }
          : null)
      }
    }));
  };

  const logs = [];
  const addMemberCalls = [];
  const sandbox = {
    console: { log: (m) => logs.push(String(m)), warn: () => {}, error: () => {} },
    document: dom,
    confirm: () => true,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    MultiCamNav: { show: () => {} },
    MultiCamSessionStore: { get: (sid) => Promise.resolve(session) },
    MultiCamSessionWs: {
      status: () => ({ localDid: "d5f6b2a1-0000-0000-0000-000000000001" }),
      connectedPeers: () => ({}),
      ensureServer: () => Promise.resolve(),
      advertiseOpenSessions: () => Promise.resolve(),
      unadvertise: () => Promise.resolve(),
      reSyncSession: () => {},
      onChanged: () => {},
      addMember: (s, member, roles) => {
        addMemberCalls.push({ member: member, roles: roles });
        const upd = JSON.parse(JSON.stringify(s));
        upd.members = (upd.members || []).concat([{
          deviceId: member.deviceId, deviceName: member.deviceName,
          enabledSkills: member.enabledSkills, sessionRoles: roles, addedAtMs: 1
        }]);
        return Promise.resolve(upd);
      }
    },
    MultiCamDiscovery: { peers: () => peers, onChanged: () => {} }
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC.names, ctx, { filename: "names.js" });
  vm.runInContext(SRC.model, ctx, { filename: "session-model.js" });
  vm.runInContext(SRC.screen, ctx, { filename: "ui/session.js" });
  return { dom: dom, logs: logs, addMemberCalls: addMemberCalls, ctx: ctx, peers: peers };
}

function flush() {
  return new Promise((r) => setImmediate(r));
}

/* ---------------- scénario : un device capture+storage+controller --------- */

const PEER = {
  deviceId: "23c5cf6e-beab-4e40-b3ab-6dc6dfed0437",
  name: "Cam D4",
  supported: ["capture", "storage", "controller"],
  enabled: ["capture", "storage", "controller"],
  enabledSkills: ["capture", "storage", "controller"],
  endpoint: "192.168.92.103:45101",
  wsEndpoint: "192.168.92.103:45102",
  version: "1.0.0",
  state: "online"
};

const SESSION = {
  sessionId: "TESTP1N",
  name: "Test masquage",
  state: "open",
  pin: "4242",
  createdAtMs: 1,
  members: [],
  masters: [{ deviceId: "d5f6b2a1-0000-0000-0000-000000000001" }]
};

(async function main() {
  const h = harness([PEER], SESSION);
  h.ctx.MultiCamSessionScreen.show({ deviceName: "Cam D1" }, { sid: "TESTP1N" });
  await flush(); await flush(); await flush();

  const card = h.dom.els.availableList.innerHTML;

  /* ---- 1. Carte « Disponibles sur le LAN » ---- */
  check(h.dom.els.availableCount.textContent === "1", "le device découvert est listé dans les disponibles (count=1)");
  check(card.indexOf("Cam D4") >= 0, "la carte affiche le nom humain du device");
  check(card.indexOf("capture · storage") >= 0, "la carte affiche « capture · storage »");
  check(card.indexOf("controller") < 0, "la carte n'affiche PAS « controller »");
  check(/member-add/.test(card), "la carte conserve le bouton [Ajouter]");

  /* ---- 2. Popup « Ajouter un device » ---- */
  h.dom.clickAdd(PEER.deviceId);
  const roles = h.dom.els.mmRoles.innerHTML;
  const meta = h.dom.els.mmDeviceMeta.textContent;

  check(h.dom.els.mmTitle.textContent === "Ajouter un device", "la popup est bien « Ajouter un device »");
  check(roles.indexOf('data-role="capture"') >= 0, "la popup propose Capture");
  check(roles.indexOf('data-role="storage"') >= 0, "la popup propose Storage");
  check(roles.indexOf("controller") < 0, "la popup ne propose PAS controller");
  check(meta.indexOf("controller") < 0, "la ligne d'information des skills n'affiche PAS controller");
  check(meta === "capture · storage", "la popup annonce « capture · storage »");
  check((roles.match(/type="checkbox"/g) || []).length === 2, "exactement 2 choix : Capture + Storage");

  /* ---- 3. `controller` n'est pas sélectionnable : seuls les rôles PROPOSÉS
   * par la popup peuvent être cochés/transmis (un choix non rendu est
   * impossible à sélectionner dans un vrai navigateur). ---- */
  const offered = (roles.match(/data-role="([^"]+)"/g) || [])
    .map((m) => m.slice('data-role="'.length, -1));
  h.dom.checkedRoles = offered;
  h.dom.els.mmSave.click();
  await flush(); await flush();
  const call = h.addMemberCalls[0];
  check(!!call, "l'enregistrement de la popup aboutit (addMember appelé)");
  if (call) {
    check(call.roles.join(",") === offered.join(","),
      "les rôles transmis sont exactement les rôles proposés par la popup (Capture, Storage)");
    check(call.roles.indexOf("controller") < 0, "aucun rôle controller n'est transmissible");
    check(call.member.enabledSkills.indexOf("controller") >= 0,
      "DONNÉE INTACTE : les skills annoncées (controller inclus) sont toujours transmises à addMember");
  }

  /* ---- 4. `controller` reste une donnée de découverte ---- */
  check(h.peers[0].enabledSkills.indexOf("controller") >= 0,
    "DONNÉE INTACTE : la table de découverte conserve toujours la capability controller");
  check(h.peers[0].enabled.join(",") === "capture,storage,controller",
    "DONNÉE INTACTE : le peer découvert est inchangé (aucun filtrage destructif)");

  /* ---- 5. Un device SANS rôle attribuable (enabledSkills ∩ VALID_ROLES vide)
   * ne doit pas apparaître dans « Disponibles sur le LAN » (§31.2), même
   * s'il annonce `controller`. Rendu réel, un cas par combinaison. ---- */
  const CASES = [
    { skills: ["capture", "storage", "controller"], shown: true,  label: "capture · storage" },
    { skills: ["capture", "controller"],           shown: true,  label: "capture" },
    { skills: ["storage", "controller"],           shown: true,  label: "storage" },
    { skills: ["capture", "storage"],              shown: true,  label: "capture · storage" },
    { skills: ["controller"],                      shown: false, label: "" },
    { skills: [],                                  shown: false, label: "" }
  ];
  for (const c of CASES) {
    const skills = c.skills.join(",") || "(aucune)";
    const peer = Object.assign({}, PEER, { enabledSkills: c.skills.slice(), enabled: c.skills.slice() });
    const hc = harness([peer], SESSION);
    hc.ctx.MultiCamSessionScreen.show({ deviceName: "Cam D1" }, { sid: "TESTP1N" });
    await flush(); await flush(); await flush();

    const cardHtml = hc.dom.els.availableList.innerHTML;
    const listed = cardHtml.indexOf("Cam D4") >= 0;
    if (c.shown) {
      check(listed, "[" + skills + "] → device affiché dans les disponibles");
      check(cardHtml.indexOf("<div class=\"small muted\">" + c.label + "</div>") >= 0,
        "[" + skills + "] → affiche « " + c.label + " »");
      check(cardHtml.indexOf("controller") < 0, "[" + skills + "] → aucun controller visible");
      check(/member-add/.test(cardHtml), "[" + skills + "] → bouton [Ajouter] présent");
      check(hc.dom.els.availableCount.textContent === "1", "[" + skills + "] → count=1");
    } else {
      check(!listed, "[" + skills + "] → device ABSENT de « Disponibles sur le LAN »");
      check(hc.dom.els.availableCount.textContent === "0", "[" + skills + "] → count=0");
      check(/Aucun device disponible sur le LAN/.test(cardHtml),
        "[" + skills + "] → état vide « Aucun device disponible sur le LAN »");
      check(/member-add/.test(cardHtml) === false, "[" + skills + "] → aucun bouton [Ajouter]");
      /* masquage d'affichage seul : la donnée technique reste disponible */
      check(JSON.stringify(hc.peers[0].enabledSkills) === JSON.stringify(c.skills),
        "[" + skills + "] → DONNÉE INTACTE : le peer découvert est inchangé (aucun filtrage destructif)");
    }
  }

  if (failures > 0) {
    console.log("\n" + failures + " échec(s)");
    process.exit(1);
  }
  console.log("\nOK — controller masqué, devices sans rôle attribuable absents, donnée préservée");
})();
