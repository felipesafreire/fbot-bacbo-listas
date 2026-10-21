/* ==========================================================================
   BacList — popup.js
   ========================================================================== */

"use strict";

/* ========== Estado ========== */
const state = {
  selectedTarget: null,
  tieProtection: false,
  autoMode: false,
  autoTimer: null,
  betCount: 0,
  wins: 0,
  losses: 0,
  totalPnl: 0,
  historyReds: 0,
  history: [],
  galeMode: 0, // 0 = sem gale | 1..10 = quantidade de gales
  galeStep: 0, // passo atual (0 = entrada, 1..N = gale N)
  galeDouble: false, // false = valor fixo | true = dobrar a cada gale (cores, empate e proteção)
  galeModeType: "fixed", // fixed | double | custom
  galeCustomValues: {},
  tieGaleCustomValues: {},
  tieProtectCustomValues: {},
  tieGaleMode: 0, // gales para listas de empate (independente)
  patternGuard: PatternGuard.normalizeConfig(PatternGuard.DEFAULT_CONFIG),
  isPopout: false,
};

/* Histórico da road (evo) + aposta aguardando resultado da próxima rodada */
let _roadHistory = [];
let _pendingBet = null;
let _lastTieSecoSig = null;
let _tieSecoBusy = false;
let _lastRoadSig = null;
let _historyPollTimer = null;
let _historyKeepAlivePort = null;
let _patternDraft = [];
const GALE_BET_DELAY_MS = 5000; // 5s: aguarda abertura das apostas após rodada encerrar
const HISTORY_POLL_MS = 2500;

const ROAD_COLOR_NAMES = { A: "Azul", V: "Vermelho", T: "Empate" };
const ROAD_COLOR_SPOT = { A: "Player", V: "Banker", T: "Tie" };
const TARGET_LABELS = { A: "Azul/Player", V: "Vermelho/Banker", T: "Empate" };

/* ========== Helpers ========== */
const $ = (id) => document.getElementById(id);

let _appInitialized = false;

/* ========== Monitor de Conexão ========== */
const _CONN_PING_URL = "https://www.google.com/favicon.ico";
const _CONN_PING_INTERVAL = 10000;
const _CONN_PING_TIMEOUT = 4000;
const _CONN_RTT_THRESHOLD = 600;

let _connMonitorTimer = null;

async function _measureLatency() {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), _CONN_PING_TIMEOUT);
  try {
    const t = Date.now();
    await fetch(_CONN_PING_URL, {
      cache: "no-store",
      mode: "no-cors",
      signal: ctrl.signal,
    });
    return Date.now() - t;
  } catch (_) {
    return Infinity;
  } finally {
    clearTimeout(tid);
  }
}

function _isConnectionTypePoor() {
  const conn = navigator.connection;
  if (!conn) return false;
  return ["slow-2g", "2g"].includes(conn.effectiveType);
}

function _setConnectionOverlay(poor, latency) {
  const overlay = $("connectionOverlay");
  const latEl = $("connectionLatency");
  if (!overlay) return;
  if (poor) {
    if (latEl)
      latEl.textContent = isFinite(latency) ? latency + "ms" : "Timeout";
    overlay.style.display = "flex";
  } else {
    overlay.style.display = "none";
  }
}

async function _checkConnection() {
  const typePoor = _isConnectionTypePoor();
  const latency = await _measureLatency();
  _setConnectionOverlay(typePoor || latency > _CONN_RTT_THRESHOLD, latency);
}

function startConnectionMonitor() {
  _checkConnection();
  _connMonitorTimer = setInterval(_checkConnection, _CONN_PING_INTERVAL);
  if (navigator.connection) {
    navigator.connection.addEventListener("change", _checkConnection);
  }
}

function initApp() {
  if (_appInitialized) return;
  _appInitialized = true;

  detectPopout();
  loadConfig();
  loadHistory();
  bindTabs();
  bindTargetButtons();
  bindTieProtection();
  initCurrencyInputs();
  bindGaleSelector();
  bindMainControls();
  bindConfigControls();
  bindPatternGuardControls();
  bindHistoryControls();
  bindPopout();
  updateUI();
  startConnectionMonitor();

  Strategies.init();
  onScheduleTypeChanged("none");

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "historyUpdate") {
      applyLiveHistory(msg.history || []);
    }
    if (msg.action === "historyStatus" && !msg.ok) {
      showHistoryStatus(msg.error || "Histórico indisponível");
    }
  });

  Strategies.startMonitor().then(() => {
    startPopupHistoryPolling();
  });
}

/* ========== Init ========== */
document.addEventListener("DOMContentLoaded", () => {
  $("loginForm")?.addEventListener("submit", onLoginSubmit);
  $("logoutBtn")?.addEventListener("click", onLogout);
  bootAuth();
});

function showAuthScreen(message) {
  const screen = $("loginScreen");
  if (screen) screen.hidden = false;
  const logoutBtn = $("logoutBtn");
  const headerUser = $("headerUser");
  if (logoutBtn) logoutBtn.hidden = true;
  if (headerUser) headerUser.hidden = true;
  const err = $("authError");
  if (!err) return;
  if (message) {
    err.textContent = message;
    err.hidden = false;
  } else {
    err.textContent = "";
    err.hidden = true;
  }
}

function hideAuthScreen() {
  const screen = $("loginScreen");
  if (screen) screen.hidden = true;
  const name = BacListAuth.username();
  const headerUser = $("headerUser");
  const logoutBtn = $("logoutBtn");
  if (headerUser) {
    headerUser.textContent = name;
    headerUser.hidden = name === "";
  }
  if (logoutBtn) logoutBtn.hidden = false;
}

function onAuthLost(message) {
  if (state.autoMode) toggleAutoMode();
  showAuthScreen(message);
}

async function enterApp() {
  hideAuthScreen();
  chrome.storage.local.set({ autoModeActive: false });
  chrome.runtime
    .sendMessage({ action: "setAutomationRunning", active: false })
    .catch(() => {});
  initApp();
  BacListAuth.startHeartbeat(() => state.autoMode, onAuthLost);
}

async function bootAuth() {
  chrome.runtime
    .sendMessage({ action: "setAutomationRunning", active: false })
    .catch(() => {});
  const ok = await BacListAuth.restore();
  if (!ok) {
    showAuthScreen(BacListAuth.takeNotice());
    return;
  }
  await enterApp();
}

function setLoginBusy(busy) {
  const btn = $("loginBtn");
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy
    ? "Entrando…"
    : '<i class="fas fa-sign-in-alt"></i> Entrar';
}

async function onLoginSubmit(event) {
  event.preventDefault();
  const username = $("authUsername")?.value.trim();
  const password = $("authPassword")?.value || "";
  if (!username || !password) {
    showAuthScreen("Preencha usuário e senha.");
    return;
  }
  setLoginBusy(true);
  try {
    await BacListAuth.login(username, password);
    $("authPassword").value = "";
    await enterApp();
  } catch (err) {
    showAuthScreen(err.message || "Não foi possível entrar.");
  } finally {
    setLoginBusy(false);
  }
}

async function onLogout() {
  if (state.autoMode) toggleAutoMode();
  await BacListAuth.logout();
  showAuthScreen("");
}

function tieDuploSecoAmount() {
  return readCurrencyInput("tieDuploSecoChip");
}

function updateTieDuploSecoHint() {
  const hint = $("tieDuploSecoHint");
  if (!hint) return;
  hint.textContent = `Entra ${formatCurrency(tieDuploSecoAmount())} só no empate, sem gale.`;
}

function maybeBetTieDuploSeco(road, galeInfo) {
  if (!$("tieDuploSeco")?.checked || !state.autoMode || !road?.length) return;
  const sig = _roadSig(road);
  if (_lastTieSecoSig === null) {
    _lastTieSecoSig = sig;
    return;
  }
  if (sig === _lastTieSecoSig || _tieSecoBusy) return;
  _lastTieSecoSig = sig;
  if (road[road.length - 1]?.cor !== "T") return;
  if (_pendingBet?.awaiting || galeInfo?.galeScheduled) return;

  _tieSecoBusy = true;
  Promise.resolve(
    executeBet("T", { tieSeco: true, amount: tieDuploSecoAmount() }),
  ).finally(() => {
    _tieSecoBusy = false;
  });
}

function applyLiveHistory(road) {
  const galeInfo = handleRoadHistoryForGale(road);
  const roundInfo = Strategies.onHistoryUpdate(road);
  _roadHistory = road;
  logRoundDebug(road, roundInfo, galeInfo);
  renderLiveHistory(road);
  maybeBetTieDuploSeco(road, galeInfo);
}

