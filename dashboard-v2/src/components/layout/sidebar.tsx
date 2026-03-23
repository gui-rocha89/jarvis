'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Bot,
  MessageSquare,
  Brain,
  Users,
  Radio,
  Building2,
  Shield,
  Settings,
  Menu,
  X,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { apiGet } from '@/lib/api';

const navItems = [
  { href: '/', label: 'Visao Geral', icon: LayoutDashboard },
  { href: '/agents', label: 'Agentes', icon: Bot },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/memory', label: 'Memoria', icon: Brain },
  { href: '/groups', label: 'Grupos', icon: Users },
  { href: '/channels', label: 'Canais', icon: Radio },
  { href: '/clients', label: 'Clientes', icon: Building2 },
  { href: '/security', label: 'Seguranca', icon: Shield },
  { href: '/settings', label: 'Configuracoes', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const data = await apiGet<{ whatsapp?: string }>('/dashboard/health');
        setOnline(data?.whatsapp === 'connected');
      } catch {
        setOnline(false);
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  if (pathname === '/login') return null;

  const navContent = (
    <>
      {/* Logo */}
      <div className="p-4 border-b border-stark-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-stark-cyan to-stark-blue flex items-center justify-center">
            <span className="text-stark-bg font-bold text-lg" style={{ fontFamily: 'Orbitron, sans-serif' }}>J</span>
          </div>
          <div>
            <h1 className="text-sm font-bold text-stark-cyan" style={{ fontFamily: 'Orbitron, sans-serif' }}>
              JARVIS
            </h1>
            <p className="text-xs text-stark-dim">v5.0 Dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          {online === null ? (
            <div className="w-2 h-2 rounded-full bg-stark-dim animate-pulse" />
          ) : online ? (
            <>
              <Wifi className="w-3 h-3 text-stark-green" />
              <span className="text-xs text-stark-green">ONLINE</span>
            </>
          ) : (
            <>
              <WifiOff className="w-3 h-3 text-stark-red" />
              <span className="text-xs text-stark-red">OFFLINE</span>
            </>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${
                isActive
                  ? 'bg-stark-cyan/10 text-stark-cyan border border-stark-cyan/30'
                  : 'text-stark-text-dim hover:text-stark-text hover:bg-stark-panel'
              }`}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-stark-border">
        <p className="text-xs text-stark-dim text-center">
          Stream Lab &copy; {new Date().getFullYear()}
        </p>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-4 left-4 z-50 p-2 bg-stark-panel border border-stark-border rounded-lg md:hidden"
      >
        {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar - mobile */}
      <aside
        className={`fixed top-0 left-0 h-full w-64 bg-stark-panel border-r border-stark-border z-40 flex flex-col transition-transform md:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {navContent}
      </aside>

      {/* Sidebar - desktop */}
      <aside className="hidden md:flex w-64 min-h-screen bg-stark-panel border-r border-stark-border flex-col shrink-0">
        {navContent}
      </aside>
    </>
  );
}
