/* ==========================================================================
   BacList — background.js (Service Worker)
   ========================================================================== */

"use strict";

/* ── Estado do polling ──────────────────────────────── */
let _pollTimer = null;
let _activeTabId = null;
let _lastHistoryHash = null;
let _inactivityPollTimer = null;
let _bettingInProgress = false;

/* ── Botão "Como jogar" — busca no iframe evo + clique CDP ── */
const HELP_BTN_SEL = '[data-role="help-button"]';
const HELP_BTN_ACTIVATED_SEL =
  '[data-role="help-button"][data-state="Activated"]';
const HELP_CHECK_MS = 10_000;
let _helpButtonTimer = null;

/* Sonda o botão no frame (autocontida — zero refs externas) */
function _probeHelpButtonInFrame() {
  const btn = document.querySelector('[data-role="help-button"]');
  const activated = document.querySelector(
    '[data-role="help-button"][data-state="Activated"]',
  );
  let rect = null;
  if (activated) {
    const r = activated.getBoundingClientRect();
    rect = {
      w: Math.round(r.width),
      h: Math.round(r.height),
      x: Math.round(r.left),
      y: Math.round(r.top),
    };
  }
  return {
    hasButton: !!btn,
    hasActivated: !!activated,
    state: btn?.getAttribute("data-state") || null,
    visible: rect ? rect.w >= 1 && rect.h >= 1 : false,
    rect,
    frameUrl: (location.href || "").slice(0, 120),
  };
}

/* Calcula coords do botão no viewport da aba (walk frameElement — autocontida) */
function _getHelpButtonTabViewportCoords() {
  const btn = document.querySelector(
    '[data-role="help-button"][data-state="Activated"]',
  );
  if (!btn) {
    const any = document.querySelector('[data-role="help-button"]');
    return {
      success: false,
      reason: any
        ? "state=" + (any.getAttribute("data-state") || "")
        : "not-found",
    };
  }

  btn.scrollIntoView({ block: "center", inline: "center" });
  const r = btn.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) {
    return { success: false, reason: "not-visible", w: r.width, h: r.height };
  }

  let x = r.left + r.width / 2;
  let y = r.top + r.height / 2;
  const chain = [
    {
      level: 0,
      localX: Math.round(x),
      localY: Math.round(y),
      src: (location.href || "").slice(0, 60),
    },
  ];

  let w = window;
  while (w !== w.top) {
    let fe = null;
    try {
      fe = w.frameElement;
    } catch (e) {
      return {
        success: false,
        reason: "frameElement-blocked",
        partialX: Math.round(x),
        partialY: Math.round(y),
        chain,
      };
    }
    if (!fe) break;

    const fr = fe.getBoundingClientRect();
    x += fr.left;
    y += fr.top;
    chain.push({
      level: chain.length,
      offsetLeft: Math.round(fr.left),
      offsetTop: Math.round(fr.top),
      cumX: Math.round(x),
      cumY: Math.round(y),
      tag: fe.tagName,
      src: (fe.src || fe.getAttribute("src") || "").slice(0, 60),
    });

    try {
      w = w.parent;
    } catch (e) {
      return {
        success: false,
        reason: "parent-blocked",
        partialX: Math.round(x),
        partialY: Math.round(y),
        chain,
      };
    }
  }

  return {
    success: true,
    x: Math.round(x),
    y: Math.round(y),
    localX: Math.round(r.left + r.width / 2),
    localY: Math.round(r.top + r.height / 2),
    chain,
    frameDepth: chain.length - 1,
  };
}

/* Dispara clique no botão Activated (autocontida — fallback se CDP falhar) */
function _dispatchHelpButtonClickInFrame() {
  const btn = document.querySelector(
    '[data-role="help-button"][data-state="Activated"]',
  );
  if (!btn) {
    const any = document.querySelector('[data-role="help-button"]');
    return {
      clicked: false,
      reason: any
        ? "state=" + (any.getAttribute("data-state") || "null")
        : "button-not-found",
      frameUrl: (location.href || "").slice(0, 120),
    };
  }

  btn.scrollIntoView({ block: "center", inline: "center" });
  const r = btn.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) {
    return {
      clicked: false,
      reason: "not-visible",
      rect: { w: r.width, h: r.height },
      frameUrl: location.href,
    };
  }

  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const types = [
    "pointerover",
    "pointerenter",
    "pointerdown",
    "mousedown",
    "mouseup",
    "click",
    "pointerup",
  ];
  types.forEach((type) => {
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: 0,
      buttons: type.includes("down") ? 1 : 0,
    };
    try {
      btn.dispatchEvent(
        new PointerEvent(type, {
          ...opts,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    } catch (_) {
      btn.dispatchEvent(new MouseEvent(type, opts));
    }
  });
  try {
    btn.click();
  } catch (_) {}

  return {
    clicked: true,
    state: "Activated",
    coords: { x: Math.round(cx), y: Math.round(cy) },
    frameUrl: (location.href || "").slice(0, 120),
  };
}

async function _scanHelpButtonFrames(tabId) {
  const results = [];
  const gameFrames = await _getGameFrames(tabId);
  const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
  const scanList = gameFrames.length ? gameFrames : allFrames || [];

  console.log(
    "[BacList][Help] Escaneando",
    scanList.length,
    "frame(s) evo, tabId=",
    tabId,
  );

  for (const f of scanList) {
    try {
      const inj = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        world: "MAIN",
        func: _probeHelpButtonInFrame,
      });
      const probe = inj?.[0]?.result || null;
      const entry = {
        frameId: f.frameId,
        url: (f.url || "").slice(0, 80),
        probe,
      };
      results.push(entry);
      console.log(
        "[BacList][Help] frame",
        f.frameId,
        "|",
        entry.url,
        "|",
        JSON.stringify(probe),
      );
    } catch (e) {
      console.warn(
        "[BacList][Help] Falha ao sondar frame",
        f.frameId,
        ":",
        e?.message || e,
      );
      results.push({
        frameId: f.frameId,
        url: (f.url || "").slice(0, 80),
        error: e?.message,
      });
    }
  }

  /* Frames fora do evo (caso o botão esteja no shell do cassino) */
  if (gameFrames.length && allFrames?.length > gameFrames.length) {
    const gameIds = new Set(gameFrames.map((f) => f.frameId));
    for (const f of allFrames) {
      if (gameIds.has(f.frameId)) continue;
      try {
        const inj = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [f.frameId] },
          world: "MAIN",
          func: _probeHelpButtonInFrame,
        });
        const probe = inj?.[0]?.result || null;
        if (probe?.hasButton) {
          const entry = {
            frameId: f.frameId,
            url: (f.url || "").slice(0, 80),
            probe,
          };
          results.push(entry);
          console.log(
            "[BacList][Help] frame extra",
            f.frameId,
            "|",
            entry.url,
            "|",
            JSON.stringify(probe),
          );
        }
      } catch (_) {}
    }
  }

  return results;
}

/* Verifica se o clique surtiu efeito (botão deixou de estar Activated) */
async function _verifyHelpClickEffect(tabId, frameId) {
  await _cdpDelay(600);
  try {
    const inj = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: _probeHelpButtonInFrame,
    });
    const probe = inj?.[0]?.result;
    const ok = !probe?.hasActivated;
    console.log(
      "[BacList][Help] Pós-clique:",
      ok ? "✓ desativado" : "✗ ainda Activated",
      "| state=",
      probe?.state,
      "| rect=",
      JSON.stringify(probe?.rect),
    );
    return {
      ok,
      state: probe?.state,
      hasActivated: probe?.hasActivated,
      probe,
    };
  } catch (e) {
    console.warn(
      "[BacList][Help] Verificação pós-clique falhou:",
      e?.message || e,
    );
    return { ok: false, error: e?.message };
  }
}

/* Clica no iframe evo correto (frameId do webNavigation) com CDP local */
async function _clickHelpButtonOnFrame(tabId, frameId, probe) {
  const iframeTarget = await _getEvoIframeDebuggerTarget(tabId, frameId);
  console.log(
    "[BacList][Help] CDP target frame",
    frameId,
    "→",
    iframeTarget?.id ? iframeTarget.id.slice(0, 12) + "…" : "nenhum",
    "|",
    (iframeTarget?.url || "").slice(0, 60),
  );

  /* T1: DOM.click no iframe CDP mapeado ao frameId correto */
  if (iframeTarget?.id) {
    console.log("[BacList][Help] T1: Runtime DOM.click no iframe target");
    const r1 = await _withDebugger(
      { targetId: iframeTarget.id },
      async (dbg) => {
        return _cdpDomClickViaRuntimeEvaluate(dbg, HELP_BTN_ACTIVATED_SEL, 0);
      },
    );
    console.log("[BacList][Help] T1 resultado:", JSON.stringify(r1));
    if (r1?.success) {
      const v = await _verifyHelpClickEffect(tabId, frameId);
      if (v.ok)
        return {
          success: true,
          method: r1.method,
          verified: true,
          x: r1.x,
          y: r1.y,
        };
    }
  }

  /* T2: mouse CDP nas coords LOCAIS do iframe (do probe — estáveis) */
  const rect = probe?.rect;
  if (iframeTarget?.id && rect?.w >= 1 && rect?.h >= 1) {
    const lx = rect.x + rect.w / 2;
    const ly = rect.y + rect.h / 2;
    console.log(
      "[BacList][Help] T2: CDP mouse local iframe — lx=",
      Math.round(lx),
      "ly=",
      Math.round(ly),
    );
    const r2 = await _withDebugger(
      { targetId: iframeTarget.id },
      async (dbg) => {
        await _dispatchCdpMouse(dbg, lx, ly);
        return {
          success: true,
          method: "cdp-iframe-local-mouse",
          x: lx,
          y: ly,
        };
      },
    );
    console.log("[BacList][Help] T2 resultado:", JSON.stringify(r2));
    if (r2?.success) {
      const v = await _verifyHelpClickEffect(tabId, frameId);
      if (v.ok)
        return {
          success: true,
          method: r2.method,
          verified: true,
          x: r2.x,
          y: r2.y,
        };
    }
  }

  /* T3: percorre TODOS os targets CDP evo até achar o que contém o botão */
  const targets = await _getEvoIframeDebuggerTargets(tabId);
  console.log(
    "[BacList][Help] T3: testando",
    targets.length,
    "target(s) CDP evo",
  );
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const r3 = await _withDebugger({ targetId: t.id }, async (dbg) => {
      await chrome.debugger.sendCommand(dbg, "Runtime.enable");
      const ev = await chrome.debugger.sendCommand(dbg, "Runtime.evaluate", {
        expression:
          '!!document.querySelector(\'[data-role="help-button"][data-state="Activated"]\')',
        returnByValue: true,
      });
      if (!ev.result?.value)
        return { success: false, error: "botão não neste target" };
      return _cdpDomClickViaRuntimeEvaluate(dbg, HELP_BTN_ACTIVATED_SEL, 0);
    });
    console.log(
      "[BacList][Help] T3 target[",
      i,
      "]",
      (t.url || "").slice(0, 50),
      "→",
      JSON.stringify(r3),
    );
    if (r3?.success) {
      const v = await _verifyHelpClickEffect(tabId, frameId);
      if (v.ok)
        return {
          success: true,
          method: r3.method || "cdp-scan-target",
          verified: true,
          targetIdx: i,
          x: r3.x,
          y: r3.y,
        };
    }
  }

  /* T4: coords viewport via frameElement walk + CDP trusted na aba */
  console.log("[BacList][Help] T4: frameElement walk → CDP aba");
  try {
    const coordInj = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: _getHelpButtonTabViewportCoords,
    });
    const coords = coordInj?.[0]?.result;
    console.log("[BacList][Help] T4 coords:", JSON.stringify(coords));
    if (coords?.success) {
      const r4 = await _cdpClickAtViewport(tabId, coords.x, coords.y);
      console.log("[BacList][Help] T4 CDP aba:", JSON.stringify(r4));
      if (r4?.success) {
        const v = await _verifyHelpClickEffect(tabId, frameId);
        if (v.ok)
          return {
            success: true,
            method: "cdp-tab-viewport-walk",
            verified: true,
            x: coords.x,
            y: coords.y,
            chain: coords.chain,
          };
      }
    } else if (coords?.partialX != null) {
      console.log(
        "[BacList][Help] T4 walk parcial — tentando CDP em",
        coords.partialX,
        coords.partialY,
      );
      const r4p = await _cdpClickAtViewport(
        tabId,
        coords.partialX,
        coords.partialY,
      );
      if (r4p?.success) {
        const v = await _verifyHelpClickEffect(tabId, frameId);
        if (v.ok)
          return {
            success: true,
            method: "cdp-tab-partial-walk",
            verified: true,
            x: coords.partialX,
            y: coords.partialY,
          };
      }
    }
  } catch (e) {
    console.warn("[BacList][Help] T4 falhou:", e?.message || e);
  }

  /* T5: coords via cadeia webNavigation + CDP aba */
  console.log("[BacList][Help] T5: webNavigation chain → CDP aba");
  const navCoords = await _resolveViewportCoordsForNavFrame(
    tabId,
    frameId,
    HELP_BTN_ACTIVATED_SEL,
    0,
  );
  console.log("[BacList][Help] T5 nav coords:", JSON.stringify(navCoords));
  if (navCoords) {
    const r5 = await _cdpClickAtViewport(tabId, navCoords.x, navCoords.y);
    console.log("[BacList][Help] T5 CDP aba:", JSON.stringify(r5));
    if (r5?.success) {
      const v = await _verifyHelpClickEffect(tabId, frameId);
      if (v.ok)
        return {
          success: true,
          method: "cdp-tab-nav-chain",
          verified: true,
          x: navCoords.x,
          y: navCoords.y,
        };
    }
  }

  /* T6: iframe CDP local (se target existir) com coords do probe */
  if (iframeTarget?.id && rect?.w >= 1 && rect?.h >= 1) {
    const lx = rect.x + rect.w / 2;
    const ly = rect.y + rect.h / 2;
    console.log(
      "[BacList][Help] T6: CDP iframe local lx=",
      Math.round(lx),
      "ly=",
      Math.round(ly),
    );
    const r6 = await _withDebugger(
      { targetId: iframeTarget.id },
      async (dbg) => {
        await _dispatchCdpMouse(dbg, lx, ly);
        return {
          success: true,
          method: "cdp-iframe-local-fallback",
          x: lx,
          y: ly,
        };
      },
    );
    if (r6?.success) {
      const v = await _verifyHelpClickEffect(tabId, frameId);
      if (v.ok)
        return {
          success: true,
          method: r6.method,
          verified: true,
          x: r6.x,
          y: r6.y,
        };
    }
  }

  return {
    success: false,
    error: "clique não surtiu efeito — botão permanece Activated",
  };
}

/* Percorre todos os iframes com srcdoc no DOM e clica no botão de fechar popup (.ao-close) */
function _probeAndClickSrcdocPopupInPage() {
  try {
    const iframes = Array.from(document.querySelectorAll("iframe[srcdoc]"));
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument;
        if (!doc) continue;
        const btn = doc.querySelector(
          'a.ao-close[data-ao-hide-popup="true"], .ao-close[data-ao-hide-popup="true"]',
        );
        if (btn) {
          btn.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: iframe.contentWindow,
            }),
          );
          return {
            clicked: true,
            href: btn.getAttribute("href") || "",
            src: (iframe.src || "").slice(0, 60),
          };
        }
      } catch (_) {}
    }
    return { clicked: false };
  } catch (e) {
    return { clicked: false, error: e?.message };
  }
}

async function _tryClickSrcdocPopup(tabId) {
  if (!tabId) return;
  const allFrames = await chrome.webNavigation
    .getAllFrames({ tabId })
    .catch(() => []);
  for (const f of allFrames || []) {
    try {
      const inj = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        world: "MAIN",
        func: _probeAndClickSrcdocPopupInPage,
      });
      const res = inj?.[0]?.result;
      if (res?.clicked) {
        console.log(
          "[BacList][Popup] ✓ Popup srcdoc fechado — frame",
          f.frameId,
          "| href=",
          res.href,
        );
        return;
      }
    } catch (_) {}
  }
}