function showHistoryStatus(message) {
  const hint = `<span class="monitor-hint">${message}</span>`;
  const empty = `<span class="live-history-empty">${message}</span>`;
  const preview = $("monitorHistoryPreview");
  const live = $("liveHistoryBalls");
  if (preview) preview.innerHTML = hint;
  if (live) live.innerHTML = empty;
}

function connectHistoryKeepAlive() {
  try {
    _historyKeepAlivePort?.disconnect();
    _historyKeepAlivePort = chrome.runtime.connect({ name: "baclist-popup" });
    _historyKeepAlivePort.onDisconnect.addListener(() => {
      _historyKeepAlivePort = null;
    });
  } catch (_) {
    _historyKeepAlivePort = null;
  }
}

async function pollLiveHistoryOnce() {
  try {
    const r = await chrome.runtime.sendMessage({ action: "fetchLiveHistory" });
    if (r?.history?.length) {
      applyLiveHistory(r.history);
      return;
    }
    if (r?.error) showHistoryStatus(r.error);
  } catch (err) {
    console.warn("[BacList] pollLiveHistoryOnce:", err?.message || err);
    showHistoryStatus("Erro ao ler histórico — recarregue a extensão.");
  }
}

function startPopupHistoryPolling() {
  stopPopupHistoryPolling();
  connectHistoryKeepAlive();
  pollLiveHistoryOnce();
  _historyPollTimer = setInterval(pollLiveHistoryOnce, HISTORY_POLL_MS);
}

function stopPopupHistoryPolling() {
  if (_historyPollTimer) {
    clearInterval(_historyPollTimer);
    _historyPollTimer = null;
  }
  if (_historyKeepAlivePort) {
    _historyKeepAlivePort.disconnect();
    _historyKeepAlivePort = null;
  }
}

window.addEventListener("beforeunload", stopPopupHistoryPolling);

/* ========== Pop-out ========== */
function detectPopout() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("popout") === "1") {
    state.isPopout = true;
    document.body.classList.add("is-popout");
    const btn = $("btnPopout");
    if (btn) {
      btn.innerHTML = '<i class="fas fa-compress-alt"></i>';
      btn.title = "Esta janela já está destacada";
      btn.disabled = true;
      btn.style.opacity = "0.4";
      btn.style.cursor = "default";
    }
  }
}

function bindPopout() {
  const btn = $("btnPopout");
  if (!btn || state.isPopout) return;
  btn.addEventListener("click", async () => {
    try {
      const r = await chrome.runtime.sendMessage({
        action: "openPopoutWindow",
      });
      if (r?.success) {
        showToast(
          r.focused ? "Janela flutuante em foco" : "Janela flutuante aberta",
          "info",
        );
      } else {
        showToast(r?.error || "Não foi possível abrir a janela", "error");
      }
    } catch (err) {
      showToast("Erro ao abrir janela flutuante", "error");
    }
  });
}

/* ========== Tabs ========== */
function bindTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".tab-content")
        .forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      $("tab-" + btn.dataset.tab).classList.add("active");
    });
  });
}

/* ========== Target Buttons ========== */
function bindTargetButtons() {
  // Alvo agora vem da estratégia detectada — sem seleção manual
}

/* ========== Tie Protection ========== */
function bindTieProtection() {
  const toggle = $("tieProtection");
  const row = $("tieValueRow");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    state.tieProtection = toggle.checked;
    row.style.display = toggle.checked ? "flex" : "none";
    _renderTieProtectPreview();
    saveConfig();
  });
}

/* ========== Gale Selector ========== */
function bindGaleSelector() {
  // Input numérico de quantidade de gale (cores)
  $("galeCountInput")?.addEventListener("change", () => {
    const v = Math.min(
      10,
      Math.max(0, parseInt($("galeCountInput").value) || 0),
    );
    $("galeCountInput").value = v;
    setGaleMode(v);
    saveConfig();
  });
  $("galeCountInput")?.addEventListener("input", () => {
    const v = Math.min(
      10,
      Math.max(0, parseInt($("galeCountInput").value) || 0),
    );
    setGaleMode(v);
  });

  // Toggle Fixo/Dobrar/Personalizado — único, aplica para cores, empate e proteção de empate
  $("galeModeToggle")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".gmt-btn");
    if (!btn) return;
    setGaleModeType(btn.dataset.mode || (btn.dataset.val === "true" ? "double" : "fixed"));
    saveConfig();
  });

  document.addEventListener("input", (e) => {
    if (e.target?.classList?.contains("gale-custom-input")) {
      const digits = (e.target.value || "").replace(/\D/g, "");
      e.target.value = digits;
      e.target.dataset.rawValue = digits;
    }
  });

  document.addEventListener("focusin", (e) => {
    if (e.target?.classList?.contains("gale-custom-input")) {
      e.target.value = e.target.dataset.rawValue || "";
      e.target.select();
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target?.classList?.contains("gale-custom-input")) {
      _saveCustomGaleInput(e.target);
      saveConfig();
    }
  });

  document.addEventListener("focusout", (e) => {
    if (e.target?.classList?.contains("gale-custom-input")) {
      _saveCustomGaleInput(e.target);
      saveConfig();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target?.classList?.contains("gale-custom-input") && e.key === "Enter") {
      e.target.blur();
    }
  });

  // Input numérico de quantidade de gale (empate)
  $("tieGaleCountInput")?.addEventListener("change", () => {
    const v = Math.min(
      10,
      Math.max(0, parseInt($("tieGaleCountInput").value) || 0),
    );
    $("tieGaleCountInput").value = v;
    setTieGaleMode(v);
    saveConfig();
  });
  $("tieGaleCountInput")?.addEventListener("input", () => {
    const v = Math.min(
      10,
      Math.max(0, parseInt($("tieGaleCountInput").value) || 0),
    );
    setTieGaleMode(v);
  });
}

function normalizeGaleModeType(mode) {
  return ["fixed", "double", "custom"].includes(mode) ? mode : "fixed";
}

function setGaleModeType(mode) {
  state.galeModeType = normalizeGaleModeType(mode);
  state.galeDouble = state.galeModeType === "double";
  _updateGaleModeToggle("galeModeToggle", state.galeModeType);
  _renderGalePreview();
  _renderTieGalePreview();
  _renderTieProtectPreview();
}

function _updateGaleModeToggle(toggleId, modeOrDouble) {
  const toggle = $(toggleId);
  if (!toggle) return;
  const mode =
    typeof modeOrDouble === "boolean"
      ? modeOrDouble
        ? "double"
        : "fixed"
      : normalizeGaleModeType(modeOrDouble);
  toggle.querySelectorAll(".gmt-btn").forEach((btn) => {
    const btnMode =
      btn.dataset.mode || (btn.dataset.val === "true" ? "double" : "fixed");
    btn.classList.toggle("gmt-active", btnMode === mode);
  });
}

function setGaleMode(gale) {
  state.galeMode = Math.min(10, Math.max(0, gale));
  state.galeStep = 0;
  if ($("galeCountInput")) $("galeCountInput").value = state.galeMode;
  _renderGalePreview();
  _renderTieProtectPreview();
}

function setTieGaleMode(gale) {
  state.tieGaleMode = Math.min(10, Math.max(0, gale));
  state.galeStep = 0;
  if ($("tieGaleCountInput")) $("tieGaleCountInput").value = state.tieGaleMode;
  _renderTieGalePreview();
}

function _customValueMap(kind) {
  if (kind === "tie") return state.tieGaleCustomValues;
  if (kind === "tieProtect") return state.tieProtectCustomValues;
  return state.galeCustomValues;
}

function _defaultCustomValue(step, base) {
  return Math.max(snapTo5(base * Math.pow(2, step)), 5);
}

function _customAmountForStep(step, base, kind) {
  if (step === 0) return base;
  const map = _customValueMap(kind);
  const value = Number(map?.[step]);
  return value > 0 ? Math.max(snapTo5(value), 5) : _defaultCustomValue(step, base);
}

function _renderCustomGaleInputs(boxId, gridId, kind, count, base) {
  const box = $(boxId);
  const grid = $(gridId);
  if (!box || !grid) return;

  if (state.galeModeType !== "custom" || count <= 0) {
    box.style.display = "none";
    grid.innerHTML = "";
    return;
  }

  box.style.display = "block";
  grid.innerHTML = Array.from({ length: count }, (_, index) => {
    const step = index + 1;
    const value = _customAmountForStep(step, base, kind);
    return `
      <label class="gale-custom-field">
        <span>G${step}</span>
        <input type="text" class="gale-custom-input" inputmode="numeric" data-kind="${kind}" data-step="${step}" data-raw-value="${value}" value="${formatCurrency(value)}" />
      </label>
    `;
  }).join("");
}

