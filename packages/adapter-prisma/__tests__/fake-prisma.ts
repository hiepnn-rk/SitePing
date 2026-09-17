import type { CommentRecord, FeedbackRecord } from "@siteping/core";
import type { SitepingPrismaClient } from "../src/index.js";

/**
 * In-memory stand-in for the `prisma.sitepingFeedback` delegate, faithful to
 * the Prisma semantics the adapter relies on: a unique `clientId` (`P2002`
 * on duplicate), `P2025` on update/delete of a missing row, `contains`
 * (case-sensitive, like Postgres `LIKE`), `{ in }` and `{ not }` filters,
 * `orderBy`, `skip`/`take`, `select`, and Prisma's rejection of a negative
 * `skip`. Lets the published conformance suite run against `PrismaStore`
 * without a database.
 *
 * A second delegate stands in for `prisma.sitepingComment`, and — like the
 * real generated client — a row only carries `comments` when the query asked
 * to `include` them. `fakePrisma({ comments: false })` drops the delegate
 * entirely, reproducing a host still on the pre-comments Prisma schema.
 */

type Where = Record<string, unknown>;

/** The `include` shape `PrismaStore` sends — comments only when the model exists. */
interface Include {
  annotations?: boolean;
  comments?: boolean | { orderBy?: { createdAt?: "asc" | "desc" } };
}

interface CreateArgs {
  data: Record<string, unknown> & { annotations?: { create: Record<string, unknown>[] } };
  include?: Include;
}

interface FindManyArgs {
  where: Where;
  orderBy?: { createdAt?: "asc" | "desc" };
  skip?: number;
  take?: number;
  select?: Record<string, boolean>;
  include?: Include;
}

