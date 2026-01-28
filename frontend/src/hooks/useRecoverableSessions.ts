/**
 * Hook for managing recoverable upload sessions
 */

import { useState, useEffect, useCallback } from 'react';
import { uploadStorage, type UploadSession } from '@/lib/uploadStorage';
import { checkUploadStatus } from '@/lib/api';

export interface UseRecoverableSessionsResult {
  sessions: UploadSession[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  discardSession: (id: string) => Promise<void>;
  discardAllSessions: () => Promise<void>;
}

export function useRecoverableSessions(): UseRecoverableSessionsResult {
  const [sessions, setSessions] = useState<UploadSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Clean up expired sessions first
      await uploadStorage.cleanExpiredSessions();

      // Get all recoverable sessions
      const recoverableSessions = await uploadStorage.getRecoverableSessions();

      // Validate each session against the server
      const validatedSessions: UploadSession[] = [];

      for (const session of recoverableSessions) {
        try {
          const status = await checkUploadStatus(session.id, session.ownerToken);
          if (status.valid) {
            validatedSessions.push(session);
          } else {
            // Session is no longer valid on server, clean it up
            console.log('[Recovery] Session no longer valid:', session.id, status.reason);
            await uploadStorage.deleteSession(session.id);
          }
        } catch (e) {
          // Network error - keep the session for now
          console.warn('[Recovery] Could not validate session:', session.id, e);
          validatedSessions.push(session);
        }
      }

      setSessions(validatedSessions);
    } catch (e: any) {
      console.error('[Recovery] Failed to load sessions:', e);
      setError(e.message || 'Failed to load recoverable sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  const discardSession = useCallback(async (id: string) => {
    try {
      await uploadStorage.deleteSession(id);
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch (e: any) {
      console.error('[Recovery] Failed to discard session:', e);
      setError(e.message || 'Failed to discard session');
    }
  }, []);

  const discardAllSessions = useCallback(async () => {
    try {
      for (const session of sessions) {
        await uploadStorage.deleteSession(session.id);
      }
      setSessions([]);
    } catch (e: any) {
      console.error('[Recovery] Failed to discard all sessions:', e);
      setError(e.message || 'Failed to discard sessions');
    }
  }, [sessions]);

  // Load sessions on mount
  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    sessions,
    loading,
    error,
    refresh,
    discardSession,
    discardAllSessions,
  };
}
