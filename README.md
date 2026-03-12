# Jarvis 2.0

**Agente de IA autônomo no WhatsApp** para a [Stream Lab](https://streamlab.com.br) — agência de marketing digital.

Personalidade inspirada no J.A.R.V.I.S. do Tony Stark: elegante, eficiente, com humor inteligente.

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![Claude](https://img.shields.io/badge/Claude_API-Anthropic-6B4FBB?logo=anthropic&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![CI/CD](https://img.shields.io/badge/CI%2FCD-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)

---

## Visão Geral

Jarvis funciona como um **gerente de projetos virtual 24/7** — recebe mensagens no WhatsApp, entende contexto, responde com inteligência e executa ações em ferramentas externas (Asana, Google Calendar).

### Destaques

- **4 Agentes Especializados** — Roteamento automático por intenção (Master, Creative, Manager, Researcher)
- **Memória Persistente** — Extração e consulta de fatos com 3 escopos (pessoas, conversas, operacional)
- **Aprendizado Passivo** — Aprende de TODA mensagem recebida, mesmo quando não responde
- **Voz Premium** — TTS via ElevenLabs + STT via Whisper, configurável pelo dashboard
- **Integrações Nativas** — Asana (gestão de projetos) + Google Calendar (captações)
- **Dashboard Seguro** — SPA com autenticação 2FA via WhatsApp, score de inteligência e gestão de memórias
- **Estudo Exaustivo** — Ingestão completa do Asana (projetos, tarefas, comentários) para base de conhecimento

---

## Arquitetura

```
                     ┌─────────────────────────┐
                     │   WhatsApp (Baileys v7)  │
                     └────────────┬────────────┘
                                  │
                     ┌────────────▼────────────┐
                     │     jarvis-v2.mjs        │
                     │   Entry Point + Express  │
                     └──┬────┬────┬────┬────┬──┘
                        │    │    │    │    │
              ┌─────────┘    │    │    │    └─────────┐
              ▼              ▼    ▼    ▼              ▼
          ┌───────┐    ┌────┐┌───┐┌───┐       ┌──────────┐
          │ Brain │    │Mem ││STT││ DB│       │  Skills  │
          │       │    │    ││TTS││   │       │ (Tools)  │
          └───┬───┘    └────┘└───┘└───┘       └──────────┘
              │              │                      │
     ┌────────┼────────┐     │         ┌────────────┼────────────┐
     ▼        ▼        ▼     ▼         ▼            ▼            ▼
 ┌───────┐┌───────┐┌──────┐┌─────┐┌────────┐┌──────────┐┌──────────┐
 │Master ││Creat. ││Manag.││Resr.││  Asana  ││  GCal    ││ Memórias │
 └───────┘└───────┘└──────┘└─────┘└────────┘└──────────┘└──────────┘
```

---

## Stack Tecnológica

| Camada | Tecnologia | Versão |
|--------|-----------|--------|
| Runtime | Node.js (ESM) | 20+ |
| WhatsApp | Baileys | v7 |
| IA Principal | Claude API (Anthropic) | Sonnet |
| IA Extração | Claude Haiku | - |
| TTS | ElevenLabs | v3 |
| STT | Whisper (OpenAI) | v1 |
| Banco de Dados | PostgreSQL | 16 |
| Cache | Redis | 7 |
| Gestão de Projetos | Asana API | v1 |
| Calendário | Google Calendar API | v3 |
| Processo | PM2 | - |
| Containers | Docker Compose | v2 |
| CI/CD | GitHub Actions | - |
| Dashboard | Tailwind CSS + Chart.js | SPA |

---

## Estrutura do Projeto

```
jarvis-v2.mjs                  # Entry point — WhatsApp + Express + Cron
src/
├── config.mjs                  # Configurações centrais (100% via .env)
├── database.mjs                # PostgreSQL — pool, initDB, CRUD
├── memory.mjs                  # Sistema de memória (Mem0-inspired)
├── brain.mjs                   # Cérebro IA + roteamento de agentes
├── audio.mjs                   # TTS (ElevenLabs/OpenAI) + STT (Whisper)
├── profiles.mjs                # Síntese de perfis (clientes, equipe)
├── batch-asana.mjs             # Estudo exaustivo do Asana
├── helpers.mjs                 # Utilitários (getMediaType, extractSender)
├── agents/
│   └── master.mjs              # Prompts dos 4 agentes + classificador
└── skills/
    └── loader.mjs              # Tools do Claude (Asana + GCal)
dashboard/
└── index.html                  # SPA do dashboard (Tailwind, Chart.js)
tests/
└── unit.test.mjs               # Suite de testes (25 casos + scan de credenciais)
.github/workflows/
├── ci.yml                      # CI — lint + testes
└── deploy.yml                  # CD — rsync + PM2 restart via SSH
docker-compose.yml              # PostgreSQL 16 + Redis 7
```

---

## Instalação

### Pré-requisitos

- Node.js 20+
- Docker + Docker Compose v2
- FFmpeg (conversão de áudio para PTT do WhatsApp)
- PM2 (`npm install -g pm2`)

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

# 5. Iniciar com PM2
pm2 start jarvis-v2.mjs --name jarvis
pm2 save
```

### Variáveis de Ambiente

Copie `.env.example` e configure todas as variáveis. As principais:

| Variável | Descrição | Obrigatória |
|----------|-----------|:-----------:|
| `ANTHROPIC_API_KEY` | Chave da API Claude | ✅ |
| `OPENAI_API_KEY` | Chave OpenAI (Whisper + TTS fallback) | ✅ |
| `ELEVENLABS_API_KEY` | Chave ElevenLabs (TTS primário) | ✅ |
| `ELEVENLABS_VOICE_ID` | ID da voz no ElevenLabs | ✅ |
| `ASANA_PAT` | Personal Access Token do Asana | ✅ |
| `ASANA_WORKSPACE` | GID do workspace Asana | ✅ |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | PostgreSQL | ✅ |
| `REDIS_PASSWORD` | Senha do Redis | ✅ |
| `JWT_SECRET` | Secret para tokens JWT do dashboard | ✅ |
| `API_KEY` | Chave interna da API REST | ✅ |
| `AI_MODEL` | Modelo principal (ex: `claude-sonnet-4-20250514`) | ✅ |
| `MEMORY_MODEL` | Modelo de extração (ex: `claude-3-haiku-20240307`) | ✅ |

> Consulte `.env.example` para a lista completa com valores de exemplo.

---

## Agentes

O Jarvis classifica a intenção de cada mensagem e roteia para o agente especializado:

| Agente | Especialidade | Triggers |
|--------|--------------|----------|
| **Master** | Conversação geral, personalidade, humor | Default (quando nenhum outro se aplica) |
| **Creative** | Copy, legendas, roteiros, CTAs | copy, arte, conteúdo, post, legenda... |
| **Manager** | Gestão de projetos, prazos, Asana | tarefa, prazo, status, cobrança... |
| **Researcher** | Pesquisa, dados, tendências | pesquisar, dados, benchmark, análise... |

---

## API REST

**Porta:** configurada via `API_PORT` (default: 3100)

### Autenticação

- **API interna:** header `x-api-key`
- **Dashboard:** `Authorization: Bearer <JWT>` (obtido via login + 2FA)

### Endpoints Públicos

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/dashboard/auth/status` | Verifica se existe conta cadastrada |
| `POST` | `/dashboard/auth/setup` | Cadastro inicial (funciona apenas 1x) |
| `POST` | `/dashboard/auth/login` | Login → envia código 2FA via WhatsApp |
| `POST` | `/dashboard/auth/verify` | Valida 2FA → retorna JWT (8h) |

### Endpoints Protegidos

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/status` | Status geral do bot |
| `POST` | `/send/text` | Enviar mensagem de texto |
| `POST` | `/send/audio` | Enviar áudio via TTS |
| `GET` | `/dashboard/health` | Health check |
| `GET` | `/dashboard/intelligence` | Score de inteligência (6 eixos + patente) |
| `GET/POST` | `/dashboard/voice` | Configurações de voz |
| `GET` | `/dashboard/memory` | Estatísticas de memória |
| `GET` | `/dashboard/memory/search` | Buscar memórias |
| `GET` | `/dashboard/memory/recent` | Memórias recentes |
| `POST` | `/dashboard/memory/add` | Adicionar memória manualmente |
| `POST` | `/dashboard/chat` | Chat com Jarvis via dashboard |
| `GET` | `/dashboard/profiles` | Listar perfis sintetizados |
| `POST` | `/dashboard/asana/study/start` | Iniciar estudo exaustivo do Asana |
| `GET` | `/dashboard/asana/study/status` | Progresso do estudo em tempo real |
| `POST` | `/dashboard/asana/study/stop` | Parar estudo |

---

## Dashboard

SPA com interface temática do JARVIS (Iron Man). Funcionalidades:

- **Score de Inteligência** — Radar com 6 eixos + sistema de patentes (Recruta → Diretor da S.H.I.E.L.D.)
- **Gestão de Memórias** — Busca, filtro por escopo, adição manual
- **Configuração de Voz** — Sliders para stability, similarity, style (ElevenLabs)
- **Chat Integrado** — Conversar com Jarvis diretamente pelo dashboard
- **Estudo do Asana** — Painel com progresso em tempo real (projetos, tarefas, comentários)
- **Perfis** — Visualização de perfis sintetizados (clientes, equipe, processos)
- **Segurança** — Login com 2FA via WhatsApp, log de acessos com geolocalização

---

## Segurança

### Autenticação do Dashboard
1. **Email + Senha** — hash bcrypt (custo 12)
2. **2FA via WhatsApp** — código de 6 dígitos, expira em 5 minutos
3. **JWT** — token com expiração de 8 horas

### Proteções
- Bloqueio após 5 tentativas (lockout de 15 minutos)
- Rate limiting: 10 tentativas/min por IP
- Alerta via WhatsApp para IPs desconhecidos
- Geolocalização de acessos via ip-api.com
- **Zero segredos no código** — scan automático nos testes

### Arquivos Sensíveis (NÃO versionados)
- `.env` — todas as credenciais
- `auth_session/` — sessão do WhatsApp
- `google-calendar-key.json` — service account do GCal
- `audio_files/` — áudios temporários

---

## CI/CD

```
git push origin master
  │
  ├─ CI (ci.yml)
  │   ├─ Node 20 + npm ci
  │   └─ npm test (25 testes + scan de credenciais)
  │
  └─ Deploy (deploy.yml) — executa apenas se CI passou
      ├─ SSH via chave Ed25519 (GitHub Secrets)
      ├─ rsync (exclui .env, auth_session, node_modules)
      ├─ npm ci --production
      └─ PM2 restart
```

**Secrets necessários no GitHub:**
- `VPS_SSH_KEY` — chave privada Ed25519
- `VPS_HOST` — IP do servidor
- `VPS_USER` — usuário SSH

---

## Testes

```bash
npm test
```

**25 casos de teste cobrindo:**
- Detecção de tipos de mídia (`getMediaType`)
- Extração de remetente em DMs e grupos (`extractSender`)
- Validação de respostas do Jarvis (`isValidResponse`)
- Roteamento de agentes por intenção (`classifyIntent`)
- Documentação do `.env.example`
- **Scan de credenciais** — varre todos os `.mjs` por chaves/tokens hardcoded

---

## Docker

```bash
# Subir serviços
docker compose up -d

# Verificar status
docker compose ps

# Logs
docker compose logs -f

# Parar
docker compose down
```

| Serviço | Imagem | Porta | Volume |
|---------|--------|-------|--------|
| PostgreSQL | `postgres:16-alpine` | `127.0.0.1:5432` | `postgres_data` |
| Redis | `redis:7-alpine` | `127.0.0.1:6379` | `redis_data` |

Ambos com health check e bind exclusivo em localhost (sem exposição externa).

---

## PM2

```bash
pm2 start jarvis-v2.mjs --name jarvis   # Iniciar
pm2 restart jarvis                        # Reiniciar
pm2 logs jarvis                           # Logs em tempo real
pm2 status                                # Status
pm2 save                                  # Salvar processos
```

---

## Licença

Projeto privado da Stream Lab. Todos os direitos reservados.
