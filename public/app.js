// =====================================
// CLOUD FUNCTIONS (US-CENTRAL1)
// =====================================
const PROJECT_ID = "digitales-bordbuch";
const REGION = "us-central1";

const BASE_URL = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;

const VERIFY_URL = `${BASE_URL}/verifyPin`;
const LOAD_AUTOMATEN_URL = `${BASE_URL}/loadAutomaten`;
const SAVE_URL = `${BASE_URL}/submitCleaning`;
const LAST_CLEANING_URL = `${BASE_URL}/loadLastCleaning`;
const WOCHENWARTUNG_URL = `${BASE_URL}/submitWochenWartung`;
const WARTUNG_URL = `${BASE_URL}/submitWartung`;
const LOAD_WARTUNGSELEMENTE_URL = "https://us-central1-digitales-bordbuch.cloudfunctions.net/loadWartungselemente";

const AUTOMATEN_CACHE_KEY = "automatenCacheV1";
const AUTOMATEN_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// =====================================
// STATE
// =====================================
let currentUser = null;
let automaten = [];
let selectedStadt = "";
let selectedCenter = "";
let selectedAutomat = "";

const lastCleaningByAutomat = {};
const selectedOrders = new Set();

// =====================================
// HELPERS
// =====================================
const $ = (id) => document.getElementById(id);

function norm(v) {
  return (v ?? "").toString().trim();
}

function formatDateEU(iso) {
  if (!iso || !iso.includes("-")) return iso;
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function readAutomatenCache() {
  try {
    const raw = localStorage.getItem(AUTOMATEN_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.automaten)) return null;
    if (Date.now() - parsed.savedAt > AUTOMATEN_CACHE_MAX_AGE_MS) return null;
    return parsed.automaten;
  } catch {
    return null;
  }
}

function writeAutomatenCache(list) {
  try {
    localStorage.setItem(
      AUTOMATEN_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), automaten: list })
    );
  } catch {
    // ignore cache errors
  }
}

async function uploadPhoto(file, pathPrefix) {
  if (!file) return "";
  if (!window.storage) {
    throw new Error("Firebase Storage ist nicht verfügbar");
  }

  try {
    const safeName = file.name.replace(/[^\w.\-]+/g, "_");
    const stamp = Date.now();
    const path = `${pathPrefix}/${stamp}-${safeName}`;
    const ref = window.storage.ref().child(path);
    await ref.put(file);
    return ref.getDownloadURL();
  } catch (err) {
    const code = err?.code ? ` (${err.code})` : "";
    const message = err?.message || "Unbekannter Fehler";
    throw new Error(`${message}${code}`);
  }
}

// ISO Kalenderwoche → "2026-W03"
function getISOWocheString(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function setStatus(msg) {
  if ($("status")) $("status").innerText = msg;
}

function setErrorDetails(msg) {
  if ($("errorDetails")) $("errorDetails").innerText = msg || "";
}

function clearStatus(delay = 0) {
  if (!$("status")) return;
  if (delay > 0) setTimeout(() => ($("status").innerText = ""), delay);
  else $("status").innerText = "";
}

function updateOrderStatus() {
  const statusEl = $("orderStatus");
  if (!statusEl) return;
  if (selectedOrders.size === 0) {
    statusEl.innerText = "";
    return;
  }

  const labels = Array.from(selectedOrders)
    .map(key => {
      switch (key) {
        case "rot":
          return "Rot";
        case "gelb":
          return "Gelb";
        case "blau":
          return "Blau";
        case "weiss":
          return "Weiß";
        case "staebe":
          return "Stäbe";
        default:
          return key;
      }
    })
    .join(", ");

  statusEl.innerText = `Ausgewählt: ${labels}`;
}

function toggleOrder(button) {
  const key = button.dataset.order;
  if (!key) return;
  if (selectedOrders.has(key)) {
    selectedOrders.delete(key);
    button.classList.remove("is-selected");
  } else {
    selectedOrders.add(key);
    button.classList.add("is-selected");
  }
  updateOrderStatus();
}

async function parseJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function buildResponseError(res, data, fallback) {
  const status = res?.status ? `HTTP ${res.status}` : "HTTP-Fehler";
  const detail = data?.error || data?.message || "";
  return detail ? `${fallback} (${status}: ${detail})` : `${fallback} (${status})`;
}

// =====================================
// INIT
// =====================================
document.addEventListener("DOMContentLoaded", () => {
  $("stadtSelect")?.addEventListener("change", onStadtChange);
  $("centerSelect")?.addEventListener("change", onCenterChange);
  $("automatSelect")?.addEventListener("change", onAutomatChange);
  document.querySelectorAll(".order-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleOrder(btn));
  });

  disableAll();
  if ($("cleaningForm")) $("cleaningForm").style.display = "none";
});

