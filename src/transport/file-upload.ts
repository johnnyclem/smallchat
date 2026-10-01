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
    if (!Buffer.isBuffer(file.content)) {
      // Never send an empty placeholder for a stream (silent data loss).
      throw new TypeError(
        `File "${file.filename}" is a ReadableStream; read it first with bufferFileUploads() (HttpTransport does this)`,
      );
    }
    const blob = new Blob([file.content], { type: file.contentType });
    formData.append(file.fieldName, blob, file.filename);
  }

  return formData;
}

/** Default cap for buffering a streamed upload: 50 MiB. */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Read every ReadableStream upload into a Buffer, so the multipart body
 * carries the whole file (and can be re-sent on a retry). Rejects, after
 * cancelling the stream, if one upload exceeds `maxBytes`.
 */
export async function bufferFileUploads(
  files: FileUpload[],
  maxBytes: number = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<FileUpload[]> {
  return Promise.all(files.map(async (file) => {
    if (Buffer.isBuffer(file.content)) return file;
    const reader = file.content.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RangeError(`File "${file.filename}" exceeds the ${maxBytes} bytes upload limit`);
      }
      chunks.push(value);
    }
    return { ...file, content: Buffer.concat(chunks) };
  }));
}

/**
 * Check if a TransportInput requires multipart encoding.
 */
export function requiresMultipart(files?: FileUpload[]): boolean {
  return files != null && files.length > 0;
}
