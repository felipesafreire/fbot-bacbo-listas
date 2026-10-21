"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const patternsSource = fs.readFileSync(
  require.resolve("../js/patterns.js"),
  "utf8",
);
const strategiesSource = fs.readFileSync(
  require.resolve("../js/strategies.js"),
  "utf8",
);

async function runScenario(target, history) {
  const counters = { bets: 0, refunds: 0 };
  const fixedTime = new Date("2026-06-29T12:00:00-03:00").getTime();
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fixedTime]));
    }
    static now() {
      return fixedTime;
    }
  }

  const toast = {
    className: "",
    textContent: "",
    classList: { add: () => {}, remove: () => {} },
  };
  const context = {
    Date: FixedDate,
    Math,
    JSON,
    Promise,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: (callback) => callback(),
    document: {
      getElementById: () => null,
      querySelector: (selector) => (selector === ".toast" ? toast : null),
      querySelectorAll: () => [],
      body: { appendChild: () => {} },
    },
    chrome: {
      storage: {
        local: {
          get: (_key, callback) =>
            callback({
              bacboSchedule: {
                rawText: "",
                schedule: [{ hh: 12, mm: 0, target }],
              },
            }),
          set: () => {},
        },
      },
      runtime: {
        sendMessage: async () => ({ success: true }),
      },
    },
    state: { autoMode: true },
    _pendingBet: null,
    executeBet: () => {
      counters.bets += 1;
    },
    recordPatternRefund: () => {
      counters.refunds += 1;
    },
    onScheduleTypeChanged: () => {},
  };
  vm.createContext(context);
  vm.runInContext(patternsSource, context);
  vm.runInContext(`${strategiesSource}\nglobalThis.__Strategies = Strategies;`, context);

  const strategies = context.__Strategies;
  strategies.init();
  strategies.setPatternGuardConfig({ enabled: true });
  strategies.setAutoEnabled(true);
  await strategies.startMonitor();
  strategies.onHistoryUpdate(history.slice(0, -1).map((cor) => ({ cor })));
  strategies.onHistoryUpdate(history.map((cor) => ({ cor })));
  await Promise.resolve();
  await Promise.resolve();
  return counters;
}

(async () => {
  const againstSequence = await runScenario("A", ["V", "V", "V", "V"]);
  assert.deepEqual(againstSequence, { bets: 0, refunds: 1 });

  const withSequence = await runScenario("V", ["V", "V", "V", "V"]);
  assert.deepEqual(withSequence, { bets: 1, refunds: 0 });

  const againstAlternating = await runScenario("A", ["A", "V", "A", "V", "A"]);
  assert.deepEqual(againstAlternating, { bets: 0, refunds: 1 });

  console.log("Strategies: aborto e execução normal passaram.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