/* Oculta o mobileMenuWrapper e fecha o botão .W37on no documento principal (fora de iframes) */
function _hideOverlaysInPage() {
  const result = {
    hiddenMenu: false,
    clickedW37on: false,
    escaped: false,
    clickedClose: 0,
    hiddenBlocking: 0,
  };

  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0 ||
      style.pointerEvents === "none"
    ) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  };

  const clickElement = (el) => {
    if (!isVisible(el)) return false;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: 0,
      buttons: 1,
    };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
      if (typeof el.click === "function") el.click();
      return true;
    } catch (_) {
      try {
        el.click();
        return true;
      } catch (_) {
        return false;
      }
    }
  };

  const dispatchEscape = () => {
    try {
      for (const type of ["keydown", "keyup"]) {
        document.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      result.escaped = true;
    } catch (_) {}
  };

  const textIncludesBlockingWord = (el) => {
    const text = String(el.innerText || el.textContent || "").toLowerCase();
    return (
      text.includes("busca") ||
      text.includes("pesquisa em alta") ||
      text.includes("pesquisar promo") ||
      text.includes("promocoes") ||
      text.includes("promoções") ||
      text.includes("escolha uma campanha") ||
      text.includes("ative sua missao") ||
      text.includes("ative sua missão")
    );
  };
  try {
    const menu =
      document.getElementById("mobileMenuWrapper") ||
      document.querySelector(".mobileMenuWrapper");
    if (menu && menu.style.display !== "none") {
      menu.style.display = "none";
      result.hiddenMenu = true;
    }
  } catch (_) {}

  dispatchEscape();

  try {
    const possibleOverlays = Array.from(
      document.querySelectorAll(
        [
          '[role="dialog"]',
          '[aria-modal="true"]',
          '[class*="modal" i]',
          '[class*="popup" i]',
          '[class*="drawer" i]',
          '[class*="search" i]',
          '[class*="promo" i]',
          '[class*="campaign" i]',
          "section",
          "aside",
          "div",
        ].join(","),
      ),
    ).filter((el) => {
      if (
        !isVisible(el) ||
        el === document.body ||
        el === document.documentElement
      ) {
        return false;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 260 || r.height < 120) return false;
      if (!textIncludesBlockingWord(el)) return false;

      const style = getComputedStyle(el);
      const z = Number.parseInt(style.zIndex, 10);
      const highLayer =
        style.position === "fixed" ||
        style.position === "sticky" ||
        style.position === "absolute" ||
        Number.isFinite(z);
      const notWholePage =
        r.width < window.innerWidth * 0.92 ||
        r.height < window.innerHeight * 0.92;
      return highLayer && notWholePage;
    });

    const closeSelectors = [
      'button[aria-label*="fechar" i]',
      'button[aria-label*="close" i]',
      '[role="button"][aria-label*="fechar" i]',
      '[role="button"][aria-label*="close" i]',
      '[data-testid*="close" i]',
      '[data-test*="close" i]',
      '[class*="close" i]',
      '[class*="fechar" i]',
      'button[title*="fechar" i]',
      'button[title*="close" i]',
      "button",
      '[role="button"]',
    ].join(",");

    for (const overlay of possibleOverlays) {
      const overlayRect = overlay.getBoundingClientRect();
      const candidates = Array.from(overlay.querySelectorAll(closeSelectors));
      let clicked = false;

      for (const candidate of candidates) {
        if (!isVisible(candidate)) continue;
        const r = candidate.getBoundingClientRect();
        const label = String(
          candidate.getAttribute("aria-label") ||
            candidate.getAttribute("title") ||
            candidate.textContent ||
            "",
        ).toLowerCase();
        const className = String(candidate.className || "").toLowerCase();
        const looksLikeClose =
          label.includes("fechar") ||
          label.includes("close") ||
          label.trim() === "x" ||
          label.trim() === "×" ||
          className.includes("close") ||
          className.includes("fechar") ||
          (r.left >= overlayRect.right - 120 &&
            r.top <= overlayRect.top + 100 &&
            r.width <= 90 &&
            r.height <= 90);

        if (looksLikeClose && clickElement(candidate)) {
          clicked = true;
          result.clickedClose += 1;
          break;
        }
      }

      if (!clicked && isVisible(overlay)) {
        overlay.setAttribute("data-bacbo-auto-hidden", "true");
        overlay.style.setProperty("display", "none", "important");
        overlay.style.setProperty("pointer-events", "none", "important");
        result.hiddenBlocking += 1;
      }
    }
  } catch (_) {}

  try {
    const btn = document.querySelector(".W37on");
    if (btn) {
      btn.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
      result.clickedW37on = true;
    }
  } catch (_) {}
  return result;
}

/* Capa da 1win: o BacBo só inicia depois do botão Jogar na tela. */
function _clickPlayButtonInPage(doClick) {
  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  };

  const playLabel = (el) =>
    String(el.innerText || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const findInRoot = (root) => {
    if (!root?.querySelector) return null;
    const byTestId = root.querySelector(
      '[data-testid="game-play-card-play-button"], [data-testid="game-play-button"], [data-testid="play-button"]',
    );
    if (byTestId && isVisible(byTestId)) return byTestId;
    for (const el of root.querySelectorAll("[data-testid]")) {
      const id = String(el.getAttribute("data-testid") || "").toLowerCase();
      if (!/play-button|play_button/.test(id) || /replay/.test(id)) continue;
      if (isVisible(el)) return el;
    }
    for (const el of root.querySelectorAll('button, [role="button"]')) {
      const text = playLabel(el);
      if (
        (text === "jogar" ||
          text === "play" ||
          text === "jogar agora" ||
          text === "iniciar") &&
        text.length <= 24 &&
        isVisible(el)
      ) {
        return el;
      }
    }
    for (const el of root.querySelectorAll("*")) {
      if (!el.shadowRoot) continue;
      const found = findInRoot(el.shadowRoot);
      if (found) return found;
    }
    return null;
  };

  const btn = findInRoot(document);
  if (!btn) return { found: false, clicked: false };
  try {
    btn.scrollIntoView({ block: "center", inline: "center" });
  } catch (_) {}
  const r = btn.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const method = btn.getAttribute("data-testid") ? "testid" : "text";
  if (!doClick) return { found: true, clicked: false, x, y, method };

  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
  };
  try {
    btn.dispatchEvent(new PointerEvent("pointerdown", opts));
    btn.dispatchEvent(new MouseEvent("mousedown", opts));
    btn.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
    btn.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    btn.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
    if (typeof btn.click === "function") btn.click();
  } catch (_) {
    try {
      btn.click();
    } catch (_) {}
  }
  return { found: true, clicked: true, x, y, method };
}

const _playClickJobs = new Map();

async function _playButtonStillVisible(tabId) {
  let frames = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch (_) {
    return false;
  }
  for (const frame of frames) {
    try {
      const scans = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        world: "MAIN",
        func: _clickPlayButtonInPage,
        args: [false],
      });
      if (scans?.[0]?.result?.found) return true;
    } catch (_) {}
  }
  return false;
}

async function _tryClickPlayButton(tabId, timeoutMs = 15000) {
  if (!tabId) return { clicked: false };
  const existing = _playClickJobs.get(tabId);
  if (existing) return existing;

  const job = _pollAndClickPlayButton(tabId, timeoutMs).finally(() => {
    _playClickJobs.delete(tabId);
  });
  _playClickJobs.set(tabId, job);
  return job;
}

async function _clickPlayWithDebugger(tabId, x, y) {
  const debuggee = { tabId };
  let attachedHere = false;
  try {
    await chrome.debugger.attach(debuggee, "1.3");
    attachedHere = true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/already attached/i.test(msg)) return { success: false, error: msg };
  }
  try {
    await _dispatchCdpMouse(debuggee, x, y);
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  } finally {
    if (attachedHere) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch (_) {}
    }
  }
}

async function _pollAndClickPlayButton(tabId, timeoutMs) {
  const start = Date.now();
  do {
    let frames = [];
    try {
      frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    } catch (_) {}
    for (const frame of frames) {
      try {
        const scans = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frame.frameId] },
          world: "MAIN",
          func: _clickPlayButtonInPage,
          args: [false],
        });
        const hit = scans?.[0]?.result;
        if (!hit?.found) continue;
        if (frame.frameId === 0) {
          const cdp = await _clickPlayWithDebugger(tabId, hit.x, hit.y);
          if (cdp?.success) {
            console.log("[BacList][Jogar] botão Jogar clicado na tela — cdp");
            return { clicked: true, method: "cdp" };
          }
        }
        const inj = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frame.frameId] },
          world: "MAIN",
          func: _clickPlayButtonInPage,
          args: [true],
        });
        if (inj?.[0]?.result?.clicked) {
          console.log(
            "[BacList][Jogar] botão Jogar clicado na tela —",
            inj[0].result.method,
          );
          return { clicked: true, method: inj[0].result.method };
        }
      } catch (_) {}
    }
    if (Date.now() - start >= timeoutMs) break;
    await _cdpDelay(400);
  } while (Date.now() - start < timeoutMs);
  console.log("[BacList][Jogar] botão Jogar não apareceu em", timeoutMs, "ms");
  return { clicked: false };
}

/* 1win: assim que o iframe do jogo existe, pede tela inteira nele. */
const _fullscreenJobs = new Map();

const _REQUEST_IFRAME_FULLSCREEN_EXPR = `(function () {
  function visible(el) {
    var s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width >= 180 && r.height >= 180;
  }
  function collect(root, out) {
    if (!root || !root.querySelectorAll) return;
    var nodes = root.querySelectorAll("iframe");
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
    var all = root.querySelectorAll("*");
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) collect(all[j].shadowRoot, out);
    }
  }
  if (document.fullscreenElement) return Promise.resolve({ ok: true, already: true, how: "iframe" });
  var found = [];
  collect(document, found);
  var visibleOnes = found.filter(visible);
  var pick = null;
  var best = 0;
  for (var n = 0; n < visibleOnes.length; n++) {
    var src = String(visibleOnes[n].src || visibleOnes[n].getAttribute("src") || "");
    var box = visibleOnes[n].getBoundingClientRect();
    var area = box.width * box.height;
    if (/evo-games\\.com|evolution/i.test(src)) {
      pick = visibleOnes[n];
      break;
    }
    if (area > best) {
      best = area;
      pick = visibleOnes[n];
    }
  }
  if (!pick) return Promise.resolve({ ok: false, reason: "iframe" });
  var req = pick.requestFullscreen || pick.webkitRequestFullscreen;
  if (!req) return Promise.resolve({ ok: false, reason: "api" });
  return Promise.resolve(req.call(pick, { navigationUI: "hide" })).then(function () {
    return { ok: true, how: "iframe" };
  }).catch(function (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  });
})()`;

const _REQUEST_DOCUMENT_FULLSCREEN_EXPR = `(function () {
  if (document.fullscreenElement) return Promise.resolve({ ok: true, already: true, how: "documento" });
  var el = document.documentElement;
  var req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return Promise.resolve({ ok: false, reason: "api" });
  return Promise.resolve(req.call(el, { navigationUI: "hide" })).then(function () {
    return { ok: true, how: "documento" };
  }).catch(function (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  });
})()`;

async function _pageHasFullscreen(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => !!document.fullscreenElement,
    });
    return !!results?.some((r) => r.result);
  } catch (_) {
    return false;
  }
}

async function _evalUserGesture(debuggee, expression) {
  const out = await _withDebugger(debuggee, async (dbg) => {
    await chrome.debugger.sendCommand(dbg, "Runtime.enable").catch(() => {});
    const ev = await chrome.debugger.sendCommand(dbg, "Runtime.evaluate", {
      expression,
      userGesture: true,
      awaitPromise: true,
      returnByValue: true,
    });
    if (ev.exceptionDetails) {
      return {
        ok: false,
        reason: ev.exceptionDetails.text || "evaluate",
      };
    }
    return ev.result?.value || { ok: false, reason: "sem retorno" };
  });
  if (out && out.success === false && !out.ok) {
    return { ok: false, reason: out.error || "debugger" };
  }
  return out || { ok: false };
}

async function _tryRequestFullscreenOnce(tabId) {
  const top = await _evalUserGesture({ tabId }, _REQUEST_IFRAME_FULLSCREEN_EXPR);
  if (top?.ok) return top;

  const targets = await _getEvoIframeDebuggerTargets(tabId);
  for (const t of targets) {
    const inner = await _evalUserGesture(
      { targetId: t.id },
      _REQUEST_DOCUMENT_FULLSCREEN_EXPR,
    );
    if (inner?.ok) return inner;
  }
  return top || { ok: false, reason: "iframe" };
}

async function _exitPageFullscreen(tabId) {
  await _evalUserGesture(
    { tabId },
    `(function () {
      if (!document.fullscreenElement) return Promise.resolve({ ok: true });
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (!exit) return Promise.resolve({ ok: false });
      return Promise.resolve(exit.call(document)).then(function () {
        return { ok: true };
      }).catch(function () {
        return { ok: false };
      });
    })()`,
  );
}

async function _pollGameFullscreen(tabId, timeoutMs) {
  const start = Date.now();
  let lastReason = "";
  while (Date.now() - start < timeoutMs) {
    if (await _playButtonStillVisible(tabId)) {
      if (await _pageHasFullscreen(tabId)) {
        console.log(
          "[BacList][TelaInteira] capa do Jogar ainda aberta — saindo da tela inteira",
        );
        await _exitPageFullscreen(tabId);
        await _cdpDelay(400);
      }
      console.log("[BacList][Jogar] clicando para iniciar antes da tela inteira");
      await _tryClickPlayButton(tabId, 8000);
      await _cdpDelay(1200);
      continue;
    }
    if (await _pageHasFullscreen(tabId)) {
      console.log("[BacList][TelaInteira] jogo em tela inteira");
      return { ok: true, already: true };
    }
    const r = await _tryRequestFullscreenOnce(tabId);
    if (r?.ok) {
      await _cdpDelay(400);
      if (await _playButtonStillVisible(tabId)) {
        await _exitPageFullscreen(tabId);
        continue;
      }
      if ((await _pageHasFullscreen(tabId)) || r.already) {
        console.log(
          "[BacList][TelaInteira] tela inteira ao carregar —",
          r.how || "ok",
        );
        return { ok: true, how: r.how };
      }
    } else if (r?.reason && r.reason !== lastReason) {
      lastReason = r.reason;
      console.log("[BacList][TelaInteira]", r.reason);
    }
    await _cdpDelay(700);
  }
  console.warn("[BacList][TelaInteira] não entrou em tela inteira");
  return { ok: false };
}

async function _enterGameFullscreen(tabId, timeoutMs = 20000) {
  if (!tabId) return { ok: false };
  const existing = _fullscreenJobs.get(tabId);
  if (existing) return existing;

  const job = _pollGameFullscreen(tabId, timeoutMs).finally(() => {
    _fullscreenJobs.delete(tabId);
  });
  _fullscreenJobs.set(tabId, job);
  return job;
}

async function _tryHideOverlays(tabId) {
  if (!tabId) return;
  try {
    const inj = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: _hideOverlaysInPage,
    });
    const res = inj?.[0]?.result;
    if (res?.hiddenMenu)
      console.log("[BacList][Menu] ✓ mobileMenuWrapper ocultado");
    if (res?.clickedW37on)
      console.log("[BacList][Menu] ✓ W37on clicado (fechado)");
    if (res?.clickedClose || res?.hiddenBlocking) {
      console.log(
        "[BacList][Tela] overlays fechados/ocultados:",
        JSON.stringify({
          clickedClose: res.clickedClose || 0,
          hiddenBlocking: res.hiddenBlocking || 0,
        }),
      );
    }
  } catch (_) {}
}

function _dismissInactivityInPage() {
  const wrapper = document.querySelector(
    '[data-role="inactivity-message-wrapper"]',
  );
  if (!wrapper) return { clicked: false };
  const rect = wrapper.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const target = document.elementFromPoint(cx, cy) || wrapper;
  target.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
    }),
  );
  return { clicked: true };
}

