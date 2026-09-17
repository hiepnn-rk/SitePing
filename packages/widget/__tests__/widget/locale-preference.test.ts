// @vitest-environment jsdom

import { BUILTIN_LOCALES } from "@siteping/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoredLocale, resolveLocaleOptions, saveLocale } from "../../src/locale-preference.js";

describe("resolveLocaleOptions", () => {
  it("returns an empty list when the switcher is off", () => {
    expect(resolveLocaleOptions(undefined)).toEqual([]);
    expect(resolveLocaleOptions(false)).toEqual([]);
  });

  it("offers every built-in locale for `true`", () => {
    expect(resolveLocaleOptions(true)).toEqual([...BUILTIN_LOCALES]);
  });

  it("keeps an explicit list in the given order", () => {
    expect(resolveLocaleOptions(["ja", "en"])).toEqual(["ja", "en"]);
  });

  it("drops duplicates", () => {
    expect(resolveLocaleOptions(["en", "ja", "en"])).toEqual(["en", "ja"]);
  });

  it("collapses a list with fewer than two usable entries — a picker that cannot pick is chrome", () => {
    expect(resolveLocaleOptions(["en"])).toEqual([]);
    expect(resolveLocaleOptions([])).toEqual([]);
    expect(resolveLocaleOptions(["en", "en"])).toEqual([]);
  });

  it("accepts custom locale codes registered at runtime", () => {
    expect(resolveLocaleOptions(["en", "nl-BE"])).toEqual(["en", "nl-BE"]);
  });
});

describe("locale persistence", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips the visitor's pick", () => {
    saveLocale("ja");
    expect(getStoredLocale()).toBe("ja");
  });

  it("returns null when nothing was stored", () => {
    expect(getStoredLocale()).toBeNull();
  });

  it("returns null for an empty stored value", () => {
    localStorage.setItem("siteping_locale", "");
    expect(getStoredLocale()).toBeNull();
  });

  it("survives storage being unavailable (private mode, blocked site data)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => saveLocale("ja")).not.toThrow();
    expect(getStoredLocale()).toBeNull();
  });
});
