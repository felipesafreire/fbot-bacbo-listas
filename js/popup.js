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
  galeMode: 1, // 0 = sem gale | 1..10 = quantidade de gales
  galeStep: 0, // passo atual (0 = entrada, 1..N = gale N)
  galeLevels: [
    { color: 10, tie: 5 },
    { color: 20, tie: 5 },
  ], // [{ color, tie }] por nível: Entrada, G1, G2…
  tieGaleMode: 0, // listas de empate: sempre igual a galeMode
  cycleMult: 1, // ciclo: após red, próxima SG = último valor apostado x2 (multiplicador sobre a base); green volta a 1
  patternGuard: PatternGuard.normalizeConfig(PatternGuard.DEFAULT_CONFIG),
  bettingHouseId: "1win",
  gameId: "bacbo_br", // bacbo_en | bacbo_br: define as fichas
  scheduleType: "none", // none | color | tie | mixed (lista carregada)
  bettingHouses: null, // cadastro do painel; null = casas padrão do HTML
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

/* ========== Relógio do cabeçalho (igual ao Automático) ========== */
function startHeaderClock() {
  const el = $("headerClock");
  if (!el) return;
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    el.dateTime = now.toISOString();
    setTimeout(tick, 1000 - now.getMilliseconds());
  };
  tick();
}

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

  loadHousesFromStorage();
  loadConfig();
  loadHistory();
  bindTabs();
  bindTargetButtons();
  bindTieProtection();
  initCurrencyInputs();
  bindGaleSelector();
  renderGamePicker();
  bindGamePicker();
  bindMainControls();
  bindConfigControls();
  bindPatternGuardControls();
  bindHistoryControls();
  updateUI();
  startConnectionMonitor();
  startHeaderClock();
  bindReleaseBanner();
  startBancaRefresh();

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
  renderHeaderPlan();
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
  renderHeaderPlan();
}

/* Vencimento do plano no cabeçalho; o heartbeat atualiza a licença, então relê a cada minuto. */
let _headerPlanTimer = null;
function renderHeaderPlan() {
  const el = $("headerPlan");
  if (!el) return;
  const license = BacListAuth.isLoggedIn() ? BacListAuth.license() : null;
  if (!license) {
    el.hidden = true;
    return;
  }
  const plan = LicenseExpiry.describe(license.license_expires_at);
  el.textContent = plan.label;
  el.classList.toggle("is-warn", plan.warn);
  el.hidden = false;
  if (!_headerPlanTimer) _headerPlanTimer = setInterval(renderHeaderPlan, 60000);
}

function onAuthLost(message) {
  BacListTelegram.stop();
  if (state.autoMode) toggleAutoMode({ silent: true });
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
  BacListTelegram.start(executeTelegramCommand);
  startReleaseCheck();
  void fetchBettingHouses();
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
    : `${window.fbotIcon('login')} Entrar`;
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
  BacListTelegram.stop();
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

/* ========== Gale (tabela por nível, igual ao Bac Bo Automático) ========== */
const GALE_MAX = 10;

function _levelValue(raw, fallback) {
  const n = typeof raw === "number" ? raw : parseMoney(raw);
  return Number.isFinite(n) && n > 0 ? snapChip(n) : fallback;
}

/** Garante uma linha por nível (Entrada + gales). Linha nova: cor dobra, empate repete. */
function _ensureGaleLevels() {
  const levels = Array.isArray(state.galeLevels) ? state.galeLevels : [];
  const out = [];
  for (let i = 0; i <= state.galeMode; i++) {
    const prev = out[i - 1] || { color: 10, tie: 5 };
    const cur = levels[i] || {};
    out.push({
      color: _levelValue(cur.color, i === 0 ? prev.color : snapChip(prev.color * 2)),
      tie: _levelValue(cur.tie, prev.tie),
    });
  }
  // Guarda os níveis acima do máximo: voltar a subir o gale recupera os valores.
  state.galeLevels = out.concat(levels.slice(out.length));
}

function renderGaleLevels() {
  const list = $("galeLevelsList");
  if (!list) return;
  _ensureGaleLevels();
  const protect = !!$("tieProtection")?.checked;
  // Coluna Empate só vale com proteção ligada ou lista com entradas de empate (🟠).
  const tieOn = protect || state.scheduleType === "tie" || state.scheduleType === "mixed";
  let html = "";
  for (let i = 0; i <= state.galeMode; i++) {
    const lv = state.galeLevels[i];
    html += `
      <div class="gale-level-row">
        <span class="gale-level-tag">${i === 0 ? "Entrada" : `G${i}`}</span>
        <input type="text" class="field-input gale-level-input" inputmode="numeric" data-step="${i}" data-kind="color" data-raw-value="${lv.color}" value="${formatCurrency(lv.color)}" aria-label="${galeStepLabel(i)} — valor na cor" />
        <input type="text" class="field-input gale-level-input" inputmode="numeric" data-step="${i}" data-kind="tie" data-raw-value="${lv.tie}" value="${formatCurrency(lv.tie)}" aria-label="${galeStepLabel(i)} — valor no empate"${tieOn ? "" : ' disabled title="Ligue Proteger empate para usar"'} />
      </div>`;
  }
  list.innerHTML = html;
}

function _saveGaleLevelInput(input) {
  const step = parseInt(input.dataset.step, 10);
  const kind = input.dataset.kind === "tie" ? "tie" : "color";
  if (!Number.isFinite(step) || !state.galeLevels[step]) return;
  const value = _levelValue(input.dataset.rawValue || input.value, state.galeLevels[step][kind]);
  state.galeLevels[step][kind] = value;
  input.dataset.rawValue = value;
  input.value = formatCurrency(value);
  renderCycleHint();
}

function bindTieProtection() {
  const toggle = $("tieProtection");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    state.tieProtection = toggle.checked;
    renderGaleLevels();
    saveConfig();
  });
}

