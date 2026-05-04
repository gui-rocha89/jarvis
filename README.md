# Jarvis 6.0

**Agente de IA multi-canal autônomo** para a [Stream Lab](https://streamlab.com.br) — laboratório criativo de marketing.

Personalidade inspirada no J.A.R.V.I.S. do Tony Stark: elegante, eficiente, com humor inteligente.

> **v6.0 — "Da Memória ao Conhecimento"** · Foco em **CONFIABILIDADE + INTELIGÊNCIA REAL**: Knowledge Graph, Profile Real-Time, Cross-Channel Identity, Anti-Leak v4, Task Copilot, Cost Tracking + Health Monitoring.

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![Claude](https://img.shields.io/badge/Claude_API-Anthropic-6B4FBB?logo=anthropic&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16+pgvector-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![CI/CD](https://img.shields.io/badge/CI%2FCD-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)
![Meta](https://img.shields.io/badge/Meta_Ads-Graph_API-1877F2?logo=meta&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)

---

## Visão Geral

Jarvis funciona como um **gerente de projetos virtual 24/7** — recebe mensagens em múltiplos canais (WhatsApp, Instagram, Email), entende contexto, responde com inteligência e executa ações em ferramentas externas (Asana, Google Calendar, Meta Ads).

### 🆕 Destaques v6.0

- **Knowledge Graph** — Conhecimento estruturado por tipo (cliente, sub-marca, projeto, ferramenta, evento, campanha, processo, decisão, pessoa). Migração custo-zero a partir de dados existentes
- **Anti-Leak v4** — Filtro inteligente: match exato com nome do sender + consulta KG. Lead com mesmo nome de membro da equipe não bloqueia mais
- **Profile Real-Time** — Profile atualizado em background ao final de cada mensagem. Sem mais defasagem de 6h
- **Cross-Channel Identity** — Mesma pessoa em WhatsApp + Instagram + Email = mesma identidade canônica (`contact_aliases`)
- **Task Copilot** — Co-piloto, não cobrador. Daily 08:50 motivacional, cobrança leve 3/6/9d, ofertas de ajuda contextuais
- **Robustez Operacional** — Boot validation de modelos (alerta deprecado), health check 5min com alerta WhatsApp, retry com fallback
- **Cost Tracking End-to-End** — Tabela `api_costs`, endpoint `/dashboard/costs`, estimativa USD por modelo/dia/cliente
- **Histórico de Chat Persistente** — `dashboard_chat_history` no PostgreSQL, sobrevive a restart
- **Dashboard UI Expandido** — 3 abas novas: Conhecimento, Custos, Saúde

### Destaques v5.0 (mantidos)

- **Multi-canal** — WhatsApp (interno + público), Instagram DM, Email (IMAP/SMTP), Dashboard Web, Voz (WebSocket)
- **6 Agentes Especializados** — Master, Creative, Manager, Researcher, Traffic e Social — roteamento automático por intenção
- **Memória Semântica (pgvector)** — Busca híbrida (vetorial + texto) com embeddings OpenAI, backfill automático
- **Atendimento Público + Showcase Mode** — Leads no WhatsApp DM com limite de 20 mensagens, horário comercial. "Quero conhecer o Jarvis" ativa modo apresentação com Opus
- **Handoff Equipe** — Equipe silencia Jarvis por lead ("eu assumo") e reativa ("Jarvis volta")
- **Autonomia Nível 2** — Move tasks entre seções e atribui responsáveis no Asana, com escalação em 3 níveis
- **Webhooks Asana** — Eventos em tempo real: tasks concluídas, criadas, sem responsável
- **WebSocket Voice** — Streaming de voz bidirecional com interrupção, latência < 2s
- **MCP Server** — 6 tools via Model Context Protocol para integração com Claude Code, Cursor, etc.
- **Dashboard v2** — Next.js 16 + TypeScript + Tailwind com 9 páginas
- **Meta Ads Multi-cliente** — Gerencia campanhas via Graph API v25.0 para 15+ clientes, descoberta automática de páginas
- **Menções Inteligentes** — Sistema de @menções com resolução fuzzy (Levenshtein), mapeamento massivo
- **Agent Loop Real** — Executa tools em loop até completar a tarefa (máx 10 iterações)
- **Extended Thinking** — Raciocina profundamente antes de responder (4K-8K tokens de thinking)
- **Prompt Caching** — System prompts estáticos são cacheados para economia e velocidade
- **Model Routing** — Seleciona automaticamente Opus (complexo) ou Sonnet (simples) por query
- **21+ Tools** — Asana, Google Calendar, Meta Ads, WhatsApp, memórias, autonomia, Knowledge Graph, geração de imagens/stickers

---

## Arquitetura

```
                     ┌──────────────────────────────────────────────────┐
                     │                   CANAIS                        │
                     │  WhatsApp  │  Instagram  │  Email  │  Dashboard │
                     └──────────────────┬───────────────────────────────┘
                                        │
                     ┌──────────────────▼───────────────────┐
                     │          jarvis-v2.mjs                │
                     │   Entry Point + Express + WebSocket   │
                     └──┬────┬────┬────┬────┬────┬────┬────┘
                        │    │    │    │    │    │    │
              ┌─────────┘    │    │    │    │    │    └─────────┐
              ▼              ▼    ▼    ▼    ▼    ▼              ▼
          ┌───────┐    ┌────┐┌───┐┌───┐┌────┐┌──────┐    ┌──────────┐
          │ Brain │    │Mem ││STT││ DB││pgv ││Webhk │    │  Skills  │
          │(Loop) │    │    ││TTS││   ││    ││      │    │ (15 Tools│
          └───┬───┘    └────┘└───┘└───┘└────┘└──────┘    └──────────┘
              │              │                      │
     ┌────────┼────────┐     │    ┌─────────────────┼──────────────────┐
     ▼        ▼        ▼     ▼    ▼        ▼        ▼        ▼        ▼
 ┌──────┐┌──────┐┌──────┐┌─────┐┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐
 │Master││Creat.││Manag.││Resr.││Traff.││Social││ Asana││ GCal ││ Meta │
 └──────┘└──────┘└──────┘└─────┘└──────┘└──────┘└──────┘└──────┘└──────┘
```

---

## Stack Tecnológica

| Camada | Tecnologia | Versão |
|--------|-----------|--------|
| Runtime | Node.js (ESM) | 20+ |
| WhatsApp | Baileys | v7 |
| IA Principal | Claude API (Anthropic) | Sonnet 4 + Opus 4 |
| IA Extração | Claude Haiku | - |
| Embeddings | OpenAI text-embedding-3-small | 1536 dims |
| TTS | ElevenLabs | v3 |
| STT | Whisper (OpenAI) | v1 |
| Banco de Dados | PostgreSQL + pgvector | 16 |
| Cache | Redis | 7 |
| Gestão de Projetos | Asana API + Webhooks | v1 |
| Calendário | Google Calendar API | v3 |
| Tráfego Pago | Meta Graph API | v25.0 |
| Instagram | Meta Graph API (Messaging) | v25.0 |
| Email | IMAP (imapflow) + SMTP (nodemailer) | - |
| WebSocket | ws | v8 |
| MCP | @modelcontextprotocol/sdk | v1 |
| Segurança | helmet + cors + JWT + bcrypt | - |
| Processo | PM2 | - |
| Containers | Docker Compose | v2 |
| CI/CD | GitHub Actions | - |
| Dashboard v1 | Tailwind CSS + Chart.js | SPA |
| Dashboard v2 | Next.js + React + TypeScript + Tailwind | 16 |

---

## Estrutura do Projeto

```
jarvis-v2.mjs                     # Entry point — WhatsApp + Express + Cron + WebSocket
src/
├── config.mjs                    # Configurações centrais (100% via .env)
├── database.mjs                  # PostgreSQL — pool, initDB, CRUD
├── memory.mjs                    # Memória semântica (Mem0 + pgvector)
├── brain.mjs                     # Cérebro IA — Agent Loop + Proativo + Público + Anti-leak v3
├── brain-document.mjs            # Documento de contexto do cérebro
├── audio.mjs                     # TTS (ElevenLabs/OpenAI) + STT (Whisper)
├── profiles.mjs                  # Síntese de perfis
├── batch-asana.mjs               # Estudo exaustivo do Asana
├── asana-email-monitor.mjs       # Monitor de @menções do Asana via IMAP
├── helpers.mjs                   # Utilitários
├── mcp-server.mjs                # MCP Server — 6 tools (entry point separado)
├── agents/
│   └── master.mjs                # Identidade + 7 canais + 6 agentes + classificador
├── channels/
│   ├── instagram.mjs             # Canal Instagram DM
│   └── email.mjs                 # Canal Email (IMAP/SMTP)
├── webhooks/
│   └── asana-webhook.mjs         # Webhooks Asana (eventos em tempo real)
└── skills/
    ├── loader.mjs                # 15 tools do Claude
    └── meta-ads.mjs              # Meta Ads — Graph API multi-cliente
dashboard/
└── index.html                    # Dashboard v1 (SPA)
dashboard-v2/                     # Dashboard v2 (Next.js 16 + TypeScript)
├── src/app/                      # 9 páginas
├── src/components/               # Componentes React
└── src/lib/                      # API client, utils
tests/
└── unit.test.mjs                 # 60+ testes + scan de credenciais
.github/workflows/
├── ci.yml                        # CI — Node 20, npm ci, npm test
└── deploy.yml                    # CD — rsync + PM2 restart
docker-compose.yml                # PostgreSQL 16 + Redis 7
```

---

## Instalação

### Pré-requisitos

- Node.js 20+
- Docker + Docker Compose v2
- FFmpeg (conversão de áudio para PTT do WhatsApp)
- PM2 (`npm install -g pm2`)
- PostgreSQL com extensão pgvector (opcional, para busca semântica)

### Setup

```bash
# 1. Clonar o repositório
git clone https://github.com/gui-rocha89/jarvis.git /opt/jarvis
cd /opt/jarvis

# 2. Instalar dependências
npm ci

# 3. Configurar variáveis de ambiente
cp .env.example .env
# Preencher TODAS as variáveis obrigatórias (ver seção abaixo)

# 4. Subir PostgreSQL e Redis
docker compose up -d

# 5. (Opcional) Instalar pgvector no PostgreSQL
docker exec -it jarvis-postgres-1 psql -U jarvis -c "CREATE EXTENSION IF NOT EXISTS vector"

# 6. Iniciar com PM2
pm2 start jarvis-v2.mjs --name jarvis
pm2 save

# 7. (Opcional) Iniciar MCP Server
node src/mcp-server.mjs

# 8. (Opcional) Dashboard v2
cd dashboard-v2 && npm ci && npm run dev
```

### Variáveis de Ambiente

Copie `.env.example` e configure todas as variáveis. As principais:

| Variável | Descrição | Obrigatória |
|----------|-----------|:-----------:|
| `ANTHROPIC_API_KEY` | Chave da API Claude | Sim |
| `OPENAI_API_KEY` | Chave OpenAI (Whisper + TTS fallback + Embeddings) | Sim |
| `ELEVENLABS_API_KEY` | Chave ElevenLabs (TTS primário) | Sim |
| `ELEVENLABS_VOICE_ID` | ID da voz no ElevenLabs | Sim |
| `ASANA_PAT` | Personal Access Token do Asana | Sim |
| `ASANA_WORKSPACE` | GID do workspace Asana | Sim |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | PostgreSQL | Sim |
| `REDIS_PASSWORD` | Senha do Redis | Sim |
| `JWT_SECRET` | Secret para tokens JWT do dashboard | Sim |
| `JARVIS_API_KEY` | Chave interna da API REST | Sim |
| `AI_MODEL` | Modelo principal (ex: `claude-sonnet-4-6`) | Sim |
| `AI_MODEL_STRONG` | Modelo forte (ex: `claude-opus-4-0-20250514`) | Sim |
| `MEMORY_MODEL` | Modelo de extração (ex: `claude-3-haiku-20240307`) | Sim |
| `META_ACCESS_TOKEN` | Token Meta Ads (longa duração) | Opcional |
| `INSTAGRAM_VERIFY_TOKEN` | Token de verificação webhook Instagram | Opcional |
| `EMAIL_IMAP_HOST`, `EMAIL_USER`, `EMAIL_PASSWORD` | Email channel (IMAP/SMTP) | Opcional |

> Consulte `.env.example` para a lista completa com valores de exemplo.

---

## Agentes

O Jarvis classifica a intenção de cada mensagem e roteia para o agente especializado:

| Agente | Especialidade | Triggers |
|--------|--------------|----------|
| **Traffic** | Tráfego pago, Meta Ads, campanhas, métricas | campanha, CPC, CTR, ROAS, ads, verba... |
| **Social** | Social media, publicação, calendário editorial | publicar, agendar, post, stories, engajamento... |
| **Creative** | Copy, legendas, roteiros, CTAs | copy, arte, conteúdo, legenda, roteiro... |
| **Manager** | Gestão de projetos, prazos, Asana | tarefa, prazo, status, cobrança... |
| **Researcher** | Pesquisa, dados, tendências | pesquisar, dados, benchmark, análise... |
| **Master** | Conversação geral, personalidade | Default (quando nenhum outro se aplica) |

---

## API REST

**Porta:** configurada via `API_PORT` (default: 3100)

### Autenticação

- **API interna:** header `x-api-key`
- **Dashboard:** `Authorization: Bearer <JWT>` (obtido via login + 2FA)

### Endpoints Principais

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST` | `/dashboard/auth/login` | Login → envia código 2FA via WhatsApp |
| `POST` | `/dashboard/auth/verify` | Valida 2FA → retorna JWT |
| `GET` | `/status` | Status geral do bot |
| `POST` | `/send/text` | Enviar mensagem de texto |
| `POST` | `/dashboard/chat` | Chat com Jarvis via dashboard |
| `GET` | `/dashboard/memory/search` | Buscar memórias (híbrido) |
| `POST` | `/dashboard/memory/backfill` | Gerar embeddings em batch |
| `POST` | `/webhooks/asana` | Webhook Asana (eventos em tempo real) |
| `POST` | `/webhooks/instagram` | Webhook Instagram DM |
| `POST` | `/dashboard/webhooks/register` | Registrar webhooks Asana |
| `GET` | `/dashboard/email-channel` | Status do monitor de email |
| `WS` | `/ws/voice` | WebSocket voice streaming |

> Consulte `CLAUDE.md` seção 8 para a lista completa de endpoints.

---

## MCP Server

O Jarvis expõe 6 tools via Model Context Protocol para integração com ferramentas externas:

```bash
# Executar como processo separado
node src/mcp-server.mjs
```

Tools disponíveis: `jarvis_send_message`, `jarvis_search_memories`, `jarvis_create_task`, `jarvis_get_client_status`, `jarvis_get_metrics`, `jarvis_memory_stats`.

---

## Dashboard

### v1 (Produção)
SPA com interface temática do JARVIS (Iron Man). Acesso via **guardiaolab.com.br**.

### v2 (Desenvolvimento)
Next.js 16 + TypeScript + React 19 + Tailwind. 9 páginas: Home, Login, Agentes, Chat, Clientes, Grupos, Memória, Segurança, Configurações.

```bash
cd dashboard-v2 && npm run dev
```

---

## Docker

```bash
docker compose up -d       # Subir serviços
docker compose ps          # Verificar status
docker compose logs -f     # Logs
docker compose down        # Parar
```

| Serviço | Imagem | Porta | Volume |
|---------|--------|-------|--------|
| PostgreSQL | `postgres:16-alpine` | `127.0.0.1:5432` | `postgres_data` |
| Redis | `redis:7-alpine` | `127.0.0.1:6379` | `redis_data` |

Ambos com health check e bind exclusivo em localhost (sem exposição externa).

---

## CI/CD

```
git push origin master
  │
  ├─ CI (ci.yml)
  │   ├─ Node 20 + npm ci
  │   └─ npm test (60+ testes + scan de credenciais)
  │
  └─ Deploy (deploy.yml) — executa apenas se CI passou
      ├─ SSH via chave Ed25519 (GitHub Secrets)
      ├─ rsync (exclui .env, auth_session, node_modules)
      ├─ npm ci --production
      └─ PM2 restart
```

---

## Testes

```bash
npm test
```

60+ casos de teste cobrindo: helpers, validação, roteamento de agentes, clientes gerenciados, agente proativo, anti-alucinação, model routing, mídia/upload, estrutura e scan de credenciais.

---

## Segurança

- Autenticação 2FA via WhatsApp (código 6 dígitos, expira 5min)
- JWT com expiração de 8 horas
- Bloqueio após 5 tentativas (lockout 15 minutos)
- Rate limiting por IP
- helmet (headers HTTP) + cors (controle de origem)
- Anti-vazamento de informações internas em todos os canais externos
- Zero segredos no código — scan automático no CI
- Geolocalização de acessos

---

## Contribuindo

1. Ler `CLAUDE.md` inteiro antes de qualquer alteração
2. Seguir a arquitetura de prompts (JARVIS_IDENTITY + CHANNEL_CONTEXT)
3. NUNCA criar system prompts novos fora de `master.mjs`
4. NUNCA alterar descrições de tasks no Asana
5. NUNCA fazer deploy manual (somente `git push`)
6. Rodar `npm test` antes de commitar
7. Português sempre com acentos

---

## Changelog

Consulte `CLAUDE.md` seção 15 para o changelog completo.

---

## Licença

Projeto privado da Stream Lab. Todos os direitos reservados.