async function _dismissInactivityOverlay(tabId) {
  if (!tabId) return { success: false, error: "Aba não encontrada." };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: _dismissInactivityInPage,
    });
    const clicked = results?.some((r) => r.result?.clicked);
    console.log(
      "[BacList] dismissInactivity tabId:",
      tabId,
      "| clicked:",
      clicked,
    );
    return { success: true, clicked };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

function _startInactivityPolling(tabId) {
  _stopInactivityPolling();
  _inactivityPollTimer = setInterval(async () => {
    if (_bettingInProgress) return;
    const id = tabId ?? _activeTabId;
    if (!id) return;
    await _dismissInactivityOverlay(id);
  }, 500);
}

function _stopInactivityPolling() {
  if (_inactivityPollTimer) {
    clearInterval(_inactivityPollTimer);
    _inactivityPollTimer = null;
  }
}

async function _tryClickHelpButton(tabId) {
  if (!tabId) {
    console.warn("[BacList][Help] tabId ausente — abortando");
    return;
  }

  console.log("[BacList][Help] ── Verificação iniciada ── tabId=", tabId);

  const [scans] = await Promise.all([
    _scanHelpButtonFrames(tabId),
    _tryClickSrcdocPopup(tabId),
    _tryHideOverlays(tabId),
  ]);

  const target = scans.find((s) => s.probe?.hasActivated);

  if (!target) {
    const anyBtn = scans.find((s) => s.probe?.hasButton);
    if (anyBtn) {
      console.log(
        "[BacList][Help] Botão existe mas sem Activated — state=",
        anyBtn.probe.state,
        "frame",
        anyBtn.frameId,
      );
    } else if (!scans.length) {
      console.log("[BacList][Help] Nenhum frame acessível na aba");
    } else {
      console.log(
        "[BacList][Help] help-button não encontrado em",
        scans.length,
        "frame(s)",
      );
    }
    return;
  }

  console.log(
    "[BacList][Help] Activated encontrado — frame",
    target.frameId,
    target.url,
    "| rect=",
    JSON.stringify(target.probe.rect),
  );

  const result = await _clickHelpButtonOnFrame(
    tabId,
    target.frameId,
    target.probe,
  );
  if (result?.success && result.verified) {
    console.log(
      "[BacList][Help] ✓ Clique efetivo — method=",
      result.method,
      "x=",
      result.x,
      "y=",
      result.y,
    );
  } else {
    console.warn(
      "[BacList][Help] ✗ Clique sem efeito:",
      result?.error || "desconhecido",
    );
  }
}

function _startCloseHelpLoop(tabId) {
  _stopCloseHelpLoop();
  console.log(
    "[BacList][Help] Loop iniciado — clique imediato + verificação a cada",
    HELP_CHECK_MS / 1000,
    "s",
  );
  _tryClickHelpButton(tabId);
  _helpButtonTimer = setInterval(
    () => _tryClickHelpButton(_activeTabId || tabId),
    HELP_CHECK_MS,
  );
}

function _stopCloseHelpLoop() {
  if (_helpButtonTimer) {
    clearInterval(_helpButtonTimer);
    _helpButtonTimer = null;
    console.log("[BacList][Help] Loop parado");
  }
}
const POLL_MS = 2500;
const EVO_FRAME_MATCH = /evo-games\.com/i;
const BETTING_HOUSES = {
  "1win": {
    url: "https://1win.io/casino/play/v_evolution:bacbo",
    clickPlay: true,
  },
  pixnabanca: {
    url: "https://www.pixnabanca.club/casino/evolution/bac-bo",
    clickPlay: false,
  },
  inovabet: {
    url: "https://www.inovabet.bet/casino/evolution/bac-bo",
    clickPlay: false,
  },
};

function _normalizeGameUrl(url) {
  try {
    return decodeURIComponent(url || "").replace(/\/+$/, "");
  } catch (_) {
    return String(url || "").replace(/\/+$/, "");
  }
}

function _houseFromUrl(url) {
  const current = _normalizeGameUrl(url);
  return (
    Object.values(BETTING_HOUSES).find((house) =>
      current.startsWith(_normalizeGameUrl(house.url)),
    ) || null
  );
}

async function _getBettingHouse() {
  try {
    const data = await chrome.storage.local.get("bacboConfig");
    const id = data?.bacboConfig?.bettingHouse;
    return BETTING_HOUSES[id] || BETTING_HOUSES["1win"];
  } catch (_) {
    return BETTING_HOUSES["1win"];
  }
}

async function _fullscreenOnLoadEnabled() {
  try {
    const data = await chrome.storage.local.get("bacboConfig");
    return data?.bacboConfig?.fullscreenOnLoad !== false;
  } catch (_) {
    return true;
  }
}

let _automationRunning = false;

chrome.storage.local.get("autoModeActive", (data) => {
  _automationRunning = !!data?.autoModeActive;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!_automationRunning) return;
  if (changeInfo.status !== "complete") return;
  if (!_houseFromUrl(tab?.url || "")?.clickPlay) return;
  _tryClickPlayButton(tabId).catch(() => {});
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (!_automationRunning) return;
  if (!EVO_FRAME_MATCH.test(details.url || "")) return;
  void (async () => {
    try {
      if (!(await _fullscreenOnLoadEnabled())) return;
      const tab = await chrome.tabs.get(details.tabId);
      if (_houseFromUrl(tab?.url || "")?.clickPlay) {
        if (await _playButtonStillVisible(details.tabId)) {
          const play = await _tryClickPlayButton(details.tabId, 12000);
          if (play?.clicked) await _cdpDelay(2000);
        }
      }
      await _enterGameFullscreen(details.tabId);
    } catch (_) {}
  })();
});
const POPOUT_URL = chrome.runtime.getURL("popup.html?popout=1");
let _popoutWindowId = null;
let _sidePanelReady = false;
let _fallbackClickBound = false;

/* ========== Instalação ========== */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "baclist-popup") {
    port.onDisconnect.addListener(() => {});
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === _popoutWindowId) _popoutWindowId = null;
});

function _bindFallbackActionClick() {
  if (_fallbackClickBound) return;
  _fallbackClickBound = true;
  chrome.action.onClicked.addListener(() => {
    _openPopoutWindow();
  });
}

async function _initSidePanel() {
  if (_sidePanelReady) return;

  if (!chrome.sidePanel?.setPanelBehavior) {
    _bindFallbackActionClick();
    _sidePanelReady = true;
    return;
  }

  try {
    await chrome.sidePanel.setOptions({ path: "popup.html", enabled: true });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    _sidePanelReady = true;
  } catch (e) {
    console.warn("[BacList] sidePanel:", e?.message || e);
    _bindFallbackActionClick();
    _sidePanelReady = true;
  }
}

async function _openPopoutWindow() {
  if (_popoutWindowId != null) {
    try {
      await chrome.windows.update(_popoutWindowId, {
        focused: true,
        drawAttention: true,
      });
      return { success: true, windowId: _popoutWindowId, focused: true };
    } catch (_) {
      _popoutWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: POPOUT_URL,
    type: "popup",
    width: 420,
    height: 780,
    focused: true,
  });

  _popoutWindowId = win.id;
  return { success: true, windowId: win.id, focused: false };
}

_initSidePanel();

chrome.runtime.onInstalled.addListener(({ reason }) => {
  _initSidePanel();
  if (reason === "install") {
    chrome.storage.local.set({
      bacboConfig: {
        betAmount: 10,
        tieEntryAmount: 5,
        tieProtection: false,
        tieAmount: 5,
        selectorPlayer: "",
        selectorTie: "",
        selectorBanker: "",
        selectorAmount: "",
        selectorConfirm: "",
        autoInterval: 5,
        betLimit: 0,
        stopLoss: 0,
        stopWin: 0,
        stopRedHistory: 0,
        fullscreenOnLoad: true,
      },
      bacboHistory: [],
      bacboStats: {
        wins: 0,
        losses: 0,
        betCount: 0,
        totalPnl: 0,
        historyReds: 0,
      },
    });
  }
});

/* ========== Listener de Mensagens ========== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Relay: content.js → popup (historyUpdate)
  if (msg.action === "historyUpdate") {
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }

  // Popup pede para iniciar o polling de histórico
  if (msg.action === "startHistoryPolling") {
    _startPolling(msg.tabId)
      .then((r) => sendResponse(r))
      .catch((e) =>
        sendResponse({ success: false, error: e?.message || String(e) }),
      );
    return true;
  }

  // Popup pede para parar
  if (msg.action === "stopHistoryPolling") {
    _stopPolling();
    sendResponse({ success: true });
    return false;
  }

  // Janela flutuante persistente (não fecha ao clicar no jogo)
  if (msg.action === "openPopoutWindow") {
    _openPopoutWindow()
      .then((r) => sendResponse(r))
      .catch((e) =>
        sendResponse({ success: false, error: e?.message || String(e) }),
      );
    return true;
  }

  // Leitura sob demanda (popup aberto — mais confiável que só o service worker)
  if (msg.action === "fetchLiveHistory") {
    _fetchLiveHistory(msg.tabId)
      .then((r) => sendResponse(r))
      .catch((e) =>
        sendResponse({
          success: false,
          history: null,
          error: e?.message || String(e),
        }),
      );
    return true;
  }

  if (msg.action === "getActiveTabId") {
    _resolveTabId(msg.tabId).then((tabId) => sendResponse({ tabId }));
    return true;
  }

  if (msg.action === "startInactivityPolling") {
    _startInactivityPolling(msg.tabId || null);
    sendResponse({ success: true });
    return true;
  }

  if (msg.action === "stopInactivityPolling") {
    _stopInactivityPolling();
    sendResponse({ success: true });
    return true;
  }

  /* Dismiss do overlay de inatividade (pré-entrada) */
  if (msg.action === "dismissInactivityOverlay") {
    const tabId = msg.tabId || _activeTabId;
    _dismissInactivityOverlay(tabId)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "setAutomationRunning") {
    _automationRunning = !!msg.active;
    chrome.storage.local.set({ autoModeActive: _automationRunning });
    if (_automationRunning) {
      _reopenBacBoGame(msg.tabId || null).catch(() => {});
    }
    sendResponse({ success: true, active: _automationRunning });
    return false;
  }

  if (msg.action === "reopenGameForEntry") {
    if (!_automationRunning) {
      sendResponse({ success: false, error: "Automação parada." });
      return false;
    }
    _reopenBacBoGame(msg.tabId || null)
      .then((r) => sendResponse(r))
      .catch((e) =>
        sendResponse({ success: false, error: e?.message || String(e) }),
      );
    return true;
  }

  // Popup pede para apostar (ficha + spot) dentro do iframe do jogo
  if (msg.action === "placeBetIframe") {
    _resolveTabId(msg.tabId)
      .then((tabId) =>
        _placeBetInGameFrame(
          tabId,
          msg.mainAmount ?? msg.chipValue ?? 5,
          msg.target,
          !!msg.tieProtection,
          msg.tieAmount ?? 5,
          msg.selectors || {},
          !!msg.waitForChips,
        ),
      )
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // Popup pede para repetir aposta (gale) — repeat-button [+ double-button]
  if (msg.action === "repeatBetIframe") {
    _resolveTabId(msg.tabId)
      .then((tabId) => _repeatBetInGameFrame(tabId, !!msg.doDouble))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "waitForFooterExpanded") {
    const tabId = msg.tabId || _activeTabId;
    _waitForFooterExpanded(tabId)
      .then((expanded) => sendResponse({ expanded }))
      .catch(() => sendResponse({ expanded: false }));
    return true;
  }

  // Content.js pede para o background buscar nos frames (fallback cross-origin)
  if (msg.action === "getNestedFrameHistory") {
    const tabId = sender.tab?.id || _activeTabId;
    _readAllFrames(tabId)
      .then((history) => sendResponse({ history }))
      .catch(() => sendResponse({ history: null }));
    return true;
  }

  switch (msg.action) {
    case "updateStats": {
      chrome.storage.local.get("bacboStats", ({ bacboStats }) => {
        const s = bacboStats || {
          wins: 0,
          losses: 0,
          betCount: 0,
          totalPnl: 0,
          historyReds: 0,
        };
        if (msg.result === "win") {
          s.wins++;
          s.totalPnl += msg.profit || 0;
        }
        if (msg.result === "loss") {
          s.losses++;
          s.totalPnl -= msg.amount || 0;
          s.historyReds = (s.historyReds || 0) + 1;
        }
        s.betCount++;
        chrome.storage.local.set({ bacboStats: s });
        sendResponse({ success: true, stats: s });
      });
      return true;
    }
    case "getStats": {
      chrome.storage.local.get("bacboStats", ({ bacboStats }) => {
        sendResponse({ success: true, stats: bacboStats });
      });
      return true;
    }
    case "clearStats": {
      chrome.storage.local.set({
        bacboStats: {
          wins: 0,
          losses: 0,
          betCount: 0,
          totalPnl: 0,
          historyReds: 0,
        },
        bacboHistory: [],
      });
      sendResponse({ success: true });
      return false;
    }
    default:
      return false;
  }
});

/* ========== Polling iniciado pelo popup ========== */
async function _startPolling(preferredTabId) {
  const tabId = await _resolveGameTabId(preferredTabId);
  if (!tabId) {
    console.warn(
      "[BacList] Polling não iniciado — aba evo-games não encontrada",
    );
    return {
      success: false,
      error: "Abra a aba do BacBo (evo-games) e tente novamente.",
    };
  }

  if (_pollTimer && _activeTabId === tabId) {
    return { success: true, tabId, alreadyRunning: true };
  }

  _stopPolling();
  _activeTabId = tabId;
  _lastHistoryHash = null;
  chrome.storage.local.set({ bacboGameTabId: tabId });
  await _poll(true);
  _pollTimer = setInterval(() => _poll(false), POLL_MS);
  _startCloseHelpLoop(tabId);
  console.log("[BacList] Polling iniciado, tabId:", tabId);
  return { success: true, tabId };
}

function _stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _stopCloseHelpLoop();
}

async function _fetchLiveHistory(preferredTabId) {
  const tabId = await _resolveGameTabId(preferredTabId);
  if (!tabId) {
    return {
      success: false,
      tabId: null,
      history: null,
      error: "Aba do jogo (evo-games) não encontrada.",
    };
  }

  const history = await _readAllFrames(tabId);
  if (!history?.length) {
    return {
      success: false,
      tabId,
      history: null,
      error: "Histórico vazio — confirme que o BacBo está carregado na aba.",
    };
  }

  return { success: true, tabId, history };
}

/* ========== Resolver aba e iframe do jogo (como desktop Playwright) ========== */
async function _findEvoGameTabId() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id || t.url?.startsWith("chrome-extension://")) continue;
    if (t.url && EVO_FRAME_MATCH.test(t.url)) return t.id;
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: t.id });
      if (frames?.some((f) => EVO_FRAME_MATCH.test(f.url || ""))) return t.id;
    } catch (_) {}
  }
  return null;
}

async function _resolveGameTabId(preferredTabId) {
  const evoTab = await _findEvoGameTabId();
  if (evoTab) {
    _activeTabId = evoTab;
    return evoTab;
  }

  if (preferredTabId) {
    try {
      await chrome.tabs.get(preferredTabId);
      _activeTabId = preferredTabId;
      return preferredTabId;
    } catch (_) {}
  }

  const stored = await chrome.storage.local.get("bacboGameTabId");
  if (stored.bacboGameTabId) {
    try {
      await chrome.tabs.get(stored.bacboGameTabId);
      _activeTabId = stored.bacboGameTabId;
      return stored.bacboGameTabId;
    } catch (_) {}
  }

  if (_activeTabId) {
    try {
      await chrome.tabs.get(_activeTabId);
      return _activeTabId;
    } catch (_) {
      _activeTabId = null;
    }
  }

  const [focused] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (focused?.id && !focused.url?.startsWith("chrome-extension://")) {
    _activeTabId = focused.id;
    return focused.id;
  }

  return null;
}

async function _resolveTabId(preferredTabId) {
  return _resolveGameTabId(preferredTabId);
}