function bindGaleSelector() {
  const readCount = () =>
    Math.min(GALE_MAX, Math.max(0, parseInt($("galeCountInput")?.value, 10) || 0));
  $("galeCountInput")?.addEventListener("change", () => {
    setGaleMode(readCount());
    saveConfig();
  });
  $("galeCountInput")?.addEventListener("input", () => setGaleMode(readCount(), { keepInput: true }));

  const list = $("galeLevelsList");
  if (!list) return;
  list.addEventListener("focusin", (e) => {
    const input = e.target.closest(".gale-level-input");
    if (!input) return;
    input.value = moneyInputText(input.dataset.rawValue || "");
    input.select();
  });
  list.addEventListener("input", (e) => {
    const input = e.target.closest(".gale-level-input");
    if (!input) return;
    const typed = (input.value || "").replace(/[^\d,]/g, "");
    input.value = typed;
    input.dataset.rawValue = typed;
  });
  list.addEventListener("focusout", (e) => {
    const input = e.target.closest(".gale-level-input");
    if (!input) return;
    _saveGaleLevelInput(input);
    saveConfig();
  });
  list.addEventListener("keydown", (e) => {
    if (e.target.closest(".gale-level-input") && e.key === "Enter") e.target.blur();
  });
}

function setGaleMode(gale, { keepInput = false } = {}) {
  state.galeMode = Math.min(GALE_MAX, Math.max(0, gale));
  // Listas só de empate usam o mesmo máximo de gale.
  state.tieGaleMode = state.galeMode;
  state.galeStep = 0;
  if (!keepInput && $("galeCountInput")) $("galeCountInput").value = state.galeMode;
  renderGaleLevels();
}

/** Valor do nível na tabela; passo acima do máximo usa a última linha. */
function getLevelAmount(step, kind) {
  _ensureGaleLevels();
  const idx = Math.min(Math.max(0, step), state.galeMode);
  const lv = state.galeLevels[idx] || state.galeLevels[0] || { color: 10, tie: 5 };
  return kind === "tie" ? lv.tie : lv.color;
}

/**
 * Config antiga (Fixo/Dobrar/Personalizado + valores soltos) vira a tabela.
 * Coluna Empate: valor da proteção, ou o da entrada de empate se não havia proteção.
 */
function migrateLegacyGaleLevels(c) {
  const mode = ["fixed", "double", "custom"].includes(c.galeModeType)
    ? c.galeModeType
    : c.galeDouble
      ? "double"
      : "fixed";
  const stepAmount = (step, base, custom) => {
    if (step === 0) return base;
    if (mode === "custom") {
      const v = Number(custom?.[step]);
      return v > 0 ? snapChip(v) : snapChip(base * 2 ** step);
    }
    return mode === "double" ? snapChip(base * 2 ** step) : base;
  };
  const colorBase = _levelValue(c.betAmount, 10);
  const tieBase = _levelValue(c.tieProtection ? c.tieAmount : c.tieEntryAmount ?? c.tieAmount, 5);
  const tieCustom = c.tieProtection ? c.tieProtectCustomValues : c.tieGaleCustomValues;
  const max = Math.min(GALE_MAX, Math.max(0, Number(c.galeMode) || 0, Number(c.tieGaleMode) || 0));
  const levels = [];
  for (let i = 0; i <= max; i++) {
    levels.push({
      color: stepAmount(i, colorBase, c.galeCustomValues),
      tie: stepAmount(i, tieBase, tieCustom),
    });
  }
  return { levels, max: Math.min(GALE_MAX, Math.max(0, Number(c.galeMode) || 0)) };
}

/* ========== Máscara de valor — aceita qualquer inteiro >= 1 ========== */

function snapAmount(raw) {
  const n = parseInt(String(raw).replace(/\D/g, ""), 10) || 0;
  return Math.max(n, 1);
}

// Mantido por compatibilidade (fichas do jogo são múltiplas de 5)
/* ========== Jogo e fichas (igual ao Bac Bo Automático) ========== */
const GAME_PROFILES = {
  bacbo_en: { id: "bacbo_en", label: "Bac Bo Inglês", icon: "dice", chipStep: 5 },
  bacbo_br: { id: "bacbo_br", label: "Bac Bo Brasileiro", icon: "flag", chipStep: 2.5 },
};

function gameProfile() {
  return GAME_PROFILES[state.gameId] || GAME_PROFILES.bacbo_br;
}

/** Menor ficha da mesa escolhida: 2,50 no brasileiro, 5 no inglês. */
function chipStep() {
  return gameProfile().chipStep;
}

