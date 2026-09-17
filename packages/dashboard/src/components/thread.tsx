import type { CommentRecord, FeedbackRecord } from "@siteping/core";
import { isUnsupported } from "@siteping/core";
import type { ReactElement, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useState } from "react";
import { formatAbsolute } from "../format.js";
import { useInboxUi } from "./context.js";
import { ChatIcon, SendIcon, TrashIcon } from "./icons.js";

interface ThreadProps {
  record: FeedbackRecord;
  /** False when no `author` is configured, or the source cannot post — the thread renders read-only. */
  canComment: boolean;
  onAdd: (body: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
}

/**
 * Discussion thread on the opened feedback: the client's replies from the
 * widget and the team's from here, oldest first, plus a composer.
 *
 * Posting is awaited rather than optimistic — the hook appends the persisted
 * record, so what is on screen is what the store has.
 */
export function Thread({ record, canComment, onAdd, onDelete }: ThreadProps): ReactElement {
  const { t, locale } = useInboxUi();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  /**
   * Set when the backend answers "no comments here" (HTTP 501, or a store
   * without `addComment` behind a custom source). Sticky: the answer cannot
   * change without a redeploy, so the composer goes away instead of
   * inviting the same refusal again.
   */
  const [unsupported, setUnsupported] = useState(false);

  const submit = async (): Promise<void> => {
    const text = body.trim();
    if (sending || text.length === 0) return;
    setSending(true);
    setFailed(false);
    try {
      await onAdd(text);
      setBody("");
    } catch (error) {
      if (isUnsupported(error)) setUnsupported(true);
      else setFailed(true);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter alone keeps inserting newlines — a reply is often several lines.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section className="spd-thread-section">
      <div className="spd-meta-label">
        <ChatIcon /> {t("comments.title")} · {record.comments.length}
      </div>
      {record.comments.length === 0 ? (
        <p className="spd-thread-empty">{t("comments.empty")}</p>
      ) : (
        <div className="spd-thread">
          {record.comments.map((comment: CommentRecord) => (
            <article className="spd-comment" key={comment.id} data-role={comment.authorRole}>
              <div className="spd-comment-head">
                <span className="spd-comment-author">{comment.authorName}</span>
                <span className="spd-comment-role">
                  {t(comment.authorRole === "team" ? "comments.roleTeam" : "comments.roleClient")}
                </span>
                <time className="spd-comment-date" dateTime={comment.createdAt.toISOString()}>
                  {formatAbsolute(comment.createdAt, locale)}
                </time>
                {canComment ? (
                  <button
                    type="button"
                    className="spd-icon-btn spd-comment-del"
                    aria-label={t("comments.delete")}
                    // The hook rethrows after reporting through `onError`;
                    // surface it inline instead of leaving it unhandled.
                    onClick={() => {
                      void onDelete(comment.id).catch((error: unknown) => {
                        if (isUnsupported(error)) setUnsupported(true);
                        else setFailed(true);
                      });
                    }}
                  >
                    <TrashIcon />
                  </button>
                ) : null}
              </div>
              <p className="spd-comment-body">{comment.body}</p>
            </article>
          ))}
        </div>
      )}
      {canComment && !unsupported ? (
        <div className="spd-comment-form">
          <textarea
            className="spd-comment-input"
            value={body}
            maxLength={5000}
            placeholder={t("comments.placeholder")}
            aria-label={t("comments.placeholder")}
            disabled={sending}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="spd-comment-form-foot">
            <span>{t("comments.hint")}</span>
            <button type="button" className="spd-btn-primary" disabled={sending} onClick={() => void submit()}>
              <SendIcon />
              {sending ? t("comments.sending") : t("comments.submit")}
            </button>
          </div>
        </div>
      ) : null}
      {failed ? (
        <p className="spd-comment-error" role="alert">
          {t("comments.error")}
        </p>
      ) : null}
    </section>
  );
}