async function _waitForTabComplete(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === "complete") return true;
    } catch (_) {
      return false;
    }
    await _cdpDelay(250);
  }
  return false;
}

async function _reopenBacBoGame(preferredTabId = null) {
  let tabId = await _findEvoGameTabId();

  if (!tabId && preferredTabId) {
    try {
      await chrome.tabs.get(preferredTabId);
      tabId = preferredTabId;
    } catch (_) {}
  }

  if (!tabId) {
    const stored = await chrome.storage.local.get("bacboGameTabId");
    if (stored.bacboGameTabId) {
      try {
        await chrome.tabs.get(stored.bacboGameTabId);
        tabId = stored.bacboGameTabId;
      } catch (_) {}
    }
  }

  if (!tabId && _activeTabId) {
    try {
      await chrome.tabs.get(_activeTabId);
      tabId = _activeTabId;
    } catch (_) {}
  }

  const house = await _getBettingHouse();

  if (!tabId) {
    const tabs = await chrome.tabs.query({});
    tabId = tabs.find((t) => t.id && _houseFromUrl(t.url || ""))?.id || null;
  }

  const url = house.url;
  try {
    if (!tabId) {
      const created = await chrome.tabs.create({ url, active: true });
      tabId = created?.id || null;
    } else {
      await chrome.tabs.update(tabId, { url, active: true });
    }
  } catch (_) {
    return { success: false, error: "Não foi possível abrir a aba do BacBo." };
  }

  if (!tabId) {
    return { success: false, error: "Não foi possível abrir a aba do BacBo." };
  }

  _activeTabId = tabId;
  _lastHistoryHash = null;
  await chrome.storage.local.set({ bacboGameTabId: tabId });
  await _waitForTabComplete(tabId);
  if (house.clickPlay) {
    const play = await _tryClickPlayButton(tabId);
    if (play?.clicked) await _cdpDelay(2500);
  }
  await _tryClickSrcdocPopup(tabId);
  await _tryHideOverlays(tabId);
  if (await _fullscreenOnLoadEnabled()) {
    try {
      await _enterGameFullscreen(tabId);
    } catch (e) {
      console.warn("[BacList][TelaInteira]", e?.message || e);
    }
  }
  await _cdpDelay(700);
  await _tryHideOverlays(tabId);
  console.log("[BacList][Pré-entrada] BacBo atualizado:", tabId, url);
  return { success: true, tabId, url, reopened: true };
}

async function _getGameFrames(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames || !frames.length) return [];
  const game = frames.filter((f) => EVO_FRAME_MATCH.test(f.url || ""));
  return game.length ? game : frames;
}

function _primaryGameFrameId(gameFrames) {
  if (!gameFrames.length) return null;
  return gameFrames[gameFrames.length - 1].frameId;
}

/* Cache: frame 37 = UI (fichas/apostas); frame 34 = shell vazio neste site */
const _uiFrameCache = new Map();

function _cacheUiFrame(tabId, frameId) {
  if (tabId != null && frameId != null) {
    _uiFrameCache.set(tabId, { frameId, at: Date.now() });
  }
}

function _getCachedUiFrame(tabId) {
  const c = _uiFrameCache.get(tabId);
  if (c && Date.now() - c.at < 120000) return c.frameId;
  return null;
}

/* Conta elementos do seletor no frame (autocontida para inject) */
function _countSelectorInFrame(selector) {
  const FOOTER = '[data-role="footer-left"], [data-role="footer-right"]';
  const list = [...document.querySelectorAll(selector)].filter(
    (el) => !el.closest(FOOTER),
  );
  return list.length;
}

/* Fichas válidas = só dentro do chip-stack da mesa (autocontida) */
function _countStackChipsInFrame() {
  const stack = document.querySelector('[data-role="chip-stack"]');
  if (!stack) return 0;
  return stack.querySelectorAll('[data-role="chip"]').length;
}

/* Escolhe o iframe evo onde o seletor existe (ex.: fichas só no frameId 37) */
async function _findBestFrameForSelector(tabId, selector) {
  const cached = _getCachedUiFrame(tabId);
  if (cached != null) return { frameId: cached, count: -1, cached: true };

  const gameFrames = await _getGameFrames(tabId);
  if (!gameFrames.length) return { frameId: null, count: 0 };

  let bestId = null;
  let bestCount = 0;

  for (const f of gameFrames) {
    try {
      const inj = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        world: "MAIN",
        func: _countSelectorInFrame,
        args: [selector],
      });
      const count = inj?.[0]?.result || 0;
      if (count > bestCount) {
        bestCount = count;
        bestId = f.frameId;
      }
    } catch (_) {}
  }

  const frameId = bestId ?? _primaryGameFrameId(gameFrames);
  if (bestCount > 0) _cacheUiFrame(tabId, frameId);
  return { frameId, count: bestCount, cached: false };
}

const _SELECTORS = {
  chipStack: '[data-role="chip-stack"] [data-role="chip"]',
  Player: '[data-role="bacbo-bet-spot-Player"]',
  Banker: '[data-role="bacbo-bet-spot-Banker"]',
  Tie: '[data-role="bacbo-bet-spot-Tie"]',
};

/* Mesmas fichas do FBot: inglês (passo 5) e brasileiro (passo 2,50). */
const CHIP_PROFILES = {
  bacbo_en: {
    id: "bacbo_en",
    minChip: 5,
    chipStep: 5,
    denominations: [5, 10, 25, 125, 500, 2500],
  },
  bacbo_br: {
    id: "bacbo_br",
    minChip: 2.5,
    chipStep: 2.5,
    denominations: [2.5, 5, 25, 125, 500],
  },
};
const CHIP_DENOMINATIONS = CHIP_PROFILES.bacbo_en.denominations;

function _toChipCents(value) {
  return Math.round(Number(value) * 100);
}

function _fromChipCents(cents) {
  return Math.round(cents) / 100;
}

function _gcdCents(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function _withLiveChipProfile(profile, denominations) {
  const denoms = [
    ...new Set(
      (denominations || [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 100000),
    ),
  ].sort((a, b) => a - b);
  if (!denoms.length) return profile;
  const cents = denoms.map(_toChipCents);
  const step = _fromChipCents(cents.reduce((g, c) => _gcdCents(g, c)));
  return {
    ...profile,
    minChip: denoms[0],
    chipStep: step,
    denominations: denoms,
    live: true,
  };
}

function _snapChipAmount(amount, profile = CHIP_PROFILES.bacbo_en) {
  const minCents = _toChipCents(profile.minChip);
  const stepCents = _toChipCents(profile.chipStep);
  const amountCents = Math.round((Number(amount) || 0) * 100);
  const snapped = Math.max(
    minCents,
    Math.floor(amountCents / stepCents) * stepCents,
  );
  return _fromChipCents(snapped);
}

/* Menor número de fichas para somar o valor, só com as fichas da mesa. */
function _planChipClicks(amount, profile = CHIP_PROFILES.bacbo_en) {
  const denominations = profile.denominations || [];
  const alvo = _snapChipAmount(amount, profile);
  const alvoCents = _toChipCents(alvo);
  const stepCents = _toChipCents(profile.chipStep);
  const chipCentsList = denominations.map(_toChipCents);
  const dp = new Array(alvoCents + 1).fill(Infinity);
  const pick = new Array(alvoCents + 1).fill(0);
  dp[0] = 0;

  for (let v = stepCents; v <= alvoCents; v += stepCents) {
    for (const c of chipCentsList) {
      if (v >= c && dp[v - c] + 1 < dp[v]) {
        dp[v] = dp[v - c] + 1;
        pick[v] = c;
      }
    }
  }

  const groupsFrom = (cents) => {
    const groups = new Map();
    let rest = cents;
    while (rest > 0) {
      const c = pick[rest];
      if (!c) break;
      groups.set(c, (groups.get(c) || 0) + 1);
      rest -= c;
    }
    return [...groups.entries()]
      .sort((a, b) => chipCentsList.indexOf(b[0]) - chipCentsList.indexOf(a[0]))
      .map(([centsValue, count]) => ({
        value: _fromChipCents(centsValue),
        count,
      }));
  };

  if (!isFinite(dp[alvoCents])) return [];

  return groupsFrom(alvoCents);
}

function _chipValueAttrCandidates(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return [];
  const fixed = n.toFixed(2);
  const variants = [String(n), fixed, fixed.replace(".", ",")];
  if (Math.abs(n - 2.5) < 0.01) {
    variants.push("2.5", "2,5", "2.50", "2,50");
  }
  return [...new Set(variants)];
}

function _chipSelectorForValue(value) {
  return _chipValueAttrCandidates(value)
    .map(
      (v) => `[data-role="chip-stack"] [data-role="chip"][data-value="${v}"]`,
    )
    .join(", ");
}

function _probeChipDenominationsInFrame() {
  function isLocked(el) {
    if (!el) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.hasAttribute("disabled")) return true;
    const st = (el.getAttribute("data-state") || "").toLowerCase();
    if (st === "disabled" || st === "inactive" || st === "locked") return true;
    const cls = String(el.className || "").toLowerCase();
    if (/\b(disabled|locked|unavailable|is-disabled)\b/.test(cls)) return true;
    return false;
  }

  const stack = document.querySelector('[data-role="chip-stack"]');
  const nodes = stack
    ? [...stack.querySelectorAll('[data-role="chip"]')]
    : [...document.querySelectorAll('[data-role="chip"]')];
  const values = new Set();
  const unlocked = new Set();
  for (const el of nodes) {
    if (el.querySelector?.('[data-role="chip"]')) continue;
    if (el.closest?.('[data-role*="bet-spot"]')) continue;
    const raw =
      el.getAttribute("data-value") ||
      el.getAttribute("data-chip-value") ||
      el.getAttribute("data-denomination") ||
      "";
    let n = parseFloat(String(raw).replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) {
      const m = String(el.textContent || "").match(/(\d+(?:[.,]\d+)?)/);
      if (m) n = parseFloat(m[1].replace(",", "."));
    }
    if (!Number.isFinite(n) || n <= 0 || n > 100000) continue;
    const value = Math.round(n * 100) / 100;
    values.add(value);
    if (!isLocked(el)) unlocked.add(value);
  }
  const denominations = [...values].sort((a, b) => a - b);
  const open = [...unlocked].sort((a, b) => a - b);
  return {
    denominations: open.length ? open : denominations,
  };
}

function _probeTotalBetInFrame() {
  const footer = '[data-role="footer-left"], [data-role="footer-right"]';
  const el = [...document.querySelectorAll('[data-role="total-bet-label-value"]')].find(
    (node) => !node.closest(footer),
  );
  return el ? el.textContent || "" : null;
}

function _parseBrlAmount(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .replace(/\u00a0/g, " ")
    .replace(/[^0-9.,]/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/\./g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

async function _getChipProfile() {
  try {
    const data = await chrome.storage.local.get("bacboConfig");
    const id = data?.bacboConfig?.chipProfile;
    return CHIP_PROFILES[id] || CHIP_PROFILES.bacbo_br;
  } catch (_) {
    return CHIP_PROFILES.bacbo_br;
  }
}

async function _readLiveChipProfile(tabId) {
  const base = await _getChipProfile();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: _probeChipDenominationsInFrame,
    });
    const live = results
      ?.map((r) => r.result)
      .find((r) => r?.denominations?.length);
    return _withLiveChipProfile(base, live?.denominations);
  } catch (_) {
    return base;
  }
}

async function _readTotalBet(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: _probeTotalBetInFrame,
    });
    const raw = results?.map((r) => r.result).find((r) => r);
    return _parseBrlAmount(raw);
  } catch (_) {
    return null;
  }
}

async function _waitForBoardTotal(tabId, expected, timeoutMs = 700) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start <= timeoutMs) {
    last = await _readTotalBet(tabId);
    if (last != null && Math.abs(last - expected) <= 0.01) return last;
    await _cdpDelay(60);
  }
  return last;
}

function _chipIndexForValue(value) {
  const i = CHIP_DENOMINATIONS.indexOf(Number(value));
  return i >= 0 ? i : 0;
}

function _findEvoFrameIdInTree(frameTree) {
  function walk(node) {
    if (!node) return null;
    if (EVO_FRAME_MATCH.test(node.frame?.url || "")) return node.frame.id;
    for (const child of node.childFrames || []) {
      const id = walk(child);
      if (id != null) return id;
    }
    return null;
  }
  return walk(frameTree);
}

function _cdpDelay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* Clique físico via CDP (equivalente ao Playwright ClickAsync — isTrusted no jogo) */
async function _withDebugger(debuggee, fn) {
  try {
    await chrome.debugger.attach(debuggee, "1.3");
    return await fn(debuggee);
  } catch (e) {
    const msg = e?.message || String(e);
    if (/another debugger|devtools/i.test(msg)) {
      return {
        success: false,
        error: "Feche o DevTools da aba do jogo e tente novamente.",
      };
    }
    return { success: false, error: msg };
  } finally {
    try {
      await chrome.debugger.detach(debuggee);
    } catch (_) {}
  }
}

async function _dispatchCdpMouse(debuggee, x, y) {
  const base = { x, y, modifiers: 0, pointerType: "mouse" };
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    ...base,
    type: "mouseMoved",
  });
  await _cdpDelay(4);
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    ...base,
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    buttons: 1,
  });
  await _cdpDelay(8);
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    ...base,
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    buttons: 0,
  });
}

/* Targets CDP do tipo iframe evo (mesma ordem que webNavigation.getAllFrames evo) */
async function _getEvoIframeDebuggerTargets(tabId) {
  const tid = Number(tabId);
  const fromApi = (await chrome.debugger.getTargets()).filter((t) => {
    if (!EVO_FRAME_MATCH.test(t.url || "")) return false;
    if (t.tabId != null && Number(t.tabId) !== tid) return false;
    return t.type === "iframe" || t.type === "page";
  });
  if (fromApi.length) return fromApi;

  // Só tenta atachar ao tab se ainda não há sessão ativa — rastreia para não desatachar sessão alheia
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId: tid }, "1.3");
    attached = true;
    const res = await chrome.debugger.sendCommand(
      { tabId: tid },
      "Target.getTargets",
      {},
    );
    const infos = (res?.targetInfos || []).filter(
      (ti) =>
        EVO_FRAME_MATCH.test(ti.url || "") &&
        (ti.type === "iframe" || ti.type === "page"),
    );
    return infos.map((ti) => ({
      id: ti.targetId,
      url: ti.url,
      tabId: tid,
      type: ti.type,
    }));
  } catch (e) {
    console.warn(
      "[BacList] getEvoIframeDebuggerTargets falhou tabId=",
      tid,
      ":",
      e?.message || e,
    );
    return [];
  } finally {
    // Só desatacha se FOI ESTE bloco que atachou — nunca matar sessão de terceiros
    if (attached) {
      try {
        await chrome.debugger.detach({ tabId: tid });
      } catch (_) {}
    }
  }
}

async function _getEvoIframeDebuggerTarget(tabId, navFrameId) {
  const gameFrames = await _getGameFrames(tabId);
  const frameIndex = gameFrames.findIndex((f) => f.frameId === navFrameId);
  const targets = await _getEvoIframeDebuggerTargets(tabId);
  if (!targets.length) return null;
  return targets[frameIndex >= 0 ? frameIndex : targets.length - 1];
}

const _evoIframeTargetCache = new Map();

/* Iframe evo com chip-stack (CDP target = documento MAIN do iframe, igual Playwright frame) */
async function _getBestEvoIframeDebuggerTarget(tabId) {
  const cached = _evoIframeTargetCache.get(tabId);
  if (cached) {
    const targets = await chrome.debugger.getTargets();
    const hit = targets.find((t) => t.id === cached);
    if (hit) return hit;
    _evoIframeTargetCache.delete(tabId);
  }

  const targets = await _getEvoIframeDebuggerTargets(tabId);
  if (!targets.length) return null;
  if (targets.length === 1) return targets[0];

  let best = targets[targets.length - 1];
  let bestCount = -1;

  for (const t of targets) {
    let count = -1;
    try {
      await chrome.debugger.attach({ targetId: t.id }, "1.3");
      await chrome.debugger.sendCommand({ targetId: t.id }, "Runtime.enable");
      const ev = await chrome.debugger.sendCommand(
        { targetId: t.id },
        "Runtime.evaluate",
        {
          expression:
            'document.querySelectorAll("[data-role=\\"chip-stack\\"] [data-role=\\"chip\\"]").length',
          returnByValue: true,
        },
      );
      count = Number(ev.result?.value) || 0;
    } catch (_) {
      count = -1;
    } finally {
      try {
        await chrome.debugger.detach({ targetId: t.id });
      } catch (_) {}
    }
    if (count > bestCount) {
      bestCount = count;
      best = t;
    }
  }

  if (bestCount > 0) _evoIframeTargetCache.set(tabId, best.id);
  return best;
}

