/* Comandos do bot do Telegram no Bac Bo Listas: /status, /ligar, /parar,
   /resetarplacar, /alterarmeta, /alterarstoploss e /inserirlista chegam pelo painel (/api/extension/commands/*),
   mesmo contrato do Bac Bo Automático. Roda no side panel, junto da automação.
   Avisos de entrada/resultado vão por /api/bot/notify, igual ao Automático.

   Entrega: o mesa-socket do painel avisa ({"type":"commands"}) no instante em que um comando
   entra na fila; aí um poll rápido (wait=0) busca o comando, sem segurar processo PHP no painel.
   Socket fora do ar: long-poll de 20s até o socket reconectar. */
"use strict";

const BacListTelegram = (() => {
  const LONG_POLL_SECONDS = 20;
  const ERROR_BACKOFF_MS = 3000;
  /** Com o socket aberto, poll de reserva a cada 60s (aviso perdido, reconexão). */
  const REALTIME_IDLE_MS = 60000;
  const SOCKET_RETRY_MAX_MS = 30000;
  /** Na largada, espera o socket abrir antes de cair no long-poll. */
  const SOCKET_GRACE_MS = 3000;
  const COMMAND_ACTIONS = new Set([
    "status",
    "ligar",
    "parar",
    "resetarplacar",
    "alterarmeta",
    "alterarstoploss",
    "inserirlista",
  ]);

  /** @type {((action: string, payload: string|null) => Promise<{ ok?: boolean, text?: string }>) | null} */
  let execute = null;
  /** Sobe a cada start/stop: loop ou socket de uma geração antiga param sozinhos. */
  let generation = 0;
  let running = false;
  /** @type {AbortController|null} */
  let abort = null;

  /* ---------- Socket de avisos (mesa-socket do painel) ---------- */
  /** @type {WebSocket|null} */
  let ws = null;
  let socketOpen = false;
  let socketRetryMs = 1000;
  let socketTimer = null;
  /** Aviso que chegou enquanto um poll rodava: o próximo poll sai na hora. */
  let kickPending = false;
  /** @type {(() => void)|null} */
  let wakeUp = null;

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function kick() {
    if (wakeUp) {
      wakeUp();
      return;
    }
    kickPending = true;
  }

  /** Espera aviso do socket ou o prazo. */
  function sleepUntilKick(ms) {
    if (kickPending) {
      kickPending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeUp = null;
        resolve();
      }, ms);
      wakeUp = () => {
        clearTimeout(timer);
        wakeUp = null;
        resolve();
      };
    });
  }

  function setSocketOpen(value) {
    if (socketOpen === value) return;
    socketOpen = value;
    // Abriu: solta o long-poll em andamento e passa ao modo rápido.
    // Fechou: acorda a espera para voltar ao long-poll.
    if (value) abort?.abort();
    kick();
  }

  function scheduleSocket(gen) {
    if (gen !== generation || socketTimer) return;
    socketTimer = setTimeout(() => {
      socketTimer = null;
      void connectSocket(gen);
    }, socketRetryMs);
    socketRetryMs = Math.min(socketRetryMs * 2, SOCKET_RETRY_MAX_MS);
  }

  async function connectSocket(gen) {
    if (gen !== generation || ws || !BacListAuth.isLoggedIn()) return;
    let socket;
    try {
      const data = await BacListAuth.api("/api/mesa-socket/ticket");
      if (!data?.url || !data?.ticket) throw new Error("ticket inválido");
      if (gen !== generation || ws) return;
      const sep = data.url.includes("?") ? "&" : "?";
      socket = new WebSocket(`${data.url}${sep}ticket=${encodeURIComponent(data.ticket)}`);
    } catch {
      scheduleSocket(gen);
      return;
    }
    ws = socket;
    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.type === "hello") {
        socketRetryMs = 1000;
        setSocketOpen(true);
      } else if (msg?.type === "commands") {
        kick();
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      setSocketOpen(false);
      scheduleSocket(gen);
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        // já fechado
      }
    };
  }

  function closeSocket() {
    if (socketTimer) clearTimeout(socketTimer);
    socketTimer = null;
    const socket = ws;
    ws = null;
    socketOpen = false;
    socketRetryMs = 1000;
    try {
      socket?.close();
    } catch {
      // já fechado
    }
  }

  /* ---------- Comandos ---------- */
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

  /** Um comando por vez. Socket aberto: poll rápido + espera o aviso. Sem socket: long-poll. */
  async function loop(gen) {
    const alive = () => gen === generation && BacListAuth.isLoggedIn();
    void connectSocket(gen);
    // Primeiro poll é rápido (pega o que já está na fila) e dá tempo do socket abrir:
    // long-poll aberto e logo cancelado ainda prende o processo PHP até o prazo.
    let first = true;
    try {
      while (alive()) {
        const realtime = socketOpen;
        const wait = realtime || first ? 0 : LONG_POLL_SECONDS;
        // Este poll já vê o que entrou até agora; aviso que chegar depois acorda o próximo.
        kickPending = false;
        const controller = new AbortController();
        abort = controller;
        let data = null;
        try {
          data = await BacListAuth.api("/api/extension/commands/poll", {
            method: "POST",
            body: JSON.stringify({ wait }),
            signal: controller.signal,
            timeoutMs: (wait + 10) * 1000,
          });
        } catch (err) {
          if (!alive()) break;
          if (err?.status === 401 || err?.status === 403) break;
          // Long-poll solto porque o socket abriu: segue direto no modo rápido.
          if (!realtime && socketOpen) continue;
          await delay(ERROR_BACKOFF_MS);
          continue;
        } finally {
          if (abort === controller) abort = null;
        }
        if (!alive()) break;
        const wasFirst = first;
        first = false;
        if (data?.command?.id) {
          await handleCommand(data.command);
          continue;
        }
        if (socketOpen) await sleepUntilKick(REALTIME_IDLE_MS);
        else if (wasFirst) await sleepUntilKick(SOCKET_GRACE_MS);
      }
    } finally {
      if (gen === generation) {
        running = false;
        closeSocket();
      }
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
    let body = {};
    try {
      // Função pode ser async (lê a banca da mesa na hora do envio).
      body = (typeof meta === "function" ? await meta() : meta) || {};
    } catch (err) {
      console.warn(`[BacList] Aviso ${type}: falha ao montar dados`, err?.message || err);
    }
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
   * `meta` pode ser função (sync ou async): é lida na hora do envio, depois dos avisos anteriores.
   */
  function notify(type, meta = {}) {
    const run = notifyChain.then(() => deliverNotify(type, meta));
    notifyChain = run.catch(() => undefined);
    return run;
  }

  function start(executor) {
    execute = executor;
    if (running) return;
    running = true;
    void loop(generation);
  }

  function stop() {
    generation++;
    running = false;
    abort?.abort();
    abort = null;
    wakeUp?.();
    closeSocket();
  }

  return { start, stop, notify };
})();
