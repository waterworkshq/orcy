import React, { useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import type { HabitatExport } from '../../types/index.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';

interface ImportHabitatDialogProps {
  habitatId?: string;
  boardName?: string;
  open: boolean;
  onClose: () => void;
  onImport: (habitatId: string) => void;
}

export function ImportHabitatDialog({ habitatId, boardName, open, onClose, onImport }: ImportHabitatDialogProps) {
  const [mode, setMode] = useState<'replace' | 'merge'>('replace');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<HabitatExport | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setPreviewError(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        const parsed = validateImportData(json);
        setPreview(parsed);
      } catch (err) {
        setPreviewError((err as Error).message);
        setPreview(null);
      }
    };
    reader.readAsText(selectedFile);
  };

  const validateImportData = (data: unknown): HabitatExport => {
    if (!data || typeof data !== 'object') throw new Error('Invalid JSON: expected an object');
    const d = data as Record<string, unknown>;
    if (typeof d.version !== 'number') throw new Error('Invalid export: missing version field');
    if (d.version !== 1) throw new Error(`Unsupported export version: ${d.version}. Only version 1 is supported.`);
    if (!d.board || typeof d.board !== 'object') throw new Error('Invalid export: missing board field');
    const board = d.board as Record<string, unknown>;
    if (typeof board.name !== 'string') throw new Error('Invalid export: board.name must be a string');

    const result: HabitatExport = {
      version: d.version as number,
      exportedAt: (d.exportedAt as string) || new Date().toISOString(),
      board: {
        name: board.name as string,
        description: (board.description as string) || '',
        columns: (board.columns as HabitatExport['board']['columns']) || [],
        features: (board.features as HabitatExport['board']['features']) || [],
        comments: (board.comments as HabitatExport['board']['comments']) || [],
        templates: (board.templates as HabitatExport['board']['templates']) || [],
        webhooks: (board.webhooks as HabitatExport['board']['webhooks']) || [],
      },
    };

    return result;
  };

  const handleImport = async () => {
    if (!preview) return;

    setImporting(true);
    try {
      let result;
      if (habitatId && mode === 'merge') {
        result = await api.habitats.importInto(habitatId, preview);
      } else {
        result = await api.habitats.import(preview);
      }

      if (result.warnings.length > 0) {
        notify.warning(`Imported with ${result.warnings.length} warning(s)`);
      } else {
        notify.success('Habitat imported successfully');
      }

      if (result.warnings.length > 0) {
        console.warn('Import warnings:', result.warnings);
      }

      onImport(result.board.id);
      handleClose();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    setFile(null);
    setPreview(null);
    setPreviewError(null);
    setMode('replace');
    onClose();
  };

  const featureCount = preview?.board.features.length ?? 0;
  const commentCount = preview?.board.comments.length ?? 0;
  const templateCount = preview?.board.templates.length ?? 0;
  const webhookCount = preview?.board.webhooks.length ?? 0;

  return (
    <Dialog open={open} onClose={handleClose}>
      <DialogHeader>
        <DialogTitle>{habitatId ? 'Import Into Habitat' : 'Import Habitat'}</DialogTitle>
      </DialogHeader>
      <DialogContent>
        {!preview && !previewError && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Select a habitat export JSON file to import.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="hidden"
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
            >
              Choose File
            </Button>
          </div>
        )}

        {previewError && (
          <div className="space-y-4">
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive">
              {previewError}
            </div>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
            >
              Choose Different File
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>
        )}

        {preview && (
          <div className="space-y-4">
            <div className="p-3 bg-muted rounded">
              <h4 className="font-medium mb-2">{preview.board.name}</h4>
              {preview.board.description && (
                <p className="text-sm text-muted-foreground mb-2">{preview.board.description}</p>
              )}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>Columns: <span className="font-medium">{preview.board.columns.length}</span></div>
                <div>Missions: <span className="font-medium">{featureCount}</span></div>
                <div>Comments: <span className="font-medium">{commentCount}</span></div>
                <div>Templates: <span className="font-medium">{templateCount}</span></div>
                <div>Webhooks: <span className="font-medium">{webhookCount}</span></div>
              </div>
            </div>

            {habitatId && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Import mode:</p>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="mode"
                    value="replace"
                    checked={mode === 'replace'}
                    onChange={() => setMode('replace')}
                    className="rounded border-input"
                  />
                  <span className="text-sm">
                    <strong>Replace:</strong> Delete existing board and recreate from export
                  </span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="mode"
                    value="merge"
                    checked={mode === 'merge'}
                    onChange={() => setMode('merge')}
                    className="rounded border-input"
                  />
                  <span className="text-sm">
                    <strong>Merge:</strong> Add exported items alongside existing ones
                  </span>
                </label>
              </div>
            )}

            <div className="p-3 bg-muted rounded text-xs text-muted-foreground">
              <strong>Note:</strong> Webhook secrets will be regenerated. Agent API keys and audit logs cannot be imported.
            </div>
          </div>
        )}
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={handleClose} disabled={importing}>
          Cancel
        </Button>
        <Button
          onClick={handleImport}
          loading={importing}
          disabled={!preview}
        >
          {habitatId && mode === 'merge' ? 'Merge Import' : 'Import'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
