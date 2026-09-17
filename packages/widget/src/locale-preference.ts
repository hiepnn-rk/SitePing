import { BUILTIN_LOCALES, type SitepingLocale } from "@siteping/core";

const STORAGE_KEY = "siteping_locale";

/**
 * The visitor's own language pick, persisted by the panel's locale switcher.
 *
 * Deliberately separate from `config.locale`: the host sets the *initial*
 * language, the visitor overrides it for their browser. Returns `null` when
 * nothing was stored, or when storage is unavailable (private mode, blocked
 * site data) — callers fall back to `config.locale`.
 */
export function getStoredLocale(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the visitor's language pick. Silently a no-op when storage is unavailable. */
export function saveLocale(locale: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Quota exceeded or localStorage disabled — the choice holds for this session only
  }
}

/**
 * Resolve `config.localeSwitcher` into the list of locales the panel picker
 * offers.
 *
 * - `undefined` / `false` → `[]` (no picker);
 * - `true` → every built-in locale;
 * - an array → those locales, order preserved, duplicates dropped.
 *
 * A list with fewer than two entries is collapsed to `[]`: a picker with a
 * single choice is chrome that can do nothing.
 */
export function resolveLocaleOptions(value: boolean | readonly SitepingLocale[] | undefined): readonly string[] {
  if (value === undefined || value === false) return [];
  const requested = value === true ? BUILTIN_LOCALES : value;
  const seen = new Set<string>();
  for (const code of requested) {
    if (typeof code === "string" && code.length > 0) seen.add(code);
  }
  return seen.size >= 2 ? [...seen] : [];
}
