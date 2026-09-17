import { hasOwn, isValidEmail, type SitepingIdentity } from "@siteping/core";

const STORAGE_KEY = "siteping_identity";

/**
 * Author identity persisted by the widget — alias of core's
 * `SitepingIdentity` (one concept, one shape; the alias keeps the widget's
 * historical export name working).
 */
export type Identity = SitepingIdentity;

/**
 * Type guard — narrows an unknown value to `Identity`.
 *
 * The name is the only required field: a non-empty string. The email is
 * optional (the modal lets visitors skip it), so an absent or empty value is
 * accepted — but a *present, non-empty* one must satisfy the shared pattern.
 * A stored address that fails it (persisted by an older, laxer modal) makes
 * the whole identity count as absent, so the modal asks again instead of
 * every submission failing with a 400.
 */
function isIdentity(value: unknown): value is Identity {
  if (!hasOwn(value, "name")) return false;
  const { name } = value;
  if (typeof name !== "string" || name.length === 0) return false;
  if (!hasOwn(value, "email") || value.email === undefined) return true;
  const { email } = value;
  return typeof email === "string" && (email.length === 0 || isValidEmail(email));
}

export function getIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: Identity): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Quota exceeded or localStorage disabled — identity works for this session only
  }
}
