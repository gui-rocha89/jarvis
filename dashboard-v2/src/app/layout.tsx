import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/layout/sidebar';

export const metadata: Metadata = {
  title: 'JARVIS Dashboard',
  description: 'Painel de controle do Jarvis - Stream Lab',
  icons: { icon: '/favicon.ico' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Orbitron:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 p-4 md:p-6 overflow-auto">{children}</main>
      </body>
    </html>
  );
}
