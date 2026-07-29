-- General-purpose, model-readable conversation attachments.
--
-- Raw bytes remain content-addressed in attachment_blobs. Textual files and
-- PDFs gain a bounded, immutable derived-text representation so provider
-- context never depends on reparsing a mutable external file.

ALTER TABLE attachments
  DROP CONSTRAINT attachments_mime_check,
  DROP CONSTRAINT attachments_bytes_check;

ALTER TABLE attachments
  ADD COLUMN original_filename TEXT NOT NULL DEFAULT 'attachment',
  ADD COLUMN extracted_text TEXT,
  ADD COLUMN extracted_text_sha256 TEXT,
  ADD COLUMN extraction_truncated BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE attachments
  ADD CONSTRAINT attachments_mime_check CHECK (
    mime IN (
      'image/png','image/jpeg','image/webp','image/gif',
      'text/plain','text/markdown','application/json','text/csv','application/pdf'
    )
  ),
  ADD CONSTRAINT attachments_bytes_check CHECK (
    bytes > 0 AND (
      (mime IN ('image/png','image/jpeg','image/webp','image/gif') AND bytes <= 3145728)
      OR
      (mime IN ('text/plain','text/markdown','application/json','text/csv')
        AND bytes <= 2097152)
      OR
      (mime='application/pdf' AND bytes <= 10485760)
    )
  ),
  ADD CONSTRAINT attachments_original_filename_check CHECK (
    length(original_filename) BETWEEN 1 AND 255
    AND original_filename !~ '[[:cntrl:]/\\]'
  ),
  ADD CONSTRAINT attachments_extracted_content_check CHECK (
    (
      mime IN ('image/png','image/jpeg','image/webp','image/gif')
      AND extracted_text IS NULL
      AND extracted_text_sha256 IS NULL
      AND extraction_truncated=false
    )
    OR
    (
      mime IN ('text/plain','text/markdown','application/json','text/csv','application/pdf')
      AND extracted_text IS NOT NULL
      AND length(extracted_text) BETWEEN 1 AND 200000
      AND extracted_text_sha256 ~ '^[0-9a-f]{64}$'
      AND width IS NULL
      AND height IS NULL
    )
  );
