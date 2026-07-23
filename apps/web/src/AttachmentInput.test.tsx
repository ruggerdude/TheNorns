// FRONT DOOR P4 (D3): AttachmentInput unit tests — paste-to-upload, thumbnail
// render, and remove — over the existing MockFetch stub. The component is
// controlled, so a tiny stateful harness mirrors how Phase 1 will drive it.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentInput } from "./AttachmentInput";
import { MockFetch } from "./test/mockFetch";

function pngFile(name = "shot.png"): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([bytes], name, { type: "image/png" });
}

function Harness({ initial = [] as string[] }: { initial?: string[] }) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <>
      <AttachmentInput projectId="p1" value={value} onChange={setValue} />
      <output data-testid="selected-ids">{value.join(",")}</output>
    </>
  );
}

const UPLOAD_URL = "/api/v2/projects/p1/attachments";

describe("AttachmentInput (FRONT DOOR P4)", () => {
  let fetchMock: MockFetch;

  beforeEach(() => {
    fetchMock = new MockFetch();
    fetchMock.install();
  });

  afterEach(() => {
    fetchMock.restore();
  });

  it("uploads a pasted image and renders a thumbnail chip", async () => {
    fetchMock.post(UPLOAD_URL, {
      status: 201,
      body: { id: "att_1", mime: "image/png", bytes: 8, width: 1, height: 1, purpose: "objective" },
    });

    render(<Harness />);
    fireEvent.paste(screen.getByTestId("attachment-dropzone"), {
      clipboardData: { files: [pngFile()], items: [] },
    });

    // The upload sends the raw File with its real media type — no base64 expansion.
    await waitFor(() => {
      expect(
        fetchMock.calls.some((call) => call.method === "POST" && call.url === UPLOAD_URL),
      ).toBe(true);
    });
    const post = fetchMock.calls.find((call) => call.method === "POST" && call.url === UPLOAD_URL);
    expect(post?.body).toBeInstanceOf(File);
    expect((post?.body as File).type).toBe("image/png");
    expect(post?.headers["content-type"]).toBe("image/png");
    expect(post?.headers["x-attachment-purpose"]).toBe("objective");

    // ...and the returned id is now selected and rendered as a thumbnail.
    await waitFor(() => {
      expect(screen.getByTestId("selected-ids")).toHaveTextContent("att_1");
    });
    const chips = screen.getAllByTestId("attachment-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.querySelector("img")?.getAttribute("src")).toContain(
      "/api/v2/projects/p1/attachments/att_1",
    );
  });

  it("uploads an image chosen through the file picker", async () => {
    fetchMock.post(UPLOAD_URL, {
      status: 201,
      body: { id: "att_2", mime: "image/png", bytes: 8, width: 2, height: 2, purpose: "objective" },
    });

    render(<Harness />);
    fireEvent.change(screen.getByTestId("attachment-file-input"), {
      target: { files: [pngFile("picked.png")] },
    });

    await waitFor(() => {
      expect(screen.getByTestId("selected-ids")).toHaveTextContent("att_2");
    });
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);
  });

  it("renders a thumbnail for a pre-selected attachment id", () => {
    render(<Harness initial={["att_9"]} />);
    const chip = screen.getByTestId("attachment-chip");
    expect(chip.querySelector("img")?.getAttribute("src")).toContain(
      "/api/v2/projects/p1/attachments/att_9",
    );
    expect(screen.getByRole("button", { name: "Remove attachment" })).toBeInTheDocument();
  });

  it("removes an attachment: DELETEs it and drops the chip", async () => {
    fetchMock.del(/\/api\/v2\/projects\/p1\/attachments\/att_9$/, { status: 204 });

    render(<Harness initial={["att_9"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));

    await waitFor(() => {
      expect(screen.queryByTestId("attachment-chip")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("selected-ids")).toHaveTextContent("");
    expect(
      fetchMock.calls.some(
        (call) => call.method === "DELETE" && call.url.endsWith("/attachments/att_9"),
      ),
    ).toBe(true);
  });

  it("rejects a non-image paste without uploading", async () => {
    render(<Harness />);
    const textFile = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.paste(screen.getByTestId("attachment-dropzone"), {
      clipboardData: { files: [textFile], items: [] },
    });

    // No image parts extracted -> nothing posted.
    await Promise.resolve();
    expect(fetchMock.calls.some((call) => call.method === "POST")).toBe(false);
    expect(screen.queryByTestId("attachment-chip")).not.toBeInTheDocument();
  });
});