// =====================================
// LOGIN
// =====================================
async function login() {
  const pin = norm($("pin")?.value);
  if (!pin) return;

  setStatus("Login läuft …");

  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });

    const data = await res.json();
    if (!data.ok) {
      setStatus("❌ Login fehlgeschlagen");
      return;
    }

    currentUser = {
      name: data.name,
      role: data.role,
      stadt: data.stadt || ""
    };

    setStatus(`Willkommen ${currentUser.name}`);
    const cached = readAutomatenCache();
    if (cached) {
      automaten = cached;
      buildSelectors();
    }
    await loadAutomaten({ silent: !!cached });

  } catch {
    setStatus("❌ Netzwerkfehler");
  }
}

// =====================================
// AUTOMATEN
// =====================================
async function loadAutomaten(options = {}) {
  try {
    const res = await fetch(LOAD_AUTOMATEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentUser)
    });

    const data = await res.json();
    if (!data?.ok) {
      setStatus(data?.error ? `❌ ${data.error}` : "❌ Automaten konnten nicht geladen werden");
      return;
    }
    automaten = Array.isArray(data.automaten) ? data.automaten : [];
    if (automaten.length) writeAutomatenCache(automaten);
    buildSelectors();

  } catch {
    if (!options.silent) setStatus("❌ Automaten konnten nicht geladen werden");
  }
}

function buildSelectors() {
  clearAll();

  if (currentUser.role === "mitarbeiter") {
    enable("automatSelect");
    fill("automatSelect", automaten.map(a => a.automatCode));
    return;
  }

  if (currentUser.role === "teamleiter") {
    selectedStadt = currentUser.stadt;
    $("stadtSelect").innerHTML = `<option>${selectedStadt}</option>`;
    enable("centerSelect");
    loadCenters();
    return;
  }

  if (currentUser.role === "admin") {
    const staedte = [...new Set(automaten.map(a => a.stadt))];
    enable("stadtSelect");
    fill("stadtSelect", staedte);
  }
}

function onStadtChange() {
  selectedStadt = $("stadtSelect").value;
  loadCenters();
}

function loadCenters() {
  const centers = [...new Set(
    automaten.filter(a => a.stadt === selectedStadt).map(a => a.center)
  )];
  enable("centerSelect");
  fill("centerSelect", centers);
}

function onCenterChange() {
  selectedCenter = $("centerSelect").value;
  const list = automaten
    .filter(a => a.center === selectedCenter)
    .map(a => a.automatCode);
  enable("automatSelect");
  fill("automatSelect", list);
}

function onAutomatChange() {
  selectedAutomat = $("automatSelect").value;
  if (!selectedAutomat) return;

  const meta = automaten.find(a => a.automatCode === selectedAutomat) || {};
  if (!selectedStadt && meta.stadt) {
    selectedStadt = meta.stadt;
  }
  if (!selectedCenter && meta.center) {
    selectedCenter = meta.center;
  }

  $("cleaningForm").style.display = "block";
  $("datum").value ||= new Date().toISOString().slice(0, 10);
  loadLastCleaning();
}

