"use strict";

const PatternGuard = (() => {
  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    strongSequence: true,
    strongSequenceLength: 3,
    majorityThreeTwo: true,
    majorityCount: 3,
    majorityWindow: 5,
    alternating: true,
    alternatingLength: 5,
    recentBreak: true,
    recentBreakLength: 4,
    recentBreakRounds: 2,
    customPatterns: [],
  });

  const COLOR_NAMES = { A: "Azul", V: "Vermelho" };

  function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function normalizeColor(value) {
    const normalized = String(value || "").trim().toUpperCase();
    if (["A", "AZUL", "BLUE", "PLAYER"].includes(normalized)) return "A";
    if (["V", "VERMELHO", "RED", "BANKER"].includes(normalized)) return "V";
    return null;
  }

  function normalizePattern(value) {
    if (Array.isArray(value)) {
      return value.map(normalizeColor).filter(Boolean).join("");
    }

    return String(value || "")
      .toUpperCase()
      .replace(/AZUL|BLUE|PLAYER/g, "A")
      .replace(/VERMELHO|RED|BANKER/g, "V")
      .replace(/🔵/gu, "A")
      .replace(/🔴/gu, "V")
      .split("")
      .filter((char) => char === "A" || char === "V")
      .join("");
  }

  function normalizeCustomPattern(pattern, index) {
    const sequence = normalizePattern(pattern?.pattern);
    const expected = normalizeColor(pattern?.expected);
    if (sequence.length < 2 || !expected) return null;

    return {
      id: String(pattern?.id || `pattern-${index}`),
      pattern: sequence.slice(-12),
      expected,
      enabled: pattern?.enabled !== false,
    };
  }

  function normalizeConfig(raw = {}) {
    const majorityWindow = clampInteger(
      raw.majorityWindow,
      3,
      10,
      DEFAULT_CONFIG.majorityWindow,
    );
    const minimumMajority = Math.floor(majorityWindow / 2) + 1;
    const majorityCount = clampInteger(
      raw.majorityCount,
      minimumMajority,
      majorityWindow,
      Math.max(minimumMajority, DEFAULT_CONFIG.majorityCount),
    );

    return {
      enabled: raw.enabled !== false,
      strongSequence: raw.strongSequence !== false,
      strongSequenceLength: clampInteger(
        raw.strongSequenceLength,
        3,
        8,
        DEFAULT_CONFIG.strongSequenceLength,
      ),
      majorityThreeTwo: raw.majorityThreeTwo !== false,
      majorityCount,
      majorityWindow,
      alternating: raw.alternating !== false,
      alternatingLength: clampInteger(
        raw.alternatingLength,
        4,
        8,
        DEFAULT_CONFIG.alternatingLength,
      ),
      recentBreak: raw.recentBreak !== false,
      recentBreakLength: clampInteger(
        raw.recentBreakLength,
        4,
        10,
        DEFAULT_CONFIG.recentBreakLength,
      ),
      recentBreakRounds: clampInteger(
        raw.recentBreakRounds,
        1,
        3,
        DEFAULT_CONFIG.recentBreakRounds,
      ),
      customPatterns: (Array.isArray(raw.customPatterns)
        ? raw.customPatterns
        : []
      )
        .map(normalizeCustomPattern)
        .filter(Boolean),
    };
  }

  function historyColors(history) {
    return (Array.isArray(history) ? history : [])
      .map((round) => normalizeColor(round?.cor ?? round))
      .filter(Boolean);
  }

  function opposite(color) {
    return color === "A" ? "V" : "A";
  }

  function colorName(color) {
    return COLOR_NAMES[color] || color;
  }

  function matchResult(rule, expected, target, snapshot, reason) {
    return {
      abort: target !== expected,
      rule,
      expected,
      target,
      snapshot,
      reason,
    };
  }

  function evaluateCustom(colors, target, config) {
    for (const custom of config.customPatterns) {
      if (!custom.enabled || colors.length < custom.pattern.length) continue;
      const snapshot = colors.slice(-custom.pattern.length).join("");
      if (snapshot !== custom.pattern) continue;

      return matchResult(
        "custom",
        custom.expected,
        target,
        snapshot,
        `Padrão personalizado ${snapshot} favorece ${colorName(custom.expected)}`,
      );
    }
    return null;
  }

  function evaluateAlternating(colors, target, config) {
    if (!config.alternating || colors.length < config.alternatingLength) {
      return null;
    }

    const recent = colors.slice(-config.alternatingLength);
    const isAlternating = recent.every(
      (color, index) => index === 0 || color !== recent[index - 1],
    );
    if (!isAlternating) return null;

    const expected = opposite(recent[recent.length - 1]);
    const snapshot = recent.join("");
    return matchResult(
      "alternating",
      expected,
      target,
      snapshot,
      `Alternância ${snapshot} favorece ${colorName(expected)}`,
    );
  }

  function countRunFromEnd(colors, endIndex) {
    if (endIndex < 0) return { color: null, length: 0, startIndex: endIndex };
    const color = colors[endIndex];
    let startIndex = endIndex;
    while (startIndex > 0 && colors[startIndex - 1] === color) startIndex -= 1;
    return {
      color,
      length: endIndex - startIndex + 1,
      startIndex,
    };
  }

  function evaluateRecentBreak(colors, target, config) {
    if (!config.recentBreak || colors.length < config.recentBreakLength + 1) {
      return null;
    }

    const currentRun = countRunFromEnd(colors, colors.length - 1);
    if (
      currentRun.length < 1 ||
      currentRun.length > config.recentBreakRounds ||
      currentRun.startIndex === 0
    ) {
      return null;
    }

    const previousRun = countRunFromEnd(colors, currentRun.startIndex - 1);
    if (
      previousRun.length < config.recentBreakLength ||
      previousRun.color === currentRun.color
    ) {
      return null;
    }

    const snapshot = colors
      .slice(previousRun.startIndex, colors.length)
      .join("");
    return matchResult(
      "recent-break",
      currentRun.color,
      target,
      snapshot,
      `Quebra recente ${snapshot} favorece ${colorName(currentRun.color)}`,
    );
  }

  function evaluateStrongSequence(colors, target, config) {
    if (!config.strongSequence || colors.length < config.strongSequenceLength) {
      return null;
    }

    const run = countRunFromEnd(colors, colors.length - 1);
    if (run.length < config.strongSequenceLength) return null;

    const snapshot = colors.slice(run.startIndex).join("");
    return matchResult(
      "strong-sequence",
      run.color,
      target,
      snapshot,
      `Sequência de ${run.length} resultados ${colorName(run.color)} favorece ${colorName(run.color)}`,
    );
  }

  function evaluateMajorityThreeTwo(colors, target, config) {
    if (
      !config.majorityThreeTwo ||
      colors.length < config.majorityWindow
    ) {
      return null;
    }

    const recent = colors.slice(-config.majorityWindow);
    const blueCount = recent.filter((color) => color === "A").length;
    const redCount = recent.length - blueCount;
    const dominantCount = Math.max(blueCount, redCount);
    if (dominantCount !== config.majorityCount || blueCount === redCount) {
      return null;
    }

    const expected = blueCount > redCount ? "A" : "V";
    const snapshot = recent.join("");
    return matchResult(
      "majority-3x2",
      expected,
      target,
      snapshot,
      `Tendência ${dominantCount} de ${config.majorityWindow} em ${snapshot} favorece ${colorName(expected)}`,
    );
  }

  function blocksOppositeSequence(history, targetValue, rawConfig = {}) {
    const match = evaluate(history, targetValue, {
      ...rawConfig,
      alternating: false,
      majorityThreeTwo: false,
      recentBreak: false,
      customPatterns: [],
    });
    if (!match.abort || match.rule !== "strong-sequence") return null;
    return match;
  }

  function evaluate(history, targetValue, rawConfig = {}) {
    const config = normalizeConfig(rawConfig);
    const target = normalizeColor(targetValue);
    const colors = historyColors(history);

    if (!config.enabled || !target || colors.length < 2) {
      return {
        abort: false,
        rule: null,
        expected: null,
        target,
        snapshot: colors.join(""),
        reason: null,
      };
    }

    const evaluators = [
      evaluateCustom,
      evaluateAlternating,
      evaluateRecentBreak,
      evaluateStrongSequence,
      evaluateMajorityThreeTwo,
    ];

    for (const evaluator of evaluators) {
      const match = evaluator(colors, target, config);
      if (match) return match;
    }

    return {
      abort: false,
      rule: null,
      expected: null,
      target,
      snapshot: colors.slice(-8).join(""),
      reason: null,
    };
  }

  return {
    DEFAULT_CONFIG,
    normalizeColor,
    normalizePattern,
    normalizeConfig,
    evaluate,
    blocksOppositeSequence,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = PatternGuard;
}