function _saveCustomGaleInput(input) {
  const kind = input.dataset.kind || "color";
  const step = parseInt(input.dataset.step, 10);
  if (!step) return;
  const value = Math.max(snapTo5(input.dataset.rawValue || input.value), 5);
  _customValueMap(kind)[step] = value;
  input.dataset.rawValue = value;
  input.value = formatCurrency(value);
  _renderGalePreview();
  _renderTieGalePreview();
  _renderTieProtectPreview();
}

function _renderGalePreview() {
  const preview = $("galePreview");
  if (!preview) return;

  const base = readCurrencyInput("betAmount");
  const n = state.galeMode;
  const mode = state.galeModeType;

  if (n === 0) {
    preview.innerHTML =
      '<span class="gale-preview-none">Sem gale — uma tentativa.</span>';
    _renderCustomGaleInputs("galeCustomBox", "galeCustomGrid", "color", 0, base);
    return;
  }

  let html = '<div class="gale-preview-list">';
  for (let i = 0; i <= n; i++) {
    const val = getAmountForStep(i, base, mode, state.galeCustomValues);
    const label = i === 0 ? "Entrada" : `${i}º Gale`;
    html += `<span class="gale-preview-step"><span class="gpv-label">${label}</span><span class="gpv-value">${formatCurrency(val)}</span></span>`;
  }
  html += "</div>";
  preview.innerHTML = html;
  _renderCustomGaleInputs("galeCustomBox", "galeCustomGrid", "color", n, base);
}

function _renderTieGalePreview() {
  const preview = $("tieGalePreview");
  if (!preview) return;

  const base = readCurrencyInput("tieEntryAmount");
  const n = state.tieGaleMode;
  const mode = state.galeModeType;

  if (n === 0) {
    preview.innerHTML =
      '<span class="gale-preview-none">Sem gale — uma tentativa.</span>';
    _renderCustomGaleInputs("tieGaleCustomBox", "tieGaleCustomGrid", "tie", 0, base);
    return;
  }

  let html = '<div class="gale-preview-list">';
  for (let i = 0; i <= n; i++) {
    const val = getAmountForStep(i, base, mode, state.tieGaleCustomValues);
    const label = i === 0 ? "Entrada" : `${i}º Gale`;
    html += `<span class="gale-preview-step"><span class="gpv-label">${label}</span><span class="gpv-value">${formatCurrency(val)}</span></span>`;
  }
  html += "</div>";
  preview.innerHTML = html;
  _renderCustomGaleInputs("tieGaleCustomBox", "tieGaleCustomGrid", "tie", n, base);
}

function _renderTieProtectPreview() {
  const preview = $("tieProtectPreview");
  if (!preview) return;

  if (!$("tieProtection")?.checked) {
    _renderCustomGaleInputs("tieProtectCustomBox", "tieProtectCustomGrid", "tieProtect", 0, readCurrencyInput("tieAmount"));
    return;
  }

  const base = readCurrencyInput("tieAmount");
  const n = state.galeMode;
  const mode = state.galeModeType;

  if (n === 0) {
    preview.innerHTML = mode === "double"
      ? `<span class="gale-preview-none">Empate: ${formatCurrency(base)} (sem gales configurados).</span>`
      : '<span class="gale-preview-none">Mesmo valor em todos os gales.</span>';
    _renderCustomGaleInputs("tieProtectCustomBox", "tieProtectCustomGrid", "tieProtect", 0, base);
    return;
  }

  let html = '<div class="gale-preview-list">';
  for (let i = 0; i <= n; i++) {
    const val = getAmountForStep(i, base, mode, state.tieProtectCustomValues);
    const label = i === 0 ? "Entrada" : `${i}º Gale`;
    html += `<span class="gale-preview-step"><span class="gpv-label">${label}</span><span class="gpv-value">${formatCurrency(val)}</span></span>`;
  }
  html += "</div>";
  preview.innerHTML = html;
  _renderCustomGaleInputs("tieProtectCustomBox", "tieProtectCustomGrid", "tieProtect", n, base);
}

/* ========== Máscara de valor — aceita qualquer inteiro >= 1 ========== */

function snapAmount(raw) {
  const n = parseInt(String(raw).replace(/\D/g, ""), 10) || 0;
  return Math.max(n, 1);
}

// Mantido por compatibilidade (fichas do jogo são múltiplas de 5)
function snapTo5(raw) {
  const n = parseInt(String(raw).replace(/\D/g, ""), 10) || 0;
  const snapped = Math.floor(n / 5) * 5;
  return Math.max(snapped, 5);
}

// Formata número inteiro como "R$ 1.250"
function formatCurrency(n) {
  return "R$ " + Number(n).toLocaleString("pt-BR");
}

function formatSignedCurrency(n) {
  const value = Number(n) || 0;
  const prefix = value < 0 ? "-" : "";
  return `${prefix}${formatCurrency(Math.abs(value))}`;
}

// Lê o valor numérico de um input — múltiplo de 5, mínimo 5
function readCurrencyInput(id) {
  const el = $(id);
  if (!el) return 5;
  const raw = (el.dataset.rawValue || el.value || "").replace(/\D/g, "");
  const n = parseInt(raw, 10) || 0;
  return Math.max(snapTo5(n), 5);
}

// Aplica máscara num input — valores de entrada são múltiplos de 5 (mínimo 5)
function applyCurrencyMask(input) {
  const v = snapTo5(input.value);
  input.value = formatCurrency(v);
  input.dataset.rawValue = v;
}

// Inicializa todos os inputs de moeda
function initCurrencyInputs() {
  document.querySelectorAll(".currency-input").forEach((input) => {
    const initial = snapTo5(parseInt(input.value, 10) || 5);
    input.value = formatCurrency(initial);
    input.dataset.rawValue = initial;

    input.addEventListener("focus", () => {
      input.value = input.dataset.rawValue || "";
      input.select();
    });

    input.addEventListener("input", () => {
      const digits = input.value.replace(/\D/g, "");
      input.value = digits;
      input.dataset.rawValue = digits || "";
    });

    input.addEventListener("blur", () => {
      applyCurrencyMask(input);
      saveConfig();
      if (typeof _renderGalePreview === "function") _renderGalePreview();
      if (typeof _renderTieGalePreview === "function") _renderTieGalePreview();
      if (typeof _renderTieProtectPreview === "function")
        _renderTieProtectPreview();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        applyCurrencyMask(input);
        input.blur();
      }
    });
  });
}

/* ========== Schedule Type → mostrar/ocultar cards de apostas ========== */
function onScheduleTypeChanged(type) {
  const noList = $("betNoList");
  const cardColor = $("cardColorBet");
  const cardTie = $("cardTieBet");
  const cardDoubleGlobal = $("cardGaleDoubleGlobal");
  const galeCountRow = $("galeCountRow");
  const tieGaleCountRow = $("tieGaleCountRow");

  const showColor = type === "color" || type === "mixed";
  const showTie = type === "tie" || type === "mixed";
  const showNone = type === "none";
  const showDouble = showColor || showTie;

  if (noList) noList.style.display = showNone ? "block" : "none";
  if (cardColor) cardColor.style.display = showColor ? "block" : "none";
  if (cardTie) cardTie.style.display = showTie ? "block" : "none";
  if (cardDoubleGlobal)
    cardDoubleGlobal.style.display = showDouble ? "block" : "none";
  if (galeCountRow) galeCountRow.style.display = showColor ? "block" : "none";
  if (tieGaleCountRow)
    tieGaleCountRow.style.display = showTie ? "block" : "none";
}

/* ========== Gale Step Label ========== */
function galeStepLabel(step) {
  if (step === 0) return "Entrada";
  return `${step}º Gale`;
}

/* ========== Calcula valor de aposta para o passo atual ========== */
function getAmountForStep(step, base, mode = state.galeModeType, customValues = {}) {
  if (step === 0) return base;
  if (mode === "custom") {
    const value = Number(customValues?.[step]);
    return value > 0 ? Math.max(snapTo5(value), 5) : _defaultCustomValue(step, base);
  }
  if (mode !== "double") return base;
  return Math.max(snapTo5(base * Math.pow(2, step)), 5);
}

function getBetAmountForStep(step, isTie) {
  const baseId = isTie ? "tieEntryAmount" : "betAmount";
  const base = readCurrencyInput(baseId);
  const customValues = isTie ? state.tieGaleCustomValues : state.galeCustomValues;
  return getAmountForStep(step, base, state.galeModeType, customValues);
}

