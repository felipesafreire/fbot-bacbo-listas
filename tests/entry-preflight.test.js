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
const backgroundSource = fs.readFileSync(
  require.resolve("../js/background.js"),
  "utf8",
);

async function runScenario(isoTime, pending = false) {
  const fixedTime = new Date(isoTime).getTime();
  const actions = [];

  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fixedTime]));
    }
    static now() {
      return fixedTime;
    }
  }

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
      querySelector: () => ({
        className: "",
        textContent: "",
        classList: { add: () => {}, remove: () => {} },
      }),
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
                schedule: [{ hh: 12, mm: 0, target: "A" }],
              },
            }),
          set: () => {},
        },
      },
      runtime: {
        sendMessage: async (message) => {
          actions.push(message.action);
          return { success: true };
        },
      },
    },
    state: { autoMode: true },
    _pendingBet: pending ? { awaiting: true } : null,
    executeBet: () => {},
    recordPatternRefund: () => {},
    onScheduleTypeChanged: () => {},
  };

  vm.createContext(context);
  vm.runInContext(patternsSource, context);
  vm.runInContext(`${strategiesSource}\nglobalThis.__Strategies = Strategies;`, context);

  const strategies = context.__Strategies;
  strategies.init();
  strategies.setAutoEnabled(true);
  await Promise.resolve();
  await Promise.resolve();

  return { actions, context, strategies };
}

(async () => {
  const twoMinutesBefore = await runScenario(
    "2026-07-02T11:58:00-03:00",
  );
  assert.equal(
    twoMinutesBefore.actions.filter(
      (action) => action === "reopenGameForEntry",
    ).length,
    1,
  );

  const tooLate = await runScenario("2026-07-02T11:59:50-03:00");
  assert.equal(
    tooLate.actions.filter((action) => action === "reopenGameForEntry").length,
    0,
  );

  const pending = await runScenario(
    "2026-07-02T11:58:00-03:00",
    true,
  );
  assert.equal(
    pending.actions.filter((action) => action === "reopenGameForEntry").length,
    0,
  );
  pending.context._pendingBet = null;
  pending.strategies.setEntryTiming("exact", 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    pending.actions.filter((action) => action === "reopenGameForEntry").length,
    1,
  );

  assert.match(
    backgroundSource,
    /https:\/\/1win\.io\/casino\/play\/v_evolution:bacbo/,
  );
  assert.match(
    backgroundSource,
    /https:\/\/www\.pixnabanca\.club\/casino\/evolution\/bac-bo/,
  );
  assert.match(
    backgroundSource,
    /https:\/\/www\.inovabet\.bet\/casino\/evolution\/bac-bo/,
  );
  assert.match(backgroundSource, /clickPlay: true/);
  assert.match(backgroundSource, /if \(house\.clickPlay\)/);
  assert.match(
    backgroundSource,
    /data-testid="game-play-card-play-button"/,
  );
  assert.match(backgroundSource, /_tryClickPlayButton\(tabId\)/);
  assert.match(
    backgroundSource,
    /chrome\.tabs\.update\(tabId, \{ url, active: true \}\)/,
  );
  assert.match(backgroundSource, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(backgroundSource, /if \(!_automationRunning\) return/);
  assert.match(backgroundSource, /msg\.action === "setAutomationRunning"/);
  assert.doesNotMatch(backgroundSource, /esportiva\.bet\.br/);
  assert.doesNotMatch(backgroundSource, /chrome\.tabs\.reload\(tabId\)/);
  assert.match(backgroundSource, /msg\.action === "reopenGameForEntry"/);
  assert.doesNotMatch(backgroundSource, /KEEP_ALIVE_INTERVAL_MS/);

  console.log("Pré-entrada: reabertura em T-2 min e proteções passaram.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
