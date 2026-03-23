'use client';

import { useApi } from '@/lib/hooks';
import { LoadingSpinner } from '@/components/ui/loading';
import { ErrorState } from '@/components/ui/error-state';
import { Bot, Megaphone, Palette, ClipboardList, Search, MessageCircle } from 'lucide-react';

interface Agent {
  name: string;
  specialty: string;
  status: string;
  triggers: string[];
}

const agentIcons: Record<string, React.ReactNode> = {
  master: <Bot className="w-5 h-5" />,
  traffic: <Megaphone className="w-5 h-5" />,
  creative: <Palette className="w-5 h-5" />,
  manager: <ClipboardList className="w-5 h-5" />,
  researcher: <Search className="w-5 h-5" />,
  social: <MessageCircle className="w-5 h-5" />,
};

const agentColors: Record<string, string> = {
  master: 'text-stark-cyan border-stark-cyan/30',
  traffic: 'text-stark-gold border-stark-gold/30',
  creative: 'text-purple-400 border-purple-400/30',
  manager: 'text-stark-blue border-stark-blue/30',
  researcher: 'text-stark-green border-stark-green/30',
  social: 'text-pink-400 border-pink-400/30',
};

export default function AgentsPage() {
  const { data, error, loading, refetch } = useApi<Agent[] | { agents: Agent[] }>(
    '/dashboard/agents',
    { refreshInterval: 30000 }
  );

  if (loading) return <LoadingSpinner size="lg" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;

  const agents = Array.isArray(data) ? data : data?.agents || [];

  return (
    <div className="space-y-6 pt-10 md:pt-0">
      <h1 className="text-xl font-bold text-stark-cyan" style={{ fontFamily: 'Orbitron, sans-serif' }}>
        Agentes
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => {
          const key = agent.name.toLowerCase();
          const colorClass = agentColors[key] || 'text-stark-text border-stark-border';
          return (
            <div
              key={agent.name}
              className={`bg-stark-panel border rounded-xl p-5 ${colorClass}`}
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-stark-bg rounded-lg">
                  {agentIcons[key] || <Bot className="w-5 h-5" />}
                </div>
                <div>
                  <h3 className="font-bold text-sm">{agent.name}</h3>
                  <p className="text-xs text-stark-dim">{agent.specialty}</p>
                </div>
              </div>
              {agent.triggers && agent.triggers.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {agent.triggers.slice(0, 6).map((t) => (
                    <span
                      key={t}
                      className="text-[10px] px-1.5 py-0.5 bg-stark-bg rounded text-stark-text-dim"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {agents.length === 0 && (
        <div className="text-center text-stark-dim py-12">
          Nenhum agente encontrado
        </div>
      )}
    </div>
  );
}
