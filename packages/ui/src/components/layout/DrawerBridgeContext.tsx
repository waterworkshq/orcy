import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface DrawerBridgeCallbacks {
  onDeployAgent?: () => void;
  onOpenStats?: () => void;
  onOpenActivity?: () => void;
  onOpenAgents?: () => void;
  onOpenDependencies?: () => void;
}

interface DrawerBridgeContextValue {
  callbacks: DrawerBridgeCallbacks;
  registerCallbacks: (callbacks: DrawerBridgeCallbacks) => () => void;
}

const DrawerBridgeContext = createContext<DrawerBridgeContextValue | null>(null);

const noopRegister = () => () => undefined;

export function useRegisterDrawerBridge() {
  const context = useContext(DrawerBridgeContext);
  return context?.registerCallbacks ?? noopRegister;
}

export function DrawerBridgeProvider({ children }: { children: React.ReactNode }) {
  const [callbacks, setCallbacks] = useState<DrawerBridgeCallbacks>({});

  const registerCallbacks = useCallback((nextCallbacks: DrawerBridgeCallbacks) => {
    setCallbacks(nextCallbacks);
    return () => setCallbacks({});
  }, []);

  const value = useMemo(
    () => ({ callbacks, registerCallbacks }),
    [callbacks, registerCallbacks]
  );

  return (
    <DrawerBridgeContext.Provider value={value}>
      {children}
    </DrawerBridgeContext.Provider>
  );
}

export function useDrawerBridgeCallbacks() {
  const context = useContext(DrawerBridgeContext);
  return context?.callbacks ?? {};
}