function getTieProtectAmountForStep(step) {
  return getAmountForStep(
    step,
    readCurrencyInput("tieAmount"),
    state.galeModeType,
    state.tieProtectCustomValues,
  );
}

/* ========== Main Controls ========== */
function bindMainControls() {
  $("btnAuto").addEventListener("click", toggleAutoMode);
  $("bettingHouse")?.addEventListener("change", saveConfig);
  $("chipProfile")?.addEventListener("change", saveConfig);
}

/* ========== Auto Mode ========== */
function toggleAutoMode() {
  state.autoMode = !state.autoMode;
  const btn = $("btnAuto");
  const label = $("autoLabel");

  if (state.autoMode) {
    btn.classList.add("active");
    label.textContent = "Parar Automação";
    setStatus("auto", "Rodando", "#63b3ed");
    showToast("Automação iniciada — monitorando estratégias", "info");
    chrome.runtime.sendMessage(
      { action: "setAutomationRunning", active: true },
      () => Strategies.setAutoEnabled(true),
    );
  } else {
    btn.classList.remove("active");
    label.textContent = "Iniciar Automação";
    setStatus("", "Inativo", "");
    clearTimeout(state.autoTimer);
    state.autoTimer = null;
    _pendingBet = null;
    showToast("Automação parada", "info");
    chrome.runtime.sendMessage(
      { action: "setAutomationRunning", active: false },
      () => Strategies.setAutoEnabled(false),
    );
  }
}

function setStatus(dotClass, text) {
  const dot = $("statusDot");
  const lbl = $("statusLabel");
  const ribbon = $("statusRibbon");
  dot.className = "status-dot" + (dotClass ? " " + dotClass : "");
  lbl.textContent = text;
  lbl.style.color = "";
  ribbon?.classList.toggle("active", !!dotClass);
}

/* ========== Histórico — sincronia aposta × rodada (~30–40s por rodada) ========== */

/**
 * Assinatura das últimas N cores do histórico.
 * Independe do tamanho total: resets, truncagens ou crescimentos são
 * detectados da mesma forma — o que importa é a sequência de cores.
 */
const ROAD_SIG_WINDOW = 50;

function _roadSig(road) {
  if (!road?.length) return "";
  return road
    .slice(-ROAD_SIG_WINDOW)
    .map((r) => r.cor)
    .join("");
}

async function _fetchFreshRoadHistory() {
  try {
    const r = await chrome.runtime.sendMessage({ action: "fetchLiveHistory" });
    if (r?.history?.length) return r.history;
  } catch (e) {
    console.warn("[BacList] fetchFreshRoadHistory:", e?.message || e);
  }
  return _roadHistory;
}

/**
 * Retorna a cor da rodada pendente ou null se ainda aguardando.
 *
 * Compara as últimas 50 cores atuais (curSig) com a assinatura gravada
 * no momento da aposta (betSig50). Se mudou → nova rodada ocorreu.
 *
 * Isso torna o reset do bead-road invisível para a lógica: não importa
 * se o histórico foi de 131 para 120 ou para 50 — a janela de 50 cores
 * reflete o estado real independentemente do tamanho total.
 */
function _peekPendingResultCor(road) {
  if (!_pendingBet?.awaiting || !road?.length) return null;

  const curSig = _roadSig(road);
  const baseSig = _pendingBet.betSig50;

  // Aguarda o histórico resetado crescer até ter ao menos a janela completa
  if (curSig.length < baseSig.length && road.length < ROAD_SIG_WINDOW)
    return null;

  if (curSig === baseSig) return null; // nenhuma rodada nova

  console.log("[BacList] Nova rodada detectada via sig50", {
    base: baseSig.slice(-10),
    atual: curSig.slice(-10),
    roadLen: road.length,
  });

  return road[road.length - 1].cor;
}

function _makeGaleInfoBase() {
  return {
    hadPendingBet: !!_pendingBet?.awaiting,
    resolved: false,
    won: null,
    betTarget: _pendingBet?.colorTarget ?? null,
    galeStepAtBet: _pendingBet?.galeStep ?? null,
    galeScheduled: false,
    resultCor: null,
  };
}

