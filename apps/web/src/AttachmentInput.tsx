// FRONT DOOR P4 (D3): a self-contained image-attachment picker for project
// objectives. Paste a screenshot, drop a file, or browse — each image is
// uploaded to the project's attachment routes and surfaced as a removable
// thumbnail chip. The component is deliberately isolated: it is NOT mounted
// anywhere here. Phase 1 owns the objective form and mounts this, driving it
// through the documented props below (`value` / `onChange` are the selected
// attachment-id contract the planning-run request consumes as `attachment_ids`).
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChangeEvent as ReactChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
} from "react";
import { authHeaders } from "./auth";
import { Alert, Button, Spinner } from "./ui";

/** The image types accepted end-to-end (mirrors the server mime allow-list). */
export const ATTACHMENT_ACCEPTED_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/** Metadata for one stored attachment, as returned by the upload route. */
export interface AttachmentDescriptor {
  id: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  purpose: string;
}

export interface AttachmentInputProps {
  /** Project the attachments belong to; used to build the upload/serve/delete URLs. */
  projectId: string;
  /**
   * Controlled selection: the attachment ids currently attached. Pass these
   * straight through to `POST /planning-runs` as `attachment_ids`.
   */
  value: string[];
  /** Called with the next id list whenever an image is added or removed. */
  onChange: (ids: string[]) => void;
  /** Purpose recorded server-side (groups the per-objective cap). Default "objective". */
  purpose?: string;
  /** Max images the UI will allow (default 8, matching the server per-objective cap). */
  maxAttachments?: number;
  /** Disable all interaction (e.g. while the parent form is submitting). */
  disabled?: boolean;
  /**
   * Optional error sink. When provided, upload/delete failures are reported
   * here in addition to the component's own inline notice; parents that render
   * their own alert can suppress the inline one with `hideInlineError`.
   */
  onError?: (message: string) => void;
  /** Suppress the built-in inline error <Alert> (use with `onError`). */
  hideInlineError?: boolean;
}

const DEFAULT_MAX = 8;
const DEFAULT_PURPOSE = "objective";

function isAcceptedImage(file: File): boolean {
  return (ATTACHMENT_ACCEPTED_MIMES as readonly string[]).includes(file.type);
}

/** File -> base64 (no data-URI prefix). Uses arrayBuffer()+btoa so it behaves
 *  identically in the browser and jsdom (no FileReader/ObjectURL dependence). */
async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

function imagesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromFiles = Array.from(data.files ?? []);
  if (fromFiles.length > 0) return fromFiles.filter(isAcceptedImage);
  // Some paste sources expose images only through the items API.
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file && isAcceptedImage(file)) fromItems.push(file);
    }
  }
  return fromItems;
}

