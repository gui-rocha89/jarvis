'use client';

import { useState } from 'react';
import { useApi } from '@/lib/hooks';
import { apiGet, apiPost } from '@/lib/api';
import { LoadingSpinner } from '@/components/ui/loading';
import { ErrorState } from '@/components/ui/error-state';
import { Search, Brain, Database, Loader2 } from 'lucide-react';

interface MemoryStats {
  total: number;
  user: number;
  chat: number;
  agent: number;
  byCategory: Record<string, number>;
  topMemories?: unknown[];
}

interface Memory {
  id: number;
  content: string;
  category: string;
  scope: string;
  importance: number;
  created_at: string;
}

export default function MemoryPage() {
  const stats = useApi<MemoryStats>('/dashboard/memory', { refreshInterval: 30000 });
  const recent = useApi<Memory[] | { memories: Memory[] }>('/dashboard/memory/recent?limit=20');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Memory[]>([]);
  const [searching, setSearching] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const data = await apiGet<Memory[] | { results: Memory[]; count: number } | { memories: Memory[] }>(
        `/dashboard/memory/search?q=${encodeURIComponent(searchQuery)}`
      );
      setSearchResults(Array.isArray(data) ? data : (data as { results?: Memory[]; memories?: Memory[] })?.results || (data as { memories?: Memory[] })?.memories || []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleBackfill = async () => {
    setBackfilling(true);
    try {
      await apiPost('/dashboard/memory/backfill');
    } catch {
      // silently fail
    } finally {
      setBackfilling(false);
    }
  };

  if (stats.loading) return <LoadingSpinner size="lg" />;

  const recentMemories = Array.isArray(recent.data) ? recent.data : recent.data?.memories || [];

  return (
    <div className="space-y-6 pt-10 md:pt-0">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-stark-cyan" style={{ fontFamily: 'Orbitron, sans-serif' }}>
          Memoria
        </h1>
        <button
          onClick={handleBackfill}
          disabled={backfilling}
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-stark-panel border border-stark-border rounded-lg hover:border-stark-cyan transition-colors disabled:opacity-50"
        >
          {backfilling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Database className="w-3 h-3" />}
          Backfill Embeddings
        </button>
      </div>

      {stats.error && <ErrorState message={stats.error} onRetry={stats.refetch} />}

      {/* Stats */}
      {stats.data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Total" value={stats.data.total} />
          <StatCard label="User" value={stats.data.user} />
          <StatCard label="Chat" value={stats.data.chat} />
          <StatCard label="Agent" value={stats.data.agent} />
        </div>
      )}

      {/* Search */}
      <div className="bg-stark-panel border border-stark-border rounded-xl p-4">
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stark-dim" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar memorias..."
              className="w-full bg-stark-bg border border-stark-border rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-stark-cyan transition-colors"
            />
          </div>
          <button
            type="submit"
            disabled={searching}
            className="px-4 py-2 bg-gradient-to-r from-stark-cyan to-stark-blue text-stark-bg text-sm font-bold rounded-lg hover:opacity-90 disabled:opacity-50"
          >
            {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Buscar'}
          </button>
        </form>

        {searchResults.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-stark-dim">{searchResults.length} resultado(s)</p>
            {searchResults.map((mem) => (
              <MemoryItem key={mem.id} memory={mem} />
            ))}
          </div>
        )}
      </div>

      {/* Recent Memories */}
      <div>
        <h2 className="text-sm font-bold text-stark-cyan mb-3 flex items-center gap-2">
          <Brain className="w-4 h-4" />
          Memorias Recentes
        </h2>
        <div className="space-y-2">
          {recentMemories.map((mem) => (
            <MemoryItem key={mem.id} memory={mem} />
          ))}
          {recentMemories.length === 0 && !recent.loading && (
            <p className="text-sm text-stark-dim text-center py-6">Nenhuma memoria encontrada</p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-stark-panel border border-stark-border rounded-lg p-3">
      <p className="text-xs text-stark-dim">{label}</p>
      <p className="text-xl font-bold text-stark-cyan">{value?.toLocaleString('pt-BR') ?? '--'}</p>
    </div>
  );
}

function MemoryItem({ memory }: { memory: Memory }) {
  const importanceColor =
    memory.importance >= 8
      ? 'text-stark-red'
      : memory.importance >= 5
      ? 'text-stark-gold'
      : 'text-stark-dim';

  return (
    <div className="bg-stark-bg border border-stark-border rounded-lg p-3">
      <p className="text-sm mb-2">{memory.content}</p>
      <div className="flex items-center gap-2 text-[10px]">
        <span className="px-1.5 py-0.5 bg-stark-panel rounded text-stark-cyan">
          {memory.scope}
        </span>
        <span className="px-1.5 py-0.5 bg-stark-panel rounded text-stark-text-dim">
          {memory.category}
        </span>
        <span className={`px-1.5 py-0.5 bg-stark-panel rounded ${importanceColor}`}>
          imp: {memory.importance}
        </span>
        {memory.created_at && (
          <span className="text-stark-dim ml-auto">
            {new Date(memory.created_at).toLocaleDateString('pt-BR')}
          </span>
        )}
      </div>
    </div>
  );
}
