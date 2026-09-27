import crypto from 'crypto';
import path from 'path';

// ============================================================================
// REUSABLE FILE UPLOAD & ASSET SAFETY MODULE
// Designed for reuse across:
// - MyDigitAsset (PDF dossiers, executive briefs, cover thumbnails)
// - MyMoneyLuck (PDF statements, verification docs)
// - MyJobGrowth (PDF/DOCX resumes, user portfolios)
// - MyFlixAI (Video clips, audio tracks, thumbnail images)
// ============================================================================

export interface FileValidationResult {
  valid: boolean;
  sanitizedFilename?: string;
  error?: string;
  detectedType?: string;
}

// Magic bytes signatures for content validation
const FILE_SIGNATURES: Record<string, number[][]> = {
  pdf: [[0x25, 0x50, 0x44, 0x46]], // %PDF
  png: [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  jpg: [
    [0xFF, 0xD8, 0xFF, 0xE0],
    [0xFF, 0xD8, 0xFF, 0xE1],
    [0xFF, 0xD8, 0xFF, 0xEE],
    [0xFF, 0xD8, 0xFF, 0xDB],
  ],
  mp4: [
    [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70],
    [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70],
  ],
  docx: [[0x50, 0x4B, 0x03, 0x04]], // Zip archive signature used by docx
};

/**
 * Validate file buffer against magic bytes and generate a secure random filename
 */
export function validateUploadFile(
  buffer: Buffer,
  originalFilename: string,
  allowedExtensions: string[],
  maxSizeBytes: number = 25 * 1024 * 1024 // 25 MB default limit
): FileValidationResult {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'Empty file payload' };
  }

  if (buffer.length > maxSizeBytes) {
    return {
      valid: false,
      error: `File size exceeds maximum allowed threshold of ${(maxSizeBytes / (1024 * 1024)).toFixed(1)} MB`,
    };
  }

  // Prevent directory traversal in filename
  const cleanBase = path.basename(originalFilename).toLowerCase();
  const ext = cleanBase.split('.').pop() || '';

  if (!allowedExtensions.includes(ext)) {
    return {
      valid: false,
      error: `File type .${ext} is not allowed. Permitted types: ${allowedExtensions.join(', ')}`,
    };
  }

  // Verify actual file magic bytes signature
  const expectedSignatures = FILE_SIGNATURES[ext];
  if (expectedSignatures) {
    const matchesSignature = expectedSignatures.some((sig) => {
      if (buffer.length < sig.length) return false;
      return sig.every((byte, idx) => buffer[idx] === byte);
    });

    if (!matchesSignature) {
      return {
        valid: false,
        error: `File contents do not match expected binary signature for .${ext}`,
      };
    }
  }

  // Generate cryptographically random, unguessable filename
  const safeRandomId = crypto.randomBytes(16).toString('hex');
  const sanitizedFilename = `${safeRandomId}.${ext}`;

  return {
    valid: true,
    sanitizedFilename,
    detectedType: ext,
  };
}
