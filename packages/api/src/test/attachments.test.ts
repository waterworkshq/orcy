import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fileStorage from '../services/fileStorage.js';
import { encodeContentDisposition } from '../middleware/attachmentAuth.js';

describe('fileStorage', () => {
  describe('sanitizeFilename', () => {
    it('allows alphanumeric, dots, dashes, underscores', () => {
      expect(fileStorage.sanitizeFilename('hello-world_test.txt')).toBe('hello-world_test.txt');
    });

    it('replaces special characters with underscores', () => {
      expect(fileStorage.sanitizeFilename('file name (1).txt')).toBe('file_name__1_.txt');
    });

    it('prevents path traversal with ..', () => {
      expect(fileStorage.sanitizeFilename('../../../etc/passwd')).toBe('etc_passwd');
    });

    it('removes leading and trailing dots', () => {
      expect(fileStorage.sanitizeFilename('..hidden..')).toBe('hidden');
    });

    it('handles empty string', () => {
      expect(fileStorage.sanitizeFilename('')).toBe('');
    });

    it('handles unicode characters', () => {
      expect(fileStorage.sanitizeFilename('documento español.pdf')).toBe('documento_espa_ol.pdf');
    });
  });
});

describe('encodeContentDisposition', () => {
  it('encodes simple ASCII filename', () => {
    const result = encodeContentDisposition('report.pdf');
    expect(result).toBe('attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf');
  });

  it('handles filenames with quotes', () => {
    const result = encodeContentDisposition('file"name.txt');
    expect(result).toContain('filename=');
    expect(result).toContain("filename*=UTF-8''file%22name.txt");
  });

  it('handles filenames with semicolons', () => {
    const result = encodeContentDisposition('file;name.txt');
    expect(result).toContain("filename*=UTF-8''file%3Bname.txt");
  });

  it('handles non-ASCII characters', () => {
    const result = encodeContentDisposition('ドキュメント.pdf');
    expect(result).toContain("filename*=UTF-8''");
    expect(result).toContain('%E3%83%89%E3%82%AD%E3%83%A5%E3%83%A1%E3%83%B3%E3%83%88');
  });

  it('handles filenames with spaces', () => {
    const result = encodeContentDisposition('my report.pdf');
    expect(result).toContain("filename*=UTF-8''my%20report.pdf");
    expect(result).toContain('filename="my_report.pdf"');
  });

  it('handles empty filename', () => {
    const result = encodeContentDisposition('');
    expect(result).toContain('filename=');
  });

  it('always includes both filename and filename* variants', () => {
    const result = encodeContentDisposition('test.pdf');
    expect(result).toMatch(/filename="/);
    expect(result).toMatch(/filename\*=UTF-8''/);
  });
});
