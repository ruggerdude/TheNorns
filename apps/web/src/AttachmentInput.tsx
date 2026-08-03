// A self-contained project attachment picker. Paste, drop, or browse for any
// file type; readable formats are extracted by the server and unknown binary
// formats remain available as durable project evidence.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  ChangeEvent as ReactChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
} from "react";
import {
  PROJECT_ATTACHMENT_ACCEPT,
  attachmentTypeLabel,
  resolvedAttachmentMime,
} from "./attachmentFiles";
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
  filename?: string;
}

export interface AttachmentInputProps {
  /** Project the attachments belong to; used to build the upload/serve/delete URLs. */
  projectId: string;
  /**
   * Controlled selection: the attachment ids currently attached. Pass these
   * straight through to `POST /planning-runs` as `attachment_ids`.
   */
  value: string[];
  /** Called with the next id list whenever a file is added or removed. */
  onChange: (ids: string[]) => void;
  /** Purpose recorded server-side (groups the per-objective cap). Default "objective". */
  purpose?: string;
  /** Max files the UI will allow (default 8, matching the server per-objective cap). */
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
  /**
   * Composer mode integrates the prompt and attachments into one control.
   * Every selected file is uploaded and retained as project evidence.
   */
  variant?: "dropzone" | "composer";
  label?: string;
  textValue?: string;
  onTextChange?: (value: string) => void;
  placeholder?: string;
  textAreaTestId?: string;
  /** Submit the containing form on Enter; Shift+Enter still inserts a line. */
  submitOnEnter?: boolean;
  /** Reports a completed upload so a parent can include metadata in its first message. */
  onUploaded?: (attachment: AttachmentDescriptor) => void;
  /** Reports a removed attachment to metadata-owning parents. */
  onRemoved?: (attachmentId: string) => void;
  /** Lets a containing form prevent submission while file uploads are active. */
  onUploadingChange?: (uploading: boolean) => void;
}

const DEFAULT_MAX = 8;
const DEFAULT_PURPOSE = "objective";

