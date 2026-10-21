/* Login do Bac Bo Listas no painel. Uma sessão por computador. */
"use strict";

const BacListAuth = (() => {
  const API_BASE = "https://fbotcassino.com.br";
  const PRODUCT = "listas";
  const HEARTBEAT_MS = 15000;

  let auth = null;
  let notice = "";
  let timer = null;

  function isLoggedIn() {
    if (!auth?.token) return false;
    if (auth.expiresAt && Date.now() > auth.expiresAt) return false;
    return true;
  }

  function username() {
    return auth?.user?.username || "";
  }

  function takeNotice() {
    const message = notice;
    notice = "";
    chrome.storage.local.remove("authNotice");
    return message;
  }

  async function ensureDeviceId() {
    const data = await chrome.storage.local.get(["deviceId"]);
    if (
      typeof data.deviceId === "string" &&
      /^[a-zA-Z0-9-]{8,64}$/.test(data.deviceId)
    ) {
      return data.deviceId;
    }
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId: id });
    return id;
  }

  async function save() {
    await chrome.storage.local.set({ auth });
  }

  async function clearLocal() {
    auth = null;
    await chrome.storage.local.remove(["auth"]);
  }

  async function request(path, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: options.method || "GET",
        headers,
        body: options.body,
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      const error = new Error(
        `Não foi possível conectar ao servidor (${err.message || "rede"})`,
      );
      error.status = 0;
      throw error;
    }

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      const message =
        data.license?.message ||
        data.error ||
        data.message ||
        (response.status === 401
          ? "Sua conta entrou em outro computador. Este login foi encerrado."
          : `Erro HTTP ${response.status}`);
      const error = new Error(message);
      error.status = response.status;
      error.code = data.code || data.license?.code || "";
      throw error;
    }

    return data;
  }

  async function login(usernameValue, password) {
    const data = await request("/api/auth/token", {
      method: "POST",
      body: JSON.stringify({
        username: usernameValue,
        password,
        device_id: await ensureDeviceId(),
        product: PRODUCT,
      }),
    });

    if (!data.access_token) {
      throw new Error(data.error || "Resposta inválida do servidor (sem token).");
    }
    if (!data.license?.valid) {
      const error = new Error(
        data.license?.message || "Bac Bo Listas não liberado para este usuário.",
      );
      error.code = data.license?.code || "not_released";
      throw error;
    }

    auth = {
      token: data.access_token,
      user: data.user || null,
      license: data.license,
      expiresAt: Date.now() + (data.expires_in || 604800) * 1000,
    };
    notice = "";
    await chrome.storage.local.remove("authNotice");
    await save();
    return data;
  }

  async function logout() {
    stopHeartbeat();
    try {
      if (auth?.token) {
        await request("/api/logout", { method: "POST" });
      }
    } catch {
      // a sessão local sai mesmo se o servidor não responder
    }
    await clearLocal();
  }

  async function me() {
    const data = await request("/api/me");
    auth = {
      ...auth,
      user: data.user || auth.user,
      license: data.license || auth.license,
    };
    if (!auth.license?.valid) {
      const error = new Error(
        auth.license?.message || "Bac Bo Listas não liberado para este usuário.",
      );
      error.status = 403;
      error.code = auth.license?.code || "not_released";
      throw error;
    }
    await save();
    return data;
  }

  async function heartbeat(running) {
    const data = await request("/api/extension/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        data: { running: !!running, game: "bacbo_listas" },
      }),
    });
    if (data.license) {
      auth = { ...auth, license: data.license };
      await save();
    }
    if (!data.license?.valid) {
      const error = new Error(
        data.license?.message || "Bac Bo Listas não liberado para este usuário.",
      );
      error.status = 403;
      error.code = data.license?.code || "not_released";
      throw error;
    }
    return data;
  }

  async function restore() {
    const stored = await chrome.storage.local.get(["auth", "authNotice"]);
    notice = stored.authNotice || "";
    auth = stored.auth || null;
    if (!isLoggedIn()) {
      auth = null;
      return false;
    }
    try {
      await me();
      return true;
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        notice = err.message || notice;
        if (notice) await chrome.storage.local.set({ authNotice: notice });
        await clearLocal();
        return false;
      }
      return true;
    }
  }

  function startHeartbeat(isRunning, onLost) {
    stopHeartbeat();
    let lost = false;
    const tick = async () => {
      if (lost || !isLoggedIn()) return;
      try {
        await heartbeat(!!isRunning());
      } catch (err) {
        if (lost) return;
        if (err.status !== 401 && err.status !== 403) return;
        lost = true;
        stopHeartbeat();
        notice =
          err.message ||
          "Sua conta entrou em outro computador. Este login foi encerrado.";
        await chrome.storage.local.set({ authNotice: notice });
        await clearLocal();
        onLost(notice);
      }
    };
    tick();
    timer = setInterval(tick, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    isLoggedIn,
    username,
    takeNotice,
    login,
    logout,
    restore,
    startHeartbeat,
    stopHeartbeat,
  };
})();