/* Lista todos os frames da árvore CDP (URLs cross-origin podem vir vazias) */
async function _collectCdpFrameList(debuggee) {
  const res = await chrome.debugger.sendCommand(debuggee, "Page.getFrameTree");
  const list = [];
  function walk(node) {
    if (!node) return;
    if (node.frame?.id) list.push(node.frame);
    for (const child of node.childFrames || []) walk(child);
  }
  const root = res?.frameTree?.frameTree ?? res?.frameTree ?? res;
  walk(root);
  return list;
}

/* navFrameId (webNavigation 76) → frame.id do CDP (mesmo índice entre iframes evo) */
async function _resolveCdpFrameIdForNav(debuggee, tabId, navFrameId) {
  const gameFrames = await _getGameFrames(tabId);
  const navIdx = gameFrames.findIndex((f) => f.frameId === navFrameId);
  const pickIdx = navIdx >= 0 ? navIdx : gameFrames.length - 1;

  const all = await _collectCdpFrameList(debuggee);
  const withEvoUrl = all.filter((f) => EVO_FRAME_MATCH.test(f.url || ""));
  if (withEvoUrl.length) {
    return withEvoUrl[pickIdx]?.id || withEvoUrl[withEvoUrl.length - 1].id;
  }

  if (all.length <= 1) return all[0]?.id || null;
  const nested = all.slice(1);
  return nested[pickIdx]?.id || nested[nested.length - 1]?.id;
}

/* Frame CDP com UI do jogo (chip-stack ou bet-spot) */
async function _resolveCdpFrameIdWithGameUi(
  debuggee,
  tabId,
  navFrameId,
  selector,
) {
  const all = await _collectCdpFrameList(debuggee);
  const probe =
    selector && /bet-spot|chip/i.test(selector)
      ? selector
      : '[data-role="chip-stack"], [data-role^="bacbo-bet-spot"]';
  const hits = [];

  for (const frame of all) {
    try {
      const { root } = await chrome.debugger.sendCommand(
        debuggee,
        "DOM.getDocument",
        {
          frameId: frame.id,
          depth: -1,
          pierce: true,
        },
      );
      const hit = await chrome.debugger.sendCommand(
        debuggee,
        "DOM.querySelector",
        {
          nodeId: root.nodeId,
          selector: probe,
        },
      );
      if (hit?.nodeId) hits.push(frame.id);
    } catch (_) {}
  }

  if (hits.length) return hits[hits.length - 1];

  return _resolveCdpFrameIdForNav(debuggee, tabId, navFrameId);
}

/* MAIN world (Runtime.evaluate no iframe target) → DOM.click + mouse trusted */
async function _cdpDomClickChipByValue(debuggee, chipValue) {
  const valStr = JSON.stringify(String(chipValue));

  await chrome.debugger.sendCommand(debuggee, "DOM.enable");
  await chrome.debugger.sendCommand(debuggee, "Runtime.enable");

  // Encontra [data-role="chip"] pelo data-value
  const evalRes = await chrome.debugger.sendCommand(
    debuggee,
    "Runtime.evaluate",
    {
      expression: `(function(){
      var stack = document.querySelector('[data-role="chip-stack"]');
      var chips = stack
        ? [...stack.querySelectorAll('[data-role="chip"]')]
        : [...document.querySelectorAll('[data-role="chip"]')];

      var chip = chips.find(function(c){ return c.getAttribute('data-value') === ${valStr}; });

      if (!chip) {
        var DENOMS = [5,10,25,125,500,2500];
        var idx = DENOMS.indexOf(Number(${valStr}));
        if (idx >= 0) chip = chips[idx];
      }
      if (!chip) chip = chips[0];
      return chip || null;
    })()`,
      objectGroup: "baclist_chip_val",
    },
  );

  if (evalRes.exceptionDetails) {
    const t =
      evalRes.exceptionDetails.text ||
      evalRes.exceptionDetails.exception?.description;
    return {
      success: false,
      error: t || "Runtime.evaluate falhou (chip value)",
    };
  }
  if (!evalRes.result?.objectId) {
    return {
      success: false,
      error: "Ficha com data-value=" + chipValue + " não encontrada",
    };
  }

  const { nodeId } = await chrome.debugger.sendCommand(
    debuggee,
    "DOM.requestNode",
    {
      objectId: evalRes.result.objectId,
    },
  );

  try {
    await chrome.debugger.sendCommand(debuggee, "DOM.scrollIntoViewIfNeeded", {
      nodeId,
    });
  } catch (_) {}

  // Coordenadas do centro do [data-role="chip"]
  let cx = null;
  let cy = null;
  try {
    const bm = await chrome.debugger.sendCommand(debuggee, "DOM.getBoxModel", {
      nodeId,
    });
    const c = bm?.model?.content;
    if (c && c.length >= 8) {
      cx = (c[0] + c[2] + c[4] + c[6]) / 4;
      cy = (c[1] + c[3] + c[5] + c[7]) / 4;
    }
  } catch (_) {}

  if (cx == null) {
    return {
      success: false,
      error: "Não foi possível obter coordenadas da ficha " + chipValue,
    };
  }

  // Clique físico via mouse events — o jogo registra pelo position hit-test
  await _cdpDelay(40);
  await _dispatchCdpMouse(debuggee, cx, cy);

  try {
    await chrome.debugger.sendCommand(debuggee, "Runtime.releaseObjectGroup", {
      objectGroup: "baclist_chip_val",
    });
  } catch (_) {}

  return {
    success: true,
    nodeId,
    chipValue,
    localX: Math.round(cx),
    localY: Math.round(cy),
    method: "chip-by-data-value",
  };
}

async function _cdpDomClickViaRuntimeEvaluate(debuggee, selector, index) {
  const idx = Number(index) || 0;
  const selJson = JSON.stringify(String(selector));

  await chrome.debugger.sendCommand(debuggee, "DOM.enable");
  await chrome.debugger.sendCommand(debuggee, "Runtime.enable");

  const evalRes = await chrome.debugger.sendCommand(
    debuggee,
    "Runtime.evaluate",
    {
      expression: `(function(){
      var list = document.querySelectorAll(${selJson});
      return list[${idx}] || null;
    })()`,
      objectGroup: "baclist_qs",
    },
  );

  if (evalRes.exceptionDetails) {
    const t =
      evalRes.exceptionDetails.text ||
      evalRes.exceptionDetails.exception?.description;
    return { success: false, error: t || "Runtime.evaluate falhou" };
  }
  if (!evalRes.result?.objectId) {
    return {
      success: false,
      error:
        "QuerySelectorAll " +
        selJson +
        ": índice " +
        idx +
        " não encontrado (MAIN)",
    };
  }

  const { nodeId } = await chrome.debugger.sendCommand(
    debuggee,
    "DOM.requestNode",
    {
      objectId: evalRes.result.objectId,
    },
  );

  try {
    await chrome.debugger.sendCommand(debuggee, "DOM.scrollIntoViewIfNeeded", {
      nodeId,
    });
  } catch (_) {}

  let cx = null;
  let cy = null;
  try {
    const bm = await chrome.debugger.sendCommand(debuggee, "DOM.getBoxModel", {
      nodeId,
    });
    const c = bm?.model?.content;
    if (c && c.length >= 8) {
      cx = (c[0] + c[2] + c[4] + c[6]) / 4;
      cy = (c[1] + c[3] + c[5] + c[7]) / 4;
    }
  } catch (_) {}

  await _cdpDelay(40);
  await chrome.debugger.sendCommand(debuggee, "DOM.click", { nodeId });

  if (cx != null && cy != null) {
    await _cdpDelay(30);
    await _dispatchCdpMouse(debuggee, cx, cy);
  }

  try {
    await chrome.debugger.sendCommand(debuggee, "Runtime.releaseObjectGroup", {
      objectGroup: "baclist_qs",
    });
  } catch (_) {}

  return {
    success: true,
    nodeId,
    selector: String(selector),
    index: idx,
    x: cx,
    y: cy,
    method: "cdp-iframe-runtime-dom",
  };
}

/* QuerySelector / performSearch no documento do frame → DOM.click (trusted) */
async function _cdpDomClickViaDomApi(debuggee, cdpFrameId, selector, index) {
  const idx = Number(index) || 0;
  const sel = String(selector);

  await chrome.debugger.sendCommand(debuggee, "DOM.enable");

  const docParams = { depth: -1, pierce: true };
  if (cdpFrameId) docParams.frameId = cdpFrameId;

  const { root } = await chrome.debugger.sendCommand(
    debuggee,
    "DOM.getDocument",
    docParams,
  );

  let nodeId = null;
  let total = 0;

  if (idx === 0) {
    const qs = await chrome.debugger.sendCommand(
      debuggee,
      "DOM.querySelector",
      {
        nodeId: root.nodeId,
        selector: sel,
      },
    );
    nodeId = qs?.nodeId;
    total = nodeId ? 1 : 0;
  }

  if (!nodeId) {
    try {
      const searchRes = await chrome.debugger.sendCommand(
        debuggee,
        "DOM.performSearch",
        {
          query: sel,
          includeUserAgentShadowDOM: true,
        },
      );
      const resultCount = Number(searchRes?.resultCount) || 0;
      if (resultCount > 0 && idx < resultCount) {
        const toIndex = Math.min(resultCount, idx + 1);
        const { nodeIds } = await chrome.debugger.sendCommand(
          debuggee,
          "DOM.getSearchResults",
          {
            searchId: searchRes.searchId,
            fromIndex: idx,
            toIndex,
          },
        );
        total = resultCount;
        nodeId = nodeIds?.[0];
      }
      if (searchRes?.searchId != null) {
        await chrome.debugger.sendCommand(
          debuggee,
          "DOM.discardSearchResults",
          {
            searchId: searchRes.searchId,
          },
        );
      }
    } catch (searchErr) {
      return {
        success: false,
        error: searchErr?.message || String(searchErr),
        cdpFrameId,
      };
    }
  }

  if (!nodeId) {
    return {
      success: false,
      error:
        'QuerySelectorAll "' +
        sel +
        '": índice ' +
        idx +
        " não encontrado (total " +
        total +
        ")",
      cdpFrameId,
    };
  }

  try {
    await chrome.debugger.sendCommand(debuggee, "DOM.scrollIntoViewIfNeeded", {
      nodeId,
    });
  } catch (_) {}

  await _cdpDelay(60);
  await chrome.debugger.sendCommand(debuggee, "DOM.click", { nodeId });

  return {
    success: true,
    nodeId,
    selector: sel,
    index: idx,
    count: total,
    cdpFrameId,
    method: "cdp-dom-queryselector",
  };
}

/* Centro do elemento no frame (inject) */
function _centerInFrame(selector, index) {
  const list = document.querySelectorAll(String(selector));
  const el = list[Number(index) || 0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return null;
  return { lx: r.left + r.width / 2, ly: r.top + r.height / 2 };
}

/* Verifica qual ficha está selecionada no chip-stack (autocontida) */
function _probeSelectedChipInFrame(expectedValue) {
  const expectedNum = Number(expectedValue);
  const expected = String(expectedNum);
  const stack = document.querySelector('[data-role="chip-stack"]');
  const chips = stack
    ? [...stack.querySelectorAll('[data-role="chip"]')]
    : [...document.querySelectorAll('[data-role="chip"]')];

  // Método primário: pai com data-role="selected-chip" contém o chip selecionado
  let selected = chips.find(
    (c) => c.parentElement?.getAttribute("data-role") === "selected-chip",
  );

  // Fallbacks para outras implementações
  if (!selected) {
    selected = chips.find((c) => {
      const st = (c.getAttribute("data-state") || "").toLowerCase();
      return st === "selected" || st === "activated" || st === "active";
    });
  }
  if (!selected) {
    selected = chips.find(
      (c) =>
        c.getAttribute("aria-selected") === "true" ||
        c.getAttribute("data-is-top") === "true",
    );
  }

  const selectedVal = selected?.getAttribute("data-value") || null;
  const same = (raw) => {
    const n = Number(String(raw || "").replace(",", "."));
    return Number.isFinite(n) && Math.abs(n - expectedNum) < 0.001;
  };
  const target = chips.find((c) => same(c.getAttribute("data-value")));

  return {
    ok: same(selectedVal),
    selectedValue: selectedVal,
    expectedValue: expected,
    selectedState:
      selected?.parentElement?.getAttribute("data-role") ||
      selected?.getAttribute("data-state") ||
      null,
    targetExists: !!target,
    targetDataValue: target?.getAttribute("data-value") || null,
    chipCount: chips.length,
  };
}

/* Variante que busca ficha por data-value em vez de índice */
function _centerChipByValue(chipValue) {
  const stack = document.querySelector('[data-role="chip-stack"]');
  const chips = stack
    ? [...stack.querySelectorAll('[data-role="chip"]')]
    : [...document.querySelectorAll('[data-role="chip"]')];

  const valStr = String(chipValue);
  let chip = chips.find((c) => c.getAttribute("data-value") === valStr);
  if (!chip) {
    const DENOMS = [5, 10, 25, 125, 500, 2500];
    const idx = DENOMS.indexOf(Number(chipValue));
    if (idx >= 0) chip = chips[idx];
  }
  if (!chip) chip = chips[0];
  if (!chip) return null;

  // Usa o [data-role="chip"] diretamente — é nele que os event listeners do jogo estão
  const r = chip.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return null;
  return {
    lx: r.left + r.width / 2,
    ly: r.top + r.height / 2,
    dataValue: chip.getAttribute("data-value"),
  };
}

/* Offset do iframe evo no documento pai (inject) */
function _evoIframeOffsetInParent(evoIndex) {
  const evoIframes = [...document.querySelectorAll("iframe")].filter((el) =>
    /evo-games\.com/i.test(el.src || el.getAttribute("src") || ""),
  );
  const idx = Number(evoIndex) || 0;
  const iframe = evoIframes[idx] ?? evoIframes[evoIframes.length - 1];
  if (!iframe) return null;
  const r = iframe.getBoundingClientRect();
  return { left: r.left, top: r.top };
}

/* local (iframe) + offset(s) dos pais → coordenadas viewport da aba */
async function _resolveViewportCoordsForNavFrame(
  tabId,
  navFrameId,
  selector,
  index,
) {
  const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
  const meta = allFrames.find((f) => f.frameId === navFrameId);
  if (!meta) return null;

  const localInj = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [navFrameId] },
    world: "MAIN",
    func: _centerInFrame,
    args: [selector, index],
  });
  const local = localInj?.[0]?.result;
  if (!local) return null;

  const gameFrames = allFrames.filter((f) => EVO_FRAME_MATCH.test(f.url || ""));
  const evoIdx = Math.max(
    0,
    gameFrames.findIndex((f) => f.frameId === navFrameId),
  );

  let vx = local.lx;
  let vy = local.ly;

  const chain = [];
  let cur = meta;
  const seen = new Set();
  while (cur && !seen.has(cur.frameId)) {
    seen.add(cur.frameId);
    chain.unshift(cur);
    if (cur.parentFrameId == null || cur.parentFrameId === cur.frameId) break;
    cur = allFrames.find((f) => f.frameId === cur.parentFrameId);
  }

  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i + 1];
    const parentId = chain[i].frameId;
    const childEvoIdx = gameFrames.findIndex(
      (f) => f.frameId === child.frameId,
    );
    const offInj = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [parentId] },
      world: "MAIN",
      func: _evoIframeOffsetInParent,
      args: [childEvoIdx >= 0 ? childEvoIdx : evoIdx],
    });
    const off = offInj?.[0]?.result;
    if (!off) return null;
    vx += off.left;
    vy += off.top;
  }

  return {
    x: Math.round(vx),
    y: Math.round(vy),
    frameId: navFrameId,
    evoIndex: evoIdx,
  };
}

