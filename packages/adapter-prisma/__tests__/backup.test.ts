import type { FeedbackBackupRecord, FeedbackResponse } from "@siteping/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSitepingHandler, PrismaStore } from "../src/index.js";
import { fakePrisma } from "./fake-prisma.js";
import { validPayloadNoAnnotations } from "./fixtures.js";

const ENDPOINT = "http://localhost/api/siteping";
const API_KEY = "secret-key";
const AUTH = { Authorization: `Bearer ${API_KEY}` };

function exportRequest(query = "", headers: Record<string, string> = AUTH): Request {
  return new Request(`${ENDPOINT}?export=true&projectName=test-project${query}`, { headers });
}

function importRequest(body: unknown, headers: Record<string, string> = AUTH): Request {
  return new Request(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
}

async function seed(handler: ReturnType<typeof createSitepingHandler>): Promise<FeedbackResponse> {
  const res = await handler.POST(
    new Request(ENDPOINT, { method: "POST", body: JSON.stringify(validPayloadNoAnnotations) }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as FeedbackResponse;
}

function record(overrides: Partial<FeedbackBackupRecord> = {}): FeedbackBackupRecord {
  return {
    id: "restored-1",
    projectName: "anything",
    type: "bug",
    message: "Restored",
    status: "resolved",
    url: "/restored",
    urlPattern: null,
    viewport: "1280x800",
    userAgent: "Backup",
    authorName: "Alice",
    authorEmail: "alice@example.com",
    clientId: "restored-client-1",
    resolvedAt: "2025-02-02T00:00:00.000Z",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-02-02T00:00:00.000Z",
    annotations: [],
    comments: [
      {
        id: "restored-c1",
        feedbackId: "restored-1",
        body: "Team reply",
        authorName: "Bob",
        authorEmail: "bob@example.com",
        authorRole: "team",
        createdAt: "2025-01-03T00:00:00.000Z",
      },
    ],
    screenshotUrl: null,
    screenshotRegion: null,
    diagnostics: null,
    ...overrides,
  };
}

describe("backup export — GET ?export=true", () => {
  let handler: ReturnType<typeof createSitepingHandler>;

  beforeEach(() => {
    handler = createSitepingHandler({ prisma: fakePrisma(), apiKey: API_KEY, publicEndpoints: ["GET", "POST"] });
  });

  it("returns full records — clientId and unredacted emails included", async () => {
    await seed(handler);

    const res = await handler.GET(exportRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { feedbacks: FeedbackBackupRecord[]; total: number };
    expect(body.total).toBe(1);
    expect(body.feedbacks[0]?.clientId).toBe(validPayloadNoAnnotations.clientId);
    expect(body.feedbacks[0]?.authorEmail).toBe(validPayloadNoAnnotations.authorEmail);
  });

  it("requires the API key even when GET is public", async () => {
    expect((await handler.GET(exportRequest("", {}))).status).toBe(401);
    // The ordinary public read still works — and still hides clientId.
    await seed(handler);
    const res = await handler.GET(new Request(`${ENDPOINT}?projectName=test-project`));
    expect(res.status).toBe(200);
    expect((await res.json()).feedbacks[0]).not.toHaveProperty("clientId");
  });

  it("follows the destructive guard when no apiKey is configured", async () => {
    const guarded = createSitepingHandler({ prisma: fakePrisma() });
    expect((await guarded.GET(exportRequest("", {}))).status).toBe(401);

    const open = createSitepingHandler({ prisma: fakePrisma(), requireAuthForDestructive: false });
    expect((await open.GET(exportRequest("", {}))).status).toBe(200);
  });
});

describe("backup import — POST { records }", () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let handler: ReturnType<typeof createSitepingHandler>;

  beforeEach(() => {
    prisma = fakePrisma();
    handler = createSitepingHandler({ prisma, apiKey: API_KEY });
  });

  it("creates unknown ids and updates known ones", async () => {
    const first = await handler.POST(importRequest({ projectName: "test-project", records: [record()] }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ created: 1, updated: 0, skipped: 0 });

    const second = await handler.POST(
      importRequest({ projectName: "test-project", records: [record({ message: "Edited", comments: [] })] }),
    );
    expect(await second.json()).toEqual({ created: 0, updated: 1, skipped: 0 });

    const res = await handler.GET(exportRequest());
    const { feedbacks } = (await res.json()) as { feedbacks: FeedbackBackupRecord[] };
    expect(feedbacks).toHaveLength(1);
    expect(feedbacks[0]).toMatchObject({
      id: "restored-1",
      projectName: "test-project",
      message: "Edited",
      createdAt: "2025-01-01T00:00:00.000Z",
      comments: [],
    });
  });

  it("keeps the imported comment ids, roles and dates", async () => {
    await handler.POST(importRequest({ projectName: "test-project", records: [record()] }));

    expect(prisma.sitepingComment?.rows).toEqual([
      expect.objectContaining({ id: "restored-c1", feedbackId: "restored-1", authorRole: "team" }),
    ]);
  });

  it("requires the API key although POST is public for the widget", async () => {
    const res = await handler.POST(importRequest({ projectName: "test-project", records: [record()] }, {}));
    expect(res.status).toBe(401);
  });

  it("rejects malformed records and unsafe screenshot URLs", async () => {
    const bad = [
      record({ createdAt: "yesterday" }),
      record({ clientId: "../escape" }),
      record({ screenshotUrl: "javascript:alert(1)" }),
    ];
    for (const r of bad) {
      const res = await handler.POST(importRequest({ projectName: "test-project", records: [r] }));
      expect(res.status).toBe(400);
    }
  });

  it("answers 501 when the store cannot import", async () => {
    const store = new PrismaStore(fakePrisma());
    const legacy = createSitepingHandler({
      store: Object.assign(Object.create(store) as PrismaStore, { importFeedbacks: undefined }),
      apiKey: API_KEY,
    });

    const res = await legacy.POST(importRequest({ projectName: "test-project", records: [record()] }));
    expect(res.status).toBe(501);
  });
});

describe("PrismaStore.importFeedbacks", () => {
  it("runs the batch inside $transaction when the client has one", async () => {
    const prisma = fakePrisma();
    const $transaction = vi.fn((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
    const store = new PrismaStore(Object.assign(prisma, { $transaction }));

    await store.importFeedbacks("p", []);

    expect($transaction).toHaveBeenCalledTimes(1);
  });
});