function prismaError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Prisma ${code}`), { code });
}

function matchesRecord(row: object, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = (row as Record<string, unknown>)[key];
    if (typeof cond === "object" && cond !== null) {
      if ("contains" in cond) return String(value).includes(String((cond as { contains: string }).contains));
      if ("in" in cond) return (cond as { in: unknown[] }).in.includes(value);
      if ("not" in cond) return value !== (cond as { not: unknown }).not;
    }
    return value === cond;
  });
}

/** Feedback-typed alias — the delegate's own `where` clauses are feedback filters. */
const matches = (row: FeedbackRecord, where: Where): boolean => matchesRecord(row, where);

function pick(row: FeedbackRecord, select: Record<string, boolean> | undefined): unknown {
  if (!select) return structuredClone(row);
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, on]) => on)
      .map(([key]) => [key, (row as unknown as Record<string, unknown>)[key]]),
  );
}

/**
 * Stand-in for `prisma.sitepingComment`. Only the operations `PrismaStore`
 * actually issues are faithful: `create`, and `deleteMany` scoped by both
 * `id` and `feedbackId` (the store relies on the zero-row result to report a
 * comment that belongs to another thread as "not found").
 */
export class FakeCommentDelegate {
  readonly rows: CommentRecord[] = [];
  private seq = 0;

  async create({ data }: { data: Record<string, unknown> }): Promise<CommentRecord> {
    const row: CommentRecord = {
      ...(data as unknown as CommentRecord),
      id: `cm-${++this.seq}`,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return structuredClone(row);
  }

  async findMany({ where }: { where?: Where }): Promise<unknown[]> {
    return this.rows.filter((r) => where === undefined || matchesRecord(r, where)).map((r) => structuredClone(r));
  }

  async findUnique({ where }: { where: { id: string } }): Promise<CommentRecord | null> {
    const row = this.rows.find((r) => r.id === where.id);
    return row ? structuredClone(row) : null;
  }

  async update({ where, data }: { where: { id: string }; data: Partial<CommentRecord> }): Promise<CommentRecord> {
    const row = this.rows.find((r) => r.id === where.id);
    if (!row) throw prismaError("P2025");
    Object.assign(row, data);
    return structuredClone(row);
  }

  async delete({ where }: { where: { id: string } }): Promise<CommentRecord> {
    const index = this.rows.findIndex((r) => r.id === where.id);
    if (index === -1) throw prismaError("P2025");
    const [row] = this.rows.splice(index, 1);
    return structuredClone(row as CommentRecord);
  }

  async deleteMany({ where }: { where: Where }): Promise<{ count: number }> {
    const doomed = this.rows.filter((r) => matchesRecord(r, where));
    for (const row of doomed) this.rows.splice(this.rows.indexOf(row), 1);
    return { count: doomed.length };
  }

  async count({ where }: { where?: Where }): Promise<number> {
    return this.rows.filter((r) => where === undefined || matchesRecord(r, where)).length;
  }

  /** Comments of one feedback, oldest first — what `include: { comments: … }` yields. */
  thread(feedbackId: string): CommentRecord[] {
    return this.rows
      .filter((r) => r.feedbackId === feedbackId)
      .map((r) => structuredClone(r))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}

export class FakeFeedbackDelegate {
  private rows: FeedbackRecord[] = [];
  private seq = 0;

  constructor(private readonly comments?: FakeCommentDelegate) {}

  /**
   * Attach the thread only when the query included it — a real client omits
   * the key otherwise, which is exactly what the adapter's row normalizer
   * has to cope with on an unmigrated schema.
   */
  private withInclude(row: FeedbackRecord, include: Include | undefined): unknown {
    const { comments: _stored, ...clone } = structuredClone(row) as FeedbackRecord & {
      comments?: CommentRecord[];
    };
    return include?.comments && this.comments ? { ...clone, comments: this.comments.thread(row.id) } : clone;
  }

  async create({ data, include }: CreateArgs): Promise<unknown> {
    if (this.rows.some((r) => r.clientId === data.clientId)) throw prismaError("P2002");
    const now = new Date();
    const id = `fb-${++this.seq}`;
    const annotations = (data.annotations?.create ?? []).map((a) => ({
      ...(a as unknown as FeedbackRecord["annotations"][number]),
      id: `ann-${++this.seq}`,
      feedbackId: id,
      elementId: (a.elementId as string | undefined) ?? null,
      anchorKey: (a.anchorKey as string | null | undefined) ?? null,
      createdAt: now,
    }));
    const row: FeedbackRecord = {
      ...(data as unknown as FeedbackRecord),
      id,
      urlPattern: (data.urlPattern as string | null | undefined) ?? null,
      screenshotUrl: (data.screenshotUrl as string | null | undefined) ?? null,
      screenshotRegion: (data.screenshotRegion as FeedbackRecord["screenshotRegion"]) ?? null,
      diagnostics: (data.diagnostics as FeedbackRecord["diagnostics"]) ?? null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      annotations,
    };
    this.rows.push(row);
    return this.withInclude(row, include);
  }

  async findMany({ where, orderBy, skip = 0, take, select, include }: FindManyArgs): Promise<unknown[]> {
    if (skip < 0) throw new Error(`PrismaClientValidationError: Invalid value for argument \`skip\`: ${skip}`);
    let result = this.rows.map((r, index) => ({ r, index })).filter(({ r }) => matches(r, where));
    if (orderBy?.createdAt === "desc") {
      // Ties broken by insertion order desc — the most favourable reading of
      // a real database's unspecified tie order.
      result.sort((a, b) => b.r.createdAt.getTime() - a.r.createdAt.getTime() || b.index - a.index);
    }
    result = result.slice(skip, take === undefined ? undefined : skip + take);
    return result.map(({ r }) => (select ? pick(r, select) : this.withInclude(r, include)));
  }

  async findUnique({
    where,
    include,
  }: {
    where: { id?: string; clientId?: string };
    include?: Include;
  }): Promise<unknown | null> {
    const row = this.rows.find((r) => (where.id !== undefined ? r.id === where.id : r.clientId === where.clientId));
    return row ? this.withInclude(row, include) : null;
  }

  async update({
    where,
    data,
    include,
  }: {
    where: { id: string };
    data: Partial<FeedbackRecord>;
    include?: Include;
  }): Promise<unknown> {
    const row = this.rows.find((r) => r.id === where.id);
    if (!row) throw prismaError("P2025");
    Object.assign(row, data, { updatedAt: new Date() });
    return this.withInclude(row, include);
  }

  async delete({ where }: { where: { id: string } }): Promise<FeedbackRecord> {
    const index = this.rows.findIndex((r) => r.id === where.id);
    if (index === -1) throw prismaError("P2025");
    const [row] = this.rows.splice(index, 1);
    // `onDelete: Cascade` on the relation — the thread goes with its feedback.
    void this.comments?.deleteMany({ where: { feedbackId: where.id } });
    return structuredClone(row as FeedbackRecord);
  }

  async deleteMany({ where }: { where: Where }): Promise<{ count: number }> {
    const doomed = this.rows.filter((r) => matches(r, where));
    this.rows = this.rows.filter((r) => !matches(r, where));
    for (const row of doomed) void this.comments?.deleteMany({ where: { feedbackId: row.id } });
    return { count: doomed.length };
  }

  async count({ where }: { where: Where }): Promise<number> {
    return this.rows.filter((r) => matches(r, where)).length;
  }
}

/**
 * A `SitepingPrismaClient` backed by fresh in-memory delegates.
 *
 * `comments: false` omits the `sitepingComment` delegate — the shape a host
 * has before running `npx @siteping/cli sync`, where `PrismaStore` must keep
 * serving feedbacks and simply not offer `addComment`.
 */
export function fakePrisma(options?: { comments?: boolean }): SitepingPrismaClient & {
  sitepingFeedback: FakeFeedbackDelegate;
  sitepingComment?: FakeCommentDelegate;
} {
  if (options?.comments === false) return { sitepingFeedback: new FakeFeedbackDelegate() };
  const sitepingComment = new FakeCommentDelegate();
  return { sitepingFeedback: new FakeFeedbackDelegate(sitepingComment), sitepingComment };
}
