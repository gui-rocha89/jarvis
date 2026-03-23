'use client';

import { useState, useEffect } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { LoadingSpinner } from '@/components/ui/loading';
import { ErrorState } from '@/components/ui/error-state';
import { Radio, Instagram, Mail, Save, Loader2, Plus, X, CheckCircle, XCircle } from 'lucide-react';

interface ChannelSettings {
  instagram: {
    enabled: boolean;
    verify_token: string;
    allowed_pages: string[];
  };
  email: {
    enabled: boolean;
    imap_host: string;
    imap_port: number;
    smtp_host: string;
    smtp_port: number;
    user: string;
    password: string;
  };
}

const defaultSettings: ChannelSettings = {
  instagram: {
    enabled: false,
    verify_token: '',
    allowed_pages: [],
  },
  email: {
    enabled: false,
    imap_host: '',
    imap_port: 993,
    smtp_host: '',
    smtp_port: 587,
    user: '',
    password: '',
  },
};

export default function ChannelsPage() {
  const [settings, setSettings] = useState<ChannelSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newPageId, setNewPageId] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await apiGet<ChannelSettings>('/dashboard/channels');
      setSettings({ ...defaultSettings, ...data });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar configurações');
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      await apiPost('/dashboard/channels', settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const addPageId = () => {
    const trimmed = newPageId.trim();
    if (!trimmed) return;
    if (settings.instagram.allowed_pages.includes(trimmed)) return;
    setSettings({
      ...settings,
      instagram: {
        ...settings.instagram,
        allowed_pages: [...settings.instagram.allowed_pages, trimmed],
      },
    });
    setNewPageId('');
  };

  const removePageId = (id: string) => {
    setSettings({
      ...settings,
      instagram: {
        ...settings.instagram,
        allowed_pages: settings.instagram.allowed_pages.filter((p) => p !== id),
      },
    });
  };

  if (loading) return <LoadingSpinner size="lg" />;
  if (error && !settings) return <ErrorState message={error} onRetry={loadSettings} />;

  return (
    <div className="space-y-6 pt-10 md:pt-0">
      <h1 className="text-xl font-bold text-stark-cyan" style={{ fontFamily: 'Orbitron, sans-serif' }}>
        <Radio className="inline w-5 h-5 mr-2 -mt-1" />
        Canais
      </h1>

      {error && (
        <div className="bg-stark-red/10 border border-stark-red/30 rounded-lg p-3 text-sm text-stark-red">
          {error}
        </div>
      )}

      {/* Instagram DM */}
      <div className="bg-stark-panel border border-stark-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-stark-cyan flex items-center gap-2">
            <Instagram className="w-4 h-4" /> Instagram DM
          </h2>
          <div className="flex items-center gap-2">
            {settings.instagram.enabled ? (
              <span className="flex items-center gap-1 text-xs text-stark-green">
                <CheckCircle className="w-3 h-3" /> Ativo
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-stark-dim">
                <XCircle className="w-3 h-3" /> Inativo
              </span>
            )}
            <ToggleSwitch
              value={settings.instagram.enabled}
              onChange={(v) =>
                setSettings({ ...settings, instagram: { ...settings.instagram, enabled: v } })
              }
            />
          </div>
        </div>

        <div className="space-y-4">
          <InputField
            label="Verify Token"
            value={settings.instagram.verify_token}
            onChange={(v) =>
              setSettings({ ...settings, instagram: { ...settings.instagram, verify_token: v } })
            }
            placeholder="Token de verificação do webhook"
          />

          <div>
            <label className="text-xs text-stark-text-dim block mb-2">
              Page IDs permitidos (whitelist)
            </label>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={newPageId}
                onChange={(e) => setNewPageId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPageId()}
                placeholder="ID da página"
                className="flex-1 bg-stark-bg border border-stark-border rounded-lg px-3 py-2 text-sm text-stark-text focus:border-stark-cyan focus:outline-none"
              />
              <button
                onClick={addPageId}
                className="px-3 py-2 bg-stark-cyan/10 border border-stark-cyan/30 text-stark-cyan rounded-lg hover:bg-stark-cyan/20 transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            {settings.instagram.allowed_pages.length === 0 ? (
              <p className="text-xs text-stark-dim italic">
                Nenhum filtro — todas as páginas são aceitas
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {settings.instagram.allowed_pages.map((id) => (
                  <span
                    key={id}
                    className="flex items-center gap-1 bg-stark-bg border border-stark-border rounded-full px-3 py-1 text-xs text-stark-text"
                  >
                    {id}
                    <button onClick={() => removePageId(id)} className="text-stark-dim hover:text-stark-red">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Email Monitor */}
      <div className="bg-stark-panel border border-stark-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-stark-cyan flex items-center gap-2">
            <Mail className="w-4 h-4" /> Email Monitor
          </h2>
          <div className="flex items-center gap-2">
            {settings.email.enabled ? (
              <span className="flex items-center gap-1 text-xs text-stark-green">
                <CheckCircle className="w-3 h-3" /> Ativo
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-stark-dim">
                <XCircle className="w-3 h-3" /> Inativo
              </span>
            )}
            <ToggleSwitch
              value={settings.email.enabled}
              onChange={(v) =>
                setSettings({ ...settings, email: { ...settings.email, enabled: v } })
              }
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <InputField
            label="IMAP Host"
            value={settings.email.imap_host}
            onChange={(v) =>
              setSettings({ ...settings, email: { ...settings.email, imap_host: v } })
            }
            placeholder="imap.gmail.com"
          />
          <InputField
            label="IMAP Port"
            value={String(settings.email.imap_port)}
            onChange={(v) =>
              setSettings({ ...settings, email: { ...settings.email, imap_port: parseInt(v) || 993 } })
            }
            placeholder="993"
            type="number"
          />
          <InputField
            label="SMTP Host"
            value={settings.email.smtp_host}
            onChange={(v) =>
              setSettings({ ...settings, email: { ...settings.email, smtp_host: v } })
            }
            placeholder="smtp.gmail.com"
          />
          <InputField
            label="SMTP Port"
            value={String(settings.email.smtp_port)}
            onChange={(v) =>
              setSettings({ ...settings, email: { ...settings.email, smtp_port: parseInt(v) || 587 } })
            }
            placeholder="587"
            type="number"
          />
          <InputField
            label="Usuário (email)"
            value={settings.email.user}
            onChange={(v) =>
              setSettings({ ...settings, email: { ...settings.email, user: v } })
            }
            placeholder="contato@streamlab.com.br"
          />
          <InputField
            label="Senha"
            value={settings.email.password}
            onChange={(v) =>
              setSettings({ ...settings, email: { ...settings.email, password: v } })
            }
            placeholder="••••••••"
            type="password"
          />
        </div>
      </div>

      {/* Salvar */}
      <button
        onClick={saveSettings}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-stark-cyan to-stark-blue text-stark-bg text-sm font-bold rounded-lg hover:opacity-90 disabled:opacity-50"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        {saved ? 'Salvo!' : 'Salvar configurações'}
      </button>
    </div>
  );
}

function ToggleSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`w-11 h-6 rounded-full transition-colors relative ${
        value ? 'bg-stark-green' : 'bg-stark-border'
      }`}
    >
      <span
        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
          value ? 'left-5.5' : 'left-0.5'
        }`}
      />
    </button>
  );
}

function InputField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="text-xs text-stark-text-dim block mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-stark-bg border border-stark-border rounded-lg px-3 py-2 text-sm text-stark-text focus:border-stark-cyan focus:outline-none"
      />
    </div>
  );
}
