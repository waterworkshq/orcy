import { mkdirSync, writeFileSync, createReadStream, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

const UPLOAD_DIR = process.env.UPLOAD_DIR || join(process.cwd(), 'uploads');

export function ensureUploadDir(): void {
  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

export function sanitizeFilename(filename: string): string {
  let result = filename.replace(/\.\./g, '').replace(/[/\\]/g, '_');
  result = result.replace(/[^a-zA-Z0-9._-]/g, '_');
  result = result.replace(/^_+/, '').replace(/_+$/, '');
  result = result.replace(/^\.+/, '').replace(/\.+$/, '');
  return result;
}

export function saveFile(id: string, filename: string, buffer: Buffer): string {
  ensureUploadDir();
  const safeName = sanitizeFilename(filename);
  const storedName = `${id}-${safeName}`;
  const filePath = join(UPLOAD_DIR, storedName);
  writeFileSync(filePath, buffer);
  return storedName;
}

export function getFilePath(storedName: string): string {
  ensureUploadDir();
  return join(UPLOAD_DIR, storedName);
}

export function readFile(storedName: string): NodeJS.ReadableStream {
  const filePath = getFilePath(storedName);
  if (!existsSync(filePath)) {
    throw new Error('File not found on disk');
  }
  return createReadStream(filePath);
}

export function deleteFile(storedName: string): void {
  const filePath = getFilePath(storedName);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
