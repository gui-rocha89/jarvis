'use client';

import { useApi } from '@/lib/hooks';
import { LoadingSpinner } from '@/components/ui/loading';
import { ErrorState } from '@/components/ui/error-state';
import { Shield, MapPin, Monitor, Clock } from 'lucide-react';

interface AccessLog {
  email: string;
  ip: string;
  user_agent: string;
  action: string;
  success: boolean;
  city?: string;
  region?: string;
  country?: string;
  created_at: string;
}

export default function SecurityPage() {
  const { data, error, loading, refetch } = useApi<AccessLog[] | { logs: AccessLog[] }>(
    '/dashboard/auth/access-log',
    { refreshInterval: 30000 }
  );

  if (loading) return <LoadingSpinner size="lg" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;

  const logs = Array.isArray(data) ? data : data?.logs || [];

  return (
    <div className="space-y-6 pt-10 md:pt-0">
      <h1 className="text-xl font-bold text-stark-cyan" style={{ fontFamily: 'Orbitron, sans-serif' }}>
        <Shield className="w-5 h-5 inline mr-2" />
        Seguranca
      </h1>

      <div className="bg-stark-panel border border-stark-border rounded-xl overflow-hidden">
        <div className="p-4 border-b border-stark-border">
          <h2 className="text-sm font-bold text-stark-text">Historico de Acessos</h2>
        </div>

        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stark-border text-stark-dim text-xs">
                <th className="px-4 py-3 text-left">Data</th>
                <th className="px-4 py-3 text-left">IP</th>
                <th className="px-4 py-3 text-left">Local</th>
                <th className="px-4 py-3 text-left">Dispositivo</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, idx) => (
                <tr key={`${log.created_at}-${idx}`} className="border-b border-stark-border/50 hover:bg-stark-bg/50">
                  <td className="px-4 py-3 text-xs text-stark-text-dim">
                    {new Date(log.created_at).toLocaleString('pt-BR')}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono">{log.ip}</td>
                  <td className="px-4 py-3 text-xs text-stark-text-dim">
                    {log.city ? `${log.city}, ${log.region || ''}, ${log.country || ''}` : '--'}
                  </td>
                  <td className="px-4 py-3 text-xs text-stark-text-dim truncate max-w-[200px]">
                    {log.user_agent?.split(' ').slice(0, 3).join(' ') || '--'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded ${
                        log.success
                          ? 'bg-stark-green/10 text-stark-green'
                          : 'bg-stark-red/10 text-stark-red'
                      }`}
                    >
                      {log.success ? 'OK' : 'Falhou'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden space-y-2 p-3">
          {logs.map((log, idx) => (
            <div key={`${log.created_at}-${idx}`} className="bg-stark-bg rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-stark-text-dim flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {new Date(log.created_at).toLocaleString('pt-BR')}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded ${
                    log.success
                      ? 'bg-stark-green/10 text-stark-green'
                      : 'bg-stark-red/10 text-stark-red'
                  }`}
                >
                  {log.success ? 'OK' : 'Falhou'}
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs text-stark-text-dim">
                <Monitor className="w-3 h-3" /> {log.ip}
              </div>
              {log.city && (
                <div className="flex items-center gap-1 text-xs text-stark-dim">
                  <MapPin className="w-3 h-3" /> {log.city}, {log.country}
                </div>
              )}
            </div>
          ))}
        </div>

        {logs.length === 0 && (
          <div className="text-center py-8 text-stark-dim text-sm">
            Nenhum acesso registrado
          </div>
        )}
      </div>
    </div>
  );
}
