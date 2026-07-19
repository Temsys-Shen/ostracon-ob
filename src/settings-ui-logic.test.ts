import { describe, expect, test } from "vitest";
import { resolveSettingsTabIndex } from "./settings-ui-logic";

describe("settings tab keyboard navigation", () => {
  test("moves and wraps with arrow keys", () => {
    expect(resolveSettingsTabIndex(0, "ArrowRight", 4)).toBe(1);
    expect(resolveSettingsTabIndex(3, "ArrowRight", 4)).toBe(0);
    expect(resolveSettingsTabIndex(0, "ArrowLeft", 4)).toBe(3);
  });

  test("supports Home and End without handling unrelated keys", () => {
    expect(resolveSettingsTabIndex(2, "Home", 4)).toBe(0);
    expect(resolveSettingsTabIndex(1, "End", 4)).toBe(3);
    expect(resolveSettingsTabIndex(1, "Enter", 4)).toBeNull();
  });
});
