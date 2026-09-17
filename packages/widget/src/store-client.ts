import {
  type AnnotationRecord,
  type AnnotationResponse,
  type CommentCreateInput,
  type CommentRecord,
  type CommentResponse,
  type FeedbackPayload,
  type FeedbackRecord,
  type FeedbackResponse,
  type FeedbackResponseList,
  flattenAnnotation,
  type SitepingStore,
  SitepingUnsupportedError,
  toFeedbackUpdate,
} from "@siteping/core";
import type { GetFeedbacksOptions, WidgetClient } from "./api-client.js";

/**
 * `WidgetClient` implementation that delegates directly to a `SitepingStore`.
 *
 * Used in client-side mode — the widget calls the store in-process instead of
 * making HTTP requests. Handles the same conversions the HTTP handler normally
 * performs: flattening annotations and serializing dates.
 */
export class StoreClient implements WidgetClient {
  /** Store mode knows the answer up front: comments exist iff the store implements them. */
  readonly supportsComments: boolean;

  constructor(
    private readonly store: SitepingStore,
    private readonly projectName: string,
  ) {
    this.supportsComments = typeof store.addComment === "function";
  }

  async sendFeedback(payload: FeedbackPayload): Promise<FeedbackResponse> {
    const record = await this.store.createFeedback({
      projectName: payload.projectName,
      type: payload.type,
      message: payload.message,
      status: "open",
      url: payload.url,
      urlPattern: payload.urlPattern ?? null,
      viewport: payload.viewport,
      userAgent: payload.userAgent,
      authorName: payload.authorName,
      authorEmail: payload.authorEmail,
      clientId: payload.clientId,
      annotations: payload.annotations.map(flattenAnnotation),
      screenshotDataUrl: payload.screenshotDataUrl ?? null,
      screenshotRegion: payload.screenshotRegion ?? null,
      diagnostics: payload.diagnostics ?? null,
    });

    return toResponse(record);
  }

  async getFeedbacks(projectName: string, options?: GetFeedbacksOptions): Promise<FeedbackResponseList> {
    const { feedbacks, total } = await this.store.getFeedbacks({
      projectName,
      page: options?.page,
      limit: options?.limit,
      type: options?.type,
      status: options?.status,
      statuses: options?.statuses,
      search: options?.search,
      url: options?.url,
      urlPattern: options?.urlPattern,
    });

    return { feedbacks: feedbacks.map(toResponse), total };
  }

  async resolveFeedback(id: string, resolved: boolean): Promise<FeedbackResponse> {
    const record = await this.store.updateFeedback(id, toFeedbackUpdate(resolved ? "resolved" : "open"));
    return toResponse(record);
  }

  async deleteFeedback(id: string): Promise<void> {
    await this.store.deleteFeedback(id);
  }

  async deleteAllFeedbacks(projectName: string): Promise<void> {
    await this.store.deleteAllFeedbacks(projectName);
  }

  async addComment(feedbackId: string, input: CommentCreateInput): Promise<CommentResponse> {
    const add = this.store.addComment;
    if (!add) {
      // Same signal the HTTP path produces for a 501, so the panel has one
      // rule for "this backend has no comments" in both modes.
      throw new SitepingUnsupportedError("Failed to post comment: this store does not support comments");
    }
    return toCommentResponse(await add.call(this.store, feedbackId, input));
  }
}

// ---------------------------------------------------------------------------
// FeedbackRecord (Date) → FeedbackResponse (string) serialization
// ---------------------------------------------------------------------------

function toResponse(record: FeedbackRecord): FeedbackResponse {
  return {
    id: record.id,
    projectName: record.projectName,
    type: record.type,
    message: record.message,
    status: record.status,
    url: record.url,
    urlPattern: record.urlPattern ?? null,
    viewport: record.viewport,
    userAgent: record.userAgent,
    authorName: record.authorName,
    authorEmail: record.authorEmail,
    resolvedAt: record.resolvedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    annotations: record.annotations.map(toAnnotationResponse),
    // `comments` may be absent on a snapshot written before comments existed
    // (a hand-rolled store, or localStorage data from an older release).
    comments: (record.comments ?? []).map(toCommentResponse),
    screenshotUrl: record.screenshotUrl ?? null,
    screenshotRegion: record.screenshotRegion ?? null,
    diagnostics: record.diagnostics ?? null,
  };
}

function toCommentResponse(comment: CommentRecord): CommentResponse {
  return {
    id: comment.id,
    feedbackId: comment.feedbackId,
    body: comment.body,
    authorName: comment.authorName,
    authorEmail: comment.authorEmail,
    authorRole: comment.authorRole,
    createdAt: comment.createdAt.toISOString(),
  };
}

function toAnnotationResponse(ann: AnnotationRecord): AnnotationResponse {
  return {
    id: ann.id,
    feedbackId: ann.feedbackId,
    cssSelector: ann.cssSelector,
    xpath: ann.xpath,
    textSnippet: ann.textSnippet,
    elementTag: ann.elementTag,
    elementId: ann.elementId,
    textPrefix: ann.textPrefix,
    textSuffix: ann.textSuffix,
    fingerprint: ann.fingerprint,
    neighborText: ann.neighborText,
    anchorKey: ann.anchorKey ?? null,
    xPct: ann.xPct,
    yPct: ann.yPct,
    wPct: ann.wPct,
    hPct: ann.hPct,
    scrollX: ann.scrollX,
    scrollY: ann.scrollY,
    viewportW: ann.viewportW,
    viewportH: ann.viewportH,
    devicePixelRatio: ann.devicePixelRatio,
    createdAt: ann.createdAt.toISOString(),
  };
}