// =====================================
// LETZTE REINIGUNG
// =====================================
async function loadLastCleaning() {
  try {
    const res = await fetch(LAST_CLEANING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ automatCode: selectedAutomat })
    });

    const data = await parseJsonSafe(res);
    if (res.ok && data?.ok && data.last) {
      $("lastCleaning").innerText =
        `Letzte Reinigung: ${formatDateEU(data.last.datum)} – ${data.last.name}`;
      setErrorDetails("");
    } else if (!res.ok || data?.ok === false) {
      setErrorDetails(
        buildResponseError(res, data, "Letzte Reinigung konnte nicht geladen werden")
      );
    }
  } catch (err) {
    setErrorDetails(
      `Letzte Reinigung konnte nicht geladen werden (Netzwerkfehler: ${err?.message || "unbekannt"})`
    );
  }
}

// =====================================
// REINIGUNG SPEICHERN (1–5) + RESET
// =====================================
async function saveCleaning() {
  if (!selectedAutomat) {
    setStatus("❌ Bitte Automat wählen");
    return;
  }

  const datumISO = $("datum")?.value;
  if (!datumISO) {
    setStatus("❌ Datum fehlt");
    return;
  }

  setStatus("⏳ Speichern läuft …");

  try {
    const meta = automaten.find(a => a.automatCode === selectedAutomat) || {};
    const payload = {
      automatCode: selectedAutomat,
      stadt: selectedStadt || currentUser.stadt || meta.stadt || "",
      center: selectedCenter || meta.center || "",
      mitarbeiter: currentUser.name || "",
      datum: datumISO,

      zucker_aufgefuellt: $("zucker")?.checked || false,
      wasser_aufgefuellt: $("wasser")?.checked || false,
      staebe_aufgefuellt: $("staebeAuf")?.checked || false,
      zuckerfach_gereinigt: $("zuckerfach")?.checked || false,
      faecher_gereinigt: $("faecher")?.checked || false,
      abwasser_entleert: $("abwasser")?.checked || false,
      produktionsraum_gereinigt: $("produktionsraum")?.checked || false,
      messer_gereinigt: $("messer")?.checked || false,
      roboterarm_gereinigt: $("roboterarm")?.checked || false,
      sieb_gereinigt: $("sieb")?.checked || false,
      auffangschale_gereinigt: $("auffangschale")?.checked || false,
      aufbewahrung_aufgeraeumt: $("aufbewahrung")?.checked || false,
      automat_aussen_gereinigt: $("aussen")?.checked || false,
      scheiben_gereinigt: $("scheiben")?.checked || false,
      brennerkopf_gereinigt: $("brennerkopf")?.checked || false,
      duese_gereinigt: $("duese")?.checked || false,

      befeuchtungstest: $("befeuchtung")?.checked || false,
      reinigungstest: $("reinigungstest")?.checked || false,
      neuer_stab_genommen: $("neuer_stab")?.checked || false,
      roboterarm_90grad: $("roboterarm_90grad")?.checked || false,
      kreditkartensystem_ok: $("kreditkarte_ok")?.checked || false,
      geldschein_system_ok: $("geldschein_ok")?.checked || false,
      material_im_system: $("material_eingetragen")?.checked || false,

      zucker_rot: Number($("zucker_rot")?.value || 0),
      zucker_gelb: Number($("zucker_gelb")?.value || 0),
      zucker_blau: Number($("zucker_blau")?.value || 0),
      zucker_weiss: Number($("zucker_weiss")?.value || 0),
      staebe: Number($("staebe")?.value || 0),

      auffaelligkeiten: norm($("auffaelligkeiten")?.value),
      bestellungen: Array.from(selectedOrders)
    };

    const res = await fetch(SAVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!data.ok) {
      setStatus("❌ Speichern fehlgeschlagen");
      return;
    }

    setStatus("✅ Gespeichert");
    clearStatus(1500);

    setTimeout(() => {
      document
        .querySelectorAll("#cleaningForm input[type='checkbox']")
        .forEach(cb => cb.checked = false);

      document
        .querySelectorAll("#cleaningForm input[type='number']")
        .forEach(inp => inp.value = "");

      document
        .querySelectorAll(".order-btn")
        .forEach(btn => btn.classList.remove("is-selected"));

      selectedOrders.clear();
      updateOrderStatus();

      $("auffaelligkeiten").value = "";
      $("bemerkung").value = "";
      $("datum").value = "";

      selectedAutomat = "";
      selectedCenter = "";
      selectedStadt = "";
      clearAll();
      if ($("cleaningForm")) $("cleaningForm").style.display = "none";
      setErrorDetails("");
    }, 3000);

    loadLastCleaning();

  } catch {
    setStatus("❌ Netzwerkfehler");
  }
}