/** "2,5" / "2,50" / "10" / 12.5 → número. */
function parseMoney(raw) {
  if (typeof raw === "number") return raw;
  let t = String(raw ?? "").replace(/[^\d,.]/g, "");
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

/** Arredonda para baixo no múltiplo da menor ficha; mínimo = uma ficha. */
function snapChip(raw) {
  const stepCents = Math.round(chipStep() * 100);
  const cents = Math.round(parseMoney(raw) * 100);
  const snapped = Math.floor(cents / stepCents) * stepCents;
  return Math.max(snapped, stepCents) / 100;
}

function moneyInputText(value) {
  return String(value).replace(".", ",");
}

function renderGamePicker() {
  const box = $("gamePicker");
  if (!box) return;
  box.innerHTML = Object.values(GAME_PROFILES)
    .map(
      (g) => `
      <label class="game-card">
        <input type="radio" name="gameId" class="game-picker-input" value="${g.id}" ${g.id === state.gameId ? "checked" : ""} />
        <div class="game-card-body">
          <div class="game-card-head">
            ${window.fbotIcon(g.icon)}
            <span class="game-card-title">${g.label}</span>
            <span class="game-card-meta">ficha mín. ${formatCurrency(g.chipStep)}</span>
          </div>
        </div>
      </label>`,
    )
    .join("");
}

function bindGamePicker() {
  $("gamePicker")?.addEventListener("change", (e) => {
    const input = e.target.closest(".game-picker-input");
    if (!input || !GAME_PROFILES[input.value]) return;
    state.gameId = input.value;
    // Casas sem o link deste jogo ficam desabilitadas na lista.
    renderHouseOptions();
    // Revalida os valores com a ficha nova (ex.: 2,50 no inglês vira 5).
    state.galeLevels = state.galeLevels.map((lv) => ({ color: snapChip(lv.color), tie: snapChip(lv.tie) }));
    renderGaleLevels();
    const chip = $("tieDuploSecoChip");
    if (chip) {
      const v = snapChip(chip.dataset.rawValue || chip.value);
      chip.dataset.rawValue = v;
      chip.value = formatCurrency(v);
      updateTieDuploSecoHint();
    }
    renderCycleHint();
    saveConfig();
    showToast(`${gameProfile().label}: ficha mínima ${formatCurrency(chipStep())}`, "info");
  });
}

/* Mantido por compatibilidade: agora segue as fichas do jogo escolhido. */
function snapTo5(raw) {
  return snapChip(raw);
}

// Formata número inteiro como "R$ 1.250"
function formatCurrency(n) {
  const v = Number(n) || 0;
  const frac = Math.round(v * 100) % 100 !== 0;
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 });
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
  return snapChip(el.dataset.rawValue || el.value || "");
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
    const initial = snapChip(input.dataset.rawValue || input.value || 5);
    input.value = formatCurrency(initial);
    input.dataset.rawValue = initial;

    input.addEventListener("focus", () => {
      input.value = moneyInputText(input.dataset.rawValue || "");
      input.select();
    });

    input.addEventListener("input", () => {
      const typed = input.value.replace(/[^\d,]/g, "");
      input.value = typed;
      input.dataset.rawValue = typed || "";
    });

    input.addEventListener("blur", () => {
      applyCurrencyMask(input);
      saveConfig();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        applyCurrencyMask(input);
        input.blur();
      }
    });
  });
}

/* ========== Lista carregada → aviso na aba Apostas ========== */
function onScheduleTypeChanged(type) {
  state.scheduleType = type;
  renderGaleLevels();
  const noList = $("betNoList");
  if (noList) noList.style.display = type === "none" ? "block" : "none";
}

/* ========== Gale Step Label ========== */
function galeStepLabel(step) {
  if (step === 0) return "Entrada";
  return `${step}º Gale`;
}

/* ========== Ciclo: após red, próxima SG = último valor apostado x2; green volta ao normal ========== */
function isCycleEnabled() {
  return !!$("cycleEnabled")?.checked;
}

function getCycleMultiplier() {
  return isCycleEnabled() ? state.cycleMult : 1;
}

function applyCycle(amount) {
  const mult = getCycleMultiplier();
  if (mult === 1) return amount;
  return snapChip(amount * mult);
}

function setCycleMult(mult) {
  state.cycleMult = Number.isFinite(mult) && mult > 1 ? mult : 1;
  renderCycleHint();
}

function renderCycleHint() {
  const hint = $("cycleHint");
  if (!hint) return;
  if (!isCycleEnabled()) {
    hint.textContent =
      "Após red, a próxima SG é o dobro do último valor apostado; gales e proteção acompanham. Volta ao normal no green.";
    return;
  }
  hint.textContent =
    state.cycleMult === 1
      ? "Ativo — próxima entrada no valor normal."
      : `Ativo — próxima SG ${formatCurrency(applyCycle(getLevelAmount(0, "color")))} (x${state.cycleMult}).`;
}

function getBetAmountForStep(step, isTie) {
  return applyCycle(getLevelAmount(step, isTie ? "tie" : "color"));
}

function getTieProtectAmountForStep(step) {
  return applyCycle(getLevelAmount(step, "tie"));
}

/* ========== Main Controls ========== */
function bindMainControls() {
  $("btnAuto").addEventListener("click", () => {
    if (state.autoMode) toggleAutoMode();
    else void startAutomationChecked();
  });
  $("bettingHouse")?.addEventListener("change", () => {
    state.bettingHouseId = $("bettingHouse").value;
    saveConfig();
  });
  $("fullscreenOnLoad")?.addEventListener("change", saveConfig);
}

/* ========== Avisos no bot do Telegram (igual ao Automático) ========== */
let _notifyStats = { entries: 0, wins: 0, losses: 0, ties: 0, startPnl: 0 };

function resetNotifyStats() {
  _notifyStats = { entries: 0, wins: 0, losses: 0, ties: 0, startPnl: state.totalPnl };
}

function notifyBot(type, meta = {}) {
  if (typeof BacListTelegram === "undefined") return;
  void BacListTelegram.notify(type, meta);
}

/**
 * Aviso com a banca da mesa lida na hora do envio ("💰 Saldo atualizado" no Telegram).
 * Sem mesa aberta, vai sem o saldo.
 */
function notifyBotWithBalance(type, meta = {}) {
  notifyBot(type, async () => {
    const base = typeof meta === "function" ? await meta() : meta;
    if (base && base.balance != null) return base;
    const balance = await readBanca();
    return balance != null ? { ...base, balance: roundMoney(balance) } : base;
  });
}

/**
 * Resumo da sessão para "Automação desligada". Igual ao Automático: o lucro é
 * a banca atual menos a banca do início da automação. Stop win/loss dispara
 * logo após o resultado, então espera a mesa pagar antes de ler o saldo.
 */
