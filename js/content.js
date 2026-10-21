/* ==========================================================================
   BacList — content.js
   Injeta em TODOS os frames (all_frames: true).
   O polling de histórico é feito pelo background.js via scripting.executeScript,
   não por este script — aqui só ficam os cliques de aposta.
   ========================================================================== */

'use strict';

const _isMainFrame = (window === window.top);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.action === 'placeBet') {
    if (!_isMainFrame) return false;
    handlePlaceBet(msg)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // startMonitor / stopMonitor mantidos para compatibilidade (não fazem mais polling)
  if (msg.action === 'startMonitor' || msg.action === 'stopMonitor') {
    sendResponse({ success: true });
    return false;
  }

  if (msg.action === 'ping') {
    sendResponse({ success: true });
    return false;
  }
});

/* ══════════════════════════════════════════════════════
   EXECUÇÃO DE APOSTA
══════════════════════════════════════════════════════ */
async function handlePlaceBet(params) {
  const { target, amount, tieProtection, tieAmount, selectors } = params;

  try {
    if (selectors.amount) {
      const amountEl = findElement(selectors.amount);
      if (amountEl) { fillInput(amountEl, amount); await wait(200); }
    }

    const targetSelector = { player: selectors.player, tie: selectors.tie, banker: selectors.banker }[target];

    if (targetSelector) {
      const el = findElement(targetSelector);
      if (!el) return { success: false, error: `Botão "${target}" não encontrado: ${targetSelector}` };
      simulateClick(el);
      await wait(300);
    } else {
      const found = await heuristicClick(target);
      if (!found) return { success: false, error: `Seletor do botão "${target}" não configurado.` };
    }

    if (tieProtection && target !== 'tie') {
      await wait(200);
      if (selectors.tie) {
        const tieEl = findElement(selectors.tie);
        if (tieEl) {
          if (selectors.amount) {
            const a = findElement(selectors.amount);
            if (a) { fillInput(a, tieAmount); await wait(200); }
          }
          simulateClick(tieEl);
          await wait(300);
        }
      } else {
        await heuristicClick('tie');
      }
    }

    if (selectors.confirm) {
      await wait(300);
      const c = findElement(selectors.confirm);
      if (c) { simulateClick(c); await wait(300); }
    }

    return { success: true };
  } catch (err) {
    console.error('[BacList] Erro ao executar aposta:', err);
    return { success: false, error: err.message };
  }
}

/* ══════════════════════════════════════════════════════
   HEURÍSTICA DE CLIQUE
══════════════════════════════════════════════════════ */
async function heuristicClick(target) {
  const keywords = {
    player: ['player', 'jogador', 'azul', 'blue', 'plr'],
    tie:    ['tie', 'empate', 'amarelo', 'yellow'],
    banker: ['banker', 'casa', 'vermelho', 'red', 'banca'],
  };
  const words   = keywords[target] || [];
  const allBtns = Array.from(document.querySelectorAll('button,[role="button"],.btn,[class*="bet"]'));

  for (const btn of allBtns) {
    const text = (btn.textContent || '').toLowerCase();
    const cls  = (btn.className   || '').toLowerCase();
    const attr = (btn.getAttribute('aria-label') || btn.getAttribute('data-type') || '').toLowerCase();
    if (words.some(w => text.includes(w) || cls.includes(w) || attr.includes(w))) {
      simulateClick(btn);
      await wait(200);
      return true;
    }
  }
  return false;
}

/* ══════════════════════════════════════════════════════
   UTILS
══════════════════════════════════════════════════════ */
function findElement(selector) {
  try { return document.querySelector(selector); } catch { return null; }
}

function simulateClick(el) {
  if (!el) return;
  ['mousedown', 'mouseup', 'click'].forEach(t =>
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
  );
}

function fillInput(el, value) {
  const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (ns) ns.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log('[BacList] content.js carregado —', window.location.href.slice(0, 80));
