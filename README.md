# Jarvis 4.0

**Agente de IA multi-agente autônomo no WhatsApp** para a [Stream Lab](https://streamlab.com.br) — laboratório criativo de marketing.

Personalidade inspirada no J.A.R.V.I.S. do Tony Stark: elegante, eficiente, com humor inteligente.

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![Claude](https://img.shields.io/badge/Claude_API-Anthropic-6B4FBB?logo=anthropic&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![CI/CD](https://img.shields.io/badge/CI%2FCD-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)
![Meta](https://img.shields.io/badge/Meta_Ads-Graph_API-1877F2?logo=meta&logoColor=white)

---

## Visão Geral

Jarvis funciona como um **gerente de projetos virtual 24/7** — recebe mensagens no WhatsApp, entende contexto, responde com inteligência e executa ações em ferramentas externas (Asana, Google Calendar, Meta Ads).

### Destaques v4.0

- **6 Agentes Especializados** — Master, Creative, Manager, Researcher, **Traffic** e **Social** — roteamento automático por intenção
- **Meta Ads Multi-cliente** — Gerencia campanhas de tráfego pago para 15+ clientes via Graph API v25.0
- **Menções Inteligentes** — Sistema de @menções no WhatsApp com resolução fuzzy (Levenshtein ≤ 2) e mapeamento massivo de contatos
- **Anti-vazamento** — Filtro duplo (prompt reforçado + código) impede exposição de informações internas em grupos de clientes
- **Agent Loop Real** — Executa tools em loop `while(tool_use)` até completar a tarefa (máx 10 iterações), igual à Claude Code
- **Extended Thinking** — Raciocina profundamente antes de responder (4K-8K tokens de thinking)
- **Interleaved Thinking** — Pensa entre cada tool call, não apenas no início
- **Prompt Caching** — System prompts estáticos são cacheados para economia e velocidade
- **Model Routing** — Seleciona automaticamente Opus (complexo) ou Sonnet (simples) por query
- **Agente Proativo** — Opera autonomamente em grupos de clientes autorizados: detecta demandas, cria tasks no Asana, notifica a equipe
- **Memória Persistente** — Extração e consulta de fatos com 3 escopos (pessoas, conversas, operacional)
- **Aprendizado Passivo** — Aprende de TODA mensagem recebida, mesmo quando não responde
- **Voz Premium** — TTS via ElevenLabs + STT via Whisper, configurável pelo dashboard
- **Dashboard Seguro** — SPA com autenticação 2FA via WhatsApp, score de inteligência e gestão de memórias
- **13 Tools** — Asana, Google Calendar, Meta Ads, WhatsApp (envio com menções), memórias

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
          │(Loop) │    │    ││TTS││   │       │ (Tools)  │
          └───┬───┘    └────┘└───┘└───┘       └──────────┘
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
| TTS | ElevenLabs | v3 |
| STT | Whisper (OpenAI) | v1 |
| Banco de Dados | PostgreSQL | 16 |
| Cache | Redis | 7 |
| Gestão de Projetos | Asana API | v1 |
| Calendário | Google Calendar API | v3 |
| Tráfego Pago | Meta Graph API | v25.0 |
| Processo | PM2 | - |
| Containers | Docker Compose | v2 |
| CI/CD | GitHub Actions | - |
| Dashboard | Tailwind CSS + Chart.js | SPA |

---

## Estrutura do Projeto

```
jarvis-v2.mjs                     # Entry point — WhatsApp + Express + Cron + Mapeamento
src/
├── config.mjs                    # Configurações centrais (100% via .env)
├── database.mjs                  # PostgreSQL — pool, initDB, CRUD
├── memory.mjs                    # Sistema de memória (Mem0-inspired)
├── brain.mjs                     # Cérebro IA — Agent Loop + Extended Thinking + Anti-leak
├── audio.mjs                     # TTS (ElevenLabs/OpenAI) + STT (Whisper)
├── profiles.mjs                  # Síntese de perfis (clientes, equipe, processos)
├── batch-asana.mjs               # Estudo exaustivo do Asana (3 fases, resumível)
├── helpers.mjs                   # Utilitários (getMediaType, extractSender)
├── agents/
│   └── master.mjs                # Prompts dos 6 agentes + classificador de intenção
└── skills/
    ├── loader.mjs                # 13 Tools do Claude (Asana + GCal + Meta + WhatsApp)
    └── meta-ads.mjs              # Meta Ads — Graph API wrapper multi-cliente
dashboard/
└── index.html                    # SPA do dashboard (Tailwind, Chart.js)
tests/
└── unit.test.mjs                 # Suite de testes (47 casos + scan de credenciais)
.github/workflows/
├── ci.yml                        # CI — Node 20, npm ci, npm test
└── deploy.yml                    # CD — rsync + PM2 restart via SSH
docker-compose.yml                # PostgreSQL 16 + Redis 7
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
| `AI_MODEL` | Modelo principal (ex: `claude-sonnet-4-6`) | ✅ |
| `AI_MODEL_STRONG` | Modelo forte (ex: `claude-opus-4-0-20250514`) | ✅ |
| `MEMORY_MODEL` | Modelo de extração (ex: `claude-3-haiku-20240307`) | ✅ |
| `META_ACCESS_TOKEN` | Token Meta Ads (longa duração) | ⚙️ |
| `META_AD_ACCOUNT_ID` | ID da conta de anúncios | ⚙️ |
| `META_PAGES_MAP` | JSON: cliente → Page ID | ⚙️ |

> Consulte `.env.example` para a lista completa com valores de exemplo.

---

## Agentes

O Jarvis classifica a intenção de cada mensagem e roteia para o agente especializado:

| Agente | Especialidade | Triggers |
|--------|--------------|----------|
| **Traffic** 📈 | Tráfego pago, Meta Ads, campanhas, métricas | campanha, CPC, CTR, ROAS, ads, verba... |
| **Social** 📱 | Social media, publicação, calendário editorial | publicar, agendar, post, stories, engajamento... |
| **Creative** 🎨 | Copy, legendas, roteiros, CTAs | copy, arte, conteúdo, legenda, roteiro... |
| **Manager** 📋 | Gestão de projetos, prazos, Asana | tarefa, prazo, status, cobrança... |
| **Researcher** 🔬 | Pesquisa, dados, tendências | pesquisar, dados, benchmark, análise... |
| **Master** 🎯 | Conversação geral, personalidade | Default (quando nenhum outro se aplica) |
| **Proativo** 🤖 | Operação autônoma em grupos de clientes | Ativado por autorização do dono |

### Tools Disponíveis (13)

| Tool | Agente | Descrição |
|------|--------|-----------|
| `criar_campanha` | Traffic | Cria campanha Meta Ads (sempre pausada) |
| `relatorio_ads` | Traffic | Relatório de métricas (CPC, CTR, ROAS, CPA) |
| `pausar_campanha` | Traffic | Pausa ou retoma campanha |
| `otimizar_campanha` | Traffic | Sugestões de otimização |
| `agendar_post` | Social | Publica ou agenda post FB/IG |
| `calendario_editorial` | Social | Consulta/planeja grade de conteúdo |
| `metricas_post` | Social | Métricas de posts orgânicos |
| `consultar_tarefas` | Manager | Busca tarefas no Asana |
| `criar_demanda_cliente` | Manager | Cria task com custom fields |
| `agendar_captacao` | Manager | Cria evento no Google Calendar + task |
| `enviar_mensagem_grupo` | Todos | Envia mensagem com @menções reais |
| `anexar_midia_asana` | Manager | Upload de mídia como anexo em task |
| `lembrar` | Todos | Registra fato na memória |

### Agente Proativo

Quando autorizado via WhatsApp ("autorizo você a operar no cliente X"), o Jarvis monitora o grupo do cliente e age autonomamente:

- **Detecta demandas** — Cruza dados históricos do Asana para entender o fluxo de cada cliente
- **Responde profissionalmente** — Tom 100% profissional, confirma recebimento, pergunta prazo
- **Cria tasks no Asana** — Projeto correto, responsável correto, baseado no que já aprendeu
- **Notifica a equipe** — Avisa no grupo interno sobre novas demandas
- **Pergunta quando não sabe** — Em vez de travar, pergunta pra equipe e aprende com a resposta
- **Anti-vazamento** — Filtro duplo garante que informações internas nunca cheguem ao cliente

### Sistema de Menções

Para menções funcionarem no WhatsApp (highlight azul + push notification), o Jarvis:

1. Mapeia **todos os contatos** no boot (grupos internos + clientes + banco de dados)
2. Resolve nomes via 3 tiers: **exato** → **parcial** → **fuzzy** (Levenshtein ≤ 2)
3. Substitui `@NomePessoa` por `@número` no texto antes de enviar
4. Envia com array `mentions` contendo JIDs `@s.whatsapp.net`

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
| `GET` | `/dashboard/agents` | Agentes e distribuição de conhecimento |
| `GET` | `/dashboard/groups` | Listar todos os grupos WhatsApp |
| `POST` | `/dashboard/groups/toggle` | Ativar/desativar grupo |
| `GET` | `/dashboard/profiles` | Listar perfis sintetizados |
| `POST` | `/dashboard/asana/study/start` | Iniciar estudo exaustivo do Asana |
| `GET` | `/dashboard/asana/study/status` | Progresso do estudo em tempo real |
| `POST` | `/dashboard/asana/study/stop` | Parar estudo |

---

## Dashboard

SPA com interface temática do JARVIS (Iron Man). Acesso via **guardiaolab.com.br**.

- **Score de Inteligência** — Radar com 6 eixos + sistema de patentes (Recruta → Diretor da S.H.I.E.L.D.)
- **6 Agentes** — Cards com especialidades, triggers e contagem de memórias relevantes
- **Distribuição de Conhecimento** — Barras visuais por categoria (clientes, processos, prazos, etc.)
- **Quem o Jarvis Mais Conhece** — Top 15 entidades com mais memórias
- **Gestão de Memórias** — Busca, filtro por escopo, adição manual
- **Configuração de Voz** — Sliders para stability, similarity, style (ElevenLabs)
- **Chat Integrado** — Conversar com Jarvis diretamente pelo dashboard
- **Estudo do Asana** — Painel com progresso em tempo real
- **Grupos** — Toggle on/off de grupos WhatsApp em tempo real (internos + clientes)
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
- Anti-vazamento de informações internas em grupos de clientes
- **Zero segredos no código** — scan automático nos testes

### Arquivos Sensíveis (NÃO versionados)
- `.env` — todas as credenciais
- `auth_session/` — sessão do WhatsApp
- `google-calendar-key.json` — service account do GCal
- `audio_files/` e `media_files/` — mídias temporárias

---

## CI/CD

```
git push origin master
  │
  ├─ CI (ci.yml)
  │   ├─ Node 20 + npm ci
  │   └─ npm test (60 testes + scan de credenciais)
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

**60 casos de teste cobrindo:**
- Detecção de tipos de mídia (`getMediaType`)
- Extração de remetente em DMs e grupos (`extractSender`)
- Validação de respostas do Jarvis (`isValidResponse`)
- Roteamento de agentes por intenção (`classifyIntent`)
- Managed Clients — ativação/desativação (`isManagedClientGroup`)
- Agente Proativo — exports e callbacks (`handleManagedClientMessage`, `registerSendFunction`)
- Anti-alucinação — bloqueia respostas fabricadas sem base em tools
- Model Routing — `AI_MODEL_STRONG` existe e é configurável
- Mídia e Upload — tools de anexo existem e aceitam parâmetros
- Documentação do `.env.example`
- **Scan de credenciais** — varre todos os `.mjs` por chaves/tokens hardcoded

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

## Changelog

### v4.1.0 (2026-03-19)
- Toggle de grupos no dashboard — ativa/desativa Jarvis por grupo em tempo real
- Tool `buscar_mensagens` — busca no histórico real do WhatsApp por palavras-chave
- Anti-leak reforçado — silêncio total em vez de sanitização parcial
- Cobrança inteligente — lê atividades do Asana (não só comentários)
- Áudio em respostas de humor (35% de chance em respostas curtas)
- App Meta Ads publicado (modo Live)
- Deploy pipeline corrigido (ssh-keyscan com fallback)
- "Agência" → "Laboratório criativo" em toda a identidade

### v4.0.0 (2026-03-16)
- 6 agentes especializados (+ Traffic e Social)
- Meta Ads multi-cliente (7 tools, 15+ páginas)
- Menções inteligentes com fuzzy matching
- Anti-vazamento em grupos de clientes
- Mapeamento massivo de contatos via histórico
- Dashboard v4.0 com 6 agentes e scroll otimizado

### v3.0.0 (2026-03-01)
- Arquitetura Claude Code (Agent Loop, Extended Thinking, Prompt Caching)
- Model Routing dinâmico (Sonnet/Opus)
- Anti-alucinação
- Dashboard com 2FA via WhatsApp

### v2.0.0 (2026-02-01)
- Agente Proativo para clientes gerenciados
- Tools: criar_demanda_cliente, enviar_mensagem_grupo, anexar_midia_asana
- Sistema de memória Mem0-inspired

### v1.0.0 (2026-01-01)
- Bot WhatsApp básico com Claude API
- Integração Asana + Google Calendar
- TTS/STT

---

## Licença

Projeto privado da Stream Lab. Todos os direitos reservados.
