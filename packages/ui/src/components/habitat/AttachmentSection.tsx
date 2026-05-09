import React, { useState, useRef, useCallback } from 'react';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import type { TaskAttachment } from '../../types/index.js';
import { Paperclip, Upload, Download, Trash2, FileText, File, FileImage, FileCode } from 'lucide-react';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return <FileImage className="h-4 w-4" />;
  if (mimeType.includes('pdf')) return <FileText className="h-4 w-4" />;
  if (mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('typescript') || mimeType.includes('text'))
    return <FileCode className="h-4 w-4" />;
  return <File className="h-4 w-4" />;
}

export function AttachmentSection({ taskId, attachments: initialAttachments }: {
  taskId: string;
  attachments: TaskAttachment[];
}) {
  const [attachments, setAttachments] = useState<TaskAttachment[]>(initialAttachments);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TaskAttachment | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(async (file: File) => {
    if (!file) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      const result = await api.attachments.upload(taskId, file, (percent) => {
        setUploadProgress(percent);
      });
      setAttachments((prev) => [result.attachment, ...prev]);
      notify.success(`Uploaded ${file.name}`);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }, [taskId]);

  async function handleDownload(attachment: TaskAttachment) {
    try {
      const { blob, filename } = await api.attachments.download(attachment.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || attachment.originalName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function handleDelete(attachment: TaskAttachment) {
    try {
      await api.attachments.delete(attachment.id);
      setAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      notify.success('Attachment deleted');
    } catch (err) {
      notify.error((err as Error).message);
    }
    setDeleteTarget(null);
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [handleUpload]);

  return (
    <Card className="mb-4">
      <CardHeader className="p-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Paperclip className="h-4 w-4" />
          Attachments
          {attachments.length > 0 && (
            <span className="text-muted-foreground">({attachments.length})</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2">
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
          onClick={() => fileInputRef.current?.click()}
          className={`cursor-pointer rounded border-2 border-dashed p-4 text-center transition-colors ${
            dragOver
              ? 'border-primary bg-primary/5'
              : 'border-input hover:border-primary/50'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            onChange={onFileChange}
            className="hidden"
          />
          {uploading ? (
            <div className="space-y-2">
              <Upload className="mx-auto h-6 w-6 text-primary animate-pulse" />
              <div className="text-sm text-muted-foreground">Uploading... {uploadProgress}%</div>
              <div className="mx-auto h-1.5 w-32 rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-200 rounded-full"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <Upload className="mx-auto h-6 w-6 text-muted-foreground" />
              <div className="text-sm text-muted-foreground">
                Drop a file here or click to browse
              </div>
            </div>
          )}
        </div>

        {attachments.length > 0 && (
          <div className="space-y-1">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="flex items-center gap-2 rounded p-1.5 hover:bg-accent group"
              >
                <span className="text-muted-foreground">
                  {getFileIcon(attachment.mimeType)}
                </span>
                <span className="flex-1 truncate text-sm">
                  {attachment.originalName}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatFileSize(attachment.sizeBytes)}
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleDownload(attachment); }}
                  className="p-1 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setDeleteTarget(attachment); }}
                  className="p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <ConfirmDialog
          open={!!deleteTarget}
          onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
          title="Delete Attachment?"
          description={`This will permanently remove "${deleteTarget?.originalName ?? 'the file'}" and cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
        />
      </CardContent>
    </Card>
  );
}
