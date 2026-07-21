// FRONT DOOR P4 (D3): image attachments module — public surface.
export {
  ATTACHMENT_CAPS,
  DEFAULT_ATTACHMENT_PURPOSE,
  AttachmentService,
  AttachmentValidationError,
  AttachmentLookupError,
  type AttachmentContent,
  type AttachmentDto,
  type AttachmentLookupCode,
  type AttachmentServiceOptions,
  type AttachmentValidationCode,
  type CreateAttachmentInput,
} from "./service.js";
export {
  ALLOWED_IMAGE_MIMES,
  type AttachmentImageMime,
  type DetectedImage,
  isAllowedImageMime,
  sniffImage,
} from "./imageMeta.js";
