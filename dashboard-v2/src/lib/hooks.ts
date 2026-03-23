'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet } from './api';

interface UseApiOptions {
  refreshInterval?: number;
  enabled?: boolean;
}

export function useApi<T>(path: string, options: UseApiOptions = {}) {
  const { refreshInterval = 0, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!enabled) return;
    try {
      const result = await apiGet<T>(path);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido');
    } finally {
      setLoading(false);
    }
  }, [path, enabled]);

  useEffect(() => {
    fetchData();
    if (refreshInterval > 0) {
      const interval = setInterval(fetchData, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [fetchData, refreshInterval]);

  return { data, error, loading, refetch: fetchData };
}
