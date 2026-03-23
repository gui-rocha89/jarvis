'use client';

import { useState, useRef, useEffect } from 'react';
import { apiPost } from '@/lib/api';
import { Send, Mic, Loader2, Bot, User } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const data = await apiPost<{ response?: string; text?: string }>(
        '/dashboard/chat',
        { message: text }
      );
      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.response || data.text || 'Sem resposta',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Erro ao enviar mensagem. Tente novamente.',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] pt-10 md:pt-0">
      <h1 className="text-xl font-bold text-stark-cyan mb-4" style={{ fontFamily: 'Orbitron, sans-serif' }}>
        Chat
      </h1>

      {/* Messages area */}
      <div className="flex-1 overflow-auto bg-stark-panel border border-stark-border rounded-xl p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-stark-dim">
            <Bot className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">Envie uma mensagem para o Jarvis</p>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'assistant' && (
              <div className="w-8 h-8 rounded-lg bg-stark-cyan/10 flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-stark-cyan" />
              </div>
            )}
            <div
              className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-stark-blue/20 border border-stark-blue/30'
                  : 'bg-stark-bg border border-stark-border'
              }`}
            >
              {msg.content}
            </div>
            {msg.role === 'user' && (
              <div className="w-8 h-8 rounded-lg bg-stark-blue/10 flex items-center justify-center shrink-0">
                <User className="w-4 h-4 text-stark-blue" />
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-lg bg-stark-cyan/10 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-stark-cyan" />
            </div>
            <div className="bg-stark-bg border border-stark-border rounded-xl px-4 py-2.5">
              <Loader2 className="w-4 h-4 animate-spin text-stark-cyan" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={sendMessage} className="mt-3 flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Digite uma mensagem..."
          className="flex-1 bg-stark-panel border border-stark-border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-stark-cyan transition-colors"
          disabled={loading}
        />
        <button
          type="button"
          className="p-2.5 bg-stark-panel border border-stark-border rounded-lg text-stark-dim hover:text-stark-cyan transition-colors"
          title="Modo voz (em breve)"
        >
          <Mic className="w-5 h-5" />
        </button>
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="p-2.5 bg-gradient-to-r from-stark-cyan to-stark-blue rounded-lg text-stark-bg hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Send className="w-5 h-5" />
        </button>
      </form>
    </div>
  );
}