function _normalizeTieMultiplier(value) {
  const n = Number(String(value || "").replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function _tiePayoutMultiplier(value) {
  const n = _normalizeTieMultiplier(value);
  const table = [88, 25, 10, 6, 4];
  if (table.includes(n)) return n;
  return 4;
}

function countHistoryReds(history = state.history) {
  return (history || []).filter((entry) => entry?.result === "loss").length;
}

function skipG1SequenceLength() {
  const n = parseInt($("skipG1SequenceLength")?.value, 10);
  if (!Number.isFinite(n)) return 3;
  return Math.min(8, Math.max(2, n));
}

function sequenceBlocksG1(road, target) {
  if (!$("patternGuardEnabled")?.checked) return null;
  if (!$("skipG1OnSequence")?.checked || target === "T") return null;
  if (typeof PatternGuard === "undefined") return null;
  return PatternGuard.blocksOppositeSequence(road, target, {
    enabled: true,
    strongSequence: true,
    strongSequenceLength: skipG1SequenceLength(),
  });
}

function _processPendingBetResult(road, resultCor, info) {
  const betTarget = _pendingBet.colorTarget;
  const galeStepAtBet = _pendingBet.galeStep;
  const isTieEntry = betTarget === "T";
  const maxGale = _pendingBet.tieSeco
    ? 0
    : isTieEntry
      ? state.tieGaleMode
      : state.galeMode;
  const hasTieProtection = _pendingBet.tieAmount > 0;
  const latestRound = road?.[road.length - 1] || {};
  const tieMultiplier =
    resultCor === "T" ? _tiePayoutMultiplier(latestRound.tieMultiplier) : null;
  const won =
    resultCor === betTarget ||
    (!isTieEntry && hasTieProtection && resultCor === "T");

  _pendingBet.awaiting = false;

  info.resolved = true;
  info.resultCor = resultCor;
  info.won = won;
  info.tieMultiplier = tieMultiplier;

  if (won) {
    state.galeStep = 0;
    finalizePendingBet("win", resultCor, { tieMultiplier });
    checkStopConditions();
    if (typeof Strategies !== "undefined" && Strategies.signalGreen) {
      Strategies.signalGreen(galeStepAtBet);
    }
    showToast(`Green — ${ROAD_COLOR_NAMES[resultCor] || resultCor}`, "success");
    _pendingBet = null;
    return info;
  }

  const lossEntry = finalizePendingBet("loss", resultCor, { tieMultiplier });

  const stepStake =
    (_pendingBet?.mainAmount || 0) + (_pendingBet?.tieAmount || 0);
  state.totalPnl -= stepStake;
  if (lossEntry) {
    lossEntry.pnl = -stepStake;
    lossEntry.balance = state.totalPnl;
    saveHistory();
    renderHistory();
  }
  updateUI();
  saveStats();

  if (checkStopConditions()) {
    state.galeStep = 0;
    _pendingBet = null;
    return info;
  }

  let g1Blocked = null;
  if (galeStepAtBet === 0 && galeStepAtBet < maxGale) {
    g1Blocked = sequenceBlocksG1(road, betTarget);
  }

  const shouldGale = galeStepAtBet < maxGale && !g1Blocked;

  if (shouldGale) {
    state.galeStep = galeStepAtBet + 1;
    info.galeScheduled = true;
    if (typeof Strategies !== "undefined" && Strategies.signalGale) {
      Strategies.signalGale(state.galeStep);
    }
    showToast(
      `Loss — ${galeStepLabel(state.galeStep)} em ${GALE_BET_DELAY_MS / 1000}s`,
      "info",
    );
    _pendingBet = null;
    setTimeout(
      () => executeBet(betTarget, { fromGale: true }),
      GALE_BET_DELAY_MS,
    );
    return info;
  }

  state.galeStep = 0;
  state.losses++;

  if (typeof Strategies !== "undefined" && Strategies.signalLoss) {
    Strategies.signalLoss(galeStepAtBet + 1);
  }
  showToast(
    g1Blocked
      ? `G1 cancelado — ${g1Blocked.reason}`
      : "Loss — sequência encerrada",
    g1Blocked ? "info" : "error",
  );
  _pendingBet = null;
  return info;
}

/* ========== Execute Bet (chamado pela engine de estratégias) ==========
   1ª entrada: seleciona ficha + clica spot (fluxo normal).
   Gales: usa repeat-button [+ double-button] — sem re-selecionar ficha ou spot. */
async function executeBet(colorTarget, options = {}) {
  const {
    fromGale = false,
    resetGale = false,
    forceEntry = false,
    tieSeco = false,
  } = options;

  if (!state.autoMode) return;
  if (!BacListAuth.isLoggedIn()) return;
  if (checkStopConditions()) return;

  if (resetGale && !fromGale) {
    if (_pendingBet?.awaiting) {
      console.warn(
        "[BacList] Nova entrada programada — encerrando sequência/gale anterior",
      );
      const prevKey = _pendingBet.scheduleKey;
      if (
        prevKey &&
        typeof Strategies !== "undefined" &&
        Strategies.abortSlot
      ) {
        Strategies.abortSlot(prevKey);
      }
      _pendingBet = null;
    }
    state.galeStep = 0;
  }

  // forceEntry ignora aposta pendente anterior (nova entrada programada tem prioridade)
  if (_pendingBet?.awaiting && !forceEntry) return;

  const internalMap = { A: "player", V: "banker", T: "tie" };
  const spotMap = { A: "Player", V: "Banker", T: "Tie" };
  const target = internalMap[colorTarget] || colorTarget;
  const spot = spotMap[colorTarget] || colorTarget;
  const isTieEntry = colorTarget === "T" || target === "tie";
  const galeStep = tieSeco ? 0 : state.galeStep;
  const isGale = !tieSeco && fromGale && galeStep > 0;

  const mainAmount = tieSeco
    ? Math.max(snapTo5(options.amount), 5)
    : getBetAmountForStep(galeStep, isTieEntry);
  const tieProtect =
    !tieSeco && !isTieEntry && ($("tieProtection")?.checked || false);
  const tieAmount = tieProtect ? getTieProtectAmountForStep(galeStep) : 0;
  const selectors = getSelectors();

  const preSig = _roadSig(_roadHistory);

  try {
    const { tabId } = await chrome.runtime.sendMessage({
      action: "getActiveTabId",
    });

    let result;
    const isCustomGale = isGale && state.galeModeType === "custom";
    if (isGale && !isCustomGale) {
      // Gale fixo/dobrar: repeat-button (+ double-button se modo dobrar ativo)
      result = await chrome.runtime.sendMessage({
        action: "repeatBetIframe",
        tabId: tabId || undefined,
        doDouble: state.galeDouble,
      });
    } else {
      // 1ª entrada ou gale personalizado: fluxo normal com fichas e spot
      result = await chrome.runtime.sendMessage({
        action: "placeBetIframe",
        tabId: tabId || undefined,
        mainAmount,
        tieAmount,
        target: spot,
        tieProtection: tieProtect,
        selectors,
        waitForChips: tieSeco,
      });
    }

    if (result?.success) {
      const road = await _fetchFreshRoadHistory();
      _roadHistory = road;
      const postSig = _roadSig(road);

      _pendingBet = {
        colorTarget,
        betSig50: postSig,
        galeStep,
        mainAmount,
        tieAmount: tieProtect ? tieAmount : 0,
        tieSeco,
        awaiting: true,
        scheduleKey:
          typeof Strategies !== "undefined" && Strategies.getActiveSlotKey
            ? Strategies.getActiveSlotKey()
            : null,
      };

      console.log("[BacList] Aposta executada", {
        alvo: TARGET_LABELS[colorTarget] || colorTarget,
        valor: mainAmount,
        empate: tieProtect ? tieAmount : 0,
        gale: galeStepLabel(galeStep),
        metodo: isGale
          ? isCustomGale
            ? "chip-spot-custom"
            : state.galeDouble
            ? "repeat+double"
            : "repeat"
          : "chip-spot",
        fromGale,
        postLen: road.length,
        betSig50_tail: postSig.slice(-10),
        plano: result.mainPlan,
        planoEmpate: result.tiePlan,
      });

      recordBet(target, mainAmount, tieProtect, tieAmount, "pending", galeStep);
      showLastBet(target, mainAmount, tieProtect, tieAmount, galeStep);

      const names = { player: "Jogador", banker: "Casa", tie: "Empate" };
      const galeMethodLabel =
        state.galeModeType === "custom"
          ? " (personalizado)"
          : state.galeDouble
            ? " (dobrar)"
            : " (repetir)";
      showToast(
        `${galeStepLabel(galeStep)}${isGale ? galeMethodLabel : ""}: ${formatCurrency(mainAmount)} em ${names[target] || target}` +
          (tieProtect ? ` + ${formatCurrency(tieAmount)} Emp.` : ""),
        "success",
      );

      if (!fromGale) {
        state.betCount++;
        const limit = parseInt($("betLimit")?.value) || 0;
        if (limit > 0 && state.betCount >= limit) {
          if (state.autoMode) toggleAutoMode();
          showToast(`Limite de ${limit} apostas atingido`, "info");
        }
      }

      if (postSig !== preSig) {
        const resultCor = road[road.length - 1]?.cor;
        if (resultCor) {
          console.warn(
            "[BacList] Histórico mudou durante o clique; mantendo aposta pendente",
            {
              preSig: preSig.slice(-10),
              postSig: postSig.slice(-10),
              resultCor,
            },
          );
          // A mudança ocorreu enquanto o clique era processado. O resultado válido
          // da aposta será somente a próxima rodada detectada pelo histórico.
        }
      }
    } else {
      console.warn("[BacList] Aposta falhou", {
        alvo: colorTarget,
        valor: mainAmount,
        erro: result?.error,
      });
      showToast(result?.error || "Não foi possível executar a aposta", "error");
    }
  } catch (err) {
    showToast("Erro: recarregue a página do jogo", "error");
    console.error("[BacList]", err);
  }
}

/* Próxima rodada no histórico = resultado da aposta pendente */
function handleRoadHistoryForGale(road) {
  const info = _makeGaleInfoBase();
  if (!info.hadPendingBet || !state.autoMode) return info;
  if (!road?.length) return info;

  const resultCor = _peekPendingResultCor(road);
  if (!resultCor) return info;

  return _processPendingBetResult(road, resultCor, info);
}

/* Debug: console do popup (clique direito no popup → Inspecionar) */
function logRoundDebug(road, roundInfo, galeInfo) {
  const last = road?.[road.length - 1];
  const sig = (road?.length || 0) + ":" + (last?.cor || "");

  if (_lastRoadSig === null) {
    _lastRoadSig = sig;
    console.log(`[BacList] Baseline: ${road?.length || 0} rodadas`);
    return;
  }
  if (sig === _lastRoadSig) return;
  _lastRoadSig = sig;

  const cor = last?.cor ?? "?";
  const sched = roundInfo?.schedule;
  const corNome = ROAD_COLOR_NAMES[cor] || cor;
  const autoStr = state.autoMode ? "ON" : "OFF";

  // Resultado da aposta
  let resultado = "";
  if (galeInfo.resolved) {
    const saiu = ROAD_COLOR_NAMES[galeInfo.resultCor] || galeInfo.resultCor;
    resultado = galeInfo.won ? `✅ GREEN (${saiu})` : `❌ LOSS (${saiu})`;
    if (galeInfo.galeScheduled)
      resultado += ` → ${galeStepLabel(state.galeStep)} em ${GALE_BET_DELAY_MS / 1000}s`;
  } else if (galeInfo.hadPendingBet) {
    resultado = "⏳ aguardando resultado";
  }

  // O que a automação fez
  let acao = "";
  if (sched?.betScheduled)
    acao = `🎯 Entrada agendada — ${galeStepLabel(0)} em 5s`;
  else if (sched?.betSkippedReason) acao = `— ${sched.betSkippedReason}`;
  else if (!roundInfo?.monitorOff && !sched?.hadActiveEntry)
    acao = "— sem horário ativo";

  const parts = [
    `[BacList] #${road?.length} | ${corNome} | Auto:${autoStr} | Passo:${state.galeStep}`,
    resultado && `  ${resultado}`,
    acao && `  ${acao}`,
  ].filter(Boolean);

  console.log(parts.join("\n"));
}

function calculateEntryPnl(entry, result, resultCor, meta = {}) {
  const amount = Number(entry?.amount || 0);
  const tieAmount = Number(entry?.tieAmount || 0);
  const targetCor = { player: "A", banker: "V", tie: "T" }[entry?.target] || entry?.target;
  const tieMultiplier = _tiePayoutMultiplier(meta.tieMultiplier);

  if (result === "loss") return -(amount + tieAmount);

  if (targetCor === "T") {
    return resultCor === "T" ? amount * tieMultiplier : -amount;
  }

  if (resultCor === targetCor) {
    return amount - tieAmount;
  }

  if (entry?.tieProtect && resultCor === "T") {
    return tieAmount * tieMultiplier;
  }

  return 0;
}

function finalizePendingBet(result, resultCor, meta = {}) {
  const entry = state.history.find((e) => e.result === "pending");
  if (entry) {
    entry.result = result;
    entry.resultCor = resultCor;
    if (meta.tieMultiplier) entry.tieMultiplier = meta.tieMultiplier;
    if (result === "win") {
      state.wins++;
      const entryPnl = calculateEntryPnl(entry, result, resultCor, meta);
      state.totalPnl += entryPnl;
      entry.pnl = entryPnl;
      entry.balance = state.totalPnl;
    } else if (result === "loss") {
      state.historyReds++;
    }
    saveHistory();
    renderHistory();
    updateUI();
    saveStats();
  }
  return entry || null;
}

function saveStats() {
  chrome.storage.local.set({
    bacboStats: {
      wins: state.wins,
      losses: state.losses,
      betCount: state.betCount,
      totalPnl: state.totalPnl,
      historyReds: state.historyReds,
    },
  });
}

/* ========== Stop Conditions ========== */
function checkStopConditions() {
  const stopLoss = parseFloat($("stopLoss")?.value) || 0;
  const stopWin = parseFloat($("stopWin")?.value) || 0;
  const stopRedHistory = parseInt($("stopRedHistory")?.value, 10) || 0;
  const redCount = countHistoryReds();
  state.historyReds = redCount;

  if (stopRedHistory > 0 && redCount >= stopRedHistory) {
    if (state.autoMode) toggleAutoMode();
    showToast(
      `Parou após ${redCount} reds no histórico (Entrada e Gales contam)`,
      "error",
    );
    return true;
  }

  if (stopLoss > 0 && state.totalPnl <= -stopLoss) {
    if (state.autoMode) toggleAutoMode();
    showToast(
      `Stop Loss atingido: R$ ${Math.abs(state.totalPnl).toFixed(2)}`,
      "error",
    );
    return true;
  }
  if (stopWin > 0 && state.totalPnl >= stopWin) {
    if (state.autoMode) toggleAutoMode();
    showToast(`Stop Win atingido: R$ ${state.totalPnl.toFixed(2)}`, "success");
    return true;
  }
  return false;
}

/* ========== Record Bet ========== */
function recordBet(
  target,
  amount,
  tieProtect,
  tieAmount,
  result,
  galeStep = 0,
) {
  const entry = {
    target,
    amount,
    tieProtect,
    tieAmount: tieProtect ? tieAmount : 0,
    result,
    galeStep,
    time: new Date().toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    ts: Date.now(),
  };
  state.history.unshift(entry);
  if (state.history.length > 50) state.history.pop();
  saveHistory();
  renderHistory();
}

function recordPatternRefund(colorTarget, match = {}) {
  const target = { A: "player", V: "banker", T: "tie" }[colorTarget] || colorTarget;
  const isTieEntry = colorTarget === "T" || target === "tie";
  const amount = getBetAmountForStep(0, isTieEntry);
  const entry = {
    target,
    amount,
    tieProtect: false,
    tieAmount: 0,
    result: "refund",
    galeStep: 0,
    pnl: 0,
    balance: state.totalPnl,
    refundReason: match.reason || "Entrada abortada pela proteção por padrão",
    patternRule: match.rule || null,
    patternSnapshot: match.snapshot || "",
    time: new Date().toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    ts: Date.now(),
  };

  state.history.unshift(entry);
  if (state.history.length > 50) state.history.pop();
  saveHistory();
  renderHistory();
  return entry;
}

/* ========== Show Last Bet ========== */
function showLastBet(target, amount, tieProtect, tieAmount, galeStep) {
  const info = $("lastBetInfo");
  const text = $("lastBetText");
  const names = { player: "Jogador", tie: "Empate", banker: "Casa" };
  let msg = `${galeStepLabel(galeStep)}: ${formatCurrency(amount)} em ${names[target] || target}`;
  if (tieProtect) msg += ` + ${formatCurrency(tieAmount)} Emp.`;
  text.textContent = msg;
  info.style.display = "block";
}

/* ========== Update UI ========== */
function updateUI() {
  $("statWins").textContent = state.wins;
  $("statLosses").textContent = state.losses;
  $("statTotal").textContent = state.betCount;
  const balanceEl = $("statBalance");
  if (balanceEl) {
    balanceEl.textContent = formatSignedCurrency(state.totalPnl);
    balanceEl.classList.toggle("text-green", state.totalPnl >= 0);
    balanceEl.classList.toggle("text-red", state.totalPnl < 0);
  }
}

/* ========== Status Label ========== */
function updateStatusLabel() {
  if (state.autoMode) return;
  setStatus("", "Inativo", "");
}

/* ========== Selectors ========== */
function getSelectors() {
  return {
    player: ($("selectorPlayer")?.value || "").trim(),
    tie: ($("selectorTie")?.value || "").trim(),
    banker: ($("selectorBanker")?.value || "").trim(),
    amount: ($("selectorAmount")?.value || "").trim(),
    confirm: ($("selectorConfirm")?.value || "").trim(),
  };
}

/* ========== Config Controls ========== */
function clampEntryLeadSeconds(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(60, Math.max(1, n));
}

function getEntryTimingMode() {
  return $("entryTimingMode")?.value === "before" ? "before" : "exact";
}

function getEntryLeadSeconds() {
  const el = $("entryLeadSeconds");
  const seconds = clampEntryLeadSeconds(el?.value);
  if (el) el.value = seconds;
  return seconds;
}

function updateEntryLeadVisibility() {
  const row = $("entryLeadSecondsRow");
  if (row) row.style.display = getEntryTimingMode() === "before" ? "block" : "none";
  getEntryLeadSeconds();
}

function syncEntryTimingStrategy() {
  if (typeof Strategies !== "undefined" && Strategies.setEntryTiming) {
    Strategies.setEntryTiming(getEntryTimingMode(), getEntryLeadSeconds());
  }
}

function patternDotHtml(color) {
  const isBlue = color === "A";
  return `<span class="pattern-dot ${isBlue ? "blue" : "red"}" title="${isBlue ? "Azul" : "Vermelho"}">${isBlue ? "A" : "V"}</span>`;
}

function readPatternGuardConfig() {
  state.patternGuard = PatternGuard.normalizeConfig({
    ...state.patternGuard,
    enabled: $("patternGuardEnabled")?.checked !== false,
    strongSequence: $("patternStrongSequence")?.checked !== false,
    strongSequenceLength: $("patternStrongSequenceLength")?.value,
    majorityThreeTwo: $("patternMajorityThreeTwo")?.checked !== false,
    majorityCount: $("patternMajorityCount")?.value,
    majorityWindow: $("patternMajorityWindow")?.value,
    alternating: $("patternAlternating")?.checked !== false,
    alternatingLength: $("patternAlternatingLength")?.value,
    recentBreak: $("patternRecentBreak")?.checked !== false,
    recentBreakLength: $("patternRecentBreakLength")?.value,
    recentBreakRounds: $("patternRecentBreakRounds")?.value,
  });
  return state.patternGuard;
}

function applyPatternGuardConfig(config) {
  state.patternGuard = PatternGuard.normalizeConfig(config);

  const values = {
    patternGuardEnabled: state.patternGuard.enabled,
    patternStrongSequence: state.patternGuard.strongSequence,
    patternMajorityThreeTwo: state.patternGuard.majorityThreeTwo,
    patternAlternating: state.patternGuard.alternating,
    patternRecentBreak: state.patternGuard.recentBreak,
  };

  Object.entries(values).forEach(([id, checked]) => {
    const input = $(id);
    if (input) input.checked = checked;
  });

  const numericValues = {
    patternStrongSequenceLength: state.patternGuard.strongSequenceLength,
    patternMajorityCount: state.patternGuard.majorityCount,
    patternMajorityWindow: state.patternGuard.majorityWindow,
    patternAlternatingLength: state.patternGuard.alternatingLength,
    patternRecentBreakLength: state.patternGuard.recentBreakLength,
    patternRecentBreakRounds: state.patternGuard.recentBreakRounds,
  };
  Object.entries(numericValues).forEach(([id, value]) => {
    const input = $(id);
    if (input) input.value = value;
  });

  updatePatternGuardVisibility();
  renderCustomPatterns();
  syncPatternGuardStrategy();
}

function syncPatternGuardStrategy() {
  if (typeof Strategies !== "undefined" && Strategies.setPatternGuardConfig) {
    Strategies.setPatternGuardConfig(readPatternGuardConfig());
  }
}

function updatePatternGuardVisibility() {
  $("patternGuardBody")?.classList.toggle(
    "is-disabled",
    !$("patternGuardEnabled")?.checked,
  );
}

function renderPatternDraft() {
  const container = $("patternDraftSequence");
  if (!container) return;
  container.innerHTML = _patternDraft.length
    ? _patternDraft.map(patternDotHtml).join("")
    : '<span class="pattern-builder-empty">Adicione ao menos 2 cores</span>';
}

function renderCustomPatterns() {
  const container = $("customPatternList");
  if (!container) return;

  const patterns = state.patternGuard.customPatterns || [];
  if (!patterns.length) {
    container.innerHTML =
      '<div class="custom-pattern-empty">Nenhum padrão personalizado.</div>';
    return;
  }

  container.innerHTML = patterns
    .map(
      (pattern, index) => `
        <div class="custom-pattern-item">
          <div class="custom-pattern-colors">
            ${pattern.pattern.split("").map(patternDotHtml).join("")}
          </div>
          <span class="custom-pattern-expected">
            permite <strong>${pattern.expected === "A" ? "Azul" : "Vermelho"}</strong>
          </span>
          <button type="button" class="custom-pattern-delete" data-delete-pattern-index="${index}" title="Excluir padrão">
            <i class="fas fa-trash"></i>
          </button>
        </div>`,
    )
    .join("");
}

function addCustomPattern() {
  if (_patternDraft.length < 2) {
    showToast("Adicione ao menos 2 cores ao padrão", "error");
    return;
  }

  const pattern = _patternDraft.join("");
  const expected = $("patternExpectedTarget")?.value === "V" ? "V" : "A";
  const duplicate = state.patternGuard.customPatterns.some(
    (item) => item.pattern === pattern && item.expected === expected,
  );
  if (duplicate) {
    showToast("Este padrão já foi adicionado", "info");
    return;
  }

  state.patternGuard.customPatterns.push({
    id: `custom-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    pattern,
    expected,
    enabled: true,
  });
  state.patternGuard = PatternGuard.normalizeConfig(state.patternGuard);
  _patternDraft = [];
  renderPatternDraft();
  renderCustomPatterns();
  saveConfig();
  showToast("Padrão de proteção adicionado", "success");
}

function bindPatternGuardControls() {
  $("patternGuardEnabled")?.addEventListener("change", () => {
    updatePatternGuardVisibility();
    saveConfig();
  });

  [
    "patternStrongSequence",
    "patternMajorityThreeTwo",
    "patternAlternating",
    "patternRecentBreak",
  ].forEach((id) => {
    $(id)?.addEventListener("change", saveConfig);
  });

  [
    "patternStrongSequenceLength",
    "patternMajorityCount",
    "patternMajorityWindow",
    "patternAlternatingLength",
    "patternRecentBreakLength",
    "patternRecentBreakRounds",
  ].forEach((id) => {
    $(id)?.addEventListener("change", () => {
      applyPatternGuardConfig(readPatternGuardConfig());
      saveConfig();
    });
  });

  document.querySelectorAll("[data-pattern-color]").forEach((button) => {
    button.addEventListener("click", () => {
      if (_patternDraft.length >= 12) {
        showToast("O padrão pode ter no máximo 12 cores", "info");
        return;
      }
      _patternDraft.push(button.dataset.patternColor === "V" ? "V" : "A");
      renderPatternDraft();
    });
  });

  $("btnPatternUndo")?.addEventListener("click", () => {
    _patternDraft.pop();
    renderPatternDraft();
  });
  $("btnAddPattern")?.addEventListener("click", addCustomPattern);
  $("customPatternList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-pattern-index]");
    if (!button) return;
    const index = Number.parseInt(button.dataset.deletePatternIndex, 10);
    if (!Number.isInteger(index)) return;
    state.patternGuard.customPatterns.splice(index, 1);
    renderCustomPatterns();
    saveConfig();
  });

  applyPatternGuardConfig(state.patternGuard);
  renderPatternDraft();
}

function bindConfigControls() {
  $("btnSaveConfig").addEventListener("click", () => {
    saveConfig();
    showToast("Configurações salvas", "success");
  });

  ["betLimit", "stopLoss", "stopWin", "stopRedHistory"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("change", saveConfig);
  });

  $("entryTimingMode")?.addEventListener("change", () => {
    updateEntryLeadVisibility();
    saveConfig();
  });
  $("entryLeadSeconds")?.addEventListener("change", () => {
    getEntryLeadSeconds();
    saveConfig();
  });

  $("tieAmount")?.addEventListener("change", saveConfig);
  $("tieDuploSeco")?.addEventListener("change", saveConfig);
  $("tieDuploSecoChip")?.addEventListener("change", () => {
    updateTieDuploSecoHint();
    saveConfig();
  });
  $("tieDuploSecoChip")?.addEventListener("blur", updateTieDuploSecoHint);
  $("skipG1OnSequence")?.addEventListener("change", saveConfig);
  $("skipG1SequenceLength")?.addEventListener("change", () => {
    const el = $("skipG1SequenceLength");
    if (el) el.value = skipG1SequenceLength();
    saveConfig();
  });
  updateTieDuploSecoHint();
  $("historyUrl")?.addEventListener("change", saveConfig);
  updateEntryLeadVisibility();
  syncEntryTimingStrategy();
}

/* ========== History Controls ========== */
function bindHistoryControls() {
  $("btnClearHistory").addEventListener("click", () => {
    if (confirm("Deseja limpar o histórico e zerar as estatísticas?")) {
      state.history = [];
      state.wins = state.losses = state.betCount = 0;
      state.totalPnl = 0;
      state.historyReds = 0;
      state.galeStep = 0;
      saveHistory();
      renderHistory();
      updateUI();
      showToast("Histórico limpo", "info");
    }
  });
}

/* ========== Render History ========== */
function renderHistory() {
  const list = $("historyList");
  if (!state.history.length) {
    list.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-dice fa-2x"></i>
        <p>Nenhuma aposta registrada</p>
      </div>`;
    return;
  }

  const targetIcons = {
    player: '<i class="fas fa-user text-blue"></i>',
    tie: '<i class="fas fa-equals text-yellow"></i>',
    banker: '<i class="fas fa-university text-red"></i>',
  };
  const targetNames = { player: "Jogador", tie: "Empate", banker: "Casa" };
  const resultIcons = {
    win: '<i class="fas fa-check-circle text-green"></i>',
    loss: '<i class="fas fa-times-circle text-red"></i>',
    pending: '<i class="fas fa-clock text-yellow"></i>',
    refund: '<i class="fas fa-rotate-left"></i>',
  };
  const galeBadge = (step) =>
    step > 0 ? `<span class="hi-gale">G${step}</span>` : "";
  const balanceLine = (entry) =>
    entry.balance == null
      ? ""
      : `<small class="hi-balance ${entry.balance >= 0 ? "text-green" : "text-red"}">Saldo ${formatSignedCurrency(entry.balance)}</small>`;
  const pnlLine = (entry) =>
    entry.pnl == null
      ? ""
      : `<small class="hi-pnl ${entry.pnl >= 0 ? "text-green" : "text-red"}">${entry.pnl >= 0 ? "+" : ""}${formatSignedCurrency(entry.pnl)}</small>`;
  const tieMultiplierLine = (entry) =>
    entry.result === "win" && entry.resultCor === "T"
      ? `<small class="hi-mult">Empate ${entry.tieMultiplier ? `x${entry.tieMultiplier}` : "green"}</small>`
      : "";
  const refundReasonLine = (entry) =>
    entry.result === "refund"
      ? `<small class="hi-refund-reason">${entry.refundReason || "Entrada não realizada"}</small>`
      : "";
  const amountStatusLine = (entry) =>
    entry.result === "refund"
      ? '<small class="hi-refund-reason">não apostado</small>'
      : "";

  list.innerHTML = state.history
    .map(
      (entry) => `
    <div class="history-item ${entry.result}">
      <div class="hi-target">
        ${targetIcons[entry.target] || ""}
        <span>${targetNames[entry.target] || entry.target}</span>
        ${galeBadge(entry.galeStep || 0)}
        ${entry.tieProtect ? '<small class="text-yellow">+Emp</small>' : ""}
        ${tieMultiplierLine(entry)}
        ${refundReasonLine(entry)}
      </div>
      <span class="hi-amount">
        <strong>${formatCurrency(entry.amount)}</strong>
        ${amountStatusLine(entry)}
        ${balanceLine(entry)}
      </span>
      <span class="hi-result">${resultIcons[entry.result] || ""}${pnlLine(entry)}</span>
      <span class="hi-time">${entry.time}</span>
    </div>
  `,
    )
    .join("");
}

/* ========== Save Config ========== */
function saveConfig() {
  const config = {
    galeMode: state.galeMode,
    galeDouble: state.galeDouble,
    galeModeType: state.galeModeType,
    galeCustomValues: state.galeCustomValues,
    tieGaleCustomValues: state.tieGaleCustomValues,
    tieProtectCustomValues: state.tieProtectCustomValues,
    tieGaleMode: state.tieGaleMode,
    betAmount: readCurrencyInput("betAmount"),
    tieEntryAmount: readCurrencyInput("tieEntryAmount"),
    tieProtection: $("tieProtection")?.checked || false,
    tieAmount: readCurrencyInput("tieAmount"),
    selectorPlayer: $("selectorPlayer")?.value || "",
    selectorTie: $("selectorTie")?.value || "",
    selectorBanker: $("selectorBanker")?.value || "",
    selectorAmount: $("selectorAmount")?.value || "",
    selectorConfirm: $("selectorConfirm")?.value || "",
    historyUrl: $("historyUrl")?.value || "",
    betLimit: parseInt($("betLimit")?.value) || 0,
    stopLoss: parseFloat($("stopLoss")?.value) || 0,
    stopWin: parseFloat($("stopWin")?.value) || 0,
    stopRedHistory: parseInt($("stopRedHistory")?.value, 10) || 0,
    entryTimingMode: getEntryTimingMode(),
    entryLeadSeconds: getEntryLeadSeconds(),
    patternGuard: readPatternGuardConfig(),
    bettingHouse: $("bettingHouse")?.value || "1win",
    chipProfile: $("chipProfile")?.value || "bacbo_br",
    tieDuploSeco: $("tieDuploSeco")?.checked || false,
    tieDuploSecoChip: readCurrencyInput("tieDuploSecoChip"),
    skipG1OnSequence: $("skipG1OnSequence")?.checked || false,
    skipG1SequenceLength: skipG1SequenceLength(),
  };
  chrome.storage.local.set({ bacboConfig: config });
  syncEntryTimingStrategy();
  syncPatternGuardStrategy();
}

/* ========== Load Config ========== */
function loadConfig() {
  chrome.storage.local.get("bacboConfig", ({ bacboConfig }) => {
    if (!bacboConfig) {
      updateEntryLeadVisibility();
      syncEntryTimingStrategy();
      return;
    }
    const c = bacboConfig;

    state.galeCustomValues = c.galeCustomValues || {};
    state.tieGaleCustomValues = c.tieGaleCustomValues || {};
    state.tieProtectCustomValues = c.tieProtectCustomValues || {};
    setGaleMode(c.galeMode ?? 0);

    setTieGaleMode(c.tieGaleMode ?? 0);
    setGaleModeType(c.galeModeType || ((c.galeDouble ?? c.tieGaleDouble) ? "double" : "fixed"));

    const setVal = (id, v) => {
      const el = $(id);
      if (!el || v == null) return;
      const n = snapTo5(parseInt(v, 10) || 5);
      el.value = formatCurrency(n);
      el.dataset.rawValue = n;
    };
    setVal("betAmount", c.betAmount);
    setVal("tieEntryAmount", c.tieEntryAmount ?? 5);
    setVal("tieAmount", c.tieAmount);

    if (c.tieProtection) {
      const cb = $("tieProtection");
      if (cb) cb.checked = true;
      state.tieProtection = true;
      const row = $("tieValueRow");
      if (row) row.style.display = "flex";
    }

    if (c.selectorPlayer) $("selectorPlayer").value = c.selectorPlayer;
    if (c.selectorTie) $("selectorTie").value = c.selectorTie;
    if (c.selectorBanker) $("selectorBanker").value = c.selectorBanker;
    if (c.selectorAmount) $("selectorAmount").value = c.selectorAmount;
    if (c.selectorConfirm) $("selectorConfirm").value = c.selectorConfirm;
    if (c.historyUrl) $("historyUrl").value = c.historyUrl;

    if (c.betLimit != null) $("betLimit").value = c.betLimit;
    if (c.stopLoss != null) $("stopLoss").value = c.stopLoss;
    if (c.stopWin != null) $("stopWin").value = c.stopWin;
    if (c.stopRedHistory != null || c.stopRedSequence != null)
      $("stopRedHistory").value = c.stopRedHistory ?? c.stopRedSequence;

    applyPatternGuardConfig(c.patternGuard || PatternGuard.DEFAULT_CONFIG);

    const entryTimingMode = c.entryTimingMode === "before" ? "before" : "exact";
    if ($("entryTimingMode")) $("entryTimingMode").value = entryTimingMode;
    if ($("entryLeadSeconds")) {
      $("entryLeadSeconds").value = clampEntryLeadSeconds(c.entryLeadSeconds ?? 1);
    }
    if ($("bettingHouse") && c.bettingHouse) {
      $("bettingHouse").value = c.bettingHouse;
    }
    if ($("chipProfile")) {
      $("chipProfile").value =
        c.chipProfile === "bacbo_en" ? "bacbo_en" : "bacbo_br";
    }
    if ($("tieDuploSeco")) $("tieDuploSeco").checked = !!c.tieDuploSeco;
    setVal("tieDuploSecoChip", c.tieDuploSecoChip ?? 5);
    if ($("skipG1OnSequence")) {
      $("skipG1OnSequence").checked = c.skipG1OnSequence !== false;
    }
    if ($("skipG1SequenceLength")) {
      const n = parseInt(c.skipG1SequenceLength, 10);
      $("skipG1SequenceLength").value = Number.isFinite(n)
        ? Math.min(8, Math.max(2, n))
        : 3;
    }
    updateTieDuploSecoHint();
    updateEntryLeadVisibility();
    syncEntryTimingStrategy();

    _renderGalePreview();
    _renderTieGalePreview();
    _renderTieProtectPreview();
    updateStatusLabel();
  });
}

/* ========== Save / Load History ========== */
function saveHistory() {
  chrome.storage.local.set({
    bacboHistory: state.history,
    bacboStats: {
      wins: state.wins,
      losses: state.losses,
      betCount: state.betCount,
      totalPnl: state.totalPnl,
      historyReds: state.historyReds,
    },
  });
}

function loadHistory() {
  chrome.storage.local.get(["bacboHistory", "bacboStats"], (data) => {
    if (data.bacboHistory) {
      state.history = data.bacboHistory;
      state.historyReds = countHistoryReds(state.history);
      renderHistory();
    }
    if (data.bacboStats) {
      const s = data.bacboStats;
      state.wins = s.wins || 0;
      state.losses = s.losses || 0;
      state.betCount = s.betCount || 0;
      state.totalPnl = s.totalPnl || 0;
      state.historyReds = countHistoryReds(state.history);
      updateUI();
    }
  });
}

/* ========== Histórico ao vivo — mesma fonte e ordem em Apostas e Estratégias ==========
   history: array do background (footer-left), ordem antigo → recente */
function renderHistoryBalls(container, history, maxCount = 10) {
  if (!container) return;

  if (!history || !history.length) {
    container.innerHTML =
      '<span class="live-history-empty">Aguardando rodadas...</span>';
    return;
  }

  const last = history.slice(-maxCount);
  const labels = { A: "Player", V: "Banker", T: "Tie" };
  const ballColors = {
    A: "live-ball-player",
    V: "live-ball-banker",
    T: "live-ball-tie",
  };
  const letters = { A: "P", V: "B", T: "T" };

  container.innerHTML = last
    .map((item, idx) => {
      const isLatest = idx === last.length - 1;
      return `
      <div class="live-ball ${ballColors[item.cor] || ""} ${isLatest ? "live-ball-latest" : ""}"
           title="${labels[item.cor] || item.cor}">
        <span class="live-ball-letter">${letters[item.cor] || "?"}</span>
      </div>
    `;
    })
    .join("");
}

function renderLiveHistory(history) {
  const container = $("liveHistoryBalls");
  const badge = $("liveHistoryBadge");

  if (!history || !history.length) {
    if (container) {
      container.innerHTML =
        '<span class="live-history-empty">Aguardando rodadas...</span>';
    }
    if (badge) badge.classList.remove("active");
    return;
  }

  if (badge) badge.classList.add("active");
  renderHistoryBalls(container, history, 10);
}

/* ========== Toast ========== */
let toastTimer;
function showToast(msg, type = "info") {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  requestAnimationFrame(() => toast.classList.add("show"));
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}
