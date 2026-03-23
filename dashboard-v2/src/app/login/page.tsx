'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api';
import { Lock, Mail, KeyRound, Loader2 } from 'lucide-react';

type Step = 'credentials' | 'verify';

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tempToken, setTempToken] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await apiPost<{ tempToken?: string; error?: string }>(
        '/dashboard/auth/login',
        { email, password }
      );
      if (data.error) {
        setError(data.error);
      } else if (data.tempToken) {
        setTempToken(data.tempToken);
        setStep('verify');
      }
    } catch {
      setError('Erro ao conectar com o servidor');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await apiPost<{ token?: string; error?: string }>(
        '/dashboard/auth/verify',
        { tempToken, code }
      );
      if (data.error) {
        setError(data.error);
      } else if (data.token) {
        localStorage.setItem('jarvis_token', data.token);
        router.push('/');
      }
    } catch {
      setError('Erro ao verificar o codigo');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen -m-4 md:-m-6">
      <div className="w-full max-w-md p-8">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-stark-cyan to-stark-blue flex items-center justify-center mx-auto mb-4 glow-cyan">
            <span className="text-stark-bg font-bold text-2xl" style={{ fontFamily: 'Orbitron, sans-serif' }}>J</span>
          </div>
          <h1 className="text-2xl font-bold text-stark-cyan" style={{ fontFamily: 'Orbitron, sans-serif' }}>
            JARVIS
          </h1>
          <p className="text-sm text-stark-dim mt-1">Dashboard de Controle</p>
        </div>

        {/* Form */}
        <div className="bg-stark-panel border border-stark-border rounded-xl p-6">
          {step === 'credentials' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs text-stark-dim mb-1.5">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stark-dim" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-stark-bg border border-stark-border rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-stark-cyan transition-colors"
                    placeholder="seu@email.com"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-stark-dim mb-1.5">Senha</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stark-dim" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-stark-bg border border-stark-border rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-stark-cyan transition-colors"
                    placeholder="********"
                    required
                  />
                </div>
              </div>
              {error && <p className="text-xs text-stark-red">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 bg-gradient-to-r from-stark-cyan to-stark-blue text-stark-bg font-bold rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Entrar
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="space-y-4">
              <p className="text-sm text-stark-text-dim text-center">
                Codigo de verificacao enviado via WhatsApp
              </p>
              <div>
                <label className="block text-xs text-stark-dim mb-1.5">Codigo 2FA</label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stark-dim" />
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-full bg-stark-bg border border-stark-border rounded-lg pl-10 pr-4 py-2.5 text-sm text-center tracking-[0.5em] focus:outline-none focus:border-stark-cyan transition-colors"
                    placeholder="000000"
                    maxLength={6}
                    required
                  />
                </div>
              </div>
              {error && <p className="text-xs text-stark-red">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 bg-gradient-to-r from-stark-cyan to-stark-blue text-stark-bg font-bold rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Verificar
              </button>
              <button
                type="button"
                onClick={() => { setStep('credentials'); setError(''); }}
                className="w-full py-2 text-sm text-stark-dim hover:text-stark-text transition-colors"
              >
                Voltar
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
