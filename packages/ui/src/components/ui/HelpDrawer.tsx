import * as React from 'react';
import { X } from 'lucide-react';
import { Drawer } from './Drawer.js';

interface HelpDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

function HelpDrawer({ isOpen, onClose, children }: HelpDrawerProps) {
  return (
    <Drawer open={isOpen} onClose={onClose} className="w-full max-w-md">
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold">Help</h2>
          <button
            onClick={onClose}
            className="rounded-sm p-1 hover:bg-accent transition-colors"
            aria-label="Close help"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </Drawer>
  );
}

export { HelpDrawer };
