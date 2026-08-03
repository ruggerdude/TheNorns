const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const TEXT_FILE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "log",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

/** The browser picker remains open to every file type. Unknown binary formats
 * are stored as octet-stream so they remain available as project evidence. */
export const PROJECT_ATTACHMENT_ACCEPT = "*/*";

export function resolvedAttachmentMime(file: File): string {
  const declared = file.type.trim().toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (IMAGE_MIMES.has(declared)) return declared;
  if (declared === "application/pdf" || extension === "pdf") return "application/pdf";
  if (declared === "application/json" || extension === "json") return "application/json";
  if (declared === "text/csv" || extension === "csv") return "text/csv";
  if (declared === "text/markdown" || extension === "md" || extension === "markdown") {
    return "text/markdown";
  }
  if (declared.startsWith("text/") || extension === "txt" || TEXT_FILE_EXTENSIONS.has(extension)) {
    return "text/plain";
  }
  return "application/octet-stream";
}

export function attachmentTypeLabel(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType === "application/json") return "JSON";
  if (mimeType === "text/markdown") return "Markdown";
  if (mimeType === "text/csv") return "CSV";
  if (mimeType.startsWith("text/")) return "Text file";
  return "File";
}