/* Coords viewport da ficha — mesma cadeia de iframes dos spots */
async function _resolveChipViewportCoords(tabId, navFrameId, chipValue) {
  const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
  const meta = allFrames.find((f) => f.frameId === navFrameId);
  if (!meta) return null;

  const localInj = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [navFrameId] },
    world: "MAIN",
    func: _centerChipByValue,
    args: [chipValue],
  });
  const local = localInj?.[0]?.result;
  if (!local) return null;

  const gameFrames = allFrames.filter((f) => EVO_FRAME_MATCH.test(f.url || ""));
  const evoIdx = Math.max(
    0,
    gameFrames.findIndex((f) => f.frameId === navFrameId),
  );

  let vx = local.lx;
  let vy = local.ly;

  const chain = [];
  let cur = meta;
  const seen = new Set();
  while (cur && !seen.has(cur.frameId)) {
    seen.add(cur.frameId);
    chain.unshift(cur);
    if (cur.parentFrameId == null || cur.parentFrameId === cur.frameId) break;
    cur = allFrames.find((f) => f.frameId === cur.parentFrameId);
  }

  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i + 1];
    const parentId = chain[i].frameId;
    const childEvoIdx = gameFrames.findIndex(
      (f) => f.frameId === child.frameId,
    );
    const offInj = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [parentId] },
      world: "MAIN",
      func: _evoIframeOffsetInParent,
      args: [childEvoIdx >= 0 ? childEvoIdx : evoIdx],
    });
    const off = offInj?.[0]?.result;
    if (!off) return null;
    vx += off.left;
    vy += off.top;
  }

  return {
    x: Math.round(vx),
    y: Math.round(vy),
    frameId: navFrameId,
    dataValue: local.dataValue,
    expectedValue: chipValue,
  };
}

async function _verifyChipSelected(tabId, frameId, chipValue) {
  await _cdpDelay(300);
  try {
    const inj = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: _probeSelectedChipInFrame,
      args: [chipValue],
    });
    const probe = inj?.[0]?.result;
    const inconclusive = !probe?.selectedValue && probe?.targetExists;
    console.log(
      "[BacList] Ficha selecionada:",
      probe?.ok ? "✓" : inconclusive ? "?" : "✗",
      "esperado=",
      probe?.expectedValue,
      "atual=",
      probe?.selectedValue ?? "n/d",
      "| state=",
      probe?.selectedState,
    );
    return { ok: !!probe?.ok, inconclusive, probe };
  } catch (e) {
    console.warn("[BacList] Verificação ficha falhou:", e?.message);
    return { ok: false, inconclusive: false, error: e?.message };
  }
}

async function _trySelectChipWithVerify(tabId, frameId, chipValue, methodFn) {
  const r = await methodFn();
  if (!r?.success) return r;

  const v = await _verifyChipSelected(tabId, frameId, chipValue);
  if (v.ok) return { ...r, verified: true, probe: v.probe };

  /* Viewport com cadeia completa (igual spots) — aceitar se DOM não expõe state */
  if (v.inconclusive && /viewport/i.test(r.method || "")) {
    console.warn(
      "[BacList] Ficha",
      chipValue,
      "— verificação inconclusiva, confiando em viewport",
    );
    return { ...r, verified: false, inconclusive: true, probe: v.probe };
  }

  return {
    ...r,
    success: false,
    verified: false,
    error:
      "ficha " +
      chipValue +
      " não selecionada (atual=" +
      (v.probe?.selectedValue ?? "n/d") +
      ")",
    probe: v.probe,
  };
}

async function _cdpClickViaScriptingViewport(
  tabId,
  navFrameId,
  selector,
  index,
) {
  const coords = await _resolveViewportCoordsForNavFrame(
    tabId,
    navFrameId,
    selector,
    index,
  );
  if (!coords) {
    return {
      success: false,
      error: "Coords viewport: elemento não encontrado no frame " + navFrameId,
    };
  }

  console.log(
    "[BacList] CDP mouse viewport",
    coords.x,
    coords.y,
    "frame",
    navFrameId,
    selector,
    index,
  );

  const r = await _withDebugger({ tabId }, async (dbg) => {
    await _dispatchCdpMouse(dbg, coords.x, coords.y);
    return {
      success: true,
      x: coords.x,
      y: coords.y,
      method: "cdp-viewport-scripting",
      ...coords,
    };
  });
  return r?.success ? { ...r, navFrameId } : r;
}

/* Form1: frame.QuerySelectorAllAsync(sel) → [index] → ClickAsync */
async function _cdpClickByQuerySelector(tabId, navFrameId, selector, index) {
  const idx = Number(index) || 0;
  const sel = String(selector || '[data-role="chip"]');

  const iframeTargets = await _getEvoIframeDebuggerTargets(tabId);
  if (!iframeTargets.length) {
    console.warn(
      "[BacList] Nenhum target CDP iframe evo; usando coords do DOM",
    );
  }

  const iframeTarget = await _getBestEvoIframeDebuggerTarget(tabId);
  if (iframeTarget?.id) {
    const r = await _withDebugger(
      { targetId: iframeTarget.id },
      async (dbg) => {
        const click = await _cdpDomClickViaRuntimeEvaluate(dbg, sel, idx);
        return { ...click, targetId: iframeTarget.id };
      },
    );
    if (r?.success) return { ...r, navFrameId };
    console.warn("[BacList] iframe Runtime click:", r?.error);
  }

  const navTarget = await _getEvoIframeDebuggerTarget(tabId, navFrameId);
  if (navTarget?.id && navTarget.id !== iframeTarget?.id) {
    const r2 = await _withDebugger({ targetId: navTarget.id }, async (dbg) => {
      return _cdpDomClickViaRuntimeEvaluate(dbg, sel, idx);
    });
    if (r2?.success) return { ...r2, navFrameId, targetId: navTarget.id };
    console.warn("[BacList] iframe nav Runtime:", r2?.error);
  }

  const rVp = await _cdpClickViaScriptingViewport(tabId, navFrameId, sel, idx);
  if (rVp?.success) return rVp;
  console.warn("[BacList] viewport scripting:", rVp?.error);

  return _withDebugger({ tabId }, async (dbg) => {
    try {
      await chrome.debugger.sendCommand(dbg, "Page.enable");

      const preferred = await _resolveCdpFrameIdWithGameUi(
        dbg,
        tabId,
        navFrameId,
        sel,
      );
      const allFrames = await _collectCdpFrameList(dbg);
      const tryIds = [];
      if (preferred) tryIds.push(preferred);
      for (const f of allFrames) {
        if (f.id && !tryIds.includes(f.id)) tryIds.push(f.id);
      }

      let lastErr =
        "Frame CDP com UI do jogo não encontrado (nav " + navFrameId + ")";
      for (const cdpFrameId of tryIds) {
        console.log(
          "[BacList] DOM.click frame",
          cdpFrameId,
          "nav",
          navFrameId,
          sel,
          idx,
        );
        const click = await _cdpDomClickViaDomApi(dbg, cdpFrameId, sel, idx);
        if (click.success) {
          return {
            ...click,
            navFrameId,
            method: click.method || "cdp-frame-dom",
          };
        }
        lastErr = click.error || lastErr;
      }

      return { success: false, error: lastErr, navFrameId };
    } catch (e) {
      return { success: false, error: e?.message || String(e), navFrameId };
    }
  });
}

async function _cdpDomClickInNavFrame(tabId, navFrameId, selector, index) {
  return _cdpClickByQuerySelector(tabId, navFrameId, selector, index);
}

/* Clique no iframe do jogo: 1) target iframe + coords locais  2) aba + coords viewport */
async function _cdpClickInGameFrame(tabId, frameId, coords) {
  const gameFrames = await _getGameFrames(tabId);
  const frameIndex = gameFrames.findIndex((f) => f.frameId === frameId);
  const iframeTargets = await _getEvoIframeDebuggerTargets(tabId);
  const iframeTarget =
    iframeTargets[frameIndex >= 0 ? frameIndex : iframeTargets.length - 1];

  const attempts = [];

  if (iframeTarget?.id && coords.localX != null) {
    const r = await _withDebugger(
      { targetId: iframeTarget.id },
      async (dbg) => {
        await _dispatchCdpMouse(dbg, coords.localX, coords.localY);
        return {
          success: true,
          method: "cdp-iframe-target",
          x: coords.localX,
          y: coords.localY,
          targetId: iframeTarget.id,
        };
      },
    );
    attempts.push(r);
    if (r?.success) return { ...r, coordMode: coords.coordMode, frameId };
  }

  const tabX = coords.tabX ?? coords.x;
  const tabY = coords.tabY ?? coords.y;
  const r2 = await _withDebugger({ tabId }, async (dbg) => {
    await _dispatchCdpMouse(dbg, tabX, tabY);
    return { success: true, method: "cdp-tab-viewport", x: tabX, y: tabY };
  });
  attempts.push(r2);
  if (r2?.success)
    return { ...r2, coordMode: coords.coordMode, frameId, attempts };

  return {
    success: false,
    error:
      attempts
        .map((a) => a?.error)
        .filter(Boolean)
        .join(" | ") || "CDP falhou",
    attempts,
  };
}

/* Igual ao desktop Playwright: QuerySelectorAll + elementos[index] no iframe evo.
   Converte getBoundingClientRect para coordenadas do viewport da aba (CDP Input). */
async function _resolveTargetInGameFrame(
  tabId,
  selector,
  index,
  expectedRolePart,
) {
  const { frameId, count, cached } = await _findBestFrameForSelector(
    tabId,
    selector,
  );
  if (frameId == null)
    return { success: false, error: "Iframe evo-games não encontrado." };
  if (!cached && count === 0) {
    return {
      success: false,
      error: "Elemento não encontrado em nenhum iframe evo: " + selector,
      frameId,
    };
  }

  const inj = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: _findClickTargetInFrame,
    args: [selector, index, expectedRolePart || ""],
  });
  const result = inj?.[0]?.result || {
    success: false,
    error: "Sem resposta ao localizar elemento.",
  };
  if (result.success) result.frameId = frameId;
  return result;
}

/* Autocontida — MAIN world do iframe (zero refs externas; cada func injetada é isolada) */
function _findClickTargetInFrame(selector, index, expectedRolePart) {
  const FOOTER = '[data-role="footer-left"], [data-role="footer-right"]';

  function inFooter(el) {
    return !!(el && el.closest(FOOTER));
  }

  function tabViewportCenter(el) {
    const target =
      el.closest('[data-role="chip"]') || el.closest(".vBTBjG") || el;
    target.scrollIntoView({ block: "center", inline: "center" });
    const r = target.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      return { success: false, error: "Elemento sem área visível" };
    }
    const localX = Math.round(r.left + r.width / 2);
    const localY = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(localX, localY);
    return {
      success: true,
      localX,
      localY,
      tabX: localX,
      tabY: localY,
      x: localX,
      y: localY,
      coordMode: "viewport-rect",
      width: Math.round(r.width),
      height: Math.round(r.height),
      dataRole: el.getAttribute("data-role") || "",
      dataValue: el.getAttribute("data-value") || "",
      hitRole: hit?.getAttribute?.("data-role") || "",
      hitTag: hit?.tagName || "",
      hitsTarget: !!(
        hit &&
        (target === hit || target.contains(hit) || el.contains(hit))
      ),
    };
  }

  const idx = Number(index) || 0;
  const all = Array.from(document.querySelectorAll(selector));
  const list = all.filter((el) => !inFooter(el));
  const count = list.length;

  if (!count || !list[idx]) {
    return {
      success: false,
      error: "Nenhum alvo fora do histórico (footer)",
      selector,
      index: idx,
      countAll: all.length,
      countFooter: all.length - count,
      frameUrl: location.href,
    };
  }

  const el = list[idx];
  const dataRole = el.getAttribute("data-role") || "";

  if (expectedRolePart && !dataRole.includes(expectedRolePart)) {
    return {
      success: false,
      error: "data-role incorreto: " + dataRole,
      expected: expectedRolePart,
      selector,
      frameUrl: location.href,
    };
  }

  const coords = tabViewportCenter(el);
  if (!coords.success) return { ...coords, selector, frameUrl: location.href };

  if (inFooter(document.elementFromPoint(coords.x, coords.y))) {
    return {
      success: false,
      error: "Coordenadas caem no footer (histórico)",
      dataRole,
      hitRole: coords.hitRole,
      x: coords.x,
      y: coords.y,
      frameUrl: location.href,
    };
  }

  return {
    success: true,
    selector,
    index: idx,
    count,
    countAll: all.length,
    ...coords,
    tagName: el.tagName,
    frameUrl: location.href,
  };
}

/* Clique por eventos no chip-stack (fallback se CDP DOM falhar) */
function _clickChipStackInFrame(chipIndex, chipValue) {
  const stack = document.querySelector('[data-role="chip-stack"]');
  if (!stack) return { success: false, error: "chip-stack ausente" };

  const chips = [...stack.querySelectorAll('[data-role="chip"]')];
  const idx = Number(chipIndex) || 0;
  const chip =
    chips.find((c) => c.getAttribute("data-value") === String(chipValue)) ||
    chips[idx];
  if (!chip)
    return {
      success: false,
      error: "ficha não encontrada no stack",
      count: chips.length,
    };

  // Usa o [data-role="chip"] diretamente — é nele que os event listeners do jogo estão
  chip.scrollIntoView({ block: "center", inline: "center" });
  const r = chip.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const types = [
    "pointerover",
    "pointerenter",
    "pointerdown",
    "mousedown",
    "mouseup",
    "click",
    "pointerup",
  ];

  types.forEach((type) => {
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: 0,
      buttons: type.includes("down") ? 1 : 0,
    };
    try {
      chip.dispatchEvent(
        new PointerEvent(type, {
          ...opts,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    } catch (_) {
      chip.dispatchEvent(new MouseEvent(type, opts));
    }
  });
  try {
    chip.click();
  } catch (_) {}

  return {
    success: true,
    method: "main-pointer-chip-stack",
    dataValue: chip.getAttribute("data-value"),
    localX: Math.round(cx),
    localY: Math.round(cy),
  };
}

/* Ficha índice 0 — só chip-stack (como a mesa ativa) */
function _findChipTargetDesktop(chipIndex) {
  const FOOTER = '[data-role="footer-left"], [data-role="footer-right"]';

  function inFooter(el) {
    return !!(el && el.closest(FOOTER));
  }

  function tabViewportCenter(el) {
    // Usa o [data-role="chip"] diretamente — é nele que os event listeners do jogo estão
    const target = el.closest('[data-role="chip"]') || el;
    target.scrollIntoView({ block: "center", inline: "center" });
    const r = target.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      return { success: false, error: "Elemento sem área visível" };
    }
    const localX = Math.round(r.left + r.width / 2);
    const localY = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(localX, localY);
    return {
      success: true,
      localX,
      localY,
      tabX: localX,
      tabY: localY,
      x: localX,
      y: localY,
      coordMode: "viewport-rect",
      width: Math.round(r.width),
      height: Math.round(r.height),
      dataRole: el.getAttribute("data-role") || "",
      dataValue: el.getAttribute("data-value") || "",
      hitRole: hit?.getAttribute?.("data-role") || "",
      hitTag: hit?.tagName || "",
      hitsTarget: !!(
        hit &&
        (target === hit || target.contains(hit) || el.contains(hit))
      ),
    };
  }

  const idx = Number(chipIndex) || 0;
  const stack = document.querySelector('[data-role="chip-stack"]');
  let chips = stack
    ? [...stack.querySelectorAll('[data-role="chip"]')]
    : [...document.querySelectorAll('[data-role="chip"]')];
  chips = chips.filter((el) => !inFooter(el));

  if (!chips.length || !chips[idx]) {
    return {
      success: false,
      error: "Ficha índice " + idx + " não encontrada no chip-stack",
      count: chips.length,
      hasStack: !!stack,
      frameUrl: location.href,
    };
  }

  const el = chips[idx];
  const coords = tabViewportCenter(el);
  if (!coords.success) return { ...coords, frameUrl: location.href };

  return {
    success: true,
    mode: "chip-stack-index",
    index: idx,
    count: chips.length,
    points: [
      {
        localX: coords.localX,
        localY: coords.localY,
        x: coords.x,
        y: coords.y,
        dataRole: coords.dataRole,
        dataValue: coords.dataValue,
      },
    ],
    ...coords,
    frameUrl: location.href,
  };
}

async function _cdpClickAtViewport(tabId, x, y) {
  return _withDebugger({ tabId }, async (debuggee) => {
    await _dispatchCdpMouse(debuggee, x, y);
    return { success: true, x, y, method: "cdp-tab-viewport" };
  });
}

/* Só CDP (isTrusted) — el.click() no MAIN é ignorado pelo Evolution */
async function _cdpClickLikeDesktop(tabId, selector, index = 0) {
  if (!tabId || !selector) {
    return { success: false, error: "Parâmetros inválidos." };
  }

  const expectedRolePart = selector.includes("bacbo-bet-spot")
    ? "bacbo-bet-spot"
    : selector.includes("repeat-button") || selector.includes("double-button")
      ? ""
      : "chip";
  const target = await _resolveTargetInGameFrame(
    tabId,
    selector,
    index,
    expectedRolePart,
  );
  if (!target.success) return target;

  console.log("[BacList] CDP spot", target.dataRole, "frameId", target.frameId);

  const clickR = await _cdpClickByQuerySelector(
    tabId,
    target.frameId,
    selector,
    index,
  );
  if (!clickR.success) return { ...clickR, target };

  return { ...clickR, ...target, method: clickR.method || "cdp-desktop" };
}

/* Frame evo que contém fichas (usado na aposta) */
async function _findBestChipFrameId(tabId) {
  const cached = _getCachedUiFrame(tabId);
  if (cached != null) return cached;

  const gameFrames = await _getGameFrames(tabId);
  if (!gameFrames.length) return null;

  let bestId = null;
  let bestCount = 0;

  for (const f of gameFrames) {
    try {
      const inj = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        world: "MAIN",
        func: _countStackChipsInFrame,
      });
      const count = inj?.[0]?.result || 0;
      if (count > bestCount) {
        bestCount = count;
        bestId = f.frameId;
      }
    } catch (_) {}
  }

  const id = bestId ?? _primaryGameFrameId(gameFrames);
  if (bestId != null) _cacheUiFrame(tabId, bestId);
  return id;
}