// =====================================
// WOCHENWARTUNG + RESET
// =====================================
async function saveWochenWartung() {
  const statusEl = $("wochenStatus");
  if (statusEl) statusEl.innerText = "⏳ Wochenwartung wird gespeichert …";

  if (!selectedAutomat || !currentUser?.name) {
    if (statusEl) statusEl.innerText = "❌ Automat fehlt";
    return;
  }

  const checkedTasks = Array.from(
    document.querySelectorAll("#sec6 input[type='checkbox']")
  ).filter(cb => cb.checked);

  const tasks = {};
  const woche = getISOWocheString();

  if (!checkedTasks.length) {
    if (statusEl) statusEl.innerText = "❌ Keine Aufgabe gewählt";
    return;
  }

  try {
    if (statusEl) statusEl.innerText = "⏳ Fotos werden hochgeladen …";
    setErrorDetails("");

    await Promise.all(checkedTasks.map(async (cb) => {
      const taskId = cb.id;
      const photoInput = document.querySelector(
        `#sec6 input[type="file"][data-task-id="${taskId}"]`
      );
      const file = photoInput?.files?.[0];
      let photoUrl = "";

      if (file) {
        try {
          photoUrl = await uploadPhoto(
            file,
            `automatenwartung/${selectedAutomat}/${woche}/${taskId}`
          );
        } catch (err) {
          if (statusEl) statusEl.innerText = "⚠️ Foto-Upload fehlgeschlagen";
          setErrorDetails(
            `Foto-Upload fehlgeschlagen, speichere ohne Foto: ${err?.message || "unbekannt"}`
          );
        }
      }

      tasks[taskId] = photoUrl ? { done: true, photoUrl } : { done: true };
    }));

    const payload = {
      automatCode: selectedAutomat,
      mitarbeiter: currentUser.name,
      woche,
      tasks
    };

    const res = await fetch(WOCHENWARTUNG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await parseJsonSafe(res);

    if (res.ok && data?.ok) {
      if (statusEl) statusEl.innerText = "✅ Wochenwartung gespeichert";

      setTimeout(() => {
        if (statusEl) statusEl.innerText = "";
        document
          .querySelectorAll("#sec6 input[type='checkbox']")
          .forEach(cb => cb.checked = false);
        document
          .querySelectorAll("#sec6 input[type='file']")
          .forEach(input => input.value = "");
      }, 3000);

    } else {
      const message = buildResponseError(res, data, "Fehler beim Speichern");
      if (statusEl) statusEl.innerText = "❌ Fehler beim Speichern";
      setErrorDetails(message);
    }

  } catch (err) {
    if (statusEl) {
      statusEl.innerText = "❌ Netzwerkfehler";
    }
    setErrorDetails(
      `Netzwerkfehler beim Speichern der Wochenwartung: ${err?.message || "unbekannt"}`
    );
  }
}

// =====================================
// WARTUNG / REPARATUREN SPEICHERN
// =====================================
async function saveWartung() {
  const statusEl = $("wartungStatus");
  if (statusEl) statusEl.innerText = "⏳ Wartung wird gespeichert …";

  if (!selectedAutomat || !currentUser?.name) {
    if (statusEl) statusEl.innerText = "❌ Automat fehlt";
    return;
  }

  const wartungselementId = $("wartungSelect")?.value || "";
  const freitext = norm($("wartungFreitext")?.value);
  const bemerkung = norm($("wartungBemerkung")?.value);
  const datum = $("datum")?.value || new Date().toISOString().slice(0, 10);

  if (!wartungselementId && !freitext) {
    if (statusEl) statusEl.innerText = "❌ Bitte Wartung angeben";
    return;
  }

  try {
    const meta = automaten.find(a => a.automatCode === selectedAutomat) || {};
    let photoUrl = "";
    const file = $("wartungFoto")?.files?.[0];

    if (file) {
      if (statusEl) statusEl.innerText = "⏳ Foto wird hochgeladen …";
      try {
        photoUrl = await uploadPhoto(
          file,
          `reparaturen/${selectedAutomat}/${datum}`
        );
      } catch (err) {
        if (statusEl) statusEl.innerText = "⚠️ Foto-Upload fehlgeschlagen";
        setErrorDetails(
          `Foto-Upload fehlgeschlagen, speichere ohne Foto: ${err?.message || "unbekannt"}`
        );
      }
    }

    const payload = {
      automatCode: selectedAutomat,
      stadt: selectedStadt || currentUser.stadt || meta.stadt || "",
      center: selectedCenter || meta.center || "",
      datum,
      name: currentUser.name,
      wartungselementId: wartungselementId || null,
      bezeichnung: freitext || "",
      bemerkung,
      photoUrl: photoUrl || ""
    };

    const res = await fetch(WARTUNG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await parseJsonSafe(res);

    if (res.ok && data?.ok) {
      if (statusEl) statusEl.innerText = "✅ Wartung gespeichert";
      setTimeout(() => {
        if (statusEl) statusEl.innerText = "";
        if ($("wartungSelect")) $("wartungSelect").value = "";
        if ($("wartungFreitext")) $("wartungFreitext").value = "";
        if ($("wartungBemerkung")) $("wartungBemerkung").value = "";
        if ($("wartungFoto")) $("wartungFoto").value = "";
      }, 3000);
    } else {
      const message = buildResponseError(res, data, "Fehler beim Speichern");
      if (statusEl) statusEl.innerText = "❌ Fehler beim Speichern";
      setErrorDetails(message);
    }

  } catch (err) {
    if (statusEl) {
      statusEl.innerText = "❌ Netzwerkfehler";
    }
    setErrorDetails(
      `Netzwerkfehler beim Speichern der Wartung: ${err?.message || "unbekannt"}`
    );
  }
}
// =====================================
// WARTUNG / REPARATUREN (PUNKT 7)
// =====================================


function onWartungToggle() {
  loadWartungselemente();
}

async function loadWartungselemente() {
  const select = document.getElementById("wartungSelect");
  if (!select) return;

  select.innerHTML = "<option value=''>– wird geladen … –</option>";
  select.disabled = true;

  try {
    const res = await fetch(LOAD_WARTUNGSELEMENTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    const data = await res.json();

    if (!data.ok || !Array.isArray(data.items)) {
      throw new Error("Ungültige Antwort");
    }

    select.innerHTML = "<option value=''>– bitte wählen –</option>";

    data.items.forEach(item => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.bezeichnung || "Ohne Bezeichnung";
      select.appendChild(opt);
    });

    select.disabled = false;

  } catch (err) {
    console.error("Wartungselemente laden fehlgeschlagen:", err);
    select.innerHTML = "<option value=''>❌ Fehler beim Laden</option>";
  }
}

// =====================================
// UI HELPERS
// =====================================
function clearAll() {
  ["stadtSelect", "centerSelect", "automatSelect"].forEach(id => {
    if ($(id)) {
      $(id).innerHTML = "<option>–</option>";
      $(id).disabled = true;
    }
  });
}

function fill(id, items) {
  const el = $(id);
  el.innerHTML = "<option>– wählen –</option>";
  items.forEach(v => el.innerHTML += `<option>${v}</option>`);
}

function enable(id) {
  if ($(id)) $(id).disabled = false;
}

function disableAll() {
  ["stadtSelect", "centerSelect", "automatSelect"].forEach(id => {
    if ($(id)) $(id).disabled = true;
  });
}