function notifySummary(reason) {
  return async () => {
    const meta = {
      reason: reason || "manual",
      entries: _notifyStats.entries,
      wins: _notifyStats.wins,
      losses: _notifyStats.losses,
      ties: _notifyStats.ties,
    };
    const wait = BALANCE_SETTLE_MS - (Date.now() - _lastResultAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const balance = await readBanca({ retries: 4, delayMs: 300 });
    if (balance != null) meta.balance = roundMoney(balance);
    if (balance != null && _banca.initial != null) {
      meta.pnl = roundMoney(balance - _banca.initial);
    } else {
      meta.pnl = roundMoney(state.totalPnl - _notifyStats.startPnl);
    }
    return meta;
  };
}

/* ========== Banca (saldo da conta na mesa) — igual ao Automático ========== */
const BANCA_REFRESH_MS = 8000;
// Tempo para a mesa creditar o pagamento antes de ler o saldo do resultado.
const BALANCE_SETTLE_MS = 3500;
const _banca = { current: null, initial: null };
let _bancaTimer = null;
let _lastPlacedAt = 0;
let _lastResultAt = 0;

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function formatBrl(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Lê o saldo da conta no iframe da mesa. Retorna null sem mesa aberta. */
async function readBanca({ retries = 2, delayMs = 250 } = {}) {
  try {
    const r = await chrome.runtime.sendMessage({
      action: "readAccountBalance",
      retries,
      delayMs,
    });
    const value = Number(r?.value);
    if (r?.value != null && Number.isFinite(value)) {
      _banca.current = value;
      renderBanca();
      return value;
    }
  } catch (_) {}
  return null;
}

function renderBanca() {
  const el = $("statBanca");
  if (el) {
    el.textContent = _banca.current != null ? formatBrl(_banca.current) : "Sem mesa";
    el.classList.toggle("balance-value--muted", _banca.current == null);
  }
  renderSessionPnl();
}

/** P&L da sessão: variação da banca da mesa; sem banca lida, o resultado das apostas. */
function renderSessionPnl() {
  const el = $("statPnl");
  if (!el) return;
  const bancaDelta = bancaSessionDelta();
  const delta = bancaDelta != null ? bancaDelta : state.betCount > 0 ? roundMoney(state.totalPnl) : null;
  el.textContent = delta != null ? formatBrl(delta) : "—";
  el.classList.toggle("stat-value--win", delta != null && delta > 0);
  el.classList.toggle("stat-value--loss", delta != null && delta < 0);
}

/** Diferença da banca desde que a automação ligou (ou o placar foi zerado). */
function bancaSessionDelta() {
  if (_banca.initial == null || _banca.current == null) return null;
  return roundMoney(_banca.current - _banca.initial);
}

/** Marca a banca de agora como início da sessão. */
async function markBancaInicial() {
  const value = await readBanca({ retries: 4, delayMs: 300 });
  _banca.initial = value != null ? value : _banca.current;
  renderBanca();
}

function startBancaRefresh() {
  if (_bancaTimer) return;
  void readBanca({ retries: 1 });
  _bancaTimer = setInterval(() => {
    // Com aposta aguardando resultado o saldo está descontado da ficha;
    // a leitura do resultado vem depois do pagamento (notifyBalanceAfterSettle).
    if (_pendingBet?.awaiting) return;
    void readBanca({ retries: 1 });
  }, BANCA_REFRESH_MS);
}

/** Depois que a rodada paga, manda o saldo atualizado (igual ao Automático). */
function notifyBalanceAfterSettle() {
  const waitStarted = Date.now();
  _lastResultAt = waitStarted;
  setTimeout(async () => {
    const balance = await readBanca({ retries: 4, delayMs: 300 });
    // Outra aposta saiu no meio da espera: o saldo já está descontado dela.
    if (balance == null || _lastPlacedAt > waitStarted) return;
    // Automação desligada no meio da espera (stop win/loss): o saldo vai no resumo.
    if (!state.autoMode) return;
    notifyBot("entry_result", { balance: roundMoney(balance) });
  }, BALANCE_SETTLE_MS);
}

const NOTIFY_SIDE = { A: "player", V: "banker", T: "tie" };

/* ========== Casas de aposta (cadastro do admin no painel) ========== */
let _configLoaded = false;

/** URLs https da casa por jogo; cadastro antigo (só url) vale para todos os jogos. */
function _houseUrls(h) {
  const out = {};
  if (h && h.urls && typeof h.urls === "object") {
    for (const [game, url] of Object.entries(h.urls)) {
      if (typeof url === "string" && /^https:\/\//i.test(url)) out[game] = url;
    }
  }
  return out;
}

/** Link da casa para o jogo; null quando a casa não tem esse jogo. */
function houseUrlForGame(h, gameId) {
  const urls = _houseUrls(h);
  if (!Object.keys(urls).length) return /^https:\/\//i.test(h?.url || "") ? h.url : null;
  return urls[gameId] || null;
}

function _validHouses(list) {
  return Array.isArray(list)
    ? list.filter(
        (h) =>
          h &&
          typeof h.id === "string" &&
          h.id &&
          typeof h.nome === "string" &&
          (/^https:\/\//i.test(h.url || "") || Object.keys(_houseUrls(h)).length > 0),
      )
    : [];
}

function renderHouseOptions() {
  const select = $("bettingHouse");
  if (!select) return;
  const houses = _validHouses(state.bettingHouses);
  if (houses.length) {
    select.innerHTML = "";
    for (const h of houses) {
      const opt = document.createElement("option");
      opt.value = h.id;
      const hasGame = !!houseUrlForGame(h, state.gameId);
      // Casa sem o link do jogo escolhido fica visível, mas não pode ser usada.
      opt.textContent = hasGame ? h.nome : `${h.nome} (sem ${gameProfile().label})`;
      opt.disabled = !hasGame;
      select.appendChild(opt);
    }
  }
  const usable = Array.from(select.options).filter((o) => !o.disabled).map((o) => o.value);
  if (usable.includes(state.bettingHouseId)) {
    select.value = state.bettingHouseId;
  } else if (usable.length) {
    // Casa removida, desligada no painel ou sem o jogo escolhido: passa para a primeira que tem.
    const hadChoice = !!state.bettingHouseId;
    state.bettingHouseId = usable[0];
    select.value = usable[0];
    // Só grava depois que a config foi lida, para não sobrescrever com o padrão.
    if (hadChoice && houses.length && _configLoaded) saveConfig();
  }
}

function loadHousesFromStorage() {
  chrome.storage.local.get("bettingHouses", ({ bettingHouses }) => {
    if (_validHouses(bettingHouses).length) {
      state.bettingHouses = bettingHouses;
      renderHouseOptions();
    }
  });
}

/** Busca as casas ativas no painel e guarda para o background abrir a casa certa. */
async function fetchBettingHouses() {
  if (!BacListAuth.isLoggedIn()) return;
  try {
    const data = await BacListAuth.api("/api/listas/casas");
    const houses = _validHouses(data?.casas).map((h) => ({
      id: h.id,
      nome: h.nome,
      url: h.url,
      urls: _houseUrls(h),
      clickPlay: !!h.clickPlay,
    }));
    if (!houses.length) return;
    state.bettingHouses = houses;
    await chrome.storage.local.set({ bettingHouses: houses });
    renderHouseOptions();
  } catch (err) {
    console.warn("[BacList] Casas de aposta: usando a lista salva", err?.message || err);
  }
}

/* ========== Versão da extensão (igual ao Automático) ========== */
const RELEASE_CHECK_MS = 10 * 60 * 1000;
let _releaseInfo = null; // { latest, current, available }
let _releaseTimer = null;
let _startingAuto = false;

function isNewerVersion(latest, current) {
  const parts = (value) => String(value || "").split(".").map((n) => parseInt(n, 10) || 0);
  const next = parts(latest);
  const installed = parts(current);
  const len = Math.max(next.length, installed.length);
  for (let i = 0; i < len; i++) {
    const diff = (next[i] || 0) - (installed[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * Consulta a versão publicada no painel. Sem rede ou sem pacote publicado,
 * não bloqueia (igual ao Automático).
 * @returns {Promise<boolean>} true quando há versão mais nova.
 */
async function checkListasRelease() {
  if (!BacListAuth.isLoggedIn()) return false;
  try {
    const data = await BacListAuth.api("/api/listas/release");
    const latest = String(data?.version || "");
    const current = chrome.runtime.getManifest().version;
    _releaseInfo = {
      latest,
      current,
      available: latest !== "" && isNewerVersion(latest, current),
    };
  } catch (_) {
    return false;
  } finally {
    renderReleaseBanner();
  }
  return !!_releaseInfo?.available;
}

function renderReleaseBanner() {
  const banner = $("extensionUpdateBanner");
  if (!banner) return;
  if (!_releaseInfo?.available || !_releaseInfo.latest) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const text = $("extensionUpdateText");
  if (text) {
    text.textContent = `Versão ${_releaseInfo.latest} pronta (instalada: ${_releaseInfo.current}). Baixe o zip, substitua os arquivos da extensão e recarregue em chrome://extensions. A automação só liga depois de atualizar.`;
  }
}

function bindReleaseBanner() {
  $("extensionUpdateDownload")?.addEventListener("click", async () => {
    const button = $("extensionUpdateDownload");
    if (button) button.disabled = true;
    try {
      await BacListAuth.downloadRelease(_releaseInfo?.latest);
    } catch (err) {
      showToast(err?.message || "Não foi possível baixar a atualização.", "error");
    } finally {
      if (button) button.disabled = false;
    }
  });
}

function startReleaseCheck() {
  void checkListasRelease();
  if (_releaseTimer) return;
  _releaseTimer = setInterval(() => void checkListasRelease(), RELEASE_CHECK_MS);
}

/**
 * Liga a automação só se a extensão estiver na versão publicada no painel.
 * @returns {Promise<{ ok: boolean, text?: string }>}
 */
async function startAutomationChecked(options = {}) {
  if (state.autoMode) return { ok: true };
  if (_startingAuto) return { ok: false, text: "Verificando a versão da extensão..." };
  _startingAuto = true;
  try {
    if (await checkListasRelease()) {
      const message = `Atualização ${_releaseInfo?.latest || "nova"} disponível. Baixe o zip no painel e recarregue a extensão antes de ligar.`;
      showToast(message, "error");
      return { ok: false, text: message };
    }
    if (!state.autoMode) toggleAutoMode(options);
    return { ok: true };
  } finally {
    _startingAuto = false;
  }
}

/* ========== Auto Mode ========== */
/**
 * @param {{ reason?: string, silent?: boolean }} options
 *   reason: motivo do desligamento no aviso do Telegram (stopWin, stopLoss, betLimit…).
 *   silent: não avisa no Telegram (comando /ligar e /parar já respondem).
 */
function toggleAutoMode(options = {}) {
  const { reason = "manual", silent = false } = options;
  state.autoMode = !state.autoMode;
  const btn = $("btnAuto");
  const label = $("autoLabel");

  if (state.autoMode) {
    btn.classList.add("active");
    label.textContent = "Parar Automação";
    setStatus("auto", "Rodando", "#63b3ed");
    setCycleMult(1);
    resetNotifyStats();
    const bancaInicial = markBancaInicial();
    if (!silent) {
      notifyBot("automation_started", async () => {
        await bancaInicial;
        return _banca.current != null ? { balance: roundMoney(_banca.current) } : {};
      });
    }
    showToast("Automação iniciada — monitorando estratégias", "info");
    chrome.runtime.sendMessage(
      { action: "setAutomationRunning", active: true },
      () => Strategies.setAutoEnabled(true),
    );
  } else {
    if (!silent) notifyBotWithBalance("automation_stopped", notifySummary(reason));
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

  // Resultado no Telegram antes de um possível "Automação desligada" (stop win/loss).
  notifyBot("entry_result", {
    result: won ? "green" : "loss",
    game: "bacbo",
    side: NOTIFY_SIDE[betTarget] || "",
    winner: NOTIFY_SIDE[resultCor] || "",
    galeLevel: galeStepAtBet,
    maxGale: Number(maxGale) || 0,
    ciclo: false,
  });
  // Rodada encerrada: o saldo com o pagamento vem num aviso separado.
  notifyBalanceAfterSettle();

  if (won) {
    _notifyStats.wins++;
    state.galeStep = 0;
    if (!_pendingBet.tieSeco) setCycleMult(1);
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
    _notifyStats.losses++;
    state.galeStep = 0;
    _pendingBet = null;
    return info;
  }

  // Entrada em cor sem proteção e saiu empate: red direto, sem gale.
  const unprotectedTie =
    !isTieEntry && !_pendingBet.tieSeco && !hasTieProtection && resultCor === "T";

  const shouldGale = galeStepAtBet < maxGale && !unprotectedTie;

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
  _notifyStats.losses++;
  if (!_pendingBet.tieSeco && isCycleEnabled()) {
    // Próxima SG = último valor apostado nesta sequência x2.
    const base = getLevelAmount(0, isTieEntry ? "tie" : "color");
    const lastStake = _pendingBet.mainAmount || 0;
    if (base > 0 && lastStake > 0) setCycleMult((lastStake * 2) / base);
  }

  if (typeof Strategies !== "undefined" && Strategies.signalLoss) {
    Strategies.signalLoss(galeStepAtBet + 1);
  }
  const cycleMsg = isCycleEnabled() && !_pendingBet.tieSeco
    ? ` — ciclo: próxima SG ${formatCurrency(applyCycle(getLevelAmount(0, isTieEntry ? "tie" : "color")))}`
    : "";
  showToast(
    (unprotectedTie
      ? "Red — empate sem proteção"
      : "Loss — sequência encerrada") + cycleMsg,
    "error",
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
    ? snapChip(options.amount)
    : getBetAmountForStep(galeStep, isTieEntry);
  const tieProtect =
    !tieSeco && !isTieEntry && ($("tieProtection")?.checked || false);
  const tieAmount = tieProtect ? getTieProtectAmountForStep(galeStep) : 0;
  const selectors = getSelectors();
  const maxGale = tieSeco ? 0 : isTieEntry ? state.tieGaleMode : state.galeMode;
  const notifySource = isGale ? "gale" : tieSeco ? "empate seco" : "lista";
  const notifySide = NOTIFY_SIDE[colorTarget] || target;

  const preSig = _roadSig(_roadHistory);
  let placed = false;

  // Entrada nova (não gale): avisa antes de clicar, como o Automático.
  const announced = !fromGale;
  if (announced) {
    notifyBotWithBalance("entry_identified", {
      game: "bacbo",
      side: notifySide,
      source: notifySource,
      galeLevel: galeStep,
      maxGale: Number(maxGale) || 0,
      ciclo: false,
    });
  }

  try {
    const { tabId } = await chrome.runtime.sendMessage({
      action: "getActiveTabId",
    });

    // Entrada e gales: fichas e spot com o valor da tabela de gale.
    const result = await chrome.runtime.sendMessage({
      action: "placeBetIframe",
      tabId: tabId || undefined,
      mainAmount,
      tieAmount,
      target: spot,
      tieProtection: tieProtect,
      selectors,
      waitForChips: tieSeco,
    });

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


      recordBet(target, mainAmount, tieProtect, tieAmount, "pending", galeStep);
      updateUI();
      placed = true;
      _lastPlacedAt = Date.now();
      if (!fromGale) _notifyStats.entries++;
      notifyBotWithBalance("entry_placed", {
        game: "bacbo",
        side: notifySide,
        amount: Math.round(mainAmount * 100) / 100,
        tieAmount: tieProtect ? Math.round(tieAmount * 100) / 100 : 0,
        source: notifySource,
        galeLevel: galeStep,
        maxGale: Number(maxGale) || 0,
        ciclo: false,
      });


      if (!fromGale) {
        state.betCount++;
        const limit = parseInt($("betLimit")?.value) || 0;
        if (limit > 0 && state.betCount >= limit) {
          if (state.autoMode) toggleAutoMode({ reason: "betLimit" });
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
      if (announced) notifyBot("entry_cancelled", {});
    }
  } catch (err) {
    if (announced && !placed) notifyBot("entry_cancelled", {});
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
    if (state.autoMode) toggleAutoMode({ reason: "Limite de reds" });
    showToast(
      `Parou após ${redCount} reds no histórico (Entrada e Gales contam)`,
      "error",
    );
    return true;
  }

  if (stopLoss > 0 && state.totalPnl <= -stopLoss) {
    if (state.autoMode) toggleAutoMode({ reason: "stopLoss" });
    showToast(
      `Stop Loss atingido: R$ ${Math.abs(state.totalPnl).toFixed(2)}`,
      "error",
    );
    return true;
  }
  if (stopWin > 0 && state.totalPnl >= stopWin) {
    if (state.autoMode) toggleAutoMode({ reason: "stopWin" });
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

/* ========== Update UI ========== */
const SIDE_NAMES = { player: "Azul", banker: "Vermelho", tie: "Empate" };

function updateUI() {
  $("statWins").textContent = state.wins;
  $("statLosses").textContent = state.losses;
  renderSessionPnl();

  const gale = $("gale-display");
  if (gale) gale.textContent = `G${state.galeStep || 0}`;

  // Última aposta: a mais recente do histórico (entrada ou gale).
  const last = state.history?.[0];
  const valueEl = $("totalBetValue");
  const metaEl = $("totalBetMeta");
  if (valueEl) {
    const amount = Number(last?.amount) || 0;
    valueEl.textContent = amount > 0 ? formatBrl(amount) : "—";
    valueEl.classList.toggle("stat-value--muted", !(amount > 0));
    if (metaEl) metaEl.textContent = amount > 0 ? SIDE_NAMES[last.target] || "" : "";
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
            ${window.fbotIcon('trash')}
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

  $("tieDuploSeco")?.addEventListener("change", saveConfig);
  $("cycleEnabled")?.addEventListener("change", () => {
    setCycleMult(1);
    saveConfig();
  });
  $("tieDuploSecoChip")?.addEventListener("change", () => {
    updateTieDuploSecoHint();
    saveConfig();
  });
  $("tieDuploSecoChip")?.addEventListener("blur", updateTieDuploSecoHint);
  updateTieDuploSecoHint();
  $("historyUrl")?.addEventListener("change", saveConfig);
  updateEntryLeadVisibility();
  syncEntryTimingStrategy();
}

/* ========== History Controls ========== */
function bindHistoryControls() {
  $("btnClearHistory").addEventListener("click", () => {
    if (confirm("Deseja limpar o histórico e zerar as estatísticas?")) {
      resetPlacar();
      showToast("Histórico limpo", "info");
    }
  });
  // Limpar do Resumo da sessão (igual ao Automático): zera placar e histórico.
  $("btnClearSession")?.addEventListener("click", () => {
    if (confirm("Limpar o resumo da sessão? Placar e histórico de apostas serão zerados.")) {
      resetPlacar();
      showToast("Resumo da sessão limpo", "info");
    }
  });
}

function resetPlacar() {
  state.history = [];
  state.wins = state.losses = state.betCount = 0;
  state.totalPnl = 0;
  state.historyReds = 0;
  state.galeStep = 0;
  setCycleMult(1);
  saveHistory();
  renderHistory();
  updateUI();
  // Placar zerado: a banca de agora vira o início da sessão (igual ao Automático).
  if (_banca.current != null) _banca.initial = _banca.current;
  renderBanca();
}

/* ========== Render History ========== */
function renderHistory() {
  const list = $("historyList");
  if (!state.history.length) {
    list.innerHTML = `
      <div class="empty-state">
        ${window.fbotIcon('dice', 'ic-2x')}
        <p>Nenhuma aposta registrada</p>
      </div>`;
    return;
  }

  const targetIcons = {
    player: window.fbotIcon('user', 'text-blue'),
    tie: window.fbotIcon('equals', 'text-yellow'),
    banker: window.fbotIcon('landmark', 'text-red'),
  };
  const targetNames = { player: "Azul", tie: "Empate", banker: "Vermelho" };
  const resultIcons = {
    win: window.fbotIcon('circle-check', 'text-green'),
    loss: window.fbotIcon('circle-x', 'text-red'),
    pending: window.fbotIcon('clock', 'text-yellow'),
    refund: window.fbotIcon('rotate-left'),
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
    gameId: state.gameId,
    galeLevels: state.galeLevels.slice(0, state.galeMode + 1),
    tieProtection: $("tieProtection")?.checked || false,
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
    bettingHouse: $("bettingHouse")?.value || state.bettingHouseId || "1win",
    fullscreenOnLoad: $("fullscreenOnLoad")?.checked !== false,
    tieDuploSeco: $("tieDuploSeco")?.checked || false,
    cycleEnabled: isCycleEnabled(),
    tieDuploSecoChip: readCurrencyInput("tieDuploSecoChip"),
  };
  chrome.storage.local.set({ bacboConfig: config });
  syncEntryTimingStrategy();
  syncPatternGuardStrategy();
}

/* ========== Load Config ========== */
function loadConfig() {
  chrome.storage.local.get("bacboConfig", ({ bacboConfig }) => {
    if (!bacboConfig) {
      _configLoaded = true;
      setGaleMode(state.galeMode);
      renderHouseOptions();
      updateEntryLeadVisibility();
      syncEntryTimingStrategy();
      return;
    }
    const c = bacboConfig;
    let migratedGale = false;
    // Jogo antes dos valores: define a menor ficha (2,50 no brasileiro, 5 no inglês).
    state.gameId = GAME_PROFILES[c.gameId] ? c.gameId : c.chipProfile === "bacbo_en" ? "bacbo_en" : "bacbo_br";
    renderGamePicker();

    const setVal = (id, v) => {
      const el = $(id);
      if (!el || v == null) return;
      const n = snapChip(v);
      el.value = formatCurrency(n);
      el.dataset.rawValue = n;
    };

    if (Array.isArray(c.galeLevels) && c.galeLevels.length) {
      state.galeLevels = c.galeLevels.map((lv) => ({ color: lv?.color, tie: lv?.tie }));
      setGaleMode(c.galeMode ?? 0);
    } else {
      const migrated = migrateLegacyGaleLevels(c);
      state.galeLevels = migrated.levels;
      setGaleMode(migrated.max);
      migratedGale = true;
    }

    if (c.tieProtection) {
      const cb = $("tieProtection");
      if (cb) cb.checked = true;
      state.tieProtection = true;
    }
    renderGaleLevels();

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
    if (c.bettingHouse) state.bettingHouseId = String(c.bettingHouse);
    renderHouseOptions();
    if ($("fullscreenOnLoad")) {
      $("fullscreenOnLoad").checked = c.fullscreenOnLoad !== false;
    }
    if ($("tieDuploSeco")) $("tieDuploSeco").checked = !!c.tieDuploSeco;
    if ($("cycleEnabled")) $("cycleEnabled").checked = !!c.cycleEnabled;
    renderCycleHint();
    setVal("tieDuploSecoChip", c.tieDuploSecoChip ?? 5);
    updateTieDuploSecoHint();
    updateEntryLeadVisibility();
    syncEntryTimingStrategy();

    updateStatusLabel();
    _configLoaded = true;
    renderHouseOptions();
    // Config antiga convertida para a tabela: grava depois de carregar o resto.
    if (migratedGale) saveConfig();
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


/* ========== Comandos do bot do Telegram ========== */
function tgPlacarLines() {
  return [
    `🔁 Gale: ${galeStepLabel(state.galeStep)}`,
    `✅ Greens: ${state.wins}`,
    `❌ Reds: ${state.losses}`,
    `💰 Resultado: ${formatSignedCurrency(state.totalPnl)}`,
  ];
}

async function tgStatusText() {
  const stopWin = parseFloat($("stopWin")?.value) || 0;
  const stopLoss = parseFloat($("stopLoss")?.value) || 0;
  const lido = await readBanca({ retries: 4, delayMs: 300 });
  const lines = [
    state.autoMode ? "▶️ Automação ligada (Bac Bo Listas)" : "⏹ Automação desligada (Bac Bo Listas)",
    lido != null ? "✅ Mesa aberta" : "🔒 Mesa fechada",
  ];
  // Igual ao Automático: sem mesa, mostra o último saldo lido.
  if (_banca.current != null) lines.push(`💰 Banca: ${formatBrl(_banca.current)}`);
  const delta = bancaSessionDelta();
  if (delta != null) {
    const icon = delta > 0 ? "📈" : delta < 0 ? "📉" : "➖";
    lines.push(`${icon} P&L da banca: ${formatBrl(delta)}`);
  }
  lines.push(
    "",
    `🎯 Entradas: ${state.betCount}`,
    ...tgPlacarLines(),
    `🏁 Stop Win: ${stopWin > 0 ? formatCurrency(stopWin) : "desligado"}`,
    `🛑 Stop Loss: ${stopLoss > 0 ? formatCurrency(stopLoss) : "desligado"}`,
  );
  if (_pendingBet?.awaiting) lines.push("⏳ Aposta aguardando resultado");
  if (_releaseInfo?.available && _releaseInfo.latest) {
    lines.push("", `⬆️ Atualização ${_releaseInfo.latest} disponível — baixe o zip no painel da extensão`);
  }
  return lines.join("\n");
}

async function executeTelegramCommand(action, payload = null) {
  if (action === "status") {
    return { ok: true, text: await tgStatusText() };
  }
  if (action === "resetarplacar") {
    resetPlacar();
    showToast("Placar zerado pelo Telegram", "info");
    return { ok: true, text: ["ℹ️ Placar zerado.", ...tgPlacarLines()].join("\n") };
  }
  if (action === "alterarmeta") {
    const value = Number(String(payload ?? "").replace(",", "."));
    if (!Number.isFinite(value) || value < 0 || value > 999999.99) {
      return { ok: false, text: "⚠️ Valor de Stop Win inválido." };
    }
    const stopWin = Math.round(value * 100) / 100;
    if ($("stopWin")) $("stopWin").value = stopWin;
    saveConfig();
    showToast(stopWin === 0 ? "Stop Win desligado" : `Stop Win: ${formatCurrency(stopWin)}`, "info");
    return {
      ok: true,
      text: stopWin === 0 ? "ℹ️ Stop Win desligado." : `ℹ️ Stop Win da sessão: ${formatCurrency(stopWin)}`,
    };
  }
  if (action === "alterarstoploss") {
    const value = Number(String(payload ?? "").replace(",", "."));
    if (!Number.isFinite(value) || value < 0 || value > 999999.99) {
      return { ok: false, text: "⚠️ Valor de Stop Loss inválido." };
    }
    const stopLoss = Math.round(value * 100) / 100;
    if ($("stopLoss")) $("stopLoss").value = stopLoss;
    saveConfig();
    showToast(stopLoss === 0 ? "Stop Loss desligado" : `Stop Loss: ${formatCurrency(stopLoss)}`, "info");
    return {
      ok: true,
      text: stopLoss === 0 ? "ℹ️ Stop Loss desligado." : `ℹ️ Stop Loss da sessão: ${formatCurrency(stopLoss)}`,
    };
  }
  if (action === "inserirlista") {
    if (state.autoMode) {
      return { ok: false, text: "⚠️ Pare a automação (/parar) antes de trocar a lista." };
    }
    const count = Strategies.importScheduleText(payload);
    if (count === 0) {
      return { ok: false, text: "⚠️ Nenhuma entrada reconhecida. A lista atual foi mantida." };
    }
    showToast(`Lista do Telegram: ${count} entrada(s)`, "success");
    return { ok: true, text: `✅ ${count} entrada(s) carregadas` };
  }
  if (action === "ligar") {
    if (state.autoMode) return { ok: true, text: "ℹ️ A automação já está ligada." };
    const started = await startAutomationChecked({ silent: true });
    if (!started.ok) return { ok: false, text: `⚠️ ${started.text}` };
    return { ok: true, text: "ℹ️ Apostador ativo. Aguardando entrada automática..." };
  }
  if (action === "parar") {
    if (!state.autoMode) return { ok: true, text: "ℹ️ A automação já está desligada." };
    toggleAutoMode({ silent: true });
    return { ok: true, text: ["ℹ️ Automação desligada.", ...tgPlacarLines()].join("\n") };
  }
  return { ok: false, text: "⚠️ Comando desconhecido." };
}