/* Coordenadas absolutas (viewport da aba) de qualquer elemento em qualquer frame.
   Usa scripting.executeScript (funciona cross-origin em extensões) — sem tocar na
   sessão CDP. allFrames deve ser obtido com o debugger já anexado (layout estável). */
async function _resolveElementViewportCoords(tabId, selector, allFrames) {
  let elemFrameId = null;
  let localX = null;
  let localY = null;

  for (const f of allFrames) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        world: "MAIN",
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          // Scroll imediato (sem animação) para garantir posição estável
          el.scrollIntoView({
            block: "nearest",
            inline: "nearest",
            behavior: "instant",
          });
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        },
        args: [selector],
      });
      if (res?.result) {
        elemFrameId = f.frameId;
        localX = res.result.x;
        localY = res.result.y;
        break;
      }
    } catch (_) {}
  }

  if (elemFrameId == null) return null;

  // Acumula offsets dos iframes pai até o viewport da aba
  let vx = localX;
  let vy = localY;
  let curFrameId = elemFrameId;

  while (true) {
    const cur = allFrames.find((f) => f.frameId === curFrameId);
    if (!cur || cur.parentFrameId == null || cur.parentFrameId === curFrameId)
      break;

    const childUrl = cur.url || "";
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [cur.parentFrameId] },
        world: "MAIN",
        func: (childSrc) => {
          const iframes = [...document.querySelectorAll("iframe")];
          let el = iframes.find((el) => {
            const s = el.src || el.getAttribute("src") || "";
            return s && childSrc && s === childSrc;
          });
          if (!el && childSrc) {
            const base = childSrc.split("?")[0];
            el = iframes.find((el) => {
              const s = (el.src || el.getAttribute("src") || "").split("?")[0];
              return s && s === base;
            });
          }
          if (!el) {
            el = iframes
              .map((el) => ({ el, r: el.getBoundingClientRect() }))
              .filter(({ r }) => r.width > 10 && r.height > 10)
              .sort(
                (a, b) => b.r.width * b.r.height - a.r.width * a.r.height,
              )[0]?.el;
          }
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top };
        },
        args: [childUrl],
      });
      if (!res?.result) break;
      vx += res.result.left;
      vy += res.result.top;
    } catch (_) {
      break;
    }
    curFrameId = cur.parentFrameId;
  }

  return { x: vx, y: vy };
}

/* Clica em qualquer elemento via Input.dispatchMouseEvent, reusando sessão CDP aberta */
async function _clickElementWithSession(
  dbg,
  tabId,
  selector,
  allFrames,
  label,
) {
  const coords = await _resolveElementViewportCoords(
    tabId,
    selector,
    allFrames,
  );
  if (!coords) {
    return {
      success: false,
      error: `${label || selector} não encontrado em nenhum frame.`,
    };
  }
  console.log(
    "[BacList]",
    label || selector,
    "→",
    Math.round(coords.x),
    Math.round(coords.y),
  );
  await _dispatchCdpMouse(dbg, coords.x, coords.y);
  return { success: true, selector, x: coords.x, y: coords.y };
}

/* Clica em um seletor usando o target CDP do iframe diretamente (sem acumular offsets de viewport).
   iframeDbg deve ser { targetId } de um target já attachado. */
async function _dispatchMouseOnIframeTarget(iframeDbg, selector) {
  const docRes = await chrome.debugger.sendCommand(
    iframeDbg,
    "DOM.getDocument",
    { depth: 0 },
  );
  const { nodeId } = await chrome.debugger.sendCommand(
    iframeDbg,
    "DOM.querySelector",
    {
      nodeId: docRes.root.nodeId,
      selector,
    },
  );
  if (!nodeId)
    return { success: false, error: `${selector} não encontrado no iframe` };

  const { model } = await chrome.debugger.sendCommand(
    iframeDbg,
    "DOM.getBoxModel",
    { nodeId },
  );
  if (!model)
    return { success: false, error: `getBoxModel falhou para ${selector}` };

  // model.content: [x1,y1, x2,y1, x2,y2, x1,y2] — centro da caixa de conteúdo
  const cx = (model.content[0] + model.content[2]) / 2;
  const cy = (model.content[1] + model.content[5]) / 2;

  console.log(
    "[BacList] iframe-target click",
    selector,
    "→",
    Math.round(cx),
    Math.round(cy),
  );
  await _dispatchCdpMouse(iframeDbg, cx, cy);
  return { success: true, x: cx, y: cy };
}

/* Verifica se a ficha com o valor esperado está selecionada via Runtime.evaluate no iframe target */
async function _probeSelectedChipInFrame_v2(iframeDbg, expectedValue) {
  const expected = String(Number(expectedValue) || 5);
  try {
    const { result } = await chrome.debugger.sendCommand(
      iframeDbg,
      "Runtime.evaluate",
      {
        expression: `(function(expected) {
        const stack = document.querySelector('[data-role="chip-stack"]');
        const chips = stack
          ? [...stack.querySelectorAll('[data-role="chip"]')]
          : [...document.querySelectorAll('[data-role="chip"]')];
        let sel = chips.find(c => c.parentElement?.getAttribute('data-role') === 'selected-chip');
        if (!sel) sel = chips.find(c => {
          const st = (c.getAttribute('data-state') || '').toLowerCase();
          return st === 'selected' || st === 'activated' || st === 'active';
        });
        if (!sel) sel = chips.find(c =>
          c.getAttribute('aria-selected') === 'true' || c.getAttribute('data-is-top') === 'true'
        );
        const raw = sel?.getAttribute('data-value') || '';
        const n = Number(String(raw).replace(',', '.'));
        return Number.isFinite(n) && Math.abs(n - Number(expected)) < 0.001;
      })(${JSON.stringify(expected)})`,
        returnByValue: true,
      },
    );
    return !!result?.value;
  } catch (_) {
    return false;
  }
}

/* Verifica se o spot já tem fichas apostadas (indicador de bet ativo) */
async function _verifyBetOnSpot(iframeDbg, spotSel) {
  await _cdpDelay(50);
  try {
    const { result } = await chrome.debugger.sendCommand(
      iframeDbg,
      "Runtime.evaluate",
      {
        expression: `(function(sel) {
        const spot = document.querySelector(sel);
        if (!spot) return { ok: false, reason: 'spot-not-found' };

        const text = [
          spot.textContent || '',
          spot.getAttribute('aria-label') || '',
          spot.getAttribute('title') || ''
        ].join(' ').replace(/\\s+/g, ' ').trim();
        const betAmount = Number(spot.dataset.betAmount || spot.dataset.amount || 0);
        const hasFlag = spot.dataset.hasChips === 'true'
          || spot.getAttribute('data-has-chips') === 'true'
          || spot.getAttribute('data-state') === 'active';
        const hasMoneyText = /(?:R\\$|BRL|\\$)\\s*\\d|\\d+[,.]\\d{2}/i.test(text);

        const sr = spot.getBoundingClientRect();
        const markerSelector = [
          '[data-role="chip"]',
          '[data-role*="chip"]',
          '[class*="chip"]',
          '[class*="Chip"]',
          '[data-bet-amount]',
          '[data-amount]'
        ].join(',');
        const markerInSpot = [...document.querySelectorAll(markerSelector)].some((el) => {
          if (!el || el === spot) return false;
          if (spot.contains(el)) return true;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const cx = (r.left + r.right) / 2;
          const cy = (r.top + r.bottom) / 2;
          return cx >= sr.left && cx <= sr.right && cy >= sr.top && cy <= sr.bottom;
        });

        return {
          ok: markerInSpot || betAmount > 0 || hasFlag || hasMoneyText,
          markerInSpot,
          betAmount,
          hasFlag,
          hasMoneyText,
          text: text.slice(0, 120)
        };
      })(${JSON.stringify(spotSel)})`,
        returnByValue: true,
      },
    );
    const value = result?.value;
    if (!value?.ok)
      console.warn("[BacList] spot sem confirmacao", spotSel, value);
    return !!value?.ok;
  } catch (e) {
    console.warn("[BacList] falha ao verificar spot", e?.message || e);
    return false;
  }
}
async function _cdpClickChipByValue(tabId, chipValue) {
  const val = Number(chipValue) || 5;
  console.log("[BacList] chip click", val);
  return _withDebugger({ tabId }, async (dbg) => {
    await _cdpDelay(80);
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!allFrames?.length) {
      return { success: false, error: "Frames não disponíveis." };
    }
    const sel = `[data-role="chip"][data-value="${val}"]`;
    return _clickElementWithSession(dbg, tabId, sel, allFrames, `chip ${val}`);
  });
}

async function _cdpClickChipByIndex(tabId, chipIndex) {
  const val = CHIP_DENOMINATIONS[Number(chipIndex) || 0] ?? 5;
  return _cdpClickChipByValue(tabId, val);
}

async function _clickMartingaleButton(tabId, dataRole) {
  const timeoutMs = 5000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (role) => {
          const btn = document.querySelector(
            `[data-role="${role}"][data-state="Default"]`,
          );
          if (!btn) {
            const any = document.querySelector(`[data-role="${role}"]`);
            return {
              success: false,
              error: any
                ? "state=" + (any.getAttribute("data-state") || "null")
                : "button-not-found",
            };
          }
          btn.click();
          return { success: true };
        },
        args: [dataRole],
      });

      const hit = results?.find((r) => r.result?.success);
      if (hit) return { success: true, method: "martingale-scripting" };
    } catch (_) {
      /* frame transitório, ignorar */
    }

    await _cdpDelay(200);
  }

  return {
    success: false,
    error: `${dataRole} não ficou disponível em ${timeoutMs}ms`,
  };
}

/* Gale: clica repeat-button (e opcionalmente double-button) */
async function _repeatBetInGameFrame(tabId, doDouble) {
  if (!tabId) return { success: false, error: "Aba do jogo não encontrada." };
  try {
    await _waitForFooterExpanded(tabId);

    const repeatR = await _clickMartingaleButton(tabId, "repeat-button");
    if (!repeatR.success)
      return {
        success: false,
        error: "repeat-button: " + (repeatR.error || "falha"),
        repeatR,
      };
    console.log(
      "[BacList] repeat-button clicado →",
      repeatR.localX,
      repeatR.localY,
    );

    if (!doDouble) return { success: true, method: "repeat", repeatR };

    await _cdpDelay(400);

    const doubleR = await _clickMartingaleButton(tabId, "double-button");
    if (!doubleR.success)
      return {
        success: false,
        error: "double-button: " + (doubleR.error || "falha"),
        repeatR,
        doubleR,
      };
    console.log(
      "[BacList] double-button clicado →",
      doubleR.localX,
      doubleR.localY,
    );
    return { success: true, method: "repeat+double", repeatR, doubleR };
  } catch (e) {
    console.error("[BacList] _repeatBetInGameFrame erro:", e);
    return { success: false, error: e.message };
  }
}

/* Valor no spot: plano ótimo de fichas → seleciona ficha → clica spot N vezes.
   Estratégia dupla:
     1. Tenta usar o target CDP do iframe (coords locais, sem cálculo de offset)
     2. Fallback: viewport coords via _resolveElementViewportCoords (tab-level CDP)
   Inclui retry de ficha com verificação. */
