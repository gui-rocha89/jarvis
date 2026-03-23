'use client';

import { useApi } from '@/lib/hooks';
import { LoadingSpinner } from '@/components/ui/loading';
import { ErrorState } from '@/components/ui/error-state';
import { Building2, MessageSquare, CheckCircle, XCircle } from 'lucide-react';

interface Client {
  name: string;
  groupJid: string;
  active: boolean;
  messageCount?: number;
  lastActivity?: string;
}

interface ProfileData {
  entity_id: string;
  entity_type: string;
  profile: {
    name?: string;
    summary?: string;
    [key: string]: unknown;
  };
}

export default function ClientsPage() {
  const profiles = useApi<ProfileData[] | { profiles: ProfileData[] }>(
    '/dashboard/profiles',
    { refreshInterval: 60000 }
  );

  if (profiles.loading) return <LoadingSpinner size="lg" />;
  if (profiles.error) return <ErrorState message={profiles.error} onRetry={profiles.refetch} />;

  const allProfiles = Array.isArray(profiles.data) ? profiles.data : profiles.data?.profiles || [];
  const clientProfiles = allProfiles.filter((p) => p.entity_type === 'client');

  return (
    <div className="space-y-6 pt-10 md:pt-0">
      <h1 className="text-xl font-bold text-stark-cyan" style={{ fontFamily: 'Orbitron, sans-serif' }}>
        Clientes
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {clientProfiles.map((client) => (
          <div
            key={client.entity_id}
            className="bg-stark-panel border border-stark-border rounded-xl p-5"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-stark-gold/10 flex items-center justify-center">
                <Building2 className="w-5 h-5 text-stark-gold" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold truncate">
                  {client.profile?.name || client.entity_id}
                </h3>
                <span className="text-[10px] text-stark-dim">{client.entity_id}</span>
              </div>
            </div>
            {client.profile?.summary && (
              <p className="text-xs text-stark-text-dim line-clamp-3 mb-3">
                {client.profile.summary}
              </p>
            )}
            <div className="flex items-center gap-3 text-xs text-stark-dim">
              <span className="flex items-center gap-1">
                <CheckCircle className="w-3 h-3 text-stark-green" /> Ativo
              </span>
            </div>
          </div>
        ))}
      </div>

      {clientProfiles.length === 0 && (
        <div className="text-center py-12">
          <Building2 className="w-12 h-12 text-stark-dim mx-auto mb-3 opacity-30" />
          <p className="text-sm text-stark-dim">Nenhum cliente encontrado</p>
          <p className="text-xs text-stark-dim mt-1">
            Clientes sao registrados automaticamente quando autorizados via WhatsApp
          </p>
        </div>
      )}
    </div>
  );
}
