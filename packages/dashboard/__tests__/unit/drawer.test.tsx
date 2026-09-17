// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Drawer } from "../../src/components/drawer.js";
import { makeRecord } from "../helpers.js";
import { renderWithUi } from "../render.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDrawer(recordOverrides = {}, commentProps: Partial<ComponentProps<typeof Drawer>> = {}) {
  const record = makeRecord(recordOverrides);
  const onAddComment = vi.fn<(id: string, body: string) => Promise<void>>().mockResolvedValue(undefined);
  const onDeleteComment = vi.fn<(id: string, commentId: string) => Promise<void>>().mockResolvedValue(undefined);
  const { container } = renderWithUi(
    <Drawer
      record={record}
      overlay={false}
      deepLinkParam="siteping"
      onClose={vi.fn()}
      onChangeStatus={vi.fn()}
      onDelete={vi.fn()}
      canComment={false}
      onAddComment={onAddComment}
      onDeleteComment={onDeleteComment}
      {...commentProps}
    />,
  );
  return { record, container, onAddComment, onDeleteComment };
}

describe("Drawer — author line", () => {
  it("renders the author email in angle brackets when present", () => {
    const { container } = renderDrawer({ authorName: "Alex Client", authorEmail: "alex@client.example" });
    const author = container.querySelector(".spd-meta-value");
    expect(author?.textContent).toContain("Alex Client");
    expect(author?.textContent).toContain("<alex@client.example>");
  });

  it("renders no empty '<>' shell when authorEmail is redacted to an empty string", () => {
    const { container } = renderDrawer({ authorName: "Alex Client", authorEmail: "" });
    const author = container.querySelector(".spd-meta-value");
    expect(author?.textContent).toContain("Alex Client");
    expect(author?.textContent).not.toContain("<>");
  });
});
