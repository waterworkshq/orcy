import React, { createContext, useContext, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../api/transport.js";
import { useHabitatStore } from "../store/habitatStore.js";
import { useModalStore } from "../store/modalStore.js";

function createSessionClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 10 * 60_000,
        retry: (failureCount, error: unknown) => {
          if (error instanceof ApiError && error.status === 429) return false;
          return failureCount < 1;
        },
        refetchOnWindowFocus: false,
      },
    },
  });
}

interface AccountSession {
  beginAuthentication: () => number;
  isCurrentAuthentication: (attempt: number) => boolean;
  completeAuthentication: (attempt: number, token: string) => boolean;
  logout: () => void;
  isActive: () => boolean;
}
const AccountSessionContext = createContext<AccountSession | null>(null);

/** Own the query client for one account, including pending mutation closures. */
export function SessionStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(() => ({ client: createSessionClient(), generation: 0 }));
  const current = useRef(state);
  const authEpoch = useRef(0);
  function replace(token: string | null) {
    authEpoch.current++;
    const previous = current.current;
    void previous.client.cancelQueries();
    previous.client.clear();
    const theme = useHabitatStore.getState().theme;
    useHabitatStore.setState({ ...useHabitatStore.getInitialState(), theme }, true);
    useModalStore.getState().closeModal();
    if (token === null) localStorage.removeItem("orcy_token");
    else localStorage.setItem("orcy_token", token);
    const next = { client: createSessionClient(), generation: previous.generation + 1 };
    current.current = next;
    setState(next);
  }
  return (
    <AccountSessionContext.Provider value={{
      beginAuthentication: () => ++authEpoch.current,
      isCurrentAuthentication: (attempt) => attempt === authEpoch.current,
      completeAuthentication: (attempt, token) => {
        if (attempt !== authEpoch.current) return false;
        replace(token);
        return true;
      },
      logout: () => replace(null),
      isActive: () => current.current === state,
    }}>
      <QueryClientProvider key={state.generation} client={state.client}>
        {children}
      </QueryClientProvider>
    </AccountSessionContext.Provider>
  );
}

export function useAccountSession() {
  const session = useContext(AccountSessionContext);
  if (!session) throw new Error("Account session requires SessionStateProvider");
  return session;
}

/** Capture the originating account for async callbacks that write shared UI state. */
export function useSessionLiveness() {
  const session = useContext(AccountSessionContext);
  return session?.isActive ?? alwaysActive;
}
const alwaysActive = () => true;
