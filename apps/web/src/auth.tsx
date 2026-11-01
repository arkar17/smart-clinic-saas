import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MeResponse } from '@sc/contracts';
import { api, setSession } from './api';

interface Auth {
  me: MeResponse | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setMe: (me: MeResponse | null) => void;
}
const Ctx = createContext<Auth>({ me: null, loading: true, refresh: async () => {}, setMe: () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const setMe = useCallback((m: MeResponse | null) => {
    if (m) setSession(m);
    setMeState(m);
  }, []);
  const refresh = useCallback(async () => {
    try {
      setMe(await api<MeResponse>('GET', '/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [setMe]);
  useEffect(() => void refresh(), [refresh]);
  return <Ctx.Provider value={{ me, loading, refresh, setMe }}>{children}</Ctx.Provider>;
}

export const hasRole = (me: MeResponse | null, ...roles: string[]) => !!me && me.roles.some((r) => roles.includes(r));
