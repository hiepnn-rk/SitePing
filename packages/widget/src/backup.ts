import {
  FEEDBACK_IMPORT_BATCH_SIZE,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  type FeedbackBackupRecord,
  type FeedbackImportResult,
  hasOwn,
  isUnsupported,
  MAX_PAGE_LIMIT,
} from "@siteping/core";
import type { WidgetClient } from "./api-client.js";

// ---------------------------------------------------------------------------
// Backup file format
// ---------------------------------------------------------------------------

/** Discriminator written into every backup so an arbitrary JSON file is never mistaken for one. */
export const BACKUP_FORMAT = "siteping-backup";
export const BACKUP_VERSION = 1;

/**
 * Full dump of a project: every feedback as stored — every column, `id`,
 * `clientId`, timestamps, unredacted emails, annotations, comments,
 * screenshots and diagnostics.
 */
export interface FeedbackBackup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  projectName: string;
  exportedAt: string;
  feedbacks: FeedbackBackupRecord[];
}

/**
 * Walk every page of `page => fetch(page)` until the reported `total` or a
 * short page, whichever comes first — a store with a wrong `total` cannot
 * loop forever.
 */
async function crawl<T>(fetchPage: (page: number) => Promise<{ feedbacks: T[]; total: number }>): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const { feedbacks, total } = await fetchPage(page);
    all.push(...feedbacks);
    if (feedbacks.length < MAX_PAGE_LIMIT || all.length >= total) return all;
  }
}

/** Every full record of the project, ignoring the panel's filters and pagination. */
export function fetchAllRecords(client: WidgetClient): Promise<FeedbackBackupRecord[]> {
  return crawl((page) => client.exportFeedbacks(page, MAX_PAGE_LIMIT));
}

/** Ids of every feedback currently in the project — through the regular (public) read. */
export async function fetchExistingIds(client: WidgetClient, projectName: string): Promise<Set<string>> {
  const feedbacks = await crawl((page) => client.getFeedbacks(projectName, { page, limit: MAX_PAGE_LIMIT }));
  return new Set(feedbacks.map((f) => f.id));
}

export function createBackup(projectName: string, feedbacks: FeedbackBackupRecord[]): FeedbackBackup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    projectName,
    exportedAt: new Date().toISOString(),
    feedbacks,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Thrown by {@link parseBackup} when the file is not a Siteping backup. */
export class InvalidBackupError extends Error {
  override readonly name = "InvalidBackupError";
}

function isDateString(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function hasDatedChildren(value: unknown): boolean {
  return Array.isArray(value) && value.every((child) => hasOwn(child, "createdAt") && isDateString(child.createdAt));
}

/**
 * Structural check only — the server re-validates every field (Zod), and in
 * store mode this is what keeps a hand-edited file from corrupting the store.
 */
function isBackupRecord(value: unknown): value is FeedbackBackupRecord {
  return (
    hasOwn(value, "id") &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    hasOwn(value, "clientId") &&
    typeof value.clientId === "string" &&
    value.clientId.length > 0 &&
    hasOwn(value, "type") &&
    (FEEDBACK_TYPES as readonly unknown[]).includes(value.type) &&
    hasOwn(value, "status") &&
    (FEEDBACK_STATUSES as readonly unknown[]).includes(value.status) &&
    hasOwn(value, "message") &&
    typeof value.message === "string" &&
    hasOwn(value, "createdAt") &&
    isDateString(value.createdAt) &&
    hasOwn(value, "updatedAt") &&
    isDateString(value.updatedAt) &&
    hasOwn(value, "resolvedAt") &&
    (value.resolvedAt === null || isDateString(value.resolvedAt)) &&
    hasOwn(value, "annotations") &&
    hasDatedChildren(value.annotations) &&
    hasOwn(value, "comments") &&
    hasDatedChildren(value.comments)
  );
}

export function parseBackup(text: string): FeedbackBackupRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InvalidBackupError("Backup file is not valid JSON", { cause: error });
  }

  if (!hasOwn(parsed, "format") || parsed.format !== BACKUP_FORMAT || !hasOwn(parsed, "feedbacks")) {
    throw new InvalidBackupError("Not a Siteping backup file");
  }
  const { feedbacks } = parsed;
  if (!Array.isArray(feedbacks) || !feedbacks.every(isBackupRecord)) {
    throw new InvalidBackupError("Backup file contains malformed feedbacks");
  }
  return feedbacks;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** What an import will do, decided by `id` before anything is written. */
export interface ImportPlan {
  /** Records whose `id` is not in the project yet. */
  create: number;
  /** Records whose `id` already exists — they will overwrite it. */
  update: number;
}

export function planImport(existingIds: ReadonlySet<string>, records: readonly FeedbackBackupRecord[]): ImportPlan {
  const update = records.filter((r) => existingIds.has(r.id)).length;
  return { create: records.length - update, update };
}

export interface ImportOutcome extends FeedbackImportResult {
  /** Records in batches the backend rejected. */
  failed: number;
}

/**
 * Upsert every record by `id`, in batches of `FEEDBACK_IMPORT_BATCH_SIZE`. A
 * rejected batch is counted as failed and the run continues; an unsupported
 * backend (store without `importFeedbacks`, HTTP 501) aborts immediately.
 */
export async function importRecords(
  client: WidgetClient,
  records: readonly FeedbackBackupRecord[],
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { created: 0, updated: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < records.length; i += FEEDBACK_IMPORT_BATCH_SIZE) {
    const batch = records.slice(i, i + FEEDBACK_IMPORT_BATCH_SIZE);
    try {
      const result = await client.importFeedbacks(batch);
      outcome.created += result.created;
      outcome.updated += result.updated;
      outcome.skipped += result.skipped;
    } catch (error) {
      if (isUnsupported(error)) throw error;
      outcome.failed += batch.length;
    }
  }
  return outcome;
}
