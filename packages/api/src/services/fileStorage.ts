import { mkdirSync, writeFileSync, createReadStream, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { notFound } from "../errors.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR || join(process.cwd(), "uploads");

/** Creates the configured upload directory if it does not already exist. */
export function ensureUploadDir(): void {
  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

/** Strips path separators and unsafe characters from a user-supplied filename so it can be stored safely on disk. */
export function sanitizeFilename(filename: string): string {
  let result = filename.replace(/\.\./g, "").replace(/[/\\]/g, "_");
  result = result.replace(/[^a-zA-Z0-9._-]/g, "_");
  result = result.replace(/^_+/, "").replace(/_+$/, "");
  result = result.replace(/^\.+/, "").replace(/\.+$/, "");
  return result;
}

/** Writes the buffer to disk under a prefixed stored name and returns that name for later retrieval. */
export function saveFile(id: string, filename: string, buffer: Buffer): string {
  ensureUploadDir();
  const safeName = sanitizeFilename(filename);
  const storedName = `${id}-${safeName}`;
  const filePath = join(UPLOAD_DIR, storedName);
  writeFileSync(filePath, buffer);
  return storedName;
}

/** Resolves the on-disk absolute path for a previously stored file name, ensuring the upload directory exists. */
export function getFilePath(storedName: string): string {
  ensureUploadDir();
  return join(UPLOAD_DIR, storedName);
}

/** Opens a streaming read handle for a stored file, throwing a not-found error if it is missing. */
export function readFile(storedName: string): NodeJS.ReadableStream {
  const filePath = getFilePath(storedName);
  if (!existsSync(filePath)) {
    throw notFound("File not found on disk");
  }
  return createReadStream(filePath);
}

/** Removes a stored file from disk, silently doing nothing when it no longer exists. */
export function deleteFile(storedName: string): void {
  const filePath = getFilePath(storedName);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
