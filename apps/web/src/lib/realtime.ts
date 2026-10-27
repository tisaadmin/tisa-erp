/** One live connection to the server per browser tab (notifications, chat messages). */
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { apiBase, session } from './api';

let sock: Socket | null = null;
let token: string | null = null;

export function getSocket(): Socket | null {
  const s = session.get();
  if (!s) return null;
  if (!sock || token !== s.accessToken) {
    sock?.disconnect();
    token = s.accessToken;
    sock = io(apiBase || undefined, { auth: (cb) => cb({ token: session.get()?.accessToken }), transports: ['websocket', 'polling'] });
  }
  return sock;
}
export function closeSocket() { sock?.disconnect(); sock = null; token = null; }

/** Run a handler for a live event while the component is on screen. */
export function useLive<T = any>(event: string, handler: (payload: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const fn = (p: T) => ref.current(p);
    s.on(event, fn);
    return () => { s.off(event, fn); };
  }, [event]);
}
