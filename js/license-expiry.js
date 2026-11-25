/* Vencimento do plano (license.license_expires_at do painel).
   Mesma regra do painel: "Plano até 24/12/2026 · 29 dias", aviso com 7 dias ou menos.
   Datas sem fuso ("2026-12-24 00:00:00") são horário de Brasília. */
"use strict";

const LicenseExpiry = (() => {
  const WARN_DAYS = 7;
  const BRT_OFFSET_MS = -3 * 3600 * 1000;
  const DAY_MS = 86400000;

  function parse(value) {
    const text = String(value ?? "").trim();
    if (text === "") return null;
    const local = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(text);
    const iso = local
      ? `${text.length === 10 ? `${text}T00:00:00` : text.replace(" ", "T")}-03:00`
      : text;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  /** Dia de calendário em Brasília, em ms UTC à meia-noite. */
  function brDay(date) {
    const shifted = new Date(date.getTime() + BRT_OFFSET_MS);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  }

  /** @returns {{label: string, warn: boolean}} */
  function describe(expiresAt, now = new Date()) {
    const expiry = parse(expiresAt);
    if (!expiry) return { label: "Sem vencimento", warn: false };
    const days = Math.max(0, Math.round((brDay(expiry) - brDay(now)) / DAY_MS));
    const day = new Date(brDay(expiry));
    const date = [
      String(day.getUTCDate()).padStart(2, "0"),
      String(day.getUTCMonth() + 1).padStart(2, "0"),
      day.getUTCFullYear(),
    ].join("/");
    const when = days === 0 ? "vence hoje" : days === 1 ? "1 dia" : `${days} dias`;
    return { label: `Plano até ${date} · ${when}`, warn: days <= WARN_DAYS };
  }

  return { describe };
})();

if (typeof module !== "undefined") module.exports = LicenseExpiry;
