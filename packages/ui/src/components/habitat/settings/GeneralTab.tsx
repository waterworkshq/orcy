import React, { useState, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import { Button } from '../../ui/Button.js';
import { useHabitatSettingsSaver } from '../../../hooks/useHabitatSettingsSaver.js';

interface GeneralTabProps {
  habitatId: string;
  boardName: string;
  boardDescription: string;
  onUpdate: (board: import('../../../types/index.js').Habitat) => void;
  onClose: () => void;
  onSavingChange?: (saving: boolean) => void;
  onExportOpen: () => void;
  onImportOpen: () => void;
  onDeleteOpen: () => void;
}

export interface GeneralTabHandle {
  save: () => Promise<void>;
}

export const GeneralTab = forwardRef<GeneralTabHandle, GeneralTabProps>(function GeneralTab({
  habitatId,
  boardName,
  boardDescription,
  onUpdate,
  onClose,
  onSavingChange,
  onExportOpen,
  onImportOpen,
  onDeleteOpen,
}, ref) {
  const [name, setName] = useState(boardName);
  const [description, setDescription] = useState(boardDescription);
  const { saving, saveSettings } = useHabitatSettingsSaver({ habitatId: habitatId, onUpdate });

  useEffect(() => {
    onSavingChange?.(saving);
  }, [saving, onSavingChange]);

  const handleSave = useCallback(async () => {
    await saveSettings({
      name: name.trim() || boardName,
      description: description.trim(),
    }, 'Habitat settings saved');
    onClose();
  }, [saveSettings, name, boardName, description, onClose]);

  useImperativeHandle(ref, () => ({ save: handleSave }), [handleSave]);

  return (
    <>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Habitat Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>
      <div className="mt-6 pt-4 border-t px-6 pb-4">
        <h4 className="text-sm font-medium mb-2">Import / Export</h4>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onExportOpen}>
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={onImportOpen}>
            Import
          </Button>
        </div>
      </div>
      <div className="mt-2 pt-4 border-t border-destructive/20 px-6 pb-4">
        <h4 className="text-sm font-medium text-destructive mb-2">Danger Zone</h4>
        <Button variant="destructive" size="sm" onClick={onDeleteOpen}>
          Delete Habitat
        </Button>
      </div>
    </>
  );
});
