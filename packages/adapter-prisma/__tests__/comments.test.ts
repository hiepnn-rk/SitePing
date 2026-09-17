import type { CommentResponse, FeedbackResponse, FeedbackResponseList } from "@siteping/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createSitepingHandler, PrismaStore } from "../src/index.js";
import { fakePrisma } from "./fake-prisma.js";
import { validPayloadNoAnnotations } from "./fixtures.js";

const ENDPOINT = "http://localhost/api/siteping";
const API_KEY = "secret-key";

/** Post a feedback through the handler and return the created record. */
async function seedFeedback(
  handler: ReturnType<typeof createSitepingHandler>,
  overrides?: Record<string, unknown>,
): Promise<FeedbackResponse> {
  const res = await handler.POST(
    new Request(ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ ...validPayloadNoAnnotations, ...overrides }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as FeedbackResponse;
}

function comment(body: Record<string, unknown>, init?: { apiKey?: string }): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: init?.apiKey ? { Authorization: `Bearer ${init.apiKey}` } : {},
    body: JSON.stringify(body),
  });
}

describe("comments — POST", () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let handler: ReturnType<typeof createSitepingHandler>;

  beforeEach(() => {
    prisma = fakePrisma();
    handler = createSitepingHandler({ prisma, requireAuthForDestructive: false });
  });

  it("appends a comment to an existing thread", async () => {
    const feedback = await seedFeedback(handler);

    const res = await handler.POST(
      comment({
        feedbackId: feedback.id,
        projectName: "test-project",
        body: "Still reproducible after the deploy",
        authorName: "Alice",
        authorEmail: "alice@example.com",
        authorRole: "client",
      }),
    );

    expect(res.status).toBe(201);
    const created = (await res.json()) as CommentResponse;
    expect(created.body).toBe("Still reproducible after the deploy");
    expect(created.feedbackId).toBe(feedback.id);
    expect(prisma.sitepingComment?.rows).toHaveLength(1);
  });

  it("serves the thread back on the feedback, oldest first", async () => {
    const feedback = await seedFeedback(handler);
    for (const body of ["first", "second"]) {
      await handler.POST(
        comment({
          feedbackId: feedback.id,
          projectName: "test-project",
          body,
          authorName: "Alice",
          authorEmail: "",
          authorRole: "client",
        }),
      );
    }

    const res = await handler.GET(new Request(`${ENDPOINT}?projectName=test-project`));
    const list = (await res.json()) as FeedbackResponseList;
    expect(list.feedbacks[0]?.comments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("downgrades an unauthenticated `team` claim to `client`", async () => {
    const feedback = await seedFeedback(handler);

    const res = await handler.POST(
      comment({
        feedbackId: feedback.id,
        projectName: "test-project",
        body: "Shipping a fix tonight — trust me",
        authorName: "Not The Team",
        authorEmail: "",
        authorRole: "team",
      }),
    );

    const created = (await res.json()) as CommentResponse;
    expect(created.authorRole).toBe("client");
  });

  it("keeps the `team` role for a Bearer-authenticated caller", async () => {
    const authed = createSitepingHandler({ prisma, apiKey: API_KEY });
    const feedback = await seedFeedback(authed);

    const res = await authed.POST(
      comment(
        {
          feedbackId: feedback.id,
          projectName: "test-project",
          body: "Fixed in 1.4.2",
          authorName: "Bob",
          authorEmail: "bob@example.com",
          authorRole: "team",
        },
        { apiKey: API_KEY },
      ),
    );

    const created = (await res.json()) as CommentResponse;
    expect(created.authorRole).toBe("team");
    expect(created.authorEmail).toBe("bob@example.com");
  });

  it("returns 404 for an unknown feedback", async () => {
    const res = await handler.POST(
      comment({
        feedbackId: "does-not-exist",
        projectName: "test-project",
        body: "Into the void",
        authorName: "Alice",
        authorEmail: "",
        authorRole: "client",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the thread belongs to another project", async () => {
    const feedback = await seedFeedback(handler);

    const res = await handler.POST(
      comment({
        feedbackId: feedback.id,
        projectName: "someone-elses-project",
        body: "Cross-project write",
        authorName: "Intruder",
        authorEmail: "",
        authorRole: "client",
      }),
    );

    expect(res.status).toBe(404);
    expect(prisma.sitepingComment?.rows).toHaveLength(0);
  });

  it("returns 400 for an empty or oversized body", async () => {
    const feedback = await seedFeedback(handler);
    const base = {
      feedbackId: feedback.id,
      projectName: "test-project",
      authorName: "Alice",
      authorEmail: "",
      authorRole: "client" as const,
    };

    expect((await handler.POST(comment({ ...base, body: "   " }))).status).toBe(400);
    expect((await handler.POST(comment({ ...base, body: "x".repeat(5001) }))).status).toBe(400);
  });

  it("returns 501 when the store cannot persist comments", async () => {
    // A host still on the pre-comments Prisma schema: the generated client
    // has no `sitepingComment` delegate, so `PrismaStore` offers no
    // `addComment` and the handler says so instead of 500-ing.
    const legacy = createSitepingHandler({ prisma: fakePrisma({ comments: false }), requireAuthForDestructive: false });
    const feedback = await seedFeedback(legacy);

    const res = await legacy.POST(
      comment({
        feedbackId: feedback.id,
        projectName: "test-project",
        body: "No table for this",
        authorName: "Alice",
        authorEmail: "",
        authorRole: "client",
      }),
    );

    expect(res.status).toBe(501);
  });

  it("keeps serving feedbacks with an empty thread on a pre-comments schema", async () => {
    const legacy = createSitepingHandler({ prisma: fakePrisma({ comments: false }), requireAuthForDestructive: false });
    await seedFeedback(legacy);

    const res = await legacy.GET(new Request(`${ENDPOINT}?projectName=test-project`));
    const list = (await res.json()) as FeedbackResponseList;
    expect(list.feedbacks[0]?.comments).toEqual([]);
  });
});

describe("comments — email redaction", () => {
  it("redacts comment author emails for unauthenticated readers", async () => {
    const prisma = fakePrisma();
    const authed = createSitepingHandler({ prisma, apiKey: API_KEY });
    const feedback = await seedFeedback(authed);
    await authed.POST(
      comment(
        {
          feedbackId: feedback.id,
          projectName: "test-project",
          body: "Reply with an address attached",
          authorName: "Bob",
          authorEmail: "bob@example.com",
          authorRole: "team",
        },
        { apiKey: API_KEY },
      ),
    );

    const open = createSitepingHandler({ prisma, apiKey: API_KEY, publicEndpoints: ["GET", "POST", "OPTIONS"] });
    const anonymous = (await (
      await open.GET(new Request(`${ENDPOINT}?projectName=test-project`))
    ).json()) as FeedbackResponseList;
    expect(anonymous.feedbacks[0]?.comments[0]?.authorEmail).toBe("");

    const withKey = (await (
      await open.GET(
        new Request(`${ENDPOINT}?projectName=test-project`, { headers: { Authorization: `Bearer ${API_KEY}` } }),
      )
    ).json()) as FeedbackResponseList;
    expect(withKey.feedbacks[0]?.comments[0]?.authorEmail).toBe("bob@example.com");
  });
});

describe("comments — DELETE", () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let handler: ReturnType<typeof createSitepingHandler>;

  async function seedThread(): Promise<{ feedbackId: string; commentId: string }> {
    const feedback = await seedFeedback(handler);
    const res = await handler.POST(
      comment({
        feedbackId: feedback.id,
        projectName: "test-project",
        body: "Doomed",
        authorName: "Alice",
        authorEmail: "",
        authorRole: "client",
      }),
    );
    const created = (await res.json()) as CommentResponse;
    return { feedbackId: feedback.id, commentId: created.id };
  }

  beforeEach(() => {
    prisma = fakePrisma();
    handler = createSitepingHandler({ prisma, requireAuthForDestructive: false });
  });

  function del(body: Record<string, unknown>, apiKey?: string): Request {
    return new Request(ENDPOINT, {
      method: "DELETE",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: JSON.stringify(body),
    });
  }

  it("deletes one comment and leaves the feedback", async () => {
    const { feedbackId, commentId } = await seedThread();

    const res = await handler.DELETE(del({ feedbackId, commentId, projectName: "test-project" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deleted: true });
    expect(prisma.sitepingComment?.rows).toHaveLength(0);
    const list = (await (
      await handler.GET(new Request(`${ENDPOINT}?projectName=test-project`))
    ).json()) as FeedbackResponseList;
    expect(list.feedbacks).toHaveLength(1);
  });

  it("returns 404 for a comment on another thread", async () => {
    const { commentId } = await seedThread();
    const other = await seedFeedback(handler, { clientId: "uuid-other" });

    const res = await handler.DELETE(del({ feedbackId: other.id, commentId, projectName: "test-project" }));

    expect(res.status).toBe(404);
    expect(prisma.sitepingComment?.rows).toHaveLength(1);
  });

  it("requires the API key like every other destructive call", async () => {
    const guarded = createSitepingHandler({ prisma, apiKey: API_KEY });
    const { feedbackId, commentId } = await seedThread();

    expect((await guarded.DELETE(del({ feedbackId, commentId, projectName: "test-project" }))).status).toBe(401);
    expect((await guarded.DELETE(del({ feedbackId, commentId, projectName: "test-project" }, API_KEY))).status).toBe(
      200,
    );
  });

  it("returns 501 when the store cannot delete comments", async () => {
    const legacy = createSitepingHandler({ prisma: fakePrisma({ comments: false }), requireAuthForDestructive: false });
    const feedback = await seedFeedback(legacy);

    const res = await legacy.DELETE(del({ feedbackId: feedback.id, commentId: "cm-1", projectName: "test-project" }));

    expect(res.status).toBe(501);
  });
});

describe("PrismaStore — comment capability probe", () => {
  it("offers addComment/deleteComment only when the client has the model", () => {
    const withModel = new PrismaStore(fakePrisma());
    expect(typeof withModel.addComment).toBe("function");
    expect(typeof withModel.deleteComment).toBe("function");

    const withoutModel = new PrismaStore(fakePrisma({ comments: false }));
    expect(withoutModel.addComment).toBeUndefined();
    expect(withoutModel.deleteComment).toBeUndefined();
  });
});
