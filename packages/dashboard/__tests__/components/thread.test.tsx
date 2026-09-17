// @vitest-environment jsdom

import { SitepingUnsupportedError } from "@siteping/core";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Thread } from "../../src/components/thread.js";
import { makeComment, makeRecord } from "../helpers.js";
import { renderWithUi } from "../render.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderThread(options?: {
  canComment?: boolean;
  comments?: ReturnType<typeof makeComment>[];
  onAdd?: (body: string) => Promise<void>;
  onDelete?: (commentId: string) => Promise<void>;
}) {
  const onAdd = options?.onAdd ?? vi.fn<(body: string) => Promise<void>>().mockResolvedValue(undefined);
  const onDelete = options?.onDelete ?? vi.fn<(commentId: string) => Promise<void>>().mockResolvedValue(undefined);
  const record = makeRecord({ id: "fb-1", comments: options?.comments ?? [] });
  const { container } = renderWithUi(
    <Thread record={record} canComment={options?.canComment ?? true} onAdd={onAdd} onDelete={onDelete} />,
  );
  return { container, onAdd, onDelete };
}

describe("Thread — rendering", () => {
  it("shows each reply with its author, role chip and body", () => {
    const { container } = renderThread({
      comments: [
        makeComment({ id: "cm-1", body: "Still happening", authorName: "Alex Client", authorRole: "client" }),
        makeComment({ id: "cm-2", body: "Fixed in 1.4.2", authorName: "Dana Dev", authorRole: "team" }),
      ],
    });

    const items = container.querySelectorAll(".spd-comment");
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute("data-role")).toBe("client");
    expect(items[0]?.querySelector(".spd-comment-author")?.textContent).toBe("Alex Client");
    expect(items[0]?.querySelector(".spd-comment-role")?.textContent).toBe("Client");
    expect(items[1]?.querySelector(".spd-comment-role")?.textContent).toBe("Team");
    expect(items[1]?.querySelector(".spd-comment-body")?.textContent).toBe("Fixed in 1.4.2");
  });

  it("shows the empty state when the thread has no replies", () => {
    const { container } = renderThread();
    expect(container.querySelector(".spd-thread-empty")?.textContent).toBe("No replies yet.");
  });

  it("hides the composer and the delete buttons when replying is unavailable", () => {
    const { container } = renderThread({ canComment: false, comments: [makeComment()] });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector(".spd-comment-del")).toBeNull();
    // The thread itself stays readable.
    expect(container.querySelector(".spd-comment-body")).not.toBeNull();
  });
});

describe("Thread — posting", () => {
  it("sends the trimmed body and clears the field", async () => {
    const { container, onAdd } = renderThread();
    const input = container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "  A reply  " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("A reply"));
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("sends on Cmd/Ctrl+Enter but not on a bare Enter", async () => {
    const { container, onAdd } = renderThread();
    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "A reply" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
  });

  it("ignores an empty submission", () => {
    const { container, onAdd } = renderThread();
    fireEvent.change(container.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("keeps the typed text and shows an inline error when the post fails", async () => {
    const onAdd = vi.fn<(body: string) => Promise<void>>().mockRejectedValue(new Error("network down"));
    const { container } = renderThread({ onAdd });
    const input = container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "A reply" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Could not post your reply"));
    expect(input.value).toBe("A reply");
  });

  it("drops the composer for good when the backend reports it cannot store comments", async () => {
    const onAdd = vi
      .fn<(body: string) => Promise<void>>()
      .mockRejectedValue(new SitepingUnsupportedError("Failed to post comment: 501"));
    const { container } = renderThread({ onAdd, comments: [makeComment()] });

    fireEvent.change(container.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "A reply" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(container.querySelector("textarea")).toBeNull());
    expect(container.querySelector(".spd-comment-body")).not.toBeNull();
    // No error banner — this is a capability answer, not a failure.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Thread — deleting", () => {
  it("deletes the clicked reply", async () => {
    const { onDelete } = renderThread({ comments: [makeComment({ id: "cm-7" })] });

    fireEvent.click(screen.getByRole("button", { name: "Delete reply" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("cm-7"));
  });

  it("surfaces a failed delete inline instead of leaving it unhandled", async () => {
    const onDelete = vi.fn<(commentId: string) => Promise<void>>().mockRejectedValue(new Error("nope"));
    renderThread({ comments: [makeComment()], onDelete });

    fireEvent.click(screen.getByRole("button", { name: "Delete reply" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Could not post your reply"));
  });
});