function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromFiles = Array.from(data.files ?? []);
  if (fromFiles.length > 0) return fromFiles;
  // Some paste sources expose files only through the items API.
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) fromItems.push(file);
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
  variant = "dropzone",
  label = "What should this phase deliver?",
  textValue = "",
  onTextChange,
  placeholder = "Describe the goal, paste a screenshot, or add a reference file…",
  textAreaTestId,
  submitOnEnter = false,
  onUploaded,
  onRemoved,
  onUploadingChange,
}: AttachmentInputProps) {
  // Render metadata keyed by id. `value` stays authoritative for selection;
  // this map only supplies each chip's dimensions/label.
  const [descriptors, setDescriptors] = useState<Record<string, AttachmentDescriptor>>({});
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerId = useId();

  // Prune metadata for ids the parent has dropped from the selection.
  useEffect(() => {
    setDescriptors((current) => {
      const next: Record<string, AttachmentDescriptor> = {};
      for (const id of value) if (current[id]) next[id] = current[id] as AttachmentDescriptor;
      return next;
    });
  }, [value]);

  useEffect(() => {
    onUploadingChange?.(uploading > 0);
  }, [onUploadingChange, uploading]);

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
        const mime = resolvedAttachmentMime(file);
        const res = await fetch(`/api/v2/projects/${projectId}/attachments`, {
          method: "POST",
          headers: {
            ...authHeaders(),
            "content-type": mime,
            "x-attachment-purpose": purpose,
            "x-attachment-filename": file.name,
          },
          credentials: "include",
          body: file,
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { message?: string };
          report(detail.message ?? `Upload failed (${res.status}).`);
          return null;
        }
        return {
          ...((await res.json()) as AttachmentDescriptor),
          filename: file.name,
        };
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
      const room = maxAttachments - value.length;
      if (room <= 0) {
        report(`You can attach at most ${maxAttachments} files.`);
        return;
      }
      const accepted = files.slice(0, room);
      if (accepted.length < files.length) {
        report(`You can attach at most ${maxAttachments} files.`);
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
        for (const descriptor of added) {
          if (!merged.includes(descriptor.id)) merged.push(descriptor.id);
          onUploaded?.(descriptor);
        }
        onChange(merged);
      }
    },
    [disabled, maxAttachments, onChange, onUploaded, report, uploadOne, value],
  );

  const removeOne = useCallback(
    async (id: string) => {
      if (disabled) return;
      // Optimistically drop from the selection; the DELETE is best-effort.
      onChange(value.filter((existing) => existing !== id));
      onRemoved?.(id);
      try {
        const res = await fetch(`/api/v2/projects/${projectId}/attachments/${id}`, {
          method: "DELETE",
          headers: authHeaders(),
          credentials: "include",
        });
        if (!res.ok && res.status !== 404) {
          report(`Could not remove the file (${res.status}).`);
        }
      } catch {
        report("Could not remove the file — check your connection.");
      }
    },
    [disabled, onChange, onRemoved, projectId, report, value],
  );

  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const files = filesFromDataTransfer(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      void handleFiles(files);
    }
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void handleFiles(filesFromDataTransfer(event.dataTransfer));
  };

  const onFilePicked = (event: ReactChangeEvent<HTMLInputElement>) => {
    void handleFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const picker = (
    <input
      ref={fileInputRef}
      type="file"
      accept={PROJECT_ATTACHMENT_ACCEPT}
      multiple
      hidden
      data-testid="attachment-file-input"
      onChange={onFilePicked}
    />
  );

  const chips =
    value.length > 0 ? (
      <ul className="attachment-chips" data-testid="attachment-chips">
        {value.map((id) => {
          const descriptor = descriptors[id];
          return (
            <li key={id} className="attachment-chip" data-testid="attachment-chip">
              {!descriptor || descriptor.mime.startsWith("image/") ? (
                <img
                  src={`/api/v2/projects/${projectId}/attachments/${id}`}
                  alt={
                    descriptor?.filename ??
                    (descriptor
                      ? `Attachment ${descriptor.width ?? "?"}×${descriptor.height ?? "?"}`
                      : "Attachment")
                  }
                />
              ) : (
                <span className="attachment-chip-file">
                  <span aria-hidden="true">↗</span>
                  <span>
                    <strong>{descriptor.filename ?? "Attachment"}</strong>
                    <small>{attachmentTypeLabel(descriptor.mime)}</small>
                  </span>
                </span>
              )}
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
    ) : null;

  if (variant === "composer") {
    return (
      <div className="attachment-input attachment-composer-field">
        <label className="field-label" htmlFor={composerId}>
          {label}
        </label>
        <div
          className={`prompt-composer${atCapacity ? " is-full" : ""}`}
          data-testid="attachment-dropzone"
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(event) => event.preventDefault()}
        >
          {chips}
          <textarea
            id={composerId}
            className="prompt-composer-textarea"
            data-testid={textAreaTestId}
            placeholder={placeholder}
            value={textValue}
            disabled={disabled}
            onChange={(event) => onTextChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (submitOnEnter && event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="prompt-composer-toolbar">
            <button
              type="button"
              className="composer-add-button"
              aria-label="Add images or files"
              title="Add files"
              disabled={!interactive}
              onClick={() => fileInputRef.current?.click()}
            >
              <span aria-hidden="true">+</span>
            </button>
            <span className="composer-help">Paste, drop, or add any file</span>
            {uploading > 0 ? <Spinner label={`Uploading ${uploading} file(s)…`} /> : null}
          </div>
          {picker}
        </div>
        {error && !hideInlineError ? <Alert testId="attachment-error">{error}</Alert> : null}
      </div>
    );
  }

  return (
    <div className="attachment-input">
      <div
        className={`attachment-dropzone${atCapacity ? " is-full" : ""}`}
        data-testid="attachment-dropzone"
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
        aria-label="Attach files: paste, drop, or browse"
      >
        <p className="attachment-hint">
          {atCapacity
            ? `Attachment limit reached (${maxAttachments}).`
            : "Paste, drop any file, or"}
        </p>
        {!atCapacity && (
          <Button
            type="button"
            variant="ghost"
            disabled={!interactive}
            onClick={() => fileInputRef.current?.click()}
          >
            Browse files
          </Button>
        )}
        {picker}
      </div>

      {chips}

      {uploading > 0 && <Spinner label={`Uploading ${uploading} file(s)…`} />}
      {error && !hideInlineError && <Alert testId="attachment-error">{error}</Alert>}
    </div>
  );
}
