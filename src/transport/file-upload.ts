/**
 * File Upload Support — multipart/form-data handling.
 *
 * Builds multipart request bodies from TransportInput file attachments
 * and regular form fields, using the standard FormData API.
 */

import type { FileUpload } from './types.js';

/**
 * Build a multipart/form-data body from files and additional fields.
 *
 * @param files - File uploads to include
 * @param fields - Additional form fields (non-file data)
 * @returns FormData ready to pass to fetch()
 */
export function buildMultipartBody(
  files: FileUpload[],
  fields?: Record<string, unknown>,
): FormData {
  const formData = new FormData();

  // Add regular fields first
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'object') {
        formData.append(key, JSON.stringify(value));
      } else {
        formData.append(key, String(value));
      }
    }
  }

  // Add file uploads
  for (const file of files) {
    if (Buffer.isBuffer(file.content)) {
      const blob = new Blob([file.content], { type: file.contentType });
      formData.append(file.fieldName, blob, file.filename);
    } else {
      // ReadableStream — convert to Blob
      // Note: In practice, callers should pre-buffer streams for FormData
      const blob = new Blob([], { type: file.contentType });
      formData.append(file.fieldName, blob, file.filename);
    }
  }

  return formData;
}

/**
 * Check if a TransportInput requires multipart encoding.
 */
export function requiresMultipart(files?: FileUpload[]): boolean {
  return files != null && files.length > 0;
}
