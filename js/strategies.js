/* ==========================================================================
   BacList — strategies.js
   Gerencia a lista de entradas por horário.

   Formato da lista (colado pelo usuário):
     HH:MM 🔵🟠   → entrar em Azul (Jogador)
     HH:MM 🔴🟠   → entrar em Vermelho (Casa)
   O emoji laranja/amarelo (🟠/🟡) é ignorado — apenas o primeiro emoji importa.

   Funcionamento:
   - O monitoramento é iniciado automaticamente ao abrir a extensão (chamado
     pelo popup.js via Strategies.startMonitor()).
   - A cada segundo, verifica se o horário atual bate com alguma entrada da lista.
   - Quando o horário chega, dispara o sinal uma única vez.
   - Se o modo Auto estiver ligado na aba Apostas, executa a aposta.
   ========================================================================== */

"use strict";

const Strategies = (() => {
  /* ── Constantes ─────────────────────────────────────── */
  const STORAGE_KEY = "bacboSchedule"; // chave no chrome.storage.local
  const MONITOR_KEY = "bacboMonitorRunning";
  const COLOR_LABELS = { A: "Azul", V: "Verm.", T: "Emp." };
  const COLOR_CLASSES = { A: "color-blue", V: "color-red", T: "color-yellow" };
  const TARGET_LABELS = { A: "Azul", V: "Vermelho", T: "Empate" };
  const TARGET_ICONS = { A: "🔵", V: "🔴", T: "🟡" };
  const GALE_STEP_LABELS = ["na entrada", "no Gale 1", "no Gale 2"];
  const IN_PROGRESS_STATUSES = ["waiting", "scheduled", "pending", "gale"];
  const SLOT_STATUS_RANK = {
    waiting: 0,
    scheduled: 1,
    pending: 2,
    gale: 3,
    loss: 4,
    green: 5,
    refund: 5,
  };

  /* Emojis aceitos por cor */
  const BLUE_EMOJIS = ["🔵", "🟦"];
  const RED_EMOJIS = ["🔴", "🟥"];
  const TIE_EMOJIS = ["🟠", "🟡", "🟧", "🟨"]; // só-empate quando não há azul/vermelho

  /* ── Estado interno ──────────────────────────────────── */
  let _schedule = []; // [{ hh, mm, target: 'A'|'V'|'T' }]
  let _scheduleType = "none"; // 'none' | 'tie' | 'color' | 'mixed'
  let _monitorRunning = false;
  let _autoEnabled = false; // true somente quando popup.js liga a automação
  let _liveHistory = [];
  let _firedKeys = new Set(); // "HH:MM" já disparados neste ciclo de monitoramento
  let _preflightKeys = new Set(); // horários já preparados 2 min antes
  let _preflightRequests = new Set();
  let _tickInterval = null;
  let _lastHistorySig = null; // assinatura do último histórico (detecção de novo item)

  /* Catálogo temporário por horário: pending → green | loss (memória da sessão) */
  let _signalCatalog = new Map(); // "HH:MM" → slot
  let _activeSlotKey = null; // horário da sequência de aposta em curso
  let _firingSignal = false; // mutex: impede dois disparos simultâneos
  let _entryTimingMode = "exact"; // "exact" | "before"
  let _entryLeadSeconds = 1; // 1..60 quando o modo for "before"
  const ENTRY_STALE_MIN = 45; // sem rodada até aqui → horário expira (não dispara mais)
  const ENTRY_TRIGGER_GRACE_MS = 70000; // uma janela de rodada; evita disparar entrada antiga acumulada
  const ENTRY_PREFLIGHT_MS = 2 * 60 * 1000;
  const ENTRY_PREFLIGHT_CUTOFF_MS = 15 * 1000;
  let _lastTickDate = null;
  let _patternGuardConfig = PatternGuard.normalizeConfig(
    PatternGuard.DEFAULT_CONFIG,
  );

  const $ = (id) => document.getElementById(id);

  /* ══════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════ */
  function init() {
    _loadSchedule();
    _bindScheduleUI();
    _bindSignalLog();
    _listenContentMessages();
  }

  /* ══════════════════════════════════════════════════════
     PERSISTÊNCIA
  ══════════════════════════════════════════════════════ */
  function _loadSchedule() {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      const saved = data[STORAGE_KEY];
      if (saved) {
        _schedule = saved.schedule || [];
        _preflightKeys.clear();
        _preflightRequests.clear();
        _scheduleType = _detectScheduleType(_schedule);

        const textarea = $("scheduleInput");
        if (textarea) textarea.value = saved.rawText || "";

        _renderSchedulePreview();
        _notifyScheduleType();
      }
    });
  }

  function _saveSchedule(rawText) {
    chrome.storage.local.set({
      [STORAGE_KEY]: {
        rawText,
        schedule: _schedule,
      },
    });
  }

  /* ══════════════════════════════════════════════════════
     PARSER DE LISTA
     Aceita linhas como:
       "12:18 🔵🟠"  →  { hh:12, mm:18, target:'A' }  (Azul; 🟠 = proteção ignorada)
       "12:32 🔴🟠"  →  { hh:12, mm:32, target:'V' }  (Vermelho)
       "🟠11:31"     →  { hh:11, mm:31, target:'T' }  (somente Empate)
     Prioridade: azul > vermelho > empate. Linhas só com 🟠/🟡 viram aposta
     exclusiva no Empate (clica a ficha de 5 e depois o Empate).
  ══════════════════════════════════════════════════════ */
  function _parseScheduleText(text) {
    const lines = text.split(/\r?\n/);
    const entries = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      // Extrair HH:MM
      const timeMatch = line.match(/(\d{1,2}):(\d{2})/);
      if (!timeMatch) continue;

      const hh = parseInt(timeMatch[1], 10);
      const mm = parseInt(timeMatch[2], 10);
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) continue;

      // Extrair cor pelo emoji: azul e vermelho têm prioridade; só-empate vira 'T'
      let target = null;
      for (const em of BLUE_EMOJIS) {
        if (line.includes(em)) {
          target = "A";
          break;
        }
      }
      if (!target) {
        for (const em of RED_EMOJIS) {
          if (line.includes(em)) {
            target = "V";
            break;
          }
        }
      }
      if (!target) {
        for (const em of TIE_EMOJIS) {
          if (line.includes(em)) {
            target = "T";
            break;
          }
        }
      }
      if (!target) continue; // linha sem emoji reconhecido

      entries.push({ hh, mm, target });
    }

    // Ordenar por horário
    entries.sort((a, b) => a.hh * 60 + a.mm - (b.hh * 60 + b.mm));
    return entries;
  }

  function _detectScheduleType(entries) {
    if (!entries.length) return "none";
    const hasTie = entries.some((e) => e.target === "T");
    const hasColor = entries.some((e) => e.target === "A" || e.target === "V");
    if (hasTie && !hasColor) return "tie";
    if (hasColor && !hasTie) return "color";
    return "mixed";
  }

  /* ══════════════════════════════════════════════════════
     BIND UI — LISTA DE HORÁRIOS
  ══════════════════════════════════════════════════════ */
  function _bindScheduleUI() {
    $("btnSaveSchedule")?.addEventListener("click", () => {
      const textarea = $("scheduleInput");
      const rawText = textarea?.value || "";

      _schedule = _parseScheduleText(rawText);
      _preflightKeys.clear();
      _preflightRequests.clear();
      _scheduleType = _detectScheduleType(_schedule);
      _saveSchedule(rawText);
      _renderSchedulePreview();
      _notifyScheduleType();

      if (_schedule.length > 0) {
        _showToast(`${_schedule.length} entrada(s) salvas!`, "success");
      } else {
        _showToast(
          "Nenhuma entrada reconhecida. Verifique o formato.",
          "error",
        );
      }
    });

    $("btnClearSchedule")?.addEventListener("click", () => {
      const textarea = $("scheduleInput");
      if (textarea) textarea.value = "";
      _schedule = [];
      _preflightKeys.clear();
      _preflightRequests.clear();
      _scheduleType = "none";
      _saveSchedule("");
      _renderSchedulePreview();
      _notifyScheduleType();
      _showToast("Lista limpa", "info");
    });

    $("scheduleInput")?.addEventListener("input", () => {
      const rawText = $("scheduleInput")?.value || "";
      const preview = _parseScheduleText(rawText);
      const type = _detectScheduleType(preview);
      if (typeof onScheduleTypeChanged === "function") {
        onScheduleTypeChanged(type);
      }
    });
  }

  function _notifyScheduleType() {
    // Notifica popup.js para mostrar/ocultar cards de apostas
    if (typeof onScheduleTypeChanged === "function") {
      onScheduleTypeChanged(_scheduleType);
    }
  }

  function _renderSchedulePreview() {
    const preview = $("schedulePreview");
    const countEl = $("schedulePreviewCount");
    const activeEl = $("schedulePreviewActive");
    const nextEl = $("schedulePreviewNext");
    if (!preview) return;

    if (!_schedule.length) {
      preview.style.display = "none";
      return;
    }

    preview.style.display = "block";
    if (countEl)
      countEl.textContent = `${_schedule.length} entrada(s) carregada(s)`;

    const pad = (n) => String(n).padStart(2, "0");

    if (activeEl) {
      const inProgress = _getInProgressSlot();
      if (inProgress) {
        activeEl.style.display = "block";
        activeEl.innerHTML =
          `<i class="fas fa-satellite-dish"></i> Em andamento: ` +
          `<strong>${_escHtml(inProgress.scheduleTime)}</strong> ` +
          `${inProgress.icon} <span class="${COLOR_CLASSES[inProgress.target] || ""}">${_escHtml(inProgress.label)}</span>` +
          ` <span class="schedule-preview-status">— ${_escHtml(_slotStatusText(inProgress))}</span>`;
      } else {
        activeEl.style.display = "none";
        activeEl.innerHTML = "";
      }
    }

    if (nextEl) {
      const next = _getNextEntry();
      if (next) {
        const icon = TARGET_ICONS[next.target] || "⚪";
        const label = TARGET_LABELS[next.target] || next.target;
        nextEl.innerHTML = `<i class="fas fa-clock"></i> Próxima: <strong>${pad(next.hh)}:${pad(next.mm)}</strong> ${icon} <span class="${COLOR_CLASSES[next.target]}">${label}</span>`;
      } else {
        nextEl.textContent = "Sem próxima entrada para hoje";
      }
    }

    _updateHeaderNextEntry(pad);
  }

  function _updateHeaderNextEntry(pad) {
    const el = $("headerNextEntry");
    if (!el) return;

    const inProgress = _getInProgressSlot();
    if (inProgress) {
      el.style.display = "flex";
      el.classList.add("in-progress");
      const icon = TARGET_ICONS[inProgress.target] || "⚪";
      const label = TARGET_LABELS[inProgress.target] || inProgress.target;
      el.innerHTML = `<i class="fas fa-satellite-dish"></i> Em andamento: <strong>${_escHtml(inProgress.scheduleTime)}</strong> ${icon} ${_escHtml(label)}`;
      return;
    }

    const next = _getNextEntry();
    if (next) {
      el.style.display = "flex";
      el.classList.remove("in-progress");
      const icon = TARGET_ICONS[next.target] || "⚪";
      const label = TARGET_LABELS[next.target] || next.target;
      el.innerHTML = `<i class="fas fa-clock"></i> Próxima: <strong>${pad(next.hh)}:${pad(next.mm)}</strong> ${icon} ${label}`;
    } else {
      el.style.display = "none";
      el.classList.remove("in-progress");
    }
  }

  function _getInProgressSlot() {
    if (_activeSlotKey) {
      const slot = _signalCatalog.get(_activeSlotKey);
      if (slot && IN_PROGRESS_STATUSES.includes(slot.status)) return slot;
    }

    for (const slot of _signalCatalog.values()) {
      if (IN_PROGRESS_STATUSES.includes(slot.status)) return slot;
    }

    return null;
  }

  function _getNextEntry() {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return _schedule.find((e) => e.hh * 60 + e.mm > nowMin) || null;
  }

  /* ══════════════════════════════════════════════════════
     MONITORAMENTO — iniciado automaticamente pelo popup.js
  ══════════════════════════════════════════════════════ */

  async function _startMonitor() {
    if (_monitorRunning) return;

    // Vincular aba evo-games (background procura em todas as abas abertas)
    try {
      const r = await chrome.runtime.sendMessage({
        action: "startHistoryPolling",
      });
      if (!r?.success && r?.error) {
        console.warn("[BacList] Polling:", r.error);
        _showToast(r.error, "error");
      }
    } catch (err) {
      console.warn("[BacList] startHistoryPolling:", err?.message || err);
    }

    _monitorRunning = true;
    _firedKeys = new Set();
    _lastHistorySig = null;
    _updateMonitorUI();
    _startTick();
    chrome.runtime
      .sendMessage({ action: "startInactivityPolling" })
      .catch(() => {});
  }

  async function _stopMonitor() {
    try {
      chrome.runtime.sendMessage({ action: "stopHistoryPolling" });
    } catch (_) {}
    chrome.runtime
      .sendMessage({ action: "stopInactivityPolling" })
      .catch(() => {});

    _monitorRunning = false;
    _stopTick();
    _updateMonitorUI();
  }

  function _updateMonitorUI() {
    const dot = $("monitorDot");
    const label = $("monitorLabel");
    const btn = $("btnMonitor");
    const btnLbl = $("monitorBtnLabel");

    if (_monitorRunning) {
      if (dot) dot.className = "monitor-dot active";
      if (label) label.textContent = "Monitorando ao vivo...";
      if (btn) btn.className = "btn-monitor-toggle stop";
      if (btnLbl) btnLbl.textContent = "Parar";
    } else {
      if (dot) dot.className = "monitor-dot";
      if (label) label.textContent = "Monitoramento inativo";
      if (btn) btn.className = "btn-monitor-toggle";
      if (btnLbl) btnLbl.textContent = "Iniciar";
    }
  }

  /* ══════════════════════════════════════════════════════
     TICK — verificação a cada segundo
  ══════════════════════════════════════════════════════ */
  function _startTick() {
    _stopTick();
    _tickInterval = setInterval(_tick, 1000);
  }

  function _stopTick() {
    if (_tickInterval) {
      clearInterval(_tickInterval);
      _tickInterval = null;
    }
  }

  // O tick NÃO dispara apostas (histórico novo → _onHistoryUpdate). Aqui: preview,
  // expira horários sem rodada e limpa chaves à meia-noite.
  function _tick() {
    if (!_monitorRunning) return;

    const now = new Date();
    const today = now.toDateString();
    if (_lastTickDate && _lastTickDate !== today) {
      _firedKeys.clear();
      _preflightKeys.clear();
      _preflightRequests.clear();
      _clearSignalCatalog();
    }
    _lastTickDate = today;

    _runEntryPreflights(now);

    let catalogChanged = _discardMissedEntries(now);

    if (_schedule.length) {
      for (const entry of _schedule) {
        const key = _entryKey(entry);
        if (!_firedKeys.has(key)) {
          const entryMs = _entryDateTime(entry, now);
          if (now.getTime() > entryMs.getTime() + ENTRY_STALE_MIN * 60 * 1000) {
            _firedKeys.add(key);
            if (_markSlotExpired(key)) catalogChanged = true;
            console.warn("[BacList] Horário expirado sem entrada:", key);
          }
        }
      }
    }

    if (_syncWaitingSlots()) catalogChanged = true;

    if (catalogChanged) {
      _renderSignalLog();
    }
    _renderSchedulePreview();
  }

  function _entryKey(e) {
    return `${e.hh}:${String(e.mm).padStart(2, "0")}`;
  }

  function _entryDateTime(e, refNow) {
    const d = new Date(refNow);
    d.setHours(e.hh, e.mm, 0, 0);
    return d;
  }

  function _clampEntryLeadSeconds(value) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return 1;
    return Math.min(60, Math.max(1, n));
  }

  function _setEntryTiming(mode, leadSeconds) {
    _entryTimingMode = mode === "before" ? "before" : "exact";
    _entryLeadSeconds = _clampEntryLeadSeconds(leadSeconds);
    _preflightKeys.clear();
    _preflightRequests.clear();
    if (_autoEnabled) _runEntryPreflights(new Date());
  }

  function _entryTriggerDateTime(e, refNow) {
    const d = _entryDateTime(e, refNow);
    if (_entryTimingMode === "before") {
      d.setSeconds(d.getSeconds() - _entryLeadSeconds);
    }
    return d;
  }

  function _runEntryPreflights(now) {
    if (!_autoEnabled || !_schedule.length) return;

    const nowMs = now.getTime();
    for (const entry of _schedule) {
      const key = _entryKey(entry);
      if (_preflightKeys.has(key) || _preflightRequests.has(key)) continue;

      const triggerMs = _entryTriggerDateTime(entry, now).getTime();
      const preflightMs = triggerMs - ENTRY_PREFLIGHT_MS;
      if (nowMs < preflightMs || nowMs >= triggerMs) continue;

      if (nowMs > triggerMs - ENTRY_PREFLIGHT_CUTOFF_MS) {
        _preflightKeys.add(key);
        console.warn(
          "[BacList][Pré-entrada] Reabertura ignorada nos últimos 15s:",
          key,
        );
        continue;
      }

      if (typeof _pendingBet !== "undefined" && _pendingBet?.awaiting) {
        continue;
      }

      _preflightRequests.add(key);
      console.log(
        "[BacList][Pré-entrada] Reabrindo BacBo antes de",
        key,
      );
      chrome.runtime
        .sendMessage({
          action: "reopenGameForEntry",
          scheduleKey: key,
        })
        .then((result) => {
          _preflightRequests.delete(key);
          if (result?.success && _autoEnabled) {
            _preflightKeys.add(key);
            console.log("[BacList][Pré-entrada] Jogo preparado:", key);
          } else {
            console.warn(
              "[BacList][Pré-entrada] Falha ao reabrir:",
              result?.error || key,
            );
          }
        })
        .catch((error) => {
          _preflightRequests.delete(key);
          console.warn(
            "[BacList][Pré-entrada] Erro ao reabrir:",
            error?.message || error,
          );
        });
    }
  }

  function _discardMissedEntries(now) {
    let changed = false;
    const nowMs = now.getTime();

    for (const entry of _schedule) {
      const key = _entryKey(entry);
      if (_firedKeys.has(key)) continue;

      const triggerMs = _entryTriggerDateTime(entry, now).getTime();
      if (nowMs <= triggerMs + ENTRY_TRIGGER_GRACE_MS) continue;

      _firedKeys.add(key);
      if (_markSlotExpired(key)) changed = true;
      console.warn("[BacList] Entrada fora da janela descartada:", key);
    }

    return changed;
  }

  /* ══════════════════════════════════════════════════════
     DISPARAR SINAL
  ══════════════════════════════════════════════════════ */
  function _ensureCatalogSlot(entry, status) {
    const key = _entryKey(entry);
    const existing = _signalCatalog.get(key);

    if (existing?.status === "green") return false;
    if (existing?.status === status && status !== "gale") return false;

    const curRank = existing ? (SLOT_STATUS_RANK[existing.status] ?? -1) : -1;
    const newRank = SLOT_STATUS_RANK[status] ?? -1;
    if (existing && curRank > newRank) return false;

    const pad = (n) => String(n).padStart(2, "0");
    const label = TARGET_LABELS[entry.target] || entry.target;
    const icon = TARGET_ICONS[entry.target] || "⚪";

    _signalCatalog.set(key, {
      scheduleKey: key,
      scheduleTime: `${pad(entry.hh)}:${pad(entry.mm)}`,
      target: entry.target,
      label,
      icon,
      status,
      galeNum: existing?.galeNum ?? 0,
      wonAtStep: existing?.wonAtStep ?? null,
      attempts: existing?.attempts ?? 0,
      firedAt: existing?.firedAt ?? Date.now(),
      resolvedAt: existing?.resolvedAt ?? null,
    });

    return true;
  }

  function _syncWaitingSlots() {
    if (!_autoEnabled) return false;
    const entry = _getActiveEntry();
    if (!entry) return false;
    return _ensureCatalogSlot(entry, "waiting");
  }

  function _markSlotExpired(key) {
    const slot = _signalCatalog.get(key);
    if (!slot || !IN_PROGRESS_STATUSES.includes(slot.status)) return false;

    slot.status = "loss";
    slot.expired = true;
    slot.attempts = 0;
    slot.resolvedAt = Date.now();
    if (_activeSlotKey === key) _activeSlotKey = null;
    return true;
  }

  function _refreshSignalUI() {
    _renderSignalLog();
    _renderSchedulePreview();
  }

  function _refundSignal(entry, match) {
    const key = _entryKey(entry);
    const slot = _signalCatalog.get(key);
    if (!slot) return;

    slot.status = "refund";
    slot.refundReason = match.reason;
    slot.patternRule = match.rule;
    slot.patternSnapshot = match.snapshot;
    slot.expected = match.expected;
    slot.attempts = 0;
    slot.resolvedAt = Date.now();
    if (_activeSlotKey === key) _activeSlotKey = null;

    if (typeof recordPatternRefund === "function") {
      recordPatternRefund(entry.target, match);
    }

    console.info("[BacList] Entrada abortada por padrão", {
      horario: key,
      alvo: entry.target,
      esperado: match.expected,
      regra: match.rule,
      historico: match.snapshot,
    });
    _showToast(`Reembolso: ${match.reason}`, "info");
    _refreshSignalUI();
  }

  function _fireSignal(entry) {
    const key = _entryKey(entry);

    // Mutex: se já está disparando uma entrada, ignorar esta
    if (_firingSignal) {
      console.warn("[BacList] Disparo ignorado (outro em andamento):", key);
      return;
    }

    // Se há aposta aguardando resultado, não interromper
    if (typeof _pendingBet !== "undefined" && _pendingBet?.awaiting) {
      console.warn("[BacList] Disparo ignorado (aposta pendente):", key);
      return;
    }

    const patternMatch = PatternGuard.evaluate(
      _liveHistory,
      entry.target,
      _patternGuardConfig,
    );
    if (patternMatch.abort) {
      _refundSignal(entry, patternMatch);
      return;
    }

    if (_activeSlotKey && _activeSlotKey !== key) {
      _abortSlot(_activeSlotKey);
    }

    _activeSlotKey = key;
    _firingSignal = true;
    if (_ensureCatalogSlot(entry, "pending")) _refreshSignalUI();

    // Libera o mutex após a aposta ser colocada (executeBet é async, 200ms de margem)
    _triggerAutoPlay(entry.target);

    setTimeout(() => {
      _firingSignal = false;
    }, 500);
  }

  /* ══════════════════════════════════════════════════════
     MENSAGENS DO CONTENT.JS (histórico ao vivo)
  ══════════════════════════════════════════════════════ */
  function _listenContentMessages() {
    /* historyUpdate é roteado pelo popup.js (evita _onNewRound duplicado) */
  }

  function _onHistoryUpdate(history) {
    const empty = {
      isNewRound: false,
      isBaseline: false,
      monitorOff: !_monitorRunning,
      schedule: null,
    };
    if (!_monitorRunning) return empty;

    _liveHistory = history || [];
    _updateHistoryPreview();

    const last = _liveHistory[_liveHistory.length - 1];
    const sig = _liveHistory.length + ":" + (last ? last.cor : "");

    if (_lastHistorySig === null) {
      _lastHistorySig = sig;
      return { ...empty, isBaseline: true };
    }
    if (sig === _lastHistorySig) return empty;

    _lastHistorySig = sig;
    return {
      isNewRound: true,
      isBaseline: false,
      monitorOff: false,
      schedule: _onNewRound(),
    };
  }

  /* ══════════════════════════════════════════════════════
     NOVO ITEM DE HISTÓRICO → verifica horário ativo e entra
  ══════════════════════════════════════════════════════ */
  function _makeScheduleInfo(entry) {
    return {
      hadActiveEntry: !!entry,
      entry: entry
        ? { hh: entry.hh, mm: entry.mm, target: entry.target }
        : null,
      betScheduled: false,
      betSkippedReason: null,
    };
  }

  function _scheduleEntryTrigger(entry, info, source) {
    if (!entry) {
      info.betSkippedReason =
        source === "clock"
          ? "nenhum horario ativo pelo relogio"
          : "nenhum horario aguardando entrada";
      return info;
    }

    const key = _entryKey(entry);
    if (_firedKeys.has(key)) {
      info.betSkippedReason = "entrada ja disparada em " + key;
      return info;
    }

    if (!_autoEnabled) {
      _firedKeys.add(key);
      info.betSkippedReason = "automacao desligada";
      return info;
    }

    _firedKeys.add(key);
    info.betScheduled = true;
    if (_ensureCatalogSlot(entry, "scheduled")) _refreshSignalUI();
    console.log(
      "[BacList] Entrada por",
      source === "clock" ? "relogio" : "historico",
      key,
      "-> aguardando footer expandido ->",
      entry.target,
    );
    (async () => {
      try {
        await chrome.runtime.sendMessage({ action: "waitForFooterExpanded" });
      } catch (_) {
        /* popup pode ter fechado antes da resposta */
      }
      _fireSignal(entry);
    })();
    return info;
  }
  function _onNewRound() {
    const entry = _getActiveEntry();
    const info = _makeScheduleInfo(entry);
    return _scheduleEntryTrigger(entry, info, "history");
  }
  function _getActiveEntrySnapshot() {
    const entry = _getActiveEntry();
    return entry ? { hh: entry.hh, mm: entry.mm, target: entry.target } : null;
  }

  /* 1ª rodada possível após HH:MM:00 — agora > horário e ainda não disparado.
     Vários horários: escolhe o mais recente já ultrapassado (ex.: 17:51 → 17:50, não 17:20). */
  function _getActiveEntry() {
    if (!_schedule.length) return null;
    const now = new Date();
    const nowMs = now.getTime();
    let best = null;
    let bestMs = -1;

    for (const e of _schedule) {
      const key = _entryKey(e);
      if (_firedKeys.has(key)) continue;

      const entryMs = _entryTriggerDateTime(e, now);
      const triggerMs = entryMs.getTime();
      if (nowMs < triggerMs) continue;
      if (nowMs > triggerMs + ENTRY_TRIGGER_GRACE_MS) continue;

      if (triggerMs > bestMs) {
        bestMs = triggerMs;
        best = e;
      }
    }
    return best;
  }

  /* ══════════════════════════════════════════════════════
     DISPARAR APOSTA AUTOMÁTICA (integração com popup.js)
  ══════════════════════════════════════════════════════ */
  function _triggerAutoPlay(colorTarget) {
    if (typeof state === "undefined" || !state.autoMode) {
      console.warn(
        "[BacList] Auto OFF — entrada programada não executada",
        colorTarget,
      );
      return;
    }
    if (typeof executeBet !== "function") return;

    // Se há aposta aguardando resultado, não interromper — apenas registrar no catálogo
    // e aguardar. O próximo ciclo tentará novamente após o resultado ser processado.
    if (typeof _pendingBet !== "undefined" && _pendingBet?.awaiting) {
      console.warn(
        "[BacList] Aposta anterior ainda pendente — novo sinal aguardando:",
        colorTarget,
      );
      return;
    }

    executeBet(colorTarget, { resetGale: true, forceEntry: false });
  }

  function _signalGreen(galeStep) {
    const key = _activeSlotKey;
    if (!key) return;
    const slot = _signalCatalog.get(key);
    if (!slot || slot.status === "green") return;

    slot.status = "green";
    slot.wonAtStep = galeStep ?? 0;
    slot.attempts = Math.max(slot.attempts, (galeStep ?? 0) + 1);
    slot.resolvedAt = Date.now();
    _activeSlotKey = null;
    _refreshSignalUI();
  }

  function _signalLoss(roundsWatched) {
    const key = _activeSlotKey;
    if (!key) return;
    const slot = _signalCatalog.get(key);
    if (!slot || slot.status === "green") return;

    slot.status = "loss";
    slot.attempts = roundsWatched || 1;
    slot.resolvedAt = Date.now();
    _activeSlotKey = null;
    _refreshSignalUI();
  }

  function _signalGale(galeNum) {
    const key = _activeSlotKey;
    if (!key) return;
    const slot = _signalCatalog.get(key);
    if (!slot || slot.status === "green") return;

    slot.status = "gale";
    slot.galeNum = galeNum;
    slot.attempts = galeNum;
    _refreshSignalUI();
  }

  function _abortSlot(key) {
    if (!key) return;
    const slot = _signalCatalog.get(key);
    if (!slot || slot.status === "green") return;

    slot.status = "loss";
    slot.attempts = Math.max(slot.attempts, slot.galeNum || 1);
    slot.resolvedAt = Date.now();
    if (_activeSlotKey === key) _activeSlotKey = null;
    _refreshSignalUI();
  }

  function _getActiveSlotKey() {
    return _activeSlotKey;
  }

  /* ══════════════════════════════════════════════════════
     LOG DE SINAIS — um card por horário (catálogo temporário)
  ══════════════════════════════════════════════════════ */
  const SIGNAL_EMPTY_HTML = `
    <div class="empty-state">
      <i class="fas fa-satellite-dish fa-2x"></i>
      <p>Aguardando detecção...</p>
    </div>`;

  function _getSignalLogs() {
    return document.querySelectorAll(".signals-log");
  }

  function _bindSignalLog() {
    document.querySelectorAll(".btn-clear-signals").forEach((btn) => {
      btn.addEventListener("click", _clearSignalCatalog);
    });
  }

  function _clearSignalCatalog() {
    _signalCatalog.clear();
    _activeSlotKey = null;
    _firingSignal = false;
    _refreshSignalUI();
  }

  function _formatSignalClock(ts) {
    return new Date(ts).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function _slotStatusText(slot) {
    if (slot.status === "waiting") {
      return "Horário ativo — aguardando 1ª rodada...";
    }
    if (slot.status === "scheduled") {
      return "Entrada agendada — aguardando mesa...";
    }
    if (slot.status === "green") {
      const where = GALE_STEP_LABELS[slot.wonAtStep] || "na entrada";
      return `GREEN — vitória ${where}`;
    }
    if (slot.status === "loss") {
      if (slot.expired) return "LOSS — expirado sem rodada";
      const n = slot.attempts || 1;
      return `LOSS — ${n} tentativa${n > 1 ? "s" : ""}`;
    }
    if (slot.status === "refund") {
      return `REEMBOLSO — ${slot.refundReason || "entrada abortada por padrão"}`;
    }
    if (slot.status === "gale") {
      return `Gale ${slot.galeNum} — aguardando resultado...`;
    }
    return "Entrada disparada — aguardando resultado...";
  }

  function _slotIconClass(slot) {
    if (slot.status === "green") return "fa-circle-check";
    if (slot.status === "loss") return "fa-circle-xmark";
    if (slot.status === "refund") return "fa-rotate-left";
    if (slot.status === "gale") return "fa-rotate";
    if (slot.status === "waiting") return "fa-clock";
    if (slot.status === "scheduled") return "fa-hourglass-half";
    return "fa-bolt";
  }

  function _slotCssClass(slot) {
    if (slot.status === "green") return "signal-green";
    if (slot.status === "loss") return "signal-loss";
    if (slot.status === "refund") return "signal-refund";
    if (slot.status === "gale") return "signal-gale";
    if (slot.status === "waiting") return "signal-waiting";
    if (slot.status === "scheduled") return "signal-scheduled";
    return "signal-entry signal-pending";
  }

  function _slotHtml(slot) {
    const clock = _formatSignalClock(slot.resolvedAt || slot.firedAt);
    const css = _slotCssClass(slot);
    const icon = _slotIconClass(slot);

    return `
      <div class="signal-item ${css}" data-schedule-key="${_escHtml(slot.scheduleKey)}">
        <div class="si-header">
          <span class="si-icon"><i class="fas ${icon}"></i></span>
          <span class="si-title">
            <strong>${_escHtml(slot.scheduleTime)}</strong>
            — ${slot.icon}
            <span class="${COLOR_CLASSES[slot.target] || ""}">${_escHtml(slot.label)}</span>
          </span>
          <span class="si-time">${clock}</span>
        </div>
        <div class="si-body">
          <span class="si-name">${_escHtml(_slotStatusText(slot))}</span>
        </div>
      </div>`;
  }

  function _renderSignalLog() {
    const logs = _getSignalLogs();
    if (!logs.length) return;

    const slots = Array.from(_signalCatalog.values()).sort(
      (a, b) => b.firedAt - a.firedAt,
    );

    const html = slots.length
      ? slots.map(_slotHtml).join("")
      : SIGNAL_EMPTY_HTML;
    logs.forEach((log) => {
      log.innerHTML = html;
    });
  }

  /* ══════════════════════════════════════════════════════
     PREVIEW DO HISTÓRICO AO VIVO
  ══════════════════════════════════════════════════════ */
  function _updateHistoryPreview() {
    const el = $("monitorHistoryPreview");
    if (!el) return;

    if (typeof renderHistoryBalls === "function") {
      renderHistoryBalls(el, _liveHistory, 10);
      return;
    }

    if (!_liveHistory.length) {
      el.innerHTML =
        '<span class="live-history-empty">Aguardando rodadas...</span>';
      return;
    }

    const last = _liveHistory.slice(-10);
    const ballClass = { A: "ball-blue", V: "ball-red", T: "ball-yellow" };
    el.innerHTML = last
      .map(
        (r) =>
          `<span class="hist-pip ${COLOR_CLASSES[r.cor] || ""}" title="${COLOR_LABELS[r.cor] || r.cor}"><span class="color-ball ${ballClass[r.cor] || ""}"></span></span>`,
      )
      .join("");
  }

  /* ══════════════════════════════════════════════════════
     UTILS
  ══════════════════════════════════════════════════════ */
  let _toastTimer;
  function _showToast(msg, type = "info") {
    let toast = document.querySelector(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    clearTimeout(_toastTimer);
    toast.textContent = msg;
    toast.className = `toast ${type}`;
    requestAnimationFrame(() => toast.classList.add("show"));
    _toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
  }

  function _escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ══════════════════════════════════════════════════════
     API pública
  ══════════════════════════════════════════════════════ */
  return {
    init,
    startMonitor: _startMonitor,
    stopMonitor: _stopMonitor,
    getPatterns: () => _schedule,
    getScheduleType: () => _scheduleType,
    setEntryTiming: _setEntryTiming,
    setPatternGuardConfig: (config) => {
      _patternGuardConfig = PatternGuard.normalizeConfig(config);
    },
    setAutoEnabled: (v) => {
      const turning_on = !!v && !_autoEnabled;
      _autoEnabled = !!v;

      if (turning_on) {
        // Descartar todas as entradas cujo horário já passou para não apostá-las retroativamente
        const now = new Date();
        for (const e of _schedule) {
          const key = _entryKey(e);
          if (_firedKeys.has(key)) continue;
          const entryMs = _entryTriggerDateTime(e, now);
          if (now.getTime() > entryMs.getTime()) {
            _firedKeys.add(key);
            console.log(
              "[BacList] Entrada passada descartada ao ligar automação:",
              key,
            );
          }
        }
        _runEntryPreflights(now);
      } else if (!_autoEnabled) {
        _preflightKeys.clear();
        _preflightRequests.clear();
      }
    },
    onHistoryUpdate: _onHistoryUpdate,
    signalGreen: _signalGreen,
    signalLoss: _signalLoss,
    signalGale: _signalGale,
    abortSlot: _abortSlot,
    getActiveSlotKey: _getActiveSlotKey,
    getActiveEntrySnapshot: _getActiveEntrySnapshot,
  };
})();
