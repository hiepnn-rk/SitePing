import {
  createCollectionStore,
  type FeedbackCreateInput,
  type FeedbackRecord,
  isUnsupported,
  type SitepingStore,
} from "@siteping/core";
import { describe, expect, it, vi } from "vitest";
import {
  BACKUP_FORMAT,
  createBackup,
  fetchAllRecords,
  fetchExistingIds,
  InvalidBackupError,
  importRecords,
  parseBackup,
  planImport,
} from "../../src/backup.js";
import { StoreClient } from "../../src/store-client.js";

// ---------------------------------------------------------------------------
// Fixtures — a real collection store behind the real StoreClient
// ---------------------------------------------------------------------------

function memoryStore(): SitepingStore {
  let rows: FeedbackRecord[] = [];
  let seq = 0;
  return createCollectionStore({
    load: () => rows,
    persist: (next) => {
      rows = next;
    },
    generateId: () => `id-${++seq}`,
  });
}

function input(clientId: string, overrides: Partial<FeedbackCreateInput> = {}): FeedbackCreateInput {
  return {
    projectName: "project",
    type: "bug",
    message: `message ${clientId}`,
    status: "open",
    url: "/page",
    viewport: "1440x900",
    userAgent: "vitest",
    authorName: "Ava",
    authorEmail: "ava@example.com",
    clientId,
    annotations: [],
    screenshotDataUrl: "data:image/jpeg;base64,AAAA",
    ...overrides,
  };
}

async function seededClient(count: number) {
  const store = memoryStore();
  for (let i = 0; i < count; i++) await store.createFeedback(input(`client-${i}`));
  return { store, client: new StoreClient(store, "project") };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("fetchAllRecords", () => {
  it("walks every page and keeps every column — clientId and email included", async () => {
    const { store, client } = await seededClient(230);
    const first = (await store.getFeedbacks({ projectName: "project", limit: 1 })).feedbacks[0]!;
    await store.addComment?.(first.id, { body: "hi", authorName: "Bob", authorEmail: "b@x.io", authorRole: "team" });

    const records = await fetchAllRecords(client);

    expect(records).toHaveLength(230);
    const exported = records.find((r) => r.id === first.id)!;
    expect(exported).toMatchObject({
      clientId: first.clientId,
      authorEmail: "ava@example.com",
      screenshotUrl: "data:image/jpeg;base64,AAAA",
      createdAt: first.createdAt.toISOString(),
    });
    expect(exported.comments[0]).toMatchObject({ body: "hi", authorEmail: "b@x.io", authorRole: "team" });
  });

  it("stops on a short page even when total over-reports", async () => {
    const { client } = await seededClient(1);
    const spy = vi.spyOn(client, "exportFeedbacks").mockResolvedValue({ feedbacks: [], total: 9999 });

    expect(await fetchAllRecords(client)).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("parseBackup", () => {
  it("round-trips an exported backup", async () => {
    const { client } = await seededClient(2);
    const records = await fetchAllRecords(client);
    const text = JSON.stringify(createBackup("project", records));

    expect(parseBackup(text)).toEqual(records);
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["a bare array", "[]"],
    ["an unrelated object", JSON.stringify({ hello: "world" })],
    ["a record without clientId", JSON.stringify({ format: BACKUP_FORMAT, feedbacks: [{ id: "x" }] })],
  ])("rejects %s", (_label, text) => {
    expect(() => parseBackup(text)).toThrow(InvalidBackupError);
  });

  it("rejects unparseable dates", async () => {
    const { client } = await seededClient(1);
    const [record] = await fetchAllRecords(client);
    const text = JSON.stringify(createBackup("project", [{ ...record!, createdAt: "yesterday" }]));
    expect(() => parseBackup(text)).toThrow(InvalidBackupError);
  });
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

describe("planImport + importRecords", () => {
  it("decides create vs update by id, then applies exactly that", async () => {
    const source = await seededClient(3);
    const records = await fetchAllRecords(source.client);

    // Target already holds one of the three ids, with outdated content.
    const target = memoryStore();
    const targetClient = new StoreClient(target, "project");
    await target.importFeedbacks?.("project", [
      { ...(await source.store.findByClientId("client-1"))!, message: "outdated", status: "open" },
    ]);
    const edited = records.map((r) =>
      r.clientId === "client-1" ? { ...r, message: "fresh", status: "wont_fix" as const } : r,
    );

    const plan = planImport(await fetchExistingIds(targetClient, "project"), edited);
    expect(plan).toEqual({ create: 2, update: 1 });

    const outcome = await importRecords(targetClient, edited);
    expect(outcome).toEqual({ created: 2, updated: 1, skipped: 0, failed: 0 });

    const restored = await fetchAllRecords(targetClient);
    expect(restored.map((r) => r.id).sort()).toEqual(records.map((r) => r.id).sort());
    const updated = restored.find((r) => r.clientId === "client-1")!;
    expect(updated).toMatchObject({ message: "fresh", status: "wont_fix" });
    // Everything else is carried over verbatim.
    const original = records.find((r) => r.clientId === "client-0")!;
    expect(restored.find((r) => r.id === original.id)).toEqual(original);
  });

  it("re-importing the same file only updates", async () => {
    const { client } = await seededClient(2);
    const records = await fetchAllRecords(client);

    expect(await importRecords(client, records)).toEqual({ created: 0, updated: 2, skipped: 0, failed: 0 });
    expect(await fetchAllRecords(client)).toEqual(records);
  });

  it("sends batches and counts a rejected batch as failed", async () => {
    const { client } = await seededClient(60);
    const records = await fetchAllRecords(client);
    const spy = vi.spyOn(client, "importFeedbacks");
    spy.mockRejectedValueOnce(new Error("500"));

    const outcome = await importRecords(client, records);

    expect(spy).toHaveBeenCalledTimes(3); // 25 + 25 + 10
    expect(outcome).toEqual({ created: 0, updated: 35, skipped: 0, failed: 25 });
  });

  it("aborts when the store cannot import", async () => {
    const store = memoryStore();
    const { importFeedbacks: _omit, ...legacy } = store;
    const client = new StoreClient(legacy as SitepingStore, "project");

    const error = await importRecords(client, [
      { ...(await fetchAllRecords((await seededClient(1)).client))[0]! },
    ]).catch((e: unknown) => e);
    expect(isUnsupported(error)).toBe(true);
  });
});
