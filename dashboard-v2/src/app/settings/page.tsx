'use client';

import { useState, useEffect } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { LoadingSpinner } from '@/components/ui/loading';
import { ErrorState } from '@/components/ui/error-state';
import { Settings, Volume2, Save, Loader2, LogOut } from 'lucide-react';
import { logout } from '@/lib/api';

interface VoiceConfig {
  stability: number;
  similarity_boost: number;
  style: number;
  speaker_boost: boolean;
}

export default function SettingsPage() {
  const [voice, setVoice] = useState<VoiceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadVoiceConfig();
  }, []);

  const loadVoiceConfig = async () => {
    try {
      const data = await apiGet<VoiceConfig | { config: VoiceConfig }>('/dashboard/voice');
      const config = (data as { config: VoiceConfig }).config || (data as VoiceConfig);
      setVoice(config);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar configuracoes');
    } finally {
      setLoading(false);
    }
  };

  const saveVoiceConfig = async () => {
    if (!voice) return;
    setSaving(true);
    try {
      await apiPost('/dashboard/voice', voice);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError('Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner size="lg" />;
  if (error && !voice) return <ErrorState message={error} onRetry={loadVoiceConfig} />;

  return (
    <div className="space-y-6 pt-10 md:pt-0">
      <h1 className="text-xl font-bold text-stark-cyan" style={{ fontFamily: 'Orbitron, sans-serif' }}>
        Configuracoes
      </h1>

      {/* Voice Config */}
      <div className="bg-stark-panel border border-stark-border rounded-xl p-6">
        <h2 className="text-sm font-bold text-stark-cyan mb-4 flex items-center gap-2">
          <Volume2 className="w-4 h-4" /> Configuracoes de Voz
        </h2>

        {voice && (
          <div className="space-y-4">
            <SliderField
              label="Estabilidade"
              value={voice.stability}
              onChange={(v) => setVoice({ ...voice, stability: v })}
            />
            <SliderField
              label="Similaridade"
              value={voice.similarity_boost}
              onChange={(v) => setVoice({ ...voice, similarity_boost: v })}
            />
            <SliderField
              label="Estilo"
              value={voice.style}
              onChange={(v) => setVoice({ ...voice, style: v })}
            />

            <div className="flex items-center justify-between">
              <span className="text-xs text-stark-text-dim">Speaker Boost</span>
              <button
                onClick={() => setVoice({ ...voice, speaker_boost: !voice.speaker_boost })}
                className={`w-11 h-6 rounded-full transition-colors relative ${
                  voice.speaker_boost ? 'bg-stark-green' : 'bg-stark-border'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    voice.speaker_boost ? 'left-5.5' : 'left-0.5'
                  }`}
                />
              </button>
            </div>

            <button
              onClick={saveVoiceConfig}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-stark-cyan to-stark-blue text-stark-bg text-sm font-bold rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saved ? 'Salvo!' : 'Salvar'}
            </button>
          </div>
        )}
      </div>

      {/* Logout */}
      <div className="bg-stark-panel border border-stark-border rounded-xl p-6">
        <h2 className="text-sm font-bold text-stark-red mb-4">Zona de Perigo</h2>
        <button
          onClick={logout}
          className="flex items-center gap-2 px-4 py-2 border border-stark-red text-stark-red text-sm rounded-lg hover:bg-stark-red/10 transition-colors"
        >
          <LogOut className="w-4 h-4" /> Sair do Dashboard
        </button>
      </div>
    </div>
  );
}

function SliderField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-stark-text-dim">{label}</span>
        <span className="text-xs font-mono text-stark-cyan">{value?.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-stark-cyan"
      />
    </div>
  );
}
