'use client';

import { useApi } from '@/lib/hooks';
import { LoadingSpinner } from '@/components/ui/loading';
import { ErrorState } from '@/components/ui/error-state';
import { StatusDot } from '@/components/ui/status-dot';
import { Brain, Zap, Activity, Shield, Target, Eye } from 'lucide-react';
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from 'recharts';

interface HealthData {
  whatsapp: string;
  database: string;
  redis: string;
  uptime: number;
  version: string;
}

interface IntelligenceData {
  score?: number;
  overallScore?: number;
  patent?: string;
  patente?: { nome: string; cor: string; icon: string };
  axes: Record<string, number> | { name: string; value: number }[];
}

interface MemoryStats {
  total: number;
  withEmbedding: number;
  byScope: Record<string, number>;
  byCategory: Record<string, number>;
}

const axisIcons: Record<string, React.ReactNode> = {
  'Raciocinio': <Brain className="w-4 h-4" />,
  'Velocidade': <Zap className="w-4 h-4" />,
  'Autonomia': <Activity className="w-4 h-4" />,
  'Seguranca': <Shield className="w-4 h-4" />,
  'Precisao': <Target className="w-4 h-4" />,
  'Percepcao': <Eye className="w-4 h-4" />,
};

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export default function OverviewPage() {
  const health = useApi<HealthData>('/dashboard/health', { refreshInterval: 30000 });
  const intel = useApi<IntelligenceData>('/dashboard/intelligence', { refreshInterval: 60000 });
  const memory = useApi<MemoryStats>('/dashboard/memory', { refreshInterval: 60000 });

  if (health.loading && intel.loading) return <LoadingSpinner size="lg" />;

  return (
    <div className="space-y-6 pt-10 md:pt-0">
      <h1 className="text-xl font-bold text-stark-cyan" style={{ fontFamily: 'Orbitron, sans-serif' }}>
        Visao Geral
      </h1>

      {/* Health Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <HealthCard
          label="WhatsApp"
          status={health.data?.whatsapp === 'connected' ? 'online' : 'offline'}
          value={health.data?.whatsapp === 'connected' ? 'Conectado' : 'Desconectado'}
        />
        <HealthCard
          label="Banco de Dados"
          status={health.data?.database === 'ok' ? 'online' : 'offline'}
          value={health.data?.database === 'ok' ? 'OK' : 'Erro'}
        />
        <HealthCard
          label="Redis"
          status={health.data?.redis === 'ok' ? 'online' : 'offline'}
          value={health.data?.redis === 'ok' ? 'OK' : 'Erro'}
        />
        <HealthCard
          label="Uptime"
          status="online"
          value={health.data?.uptime ? formatUptime(health.data.uptime) : '--'}
        />
      </div>

      {health.error && <ErrorState message={health.error} onRetry={health.refetch} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Intelligence Radar */}
        <div className="bg-stark-panel border border-stark-border rounded-xl p-6">
          <h2 className="text-sm font-bold text-stark-cyan mb-4">Radar de Inteligencia</h2>
          {intel.error ? (
            <ErrorState message={intel.error} onRetry={intel.refetch} />
          ) : intel.data?.axes ? (
            (() => {
              // API retorna axes como objeto {empresa:100,...} — converter pra array
              const axesArray = Array.isArray(intel.data.axes)
                ? intel.data.axes
                : Object.entries(intel.data.axes).map(([name, value]) => ({ name, value: value as number }));
              const patentName = intel.data.patente?.nome || intel.data.patent || '--';
              const score = intel.data.overallScore ?? intel.data.score ?? '--';
              return (
                <>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <RadarChart data={axesArray}>
                        <PolarGrid stroke="#1a2332" />
                        <PolarAngleAxis
                          dataKey="name"
                          tick={{ fill: '#94a3b8', fontSize: 11 }}
                        />
                        <Radar
                          dataKey="value"
                          stroke="#00f0ff"
                          fill="#00f0ff"
                          fillOpacity={0.15}
                          strokeWidth={2}
                        />
                      </RadarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex items-center justify-between mt-4 pt-4 border-t border-stark-border">
                    <div>
                      <p className="text-xs text-stark-dim">Patente Atual</p>
                      <p className="text-lg font-bold text-stark-gold">{patentName}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-stark-dim">Score</p>
                      <p className="text-lg font-bold text-stark-cyan">{score}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-4">
                    {axesArray.map((axis) => (
                      <div key={axis.name} className="flex items-center gap-1.5 text-xs text-stark-text-dim">
                        {axisIcons[axis.name] || <Zap className="w-3 h-3" />}
                        <span>{axis.name}: {axis.value}</span>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()
          ) : null}
        </div>

        {/* Memory Stats */}
        <div className="bg-stark-panel border border-stark-border rounded-xl p-6">
          <h2 className="text-sm font-bold text-stark-cyan mb-4">Memoria</h2>
          {memory.error ? (
            <ErrorState message={memory.error} onRetry={memory.refetch} />
          ) : memory.data ? (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <StatBox label="Total de Memorias" value={memory.data.total} />
                <StatBox label="Com Embedding" value={memory.data.withEmbedding} />
              </div>
              {memory.data.byScope && (
                <div>
                  <p className="text-xs text-stark-dim mb-2">Por Escopo</p>
                  <div className="space-y-2">
                    {Object.entries(memory.data.byScope).map(([scope, count]) => (
                      <div key={scope} className="flex items-center justify-between">
                        <span className="text-xs text-stark-text-dim capitalize">{scope}</span>
                        <span className="text-xs font-mono text-stark-cyan">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {memory.data.byCategory && (
                <div>
                  <p className="text-xs text-stark-dim mb-2">Por Categoria</p>
                  <div className="space-y-1">
                    {Object.entries(memory.data.byCategory)
                      .sort(([, a], [, b]) => b - a)
                      .map(([cat, count]) => (
                        <div key={cat} className="flex items-center justify-between">
                          <span className="text-xs text-stark-text-dim">{cat}</span>
                          <span className="text-xs font-mono text-stark-text-dim">{count}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function HealthCard({
  label,
  status,
  value,
}: {
  label: string;
  status: 'online' | 'offline';
  value: string;
}) {
  return (
    <div className="bg-stark-panel border border-stark-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-stark-dim">{label}</span>
        <StatusDot status={status} />
      </div>
      <p className="text-sm font-bold">{value}</p>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-stark-bg rounded-lg p-3">
      <p className="text-xs text-stark-dim">{label}</p>
      <p className="text-xl font-bold text-stark-cyan">{value?.toLocaleString('pt-BR') ?? '--'}</p>
    </div>
  );
}
