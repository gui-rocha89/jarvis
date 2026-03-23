'use client';

import { useState, useEffect } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { LoadingSpinner } from '@/components/ui/loading';
import { ErrorState } from '@/components/ui/error-state';
import { Users, Building2, MessageSquare } from 'lucide-react';

interface Group {
  jid: string;
  name: string;
  type: 'internal' | 'client' | 'other';
  active: boolean;
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGroups = async () => {
    try {
      const data = await apiGet<{ groups: Group[] } | Group[]>('/dashboard/groups');
      const list = Array.isArray(data) ? data : data?.groups || [];
      setGroups(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar grupos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGroups();
  }, []);

  const toggleGroup = async (jid: string, active: boolean) => {
    try {
      await apiPost('/dashboard/groups/toggle', { jid, active });
      setGroups((prev) =>
        prev.map((g) => (g.jid === jid ? { ...g, active } : g))
      );
    } catch {
      // Revert on error
      fetchGroups();
    }
  };

  if (loading) return <LoadingSpinner size="lg" />;
  if (error) return <ErrorState message={error} onRetry={fetchGroups} />;

  const typeIcon = {
    internal: <Users className="w-4 h-4 text-stark-cyan" />,
    client: <Building2 className="w-4 h-4 text-stark-gold" />,
    other: <MessageSquare className="w-4 h-4 text-stark-dim" />,
  };

  const typeLabel = {
    internal: 'Interno',
    client: 'Cliente',
    other: 'Outro',
  };

  const typeBadgeColor = {
    internal: 'bg-stark-cyan/10 text-stark-cyan',
    client: 'bg-stark-gold/10 text-stark-gold',
    other: 'bg-stark-dim/10 text-stark-dim',
  };

  return (
    <div className="space-y-6 pt-10 md:pt-0">
      <h1 className="text-xl font-bold text-stark-cyan" style={{ fontFamily: 'Orbitron, sans-serif' }}>
        Grupos
      </h1>

      <div className="space-y-2">
        {groups.map((group) => (
          <div
            key={group.jid}
            className="flex items-center justify-between bg-stark-panel border border-stark-border rounded-lg p-4"
          >
            <div className="flex items-center gap-3 min-w-0">
              {typeIcon[group.type] || typeIcon.other}
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{group.name}</p>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${typeBadgeColor[group.type] || typeBadgeColor.other}`}>
                  {typeLabel[group.type] || 'Outro'}
                </span>
              </div>
            </div>
            <button
              onClick={() => toggleGroup(group.jid, !group.active)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                group.active ? 'bg-stark-green' : 'bg-stark-border'
              }`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  group.active ? 'left-5.5' : 'left-0.5'
                }`}
              />
            </button>
          </div>
        ))}
      </div>

      {groups.length === 0 && (
        <div className="text-center text-stark-dim py-12">
          Nenhum grupo encontrado
        </div>
      )}
    </div>
  );
}
