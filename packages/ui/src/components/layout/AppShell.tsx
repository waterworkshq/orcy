import { Outlet } from 'react-router-dom';
import { SideNavBar } from '../habitat/SideNavBar.js';
import { TaskDetailModal } from '../habitat/TaskDetailModal.js';
import { DrawerBridgeProvider, useDrawerBridgeCallbacks } from './DrawerBridgeContext.js';
import { TopAppBar } from './TopAppBar.js';

function AppShellFrame() {
  const callbacks = useDrawerBridgeCallbacks();

  return (
    <div className="flex h-screen overflow-hidden bg-surface" data-testid="app-shell">
      <SideNavBar {...callbacks} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopAppBar />
        <main className="min-h-0 flex-1 overflow-auto" data-testid="app-shell-content">
          <Outlet />
        </main>
      </div>
      <TaskDetailModal />
    </div>
  );
}

export function AppShell() {
  return (
    <DrawerBridgeProvider>
      <AppShellFrame />
    </DrawerBridgeProvider>
  );
}
