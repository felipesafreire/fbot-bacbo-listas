/* Comandos do bot do Telegram no Bac Bo Listas: /status, /ligar, /parar,
   /resetarplacar e /alterarmeta chegam pelo painel (/api/extension/commands/*),
   mesmo contrato do Bac Bo Automático. Roda no side panel, junto da automação.
   Avisos de entrada/resultado vão por /api/bot/notify, igual ao Automático. */
"use strict";

const BacListTelegram = (() => {
  const LONG_POLL_SECONDS = 20;
  const ERROR_BACKOFF_MS = 3000;
  const COMMAND_ACTIONS = new Set([
    "status",
    "ligar",
    "parar",
    "resetarplacar",
    "alterarmeta",
  ]);

  /** @type {((action: string, payload: string|null) => Promise<{ ok?: boolean, text?: string }>) | null} */
  let execute = null;
  let running = false;
  let abort = null;

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function handleCommand(command) {
    const id = Number(command.id);
    const action = String(command.action || "");
    const payload =
      command.payload == null || command.payload === "" ? null : String(command.payload);
    let ok = false;
    let text = "Comando concluído.";
    if (!COMMAND_ACTIONS.has(action)) {
      text = "Comando desconhecido.";
    } else {
      try {
        const result = await execute(action, payload);
        ok = !!result?.ok;
        text = (String(result?.text || "").trim() || "Comando concluído.").slice(0, 500);
      } catch (err) {
        text = String(err?.message || "Falha ao executar o comando.").slice(0, 500);
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await BacListAuth.api(`/api/extension/commands/${id}/result`, {
          method: "POST",
          body: JSON.stringify({ ok, text }),
        });
        return;
      } catch (err) {
        // 409: já respondido ou expirado; o servidor expira o comando em 90s.
        if (err?.status === 409 || err?.status === 401) return;
      }
    }
  }

  /** Long-poll de 20s enquanto houver login. Um comando por vez. */
  async function loop() {
    if (running) return;
    running = true;
    try {
      while (running && BacListAuth.isLoggedIn()) {
        abort = new AbortController();
        let data = null;
        try {
          data = await BacListAuth.api("/api/extension/commands/poll", {
            method: "POST",
            body: JSON.stringify({ wait: LONG_POLL_SECONDS }),
            signal: abort.signal,
            timeoutMs: (LONG_POLL_SECONDS + 10) * 1000,
          });
        } catch (err) {
          if (!running) break;
          if (err?.status === 401 || err?.status === 403) break;
          await delay(ERROR_BACKOFF_MS);
          continue;
        } finally {
          abort = null;
        }
        if (!running) break;
        if (data?.command?.id) await handleCommand(data.command);
      }
    } finally {
      running = false;
    }
  }

  /* ---------- Avisos no chat do bot (/api/bot/notify) ---------- */
  let notifyChain = Promise.resolve();

  function sendNotify(type, meta) {
    return BacListAuth.api("/api/bot/notify", {
      method: "POST",
      body: JSON.stringify({ type, meta }),
    });
  }

  async function deliverNotify(type, meta) {
    if (!BacListAuth.isLoggedIn()) return;
    const body = typeof meta === "function" ? meta() : meta || {};
    try {
      try {
        await sendNotify(type, body);
      } catch (err) {
        // Painel aceita um aviso por segundo por usuário.
        if (err?.code !== "rate_limited") throw err;
        await delay(1100);
        await sendNotify(type, body);
      }
    } catch (err) {
      console.warn(`[BacList] Aviso no Telegram falhou (${type})`, err?.message || err);
    }
  }

  /**
   * Enfileira um aviso no bot do Telegram (entrada, resultado, liga/desliga).
   * `meta` pode ser função: é lida na hora do envio, depois dos avisos anteriores.
   */
  function notify(type, meta = {}) {
    const run = notifyChain.then(() => deliverNotify(type, meta));
    notifyChain = run.catch(() => undefined);
    return run;
  }

  function start(executor) {
    execute = executor;
    void loop();
  }

  function stop() {
    running = false;
    abort?.abort();
  }

  return { start, stop, notify };
})();