export function AttachmentInput({
  projectId,
  value,
  onChange,
  purpose = DEFAULT_PURPOSE,
  maxAttachments = DEFAULT_MAX,
  disabled = false,
  onError,
  hideInlineError = false,
}: AttachmentInputProps) {
  // Render metadata keyed by id. `value` stays authoritative for selection;
  // this map only supplies each chip's dimensions/label.
  const [descriptors, setDescriptors] = useState<Record<string, AttachmentDescriptor>>({});
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Prune metadata for ids the parent has dropped from the selection.
  useEffect(() => {
    setDescriptors((current) => {
      const next: Record<string, AttachmentDescriptor> = {};
      for (const id of value) if (current[id]) next[id] = current[id] as AttachmentDescriptor;
      return next;
    });
  }, [value]);

  const report = useCallback(
    (message: string) => {
      setError(message);
      onError?.(message);
    },
    [onError],
  );

  const remaining = maxAttachments - value.length;
  const atCapacity = remaining <= 0;
  const interactive = !disabled && uploading === 0;

  const uploadOne = useCallback(
    async (file: File): Promise<AttachmentDescriptor | null> => {
      try {
        const base64 = await fileToBase64(file);
        const res = await fetch(`/api/v2/projects/${projectId}/attachments`, {
          method: "POST",
          headers: authHeaders(true),
          credentials: "include",
          body: JSON.stringify({ mime: file.type, base64, purpose }),
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { message?: string };
          report(detail.message ?? `Upload failed (${res.status}).`);
          return null;
        }
        return (await res.json()) as AttachmentDescriptor;
      } catch {
        report("Upload failed — check your connection and try again.");
        return null;
      }
    },
    [projectId, purpose, report],
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (disabled || files.length === 0) return;
      setError(null);
      const images = files.filter(isAcceptedImage);
      if (images.length < files.length) {
        report("Only PNG, JPEG, WebP, or GIF images can be attached.");
      }
      const room = maxAttachments - value.length;
      if (room <= 0) {
        report(`You can attach at most ${maxAttachments} images.`);
        return;
      }
      const accepted = images.slice(0, room);
      if (accepted.length < images.length) {
        report(`You can attach at most ${maxAttachments} images.`);
      }

      setUploading((n) => n + accepted.length);
      const added: AttachmentDescriptor[] = [];
      try {
        for (const file of accepted) {
          const descriptor = await uploadOne(file);
          if (descriptor) added.push(descriptor);
        }
      } finally {
        setUploading((n) => Math.max(0, n - accepted.length));
      }
      if (added.length > 0) {
        setDescriptors((current) => {
          const next = { ...current };
          for (const descriptor of added) next[descriptor.id] = descriptor;
          return next;
        });
        // Dedupe: the server returns the existing id for identical content.
        const merged = [...value];
        for (const descriptor of added)
          if (!merged.includes(descriptor.id)) merged.push(descriptor.id);
        onChange(merged);
      }
    },
    [disabled, maxAttachments, onChange, report, uploadOne, value],
  );

  const removeOne = useCallback(
    async (id: string) => {
      if (disabled) return;
      // Optimistically drop from the selection; the DELETE is best-effort.
      onChange(value.filter((existing) => existing !== id));
      try {
        const res = await fetch(`/api/v2/projects/${projectId}/attachments/${id}`, {
          method: "DELETE",
          headers: authHeaders(),
          credentials: "include",
        });
        if (!res.ok && res.status !== 404) {
          report(`Could not remove the image (${res.status}).`);
        }
      } catch {
        report("Could not remove the image — check your connection.");
      }
    },
    [disabled, onChange, projectId, report, value],
  );

  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const images = imagesFromDataTransfer(event.clipboardData);
    if (images.length > 0) {
      event.preventDefault();
      void handleFiles(images);
    }
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void handleFiles(imagesFromDataTransfer(event.dataTransfer));
  };

  const onFilePicked = (event: ReactChangeEvent<HTMLInputElement>) => {
    void handleFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  return (
    <div className="attachment-input">
      <div
        className={`attachment-dropzone${atCapacity ? " is-full" : ""}`}
        data-testid="attachment-dropzone"
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
        aria-label="Attach images: paste, drop, or browse"
      >
        <p className="attachment-hint">
          {atCapacity
            ? `Attachment limit reached (${maxAttachments}).`
            : "Paste a screenshot, drop an image, or"}
        </p>
        {!atCapacity && (
          <Button
            type="button"
            variant="ghost"
            disabled={!interactive}
            onClick={() => fileInputRef.current?.click()}
          >
            Browse images
          </Button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPTED_MIMES.join(",")}
          multiple
          hidden
          data-testid="attachment-file-input"
          onChange={onFilePicked}
        />
      </div>

      {value.length > 0 && (
        <ul className="attachment-chips" data-testid="attachment-chips">
          {value.map((id) => {
            const descriptor = descriptors[id];
            return (
              <li key={id} className="attachment-chip" data-testid="attachment-chip">
                <img
                  src={`/api/v2/projects/${projectId}/attachments/${id}`}
                  alt={
                    descriptor
                      ? `Attachment ${descriptor.width ?? "?"}×${descriptor.height ?? "?"}`
                      : "Attachment"
                  }
                />
                <button
                  type="button"
                  className="attachment-chip-remove"
                  aria-label="Remove attachment"
                  disabled={disabled}
                  onClick={() => void removeOne(id)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {uploading > 0 && <Spinner label={`Uploading ${uploading} image(s)…`} />}
      {error && !hideInlineError && <Alert testId="attachment-error">{error}</Alert>}
    </div>
  );
}