async function _placeAmountOnSpot(tabId, spotSel, amount, baseBoard = 0) {
  const profile = await _readLiveChipProfile(tabId);
  const total = _snapChipAmount(amount, profile);
  const plan = _planChipClicks(total, profile);
  if (!plan.length) {
    return {
      success: false,
      error: `R$ ${total} não fecha com as fichas desta mesa.`,
      plan,
    };
  }
  const expectedBoard = Math.round((baseBoard + total) * 100) / 100;

  console.log(
    "[BacList] plano fichas",
    profile.live ? "ao vivo" : profile.id,
    total,
    plan,
  );

  return _withDebugger({ tabId }, async (tabDbg) => {
    // Habilita descoberta de iframe targets (cross-origin iframes passam a ser visíveis)
    await chrome.debugger
      .sendCommand(tabDbg, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => {});

    await _cdpDelay(20);

    const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!allFrames?.length) {
      return { success: false, error: "Frames não disponíveis.", plan };
    }

    // Descobre iframe targets via sessão já aberta (evita "another debugger" ao re-atachar ao tab)
    let iframeDbg = null;
    try {
      const res = await chrome.debugger.sendCommand(
        tabDbg,
        "Target.getTargets",
        {},
      );
      const iframeInfos = (res?.targetInfos || []).filter(
        (ti) =>
          EVO_FRAME_MATCH.test(ti.url || "") &&
          (ti.type === "iframe" || ti.type === "page"),
      );
      for (const ti of iframeInfos) {
        const candidate = { targetId: ti.targetId };
        try {
          await chrome.debugger.attach(candidate, "1.3");
          iframeDbg = candidate;
          console.log("[BacList] usando iframe target CDP:", ti.url);
          break;
        } catch (_) {}
      }
    } catch (_) {}

    if (!iframeDbg) {
      // Tenta também via cache/getTargets para targets já visíveis
      const fromApi = (await chrome.debugger.getTargets()).filter((t) => {
        if (!EVO_FRAME_MATCH.test(t.url || "")) return false;
        if (t.tabId != null && Number(t.tabId) !== Number(tabId)) return false;
        return t.type === "iframe" || t.type === "page";
      });
      for (const t of fromApi) {
        const candidate = { targetId: t.id };
        try {
          await chrome.debugger.attach(candidate, "1.3");
          iframeDbg = candidate;
          console.log("[BacList] usando iframe target (getTargets):", t.url);
          break;
        } catch (_) {}
      }
    }

    if (!iframeDbg) {
      console.log(
        "[BacList] iframe target não disponível — usando viewport coords (fallback)",
      );
    }

    /* Clica em um seletor: via iframe target (preferido) ou viewport coords (fallback) */
    const clickSelector = async (selector) => {
      if (iframeDbg) {
        const r = await _dispatchMouseOnIframeTarget(iframeDbg, selector);
        if (r.success) return r;
        console.warn(
          "[BacList] iframe click falhou, tentando viewport:",
          r.error,
        );
      }
      const coords = await _resolveElementViewportCoords(
        tabId,
        selector,
        allFrames,
      );
      if (!coords)
        return {
          success: false,
          error: `${selector} não encontrado em nenhum frame`,
        };
      console.log(
        "[BacList] viewport click",
        selector,
        "→",
        Math.round(coords.x),
        Math.round(coords.y),
      );
      await _dispatchCdpMouse(tabDbg, coords.x, coords.y);
      return { success: true, x: coords.x, y: coords.y };
    };

    /* Verifica se a ficha correta está selecionada (via executeScript em todos os frames).
       Loga o estado real do chip para diagnóstico — não bloqueia o fluxo se o clique ocorreu. */
    const verifyChip = async (value) => {
      if (iframeDbg) {
        const ok = await _probeSelectedChipInFrame_v2(iframeDbg, value);
        if (ok) return true;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: _probeSelectedChipInFrame,
          args: [value],
        });
        const hit = results?.find((r) => r.result?.targetExists);
        if (hit) {
          const { ok, selectedValue, selectedState, targetDataValue } =
            hit.result;
          console.log(
            "[BacList] verifyChip",
            value,
            "| ok:",
            ok,
            "| selectedValue:",
            selectedValue,
            "| selectedState:",
            selectedState,
            "| targetDataValue:",
            targetDataValue,
          );
          return ok;
        }
        return false;
      } catch (_) {
        return false;
      }
    };

    try {
      const undoBoard = async () => {
        for (let i = 0; i < 12; i++) {
          const undo = await clickSelector('[data-role="undo-button"]');
          if (!undo.success) break;
          await _cdpDelay(40);
        }
      };

      for (const { value, count } of plan) {
        let selected = await verifyChip(value);
        for (let attempt = 0; attempt < 2 && !selected; attempt++) {
          if (attempt > 0) await _cdpDelay(80);
          let r = { success: false, error: `Ficha ${value} não encontrada.` };
          for (const candidate of _chipValueAttrCandidates(value)) {
            r = await clickSelector(
              `[data-role="chip-stack"] [data-role="chip"][data-value="${candidate}"]`,
            );
            if (r.success) break;
          }
          if (!r.success) {
            await undoBoard();
            return { success: false, error: r.error, plan };
          }
          await _cdpDelay(50);
          selected = await verifyChip(value);
        }

        if (!selected) {
          await undoBoard();
          return {
            success: false,
            error: `Ficha ${value} não confirmada na mesa.`,
            plan,
          };
        }

        for (let i = 0; i < count; i++) {
          if (i > 0) await _cdpDelay(180);
          await clickSelector(spotSel);
        }

        await _cdpDelay(20);
      }

      const read = await _waitForBoardTotal(tabId, expectedBoard);
      if (read == null) {
        return { success: true, total, plan, verified: false };
      }
      if (Math.abs(read - expectedBoard) > 0.01) {
        await undoBoard();
        return {
          success: false,
          error: `Valor divergente (lido ${read}, esperado ${expectedBoard}). Fichas retiradas.`,
          total,
          plan,
        };
      }

      return { success: true, total, plan, verified: true };
    } finally {
      if (iframeDbg) await chrome.debugger.detach(iframeDbg).catch(() => {});
    }
  });
}

async function _poll(forceSend) {
  if (!_activeTabId) return;
  try {
    const history = await _readAllFrames(_activeTabId);
    if (!history?.length) {
      if (forceSend) {
        chrome.runtime
          .sendMessage({
            action: "historyStatus",
            ok: false,
            error: "Histórico vazio no iframe do jogo.",
            tabId: _activeTabId,
          })
          .catch(() => {});
      }
      return;
    }

    const hash =
      history.length +
      ":" +
      history
        .slice(-10)
        .map((h) => h.cor)
        .join("");
    if (!forceSend && hash === _lastHistoryHash) return;
    _lastHistoryHash = hash;

    chrome.runtime
      .sendMessage({ action: "historyUpdate", history, tabId: _activeTabId })
      .catch(() => {});
  } catch (e) {
    console.warn("[BacList] _poll erro:", e?.message || e);
  }
}

/* ========== Leitura em todos os frames do tab ========== */
async function _readAllFrames(tabId) {
  if (!tabId) return null;
  try {
    const gameFrames = await _getGameFrames(tabId);
    if (!gameFrames.length) {
      console.warn("[BacList] Nenhum frame encontrado na aba", tabId);
      return null;
    }

    const results = await Promise.allSettled(
      gameFrames.map((f) =>
        chrome.scripting
          .executeScript({
            target: { tabId, frameIds: [f.frameId] },
            func: _extractRoadItemsInFrame,
          })
          .then((r) => r?.[0]?.result || [])
          .catch(() => []),
      ),
    );

    const candidates = results
      .filter(
        (r) =>
          r.status === "fulfilled" &&
          Array.isArray(r.value) &&
          r.value.length > 0,
      )
      .map((r) => r.value)
      .sort((a, b) => b.length - a.length);

    return candidates[0] || null;
  } catch (e) {
    console.error("[BacList] _readAllFrames erro:", e);
    return null;
  }
}

/* Aguarda o footer da mesa estar expandido (data-is-collapsed="false") antes de clicar nas fichas.
   O footer precisa estar visível para os cliques atingirem os elementos corretamente. */
async function _waitForFooterExpanded(tabId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () =>
          !!document.querySelector(
            '[data-role="footer-perspective-container"][data-is-collapsed="false"]',
          ),
      });
      if (results?.some((r) => r.result === true)) {
        console.log("[BacList] footer expandido — colocando fichas");
        return true;
      }
    } catch (_) {
      /* frame transitório, ignorar */
    }
    await _cdpDelay(200);
  }
  console.warn(
    "[BacList] footer não expandiu em",
    timeoutMs,
    "ms — prosseguindo mesmo assim",
  );
  return false;
}

function _probeBettingChipsReady() {
  function isLocked(el) {
    if (!el) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.hasAttribute("disabled")) return true;
    const st = (el.getAttribute("data-state") || "").toLowerCase();
    return st === "disabled" || st === "inactive" || st === "locked";
  }

  const stack = document.querySelector('[data-role="chip-stack"]');
  if (!stack) return false;
  const chips = [...stack.querySelectorAll('[data-role="chip"]')].filter((el) => {
    if (el.querySelector?.('[data-role="chip"]')) return false;
    if (el.closest?.('[data-role*="bet-spot"]')) return false;
    const box = el.getBoundingClientRect();
    return box.width >= 8 && box.height >= 8 && !isLocked(el);
  });
  if (chips.length < 2) return false;
  const footer = document.querySelector(
    '[data-role="footer-perspective-container"]',
  );
  if (footer && footer.getAttribute("data-is-collapsed") !== "false") return false;
  return true;
}

async function _waitForBettingChips(tabId, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: _probeBettingChipsReady,
      });
      if (results?.some((r) => r.result === true)) {
        console.log("[BacList] fichas visíveis após o empate");
        await _cdpDelay(800);
        return true;
      }
    } catch (_) {
      /* frame ainda trocando depois do resultado */
    }
    await _cdpDelay(250);
  }
  console.warn("[BacList] fichas não apareceram após o empate");
  return false;
}

/* ══════════════════════════════════════════════════════
   APOSTA NO IFRAME — clica a ficha e depois o(s) spot(s) da aposta.
   As fichas e os spots (data-role="bacbo-bet-spot-Player|Tie|Banker") ficam no
   MESMO iframe do histórico, por isso injetamos em todos os frames e só agimos
   no frame que realmente contém as fichas.
══════════════════════════════════════════════════════ */
async function _placeBetInGameFrame(
  tabId,
  mainAmount,
  target,
  tieProtection,
  tieAmount,
  selectors,
  waitForChips = false,
) {
  if (!tabId) return { success: false, error: "Aba do jogo não encontrada." };
  _bettingInProgress = true;
  try {
    if (waitForChips) {
      const ready = await _waitForBettingChips(tabId);
      if (!ready) {
        return {
          success: false,
          error: "Fichas ainda não apareceram após o empate.",
        };
      }
    }
    const house = await _getBettingHouse();
    let gameJustOpened = false;
    if (_automationRunning && house.clickPlay) {
      const play = await _tryClickPlayButton(tabId, 800);
      if (play?.clicked) {
        gameJustOpened = true;
        await _cdpDelay(2500);
      }
    }
    if (gameJustOpened && (await _fullscreenOnLoadEnabled())) {
      await _enterGameFullscreen(tabId);
    }
    await _tryClickSrcdocPopup(tabId);
    await _tryHideOverlays(tabId);

    const customSpot =
      (selectors && selectors[String(target).toLowerCase()]) || "";
    const spotSel = customSpot || `[data-role="bacbo-bet-spot-${target}"]`;

    const mainR = await _placeAmountOnSpot(tabId, spotSel, mainAmount);
    if (!mainR.success) return { ...mainR, step: "main" };

    let tieR = null;
    if (tieProtection && target !== "Tie") {
      await _cdpDelay(40);
      const tieSel = (selectors && selectors.tie) || _SELECTORS.Tie;
      tieR = await _placeAmountOnSpot(
        tabId,
        tieSel,
        tieAmount || 5,
        mainR.total,
      );
      if (!tieR.success) {
        return {
          success: false,
          error: "Aposta principal OK, mas empate falhou.",
          step: "tie",
          mainR,
          tieR,
        };
      }
    }

    return {
      success: true,
      mainAmount: mainR.total,
      tieAmount: tieR?.total || 0,
      mainPlan: mainR.plan,
      tiePlan: tieR?.plan || null,
      method: "chip-plan",
      mainR,
      tieR,
    };
  } catch (e) {
    console.error("[BacList] _placeBetInGameFrame erro:", e);
    return { success: false, error: e.message };
  } finally {
    _bettingInProgress = false;
  }
}

/* ── Função injetada nos frames via scripting.executeScript ──
   REGRA: zero referências externas — totalmente autocontida. */
function _extractRoadItemsInFrame() {
  function corFromName(n) {
    if (n === "player") return "A";
    if (n === "banker") return "V";
    if (n === "tie") return "T";
    return null;
  }

  // Converte "#RGB", "#RRGGBB" ou "rgb()/rgba()" em {r,g,b}
  function _rgb(fill) {
    if (!fill) return null;
    const s = String(fill).trim();
    const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };
    const h = s.replace(/^#/, "");
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
      };
    }
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
      };
    }
    return null;
  }

  function isBlue(fill) {
    const c = _rgb(fill);
    if (!c) return /2[Ff]63|blue/i.test(fill);
    return c.b > 120 && c.b > c.r && c.b > c.g;
  }

  function isRed(fill) {
    const c = _rgb(fill);
    if (!c) return /[Dd]9[2Aa]|red/i.test(fill);
    return c.r > 150 && c.r > c.g * 1.8 && c.r > c.b * 1.8;
  }

  // Empate neste cassino é âmbar/dourado (ex.: #CE922B). Também aceitamos
  // amarelo e verde (temas antigos) como empate.
  function isTie(fill) {
    const c = _rgb(fill);
    if (!c) return /[Cc][Ee]9|amber|gold|yellow|green|39[Aa]/i.test(fill);
    const { r, g, b } = c;
    // Âmbar/dourado/amarelo: vermelho e verde altos, azul baixo
    const amber =
      r > 120 && g > 80 && b < 130 && Math.min(r, g) - b > 25 && r < g * 2.4;
    // Verde (tema antigo)
    const green = g > 120 && g > r * 1.3 && g > b;
    return amber || green;
  }

  function corFromFill(fill) {
    if (
      !fill ||
      fill === "none" ||
      fill === "white" ||
      fill === "#fff" ||
      fill === "#ffffff"
    )
      return null;
    const f = fill.trim();
    if (isBlue(f)) return "A";
    if (isRed(f)) return "V";
    if (isTie(f)) return "T";
    return null;
  }

  function parseItem(el) {
    // 1. Atributo name diretamente no próprio elemento roadItem (Player/Banker/Tie)
    const nameAttr = (el.getAttribute("name") || "").toLowerCase().trim();
    if (nameAttr) {
      const c = corFromName(nameAttr);
      if (c) return c;
    }

    // 2. Texto interno: P / B / T
    const t = (el.textContent || "").trim().replace(/\s+/g, "").toUpperCase();
    if (t === "P") return "A";
    if (t === "B") return "V";
    if (t === "T") return "T";

    // 3. [data-type="roadItemColor"] fill
    const colorNode = el.querySelector('[data-type="roadItemColor"]');
    if (colorNode) {
      const c = corFromFill(colorNode.getAttribute("fill"));
      if (c) return c;
    }

    // 4. qualquer elemento com fill como fallback
    for (const f of el.querySelectorAll("[fill]")) {
      const c = corFromFill(f.getAttribute("fill"));
      if (c) return c;
    }

    return null;
  }

  function parseTieMultiplier(el) {
    const candidates = [
      el.getAttribute("data-multiplier"),
      el.getAttribute("data-payout"),
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.textContent,
    ].filter(Boolean);

    for (const raw of candidates) {
      const text = String(raw).replace(/\s+/g, " ");
      const direct = text.match(/(\d+(?:[.,]\d+)?)\s*(?:x|×)/i);
      if (direct) return Number(direct[1].replace(",", "."));
      const odds = text.match(/(\d+(?:[.,]\d+)?)\s*:\s*1/i);
      if (odds) return Number(odds[1].replace(",", "."));
    }

    return null;
  }

  function collectEntries(root) {
    if (!root) return [];
    const coords = Array.from(
      root.querySelectorAll('[data-type="coordinates"]'),
    );
    const entries = [];

    for (const coord of coords) {
      const dx = coord.getAttribute("data-x");
      const dy = coord.getAttribute("data-y");
      if (dx === null || dy === null) continue;
      const x = Number(dx);
      const y = Number(dy);
      if (!isFinite(x) || !isFinite(y) || x < 0 || y < 0) continue;
      const ri = coord.querySelector('[data-type="roadItem"]');
      if (!ri) continue;
      const cor = parseItem(ri);
      if (cor)
        entries.push({
          x,
          y,
          cor,
          tieMultiplier: cor === "T" ? parseTieMultiplier(ri) : null,
        });
    }

    entries.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
    return entries;
  }

  // footer-left = bead-road real; footer-right = derivada. Tentar fallbacks se o DOM mudar.
  const roots = [
    document.querySelector('[data-role="footer-left"]'),
    document.querySelector('[data-role="Bead-road"]'),
    document.querySelector('[data-role="bead-road"]'),
    document,
  ].filter(Boolean);

  let entries = [];
  for (const root of roots) {
    entries = collectEntries(root);
    if (entries.length) break;
  }

  // Último fallback: roadItems sem grid de coordinates
  if (!entries.length) {
    const items = Array.from(
      document.querySelectorAll('[data-type="roadItem"]'),
    );
    for (const ri of items) {
      const cor = parseItem(ri);
      if (cor)
        entries.push({
          x: entries.length,
          y: 0,
          cor,
          tieMultiplier: cor === "T" ? parseTieMultiplier(ri) : null,
        });
    }
  }

  return entries.map((e) => ({
    cor: e.cor,
    id: null,
    tieMultiplier: e.tieMultiplier || null,
  }));
}

/* ========== Badge ========== */
chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoModeActive) {
    const active = !!changes.autoModeActive.newValue;
    _automationRunning = active;
    chrome.action.setBadgeText({ text: active ? "AUTO" : "" });
    chrome.action.setBadgeBackgroundColor({
      color: active ? "#0094ff" : "#ef4444",
    });
  }
});
