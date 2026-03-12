import { beforeEach, describe, expect, it } from "vitest";
import {
  getNextThinkingToggleState,
  getThinkingSettingForProvider,
  getThinkingToggleState,
} from "../useModelSettings";

const THINKING_MODE_KEY = "yep-anywhere-thinking-mode";
const THINKING_LEVEL_KEY = "yep-anywhere-thinking-level";

describe("useModelSettings provider-aware helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uses reasoning effort directly for Codex when thinking is enabled", () => {
    localStorage.setItem(THINKING_MODE_KEY, "auto");
    localStorage.setItem(THINKING_LEVEL_KEY, "max");

    expect(getThinkingSettingForProvider("codex")).toBe("max");
  });

  it("keeps Claude-style auto thinking for non-Codex providers", () => {
    localStorage.setItem(THINKING_MODE_KEY, "auto");
    localStorage.setItem(THINKING_LEVEL_KEY, "max");

    expect(getThinkingSettingForProvider("claude")).toBe("auto");
  });

  it("cycles Codex reasoning levels directly from off to max and back to off", () => {
    let state = getNextThinkingToggleState("codex", "off", "high");
    expect(state).toEqual({ thinkingMode: "on", effortLevel: "low" });

    state = getNextThinkingToggleState(
      "codex",
      state.thinkingMode,
      state.effortLevel,
    );
    expect(state).toEqual({ thinkingMode: "on", effortLevel: "medium" });

    state = getNextThinkingToggleState(
      "codex",
      state.thinkingMode,
      state.effortLevel,
    );
    expect(state).toEqual({ thinkingMode: "on", effortLevel: "high" });

    state = getNextThinkingToggleState(
      "codex",
      state.thinkingMode,
      state.effortLevel,
    );
    expect(state).toEqual({ thinkingMode: "on", effortLevel: "max" });

    state = getNextThinkingToggleState(
      "codex",
      state.thinkingMode,
      state.effortLevel,
    );
    expect(state).toEqual({ thinkingMode: "off", effortLevel: "max" });
  });

  it("shows Codex reasoning label instead of Claude auto/on copy", () => {
    expect(getThinkingToggleState("codex", "on", "high")).toMatchObject({
      className: "active on",
      title: "Reasoning: high",
      ariaLabel: "Reasoning level: high",
      showAutoBadge: false,
    });
  });
});
