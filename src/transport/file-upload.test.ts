/**
 * Feature: File Upload Support
 *
 * Builds multipart/form-data bodies from file attachments and form fields.
 */

import { describe, it, expect } from 'vitest';
import { buildMultipartBody, requiresMultipart } from './file-upload.js';

describe('Feature: Multipart Body Building', () => {
  describe('Scenario: Build FormData with file uploads', () => {
    it('Given a Buffer file upload, When buildMultipartBody is called, Then FormData contains the file', () => {
      const files = [{
        fieldName: 'avatar',
        content: Buffer.from('image-data'),
        filename: 'avatar.png',
        contentType: 'image/png',
      }];

      const formData = buildMultipartBody(files);

      expect(formData.get('avatar')).toBeTruthy();
    });
  });

  describe('Scenario: Build FormData with additional fields', () => {
    it('Given fields and files, When buildMultipartBody is called, Then both are included in FormData', () => {
      const files = [{
        fieldName: 'file',
        content: Buffer.from('data'),
        filename: 'test.txt',
        contentType: 'text/plain',
      }];
      const fields = { name: 'test-name', count: 42 };

      const formData = buildMultipartBody(files, fields);

      expect(formData.get('name')).toBe('test-name');
      expect(formData.get('count')).toBe('42');
      expect(formData.get('file')).toBeTruthy();
    });
  });

  describe('Scenario: Object fields are JSON-stringified', () => {
    it('Given an object field value, When buildMultipartBody is called, Then it is JSON-stringified', () => {
      const formData = buildMultipartBody([], {
        metadata: { key: 'value' },
      });

      expect(formData.get('metadata')).toBe('{"key":"value"}');
    });
  });

  describe('Scenario: Null and undefined fields are skipped', () => {
    it('Given null/undefined field values, When buildMultipartBody is called, Then they are excluded', () => {
      const formData = buildMultipartBody([], {
        present: 'yes',
        absent: null,
        missing: undefined,
      });

      expect(formData.get('present')).toBe('yes');
      expect(formData.get('absent')).toBeNull();
      expect(formData.get('missing')).toBeNull();
    });
  });

  describe('Scenario: Multiple file uploads', () => {
    it('Given multiple files, When buildMultipartBody is called, Then all files are included', () => {
      const files = [
        { fieldName: 'file1', content: Buffer.from('a'), filename: 'a.txt', contentType: 'text/plain' },
        { fieldName: 'file2', content: Buffer.from('b'), filename: 'b.txt', contentType: 'text/plain' },
      ];

      const formData = buildMultipartBody(files);

      expect(formData.get('file1')).toBeTruthy();
      expect(formData.get('file2')).toBeTruthy();
    });
  });

  describe('Scenario: Empty files array', () => {
    it('Given no files and no fields, When buildMultipartBody is called, Then an empty FormData is returned', () => {
      const formData = buildMultipartBody([]);
      // FormData is valid but empty
      expect(formData).toBeInstanceOf(FormData);
    });
  });
});

describe('Feature: Multipart Detection', () => {
  describe('Scenario: Files present', () => {
    it('Given a non-empty files array, When requiresMultipart is called, Then it returns true', () => {
      expect(requiresMultipart([{
        fieldName: 'f',
        content: Buffer.from('x'),
        filename: 'x.bin',
        contentType: 'application/octet-stream',
      }])).toBe(true);
    });
  });

  describe('Scenario: No files', () => {
    it('Given undefined files, When requiresMultipart is called, Then it returns false', () => {
      expect(requiresMultipart(undefined)).toBe(false);
    });

    it('Given an empty files array, When requiresMultipart is called, Then it returns false', () => {
      expect(requiresMultipart([])).toBe(false);
    });

    it('Given null, When requiresMultipart is called, Then it returns false', () => {
      expect(requiresMultipart(null as unknown as undefined)).toBe(false);
    });
  });
});
