# Jarvis 5.0 — Technical Reference

> **Projeto:** Jarvis · **Organização:** Stream Lab · **Versão:** 5.0.0
> **Última atualização:** 2026-03-25 · **Autores:** Equipe Stream Lab + Claude Code

---

## 0. PRINCÍPIOS DE DESENVOLVIMENTO (LEIA PRIMEIRO)

> ⚠️ **OBRIGATÓRIO.** Estas regras existem porque erros foram cometidos. Cada regra aqui foi escrita com sangue (metafórico). Se você é uma sessão futura do Claude Code, LEIA TUDO antes de tocar em qualquer código.

### 0.1 Arquitetura de Prompts — UMA IDENTIDADE

O Jarvis usa a mesma arquitetura do Claude: **uma identidade que nunca muda, contexto adapta por canal**.

```
src/agents/master.mjs
├── JARVIS_IDENTITY      → Quem ele é. Regras. Equipe. Tom. NUNCA DUPLICAR.
├── CHANNEL_CONTEXT       → Adapta por canal (7 canais: WhatsApp interno/público, Asana, Dashboard, Voz, Instagram DM, Email)
├── AGENT_EXPERTISE       → Foco por especialidade (1-2 linhas, NÃO redefine personalidade)
├── MASTER_SYSTEM_PROMPT  → Compatibilidade = JARVIS_IDENTITY + CHANNEL_CONTEXT.whatsapp_internal
└── AGENT_PROMPTS         → Compatibilidade = JARVIS_IDENTITY + AGENT_EXPERTISE[agent]
```

**REGRAS INVIOLÁVEIS DE PROMPTS:**

| ❌ PROIBIDO | ✅ CORRETO |
|------------|-----------|
| Criar novo system prompt do zero em outro arquivo | Importar `JARVIS_IDENTITY` + `CHANNEL_CONTEXT` de `master.mjs` |
| Escrever "Você é o Jarvis..." em qualquer lugar que não seja `JARVIS_IDENTITY` | Compor: `JARVIS_IDENTITY + CHANNEL_CONTEXT.canal + contexto_dinâmico` |
| Adicionar "NUNCA faça X" em tool descriptions | Colocar regra comportamental em `JARVIS_IDENTITY` ou `CHANNEL_CONTEXT` |
| Criar prompt separado para email monitor, dashboard, instagram, etc | Usar `JARVIS_IDENTITY + CHANNEL_CONTEXT.canal_correspondente` |
| Redefinir personalidade em AGENT_EXPERTISE | AGENT_EXPERTISE = só o foco técnico (1-2 linhas) |

**Como adicionar um NOVO CANAL:**
```javascript
// Em master.mjs, adicionar ao CHANNEL_CONTEXT:
export const CHANNEL_CONTEXT = {
  ...canais_existentes,
  novo_canal: `CANAL: Nome do canal. Regras específicas deste canal aqui.`,
};
// Em qualquer lugar que use: JARVIS_IDENTITY + '\n\n' + CHANNEL_CONTEXT.novo_canal
```

**Como adicionar uma NOVA EXPERTISE:**
```javascript
// Em master.mjs, adicionar ao AGENT_EXPERTISE:
export const AGENT_EXPERTISE = {
  ...expertises_existentes,
  novo_agente: `ESPECIALIDADE ATIVA: Nome. Habilidades: x, y, z.`,
};
```

**CHANNEL_CONTEXT — 7 canais disponíveis (v5.0):**

| Canal | Chave | Descrição |
|-------|-------|-----------|
| WhatsApp Interno | `whatsapp_internal` | Grupos e DMs da equipe — tom informal, acesso total |
| WhatsApp Público | `whatsapp_public` | DMs de leads/desconhecidos — tom profissional e acolhedor, sem expor ferramentas internas |
| Asana | `asana` | Comentários em tasks — sem saudação, direto ao ponto |
| Dashboard | `dashboard` | Chat do painel web — Gui é o dono, acesso total |
| Dashboard Voz | `dashboard_voice` | Conversa por voz em tempo real — frases curtas, sem markdown |
| Instagram DM | `instagram_dm` | DMs do Instagram — respostas curtas (máx 3 frases), sem markdown, sem mencionar ferramentas internas |
| Email | `email` | Respostas formais — saudação, assinatura "Equipe Stream Lab", sem emojis |

### 0.2 Anti-Padrões (O QUE JÁ DEU ERRADO)

| Anti-Padrão | O que aconteceu | Solução |
|-------------|----------------|---------|
| **18 system prompts** | Cada arquivo definia "quem o Jarvis é" de forma diferente → comportamento esquizofrênico | Uma identidade (`JARVIS_IDENTITY`), contexto por canal |
| **Deploy manual via SCP** | Código foi direto pro servidor sem passar pelo CI → bugs sem testes | SOMENTE `git push` → CI → deploy automático |
| **Band-aids em prompts** | "NUNCA faça X" empilhado em 4 arquivos diferentes → contradições | Regra vai em UM lugar (identity ou channel) |
| **Tool descriptions com regras comportamentais** | Tool `comentar_task` tinha "NUNCA repita nome" → confunde o modelo | Tools = descrição técnica. Comportamento = identity/channel |
| **Buscar poucos dados antes de responder** | Jarvis dizia "não tenho contexto" quando os dados existiam nos comentários | Buscar 20+ comentários, descrição completa, custom fields |
| **Opus para tudo** | Email monitor usava Opus + Extended Thinking → 15-20s de latência | Sonnet para respostas rápidas (Asana, voz). Opus só para decisões complexas |

### 0.3 Fluxo de Desenvolvimento Obrigatório

```
1. Ler CLAUDE.md (este arquivo) INTEIRO antes de começar
2. Entender a arquitetura ANTES de modificar
3. Modificar código
4. Rodar npm test (testes devem passar)
5. git add <arquivos específicos> (NUNCA git add -A)
6. git commit com mensagem descritiva
7. git push origin master
8. Acompanhar CI → Deploy no GitHub Actions
9. NUNCA fazer scp/ssh direto pro servidor
```

### 0.4 Quando o Gui Reclamar

O Gui é direto e reclama quando algo não funciona. Padrões comuns:

| Reclamação | Causa provável | Ação |
|-----------|---------------|------|
| "Nada mudou" | Cache do browser ou deploy não foi feito | Verificar se `git push` aconteceu, checar CI/CD |
| "Tá repetindo nome" | Menção Asana + nome no texto = duplicado | Verificar CHANNEL_CONTEXT.asana e tool `comentar_task` |
| "Demora muito" | Opus + Extended Thinking + muitas memórias | Usar Sonnet, reduzir memórias, sem thinking |
| "Esquizofrenia" | Prompts contraditórios em arquivos diferentes | Verificar se está usando JARVIS_IDENTITY em todos os lugares |
| "Coisa amadora" | Patching em vez de resolver a raiz | Refatorar a causa, não adicionar mais regras |

### 0.5 Checklist Antes de Qualquer Mudança em Prompts

- [ ] A mudança está em `JARVIS_IDENTITY`, `CHANNEL_CONTEXT` ou `AGENT_EXPERTISE`?
- [ ] NÃO criei um system prompt novo em outro arquivo?
- [ ] NÃO adicionei regra comportamental em tool description?
- [ ] NÃO dupliquei informação que já existe em `JARVIS_IDENTITY`?
- [ ] Os testes passam (`npm test`)?
- [ ] O deploy é via `git push` (NÃO via scp/ssh)?

---

## 1. Visão Geral da Arquitetura

Jarvis 5.0 é um **sistema de IA multi-agente autônomo e multi-canal** que opera como gestor de projetos virtual 24/7 para a Stream Lab (laboratório criativo de marketing). A arquitetura é inspirada na [Claude Code](https://claude.com/claude-code), com Agent Loop real, Extended Thinking, Prompt Caching e Model Routing dinâmico.

### 1.1 Capacidades Principais

| Capacidade | Descrição |
|-----------|-----------|
| **6 Agentes Especializados** | Master, Creative, Manager, Researcher, Traffic, Social — roteamento automático por intenção |
| **Multi-canal** | WhatsApp (interno + público), Instagram DM, Email (IMAP/SMTP), Dashboard, Voz (WebSocket) |
| **Gestão Proativa de Clientes** | Opera autonomamente em grupos de clientes autorizados (responde, cria tasks, notifica equipe) |
| **Atendimento Público** | Leads/desconhecidos no DM recebem atendimento automático com limite de 20 mensagens e horário comercial |
| **Showcase Mode** | Modo apresentação ("Quero conhecer o Jarvis") — Opus para respostas impressionantes, auto-venda inteligente, anti-troll, blindagem contra alucinação |
| **Handoff Equipe** | Equipe silencia Jarvis por lead ("eu assumo", "deixa comigo") e reativa com "Jarvis volta" |
| **Geração de Imagens/Stickers** | Tools `gerar_imagem` (DALL-E 3) e `criar_sticker` (WebP 512x512) nos grupos internos |
| **Meta Ads Multi-cliente** | Gerencia campanhas de tráfego pago via Graph API v25.0 para múltiplos clientes |
| **Menções Inteligentes** | Sistema de @menções com resolução fuzzy (Levenshtein real, distância ≤ 2), mapeamento massivo via histórico |
| **Memória Semântica (pgvector)** | Busca híbrida (vetorial + texto) com embeddings OpenAI, backfill automático |
| **Autonomia Nível 2** | Mover tasks entre seções e atribuir responsáveis no Asana, com escalação em 3 níveis |
| **Webhooks Asana** | Eventos em tempo real (task criada, movida, concluída) com notificação automática |
| **Anti-vazamento v3** | Filtro expandido (nomes, cross-client, termos de IA) com normalização e silêncio total |
| **Dashboard v2** | Next.js 16 + TypeScript + Tailwind com 9 páginas (clientes, segurança, configurações...) |
| **MCP Server** | 6 tools expostas via Model Context Protocol para integração com Claude Code, Cursor, etc. |
| **WebSocket Voice** | Streaming de voz bidirecional com interrupção, latência < 2s |

### 1.2 Stack Tecnológico

```
Runtime:      Node.js 20 (ESM)
WhatsApp:     Baileys v7 (multi-device, auto-reconnect)
IA:           Claude API (Anthropic) — Sonnet 4 + Opus 4
Embeddings:   OpenAI text-embedding-3-small (1536 dims)
Banco:        PostgreSQL 16 + pgvector (busca semântica)
Cache:        Redis 7 (AOF habilitado)
TTS:          ElevenLabs v3 (primário) + OpenAI TTS (fallback)
STT:          Whisper (OpenAI)
Calendário:   Google Calendar API (JWT service account)
Ads:          Meta Graph API v25.0 (Facebook/Instagram Ads)
Gestão:       Asana REST API (Personal Access Token) + Webhooks
Email:        IMAP (imapflow) + SMTP (nodemailer)
Instagram:    Meta Graph API (Messaging + Webhooks)
WebSocket:    ws (voice streaming bidirecional)
MCP:          @modelcontextprotocol/sdk (6 tools)
Segurança:    helmet + cors + JWT + bcrypt
Frontend v1:  Tailwind CSS + Chart.js (SPA em dashboard/index.html)
Frontend v2:  Next.js 16 + React 19 + TypeScript + Tailwind (dashboard-v2/)
CI/CD:        GitHub Actions → rsync → PM2
Infra:        Ubuntu 24.04 LTS (Azure VPS)
```

---

## 2. Estrutura do Projeto

```
jarvis-v2.mjs                     # Entry point — WhatsApp + Express + Cron + WebSocket Voice
src/
├── config.mjs                    # Configurações centrais (100% via process.env)
├── database.mjs                  # PostgreSQL — pool, initDB, CRUD mensagens/contatos/grupos/leads/cobranças
├── memory.mjs                    # Memória semântica (Mem0 + pgvector, embeddings, backfill)
├── brain.mjs                     # Cérebro IA — Agent Loop, proativo, público, anti-leak v3, escalação
├── brain-document.mjs            # Geração de documento de contexto do cérebro
├── audio.mjs                     # TTS (ElevenLabs/OpenAI) + STT (Whisper)
├── profiles.mjs                  # Síntese de perfis (clientes, equipe, processos)
├── batch-asana.mjs               # Estudo exaustivo do Asana (3 fases, resumível)
├── asana-email-monitor.mjs       # Monitor de @menções do Asana via IMAP
├── helpers.mjs                   # Utilitários (getMediaType, extractSender)
├── mcp-server.mjs                # MCP Server — 6 tools via stdio (entry point separado)
├── agents/
│   └── master.mjs                # Prompts: JARVIS_IDENTITY, CHANNEL_CONTEXT (7 canais), AGENT_EXPERTISE, classificador
├── channels/
│   ├── instagram.mjs             # Canal Instagram DM (webhook Meta Graph API)
│   └── email.mjs                 # Canal Email genérico (IMAP poll + SMTP auto-resposta + classificação)
├── webhooks/
│   └── asana-webhook.mjs         # Asana Webhooks (processamento de eventos em tempo real)
└── skills/
    ├── loader.mjs                # 17 tools do Claude (Asana + Calendar + Meta Ads + WhatsApp + Autonomia + Imagens)
    └── meta-ads.mjs              # Meta Ads — Graph API wrapper multi-cliente
dashboard/
└── index.html                    # Dashboard v1 — SPA (Tailwind, Chart.js, auto-refresh)
dashboard-v2/                     # Dashboard v2 — Next.js 16 + TypeScript + Tailwind
├── src/app/
│   ├── page.tsx                  # Home (overview/inteligência)
│   ├── login/page.tsx            # Login + 2FA
│   ├── agents/page.tsx           # 6 agentes + distribuição de conhecimento
│   ├── chat/page.tsx             # Chat integrado com Jarvis
│   ├── clients/page.tsx          # Clientes gerenciados
│   ├── groups/page.tsx           # Grupos WhatsApp (toggle on/off)
│   ├── memory/page.tsx           # Gestão de memórias + backfill pgvector
│   ├── security/page.tsx         # Auditoria de acessos + geolocalização
│   └── settings/page.tsx         # Configurações de voz + modelos
├── src/components/               # Componentes React reutilizáveis
├── src/lib/                      # API client, utils
├── package.json                  # Next.js 16, React 19, Recharts, Lucide
└── tsconfig.json                 # TypeScript config
tests/
└── unit.test.mjs                 # Suite de testes (60+ casos + scan de credenciais)
.github/workflows/
├── ci.yml                        # CI — Node 20, npm ci, npm test
└── deploy.yml                    # CD — rsync para VPS via SSH (auto após CI)
docker-compose.yml                # PostgreSQL 16 + Redis 7 (bind localhost only)
.env                              # Credenciais (NÃO VERSIONADO)
auth_session/                     # Sessão WhatsApp (NÃO VERSIONADO)
```

---

## 3. Regras Invioláveis

> ⚠️ **Estas regras são absolutas. Violá-las causa perda de dados ou exposição de informações sensíveis.**

### 3.1 Asana
- **NUNCA alterar descrições de tasks** — usar SOMENTE comentários para comunicação
- Projetos públicos: Cabine de Comando, Produção de Design, Produção de Audiovisual, Captações
- Demais projetos são **CONFIDENCIAIS** — não expor em respostas a clientes
- Campanhas Meta Ads SEMPRE criadas como `PAUSED` — ativação manual obrigatória

### 3.2 Código
- **Pool PostgreSQL:** usar `pool` exportado de `database.mjs` (NUNCA `CONFIG.DATABASE_URL`)
- **Auth interna (WhatsApp → API):** header `x-api-key` (NÃO `Authorization: Bearer`)
- **Auth Dashboard:** JWT via `Authorization: Bearer <token>` (login + 2FA obrigatório)
- **Google JWT:** sintaxe de objeto `new google.auth.JWT({ email, key, scopes })`
- **Credenciais:** TODAS vêm do `.env` — NUNCA hardcodar senhas, tokens, IPs, telefones ou GIDs
- **Português SEMPRE com acentos** em respostas e documentação voltada ao usuário
- **Menções WhatsApp:** SEMPRE usar `@s.whatsapp.net` (phoneNumber), NUNCA `@lid`
- **Anti-vazamento:** NUNCA expor nomes de equipe, tools ou processos internos em grupos de clientes ou canais públicos (Instagram DM, WhatsApp público, Email)
- **Tom humanizado:** máx 1 emoji por mensagem em TODOS os canais — sem exageros

### 3.3 Deploy
- **NUNCA fazer deploy manual direto no servidor** — deploy SOMENTE via GitHub CI/CD (`git push`)
- Pipeline: `git push` → CI (testes) → Deploy automático (rsync + PM2 restart)

### 3.4 Arquivos NÃO versionados
| Arquivo/Diretório | Motivo |
|-------------------|--------|
| `.env` | Chaves de API, senhas, IDs sensíveis |
| `auth_session/` | Sessão criptografada do WhatsApp |
| `node_modules/` | Dependências (instaladas via npm ci) |
| `google-calendar-key.json` | Service account Google |
| `audio_files/` | Áudios temporários (TTS) |
| `media_files/` | Mídias baixadas do WhatsApp |

---

## 4. Módulos — Referência Detalhada

### 4.1 `jarvis-v2.mjs` — Entry Point

**Exporta:** nada (entry point)

**Responsabilidades:**
- Conexão WhatsApp via Baileys (multi-device, QR code, auto-reconnect com backoff)
- Handler unificado de mensagens (texto, áudio, captions de imagem/vídeo, mídias)
- Aprendizado passivo em tempo real (`processMemory()` em TODAS mensagens ≥20 caracteres)
- **Homework via WhatsApp** — detecta instruções/correções do dono → salva como homework (prioridade máxima no contexto)
- **Autorização de clientes** — regex detecta "autorizo você a operar no cliente X" → persiste no banco
- **Agente Proativo** — intercepta mensagens de grupos gerenciados antes do fluxo normal
- **Atendimento Público** — `handlePublicDM()` para DMs de leads/desconhecidos (limite 10 mensagens, horário comercial)
- **Mapeamento de contatos** — 3 camadas (boot + background + tempo real) para sistema de menções
- Express API com autenticação dupla (`x-api-key` para bot, JWT para dashboard)
- **WebSocket Voice** — servidor WebSocket em `/ws/voice` para streaming de voz bidirecional
- **Webhooks** — endpoints públicos para Asana (`/webhooks/asana`) e Instagram (`/webhooks/instagram`)
- Cron jobs: syncProfiles (6h), estudo Asana incremental (5x/dia seg-sex). **Cobranças e relatório diário DESABILITADOS** temporariamente (até corrigir formato)
- Sistema `sentByBot` para evitar auto-resposta
- Gamificação: patentes (10 níveis: Recruta → Diretor da S.H.I.E.L.D.) e score de inteligência (6 eixos)
- Inicialização de canais: `startChannelEmailMonitor()`, importação de handlers Instagram/Asana

**Funções-chave:**
| Função | Descrição |
|--------|-----------|
| `handleIncomingMessage(m)` | Pipeline completo: filtro → store → aprendizado → homework → proativo → público → resposta |
| `sendText(jid, text)` | Envio de mensagem com flag sentByBot |
| `sendTextWithMentions(jid, text, mentions)` | Envio com @menções reais (highlight + push notification) |
| `mapAllKnownGroups(sock)` | Background: mapeia TODOS os contatos do banco + grupos para menções |

### 4.2 `src/config.mjs` — Configuração Central

**Exporta:** `CONFIG`, `TEAM_ASANA`, `ASANA_PROJECTS`, `ASANA_SECTIONS`, `ASANA_CUSTOM_FIELDS`, `ASANA_CLIENTE_MAP`, `ASANA_URGENCIA_MAP`, `ASANA_TIER_MAP`, `ASANA_TIPO_DEMANDA_MAP`, `PUBLIC_ASANA_PROJECTS`, `JARVIS_ALLOWED_GROUPS`, `AUDIO_ALLOWED`, `teamPhones`, `teamWhatsApp`, `managedClients`, `loadManagedClients`, `saveManagedClients`, `isManagedClientGroup`

- 100% das configurações via `process.env` — zero defaults sensíveis
- Parsing de JSON para maps complexos (Asana custom fields, equipe, projetos)
- **Maps em memória:**
  - `teamWhatsApp` — Map<nome, JID> para resolução de menções
  - `teamPhones` — Map<nome, JID@s.whatsapp.net> para menções com notificação
  - `managedClients` — Map<groupJid, clientConfig> persistido em `jarvis_config`

### 4.3 `src/database.mjs` — Persistência

**Exporta:** `pool`, `initDB`, `storeMessage`, `getRecentMessages`, `getContactInfo`, `getGroupInfo`, `upsertContact`, `upsertGroup`, `getMessageCount`, `upsertPublicConversation`, `getPublicConversation`, `incrementPublicMessages`, `getCobrancaLog`, `upsertCobrancaLog`, `resetCobrancaLog`

**Esquema de tabelas:**

| Tabela | Propósito | Campos-chave |
|--------|-----------|-------------|
| `jarvis_messages` | Histórico completo de mensagens | message_id, chat_id, sender, push_name, text, is_audio, transcription, media_type |
| `jarvis_contacts` | Diretório de contatos WhatsApp | jid, push_name, role, updated_at |
| `jarvis_groups` | Registro de grupos | jid, name |
| `jarvis_config` | Key-value store (JSONB) | key, value |
| `jarvis_memories` | Fatos extraídos por IA + embeddings | content, category, importance, scope, entity_id, **embedding vector(1536)** |
| `jarvis_profiles` | Perfis sintetizados | entity_type, entity_id, profile (JSONB) |
| `homework` | Instruções de treinamento manual | instruction, context, created_at |
| `gcal_sync` | Sincronização Asana ↔ Google Calendar | asana_task_gid, gcal_event_id |
| `group_events` | Eventos de participantes | group_jid, participant_jid, event_type |
| `asana_study_log` | Progresso do estudo exaustivo | phase, entity_gid, status |
| `dashboard_users` | Contas do dashboard | email, password_hash, totp_secret |
| `dashboard_access_log` | Auditoria de acessos | user_id, ip, user_agent, geo |
| `dashboard_2fa_codes` | Códigos 2FA temporários | code, expires_at, used |
| `public_conversations` | Conversas com leads/público | jid, name, status, messages_count, first_message_at, last_message_at |
| `cobranca_log` | Log de cobranças com escalação | task_gid, cobranca_count, last_cobrada_at |
| `email_log` | Log de emails do canal genérico | from_address, subject, body_preview, classification, created_at |

### 4.4 `src/memory.mjs` — Sistema de Memória Semântica (Mem0 + pgvector)

**Exporta:** `initMemory`, `extractFacts`, `storeFacts`, `searchMemories`, `smartSearchMemories`, `getMemoryContext`, `processMemory`, `getMemoryStats`, `backfillEmbeddings`, `generateEmbedding`, `pgvectorEnabled`

**Arquitetura:**
```
Mensagem recebida
  └─ processMemory() [background, non-blocking]
       └─ extractFacts() [Claude Haiku]
            └─ storeFacts() [ADD/UPDATE pipeline]
                 ├─ deduplica fatos existentes via ILIKE
                 └─ generateEmbedding() → salva vector(1536)
```

- **3 escopos:** `user` (pessoas), `chat` (conversas), `agent` (operacional)
- **10 categorias:** preference, client, client_profile, decision, deadline, rule, style, team_member, process, pattern
- **Aprendizado passivo:** `processMemory()` roda em TODA mensagem ≥20 chars — Jarvis aprende 24/7
- **extractFacts com contexto:** prompt inclui nome/tipo do grupo de origem e lista da equipe para classificação correta (equipe vs cliente)
- **Contextualização:** `getMemoryContext()` agrega 6 fontes (user, chat, agent, client profile, sender profile, homework)

**pgvector — Busca Semântica (NOVO v5.0):**

| Componente | Descrição |
|-----------|-----------|
| `generateEmbedding(text)` | Gera embedding via OpenAI `text-embedding-3-small` (1536 dimensões). Cache em memória com TTL 1h |
| `searchMemories()` | **Busca híbrida**: se pgvector habilitado, combina similaridade vetorial (peso 0.7) + importância (peso 0.3). Fallback: ILIKE |
| `smartSearchMemories()` | Com pgvector: busca semântica direta. Sem pgvector: fallback com Haiku para expandir queries |
| `backfillEmbeddings(batchSize)` | Gera embeddings para memórias antigas que não têm. Batches de 50 (máx 200). Endpoint: `POST /dashboard/memory/backfill` |
| `pgvectorEnabled` | Flag booleana — detecta automaticamente se a extensão `vector` está instalada no PostgreSQL |
| Índice HNSW | `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` — mais rápido que IVFFlat para < 1M registros |
| Modelo | `text-embedding-3-small` (OpenAI) — 1536 dimensões, custo baixo |
| Estatísticas | `getMemoryStats()` retorna `total`, `withEmbedding`, `pgvectorEnabled` |

### 4.5 `src/brain.mjs` — Cérebro IA

**Exporta:** `shouldJarvisRespond`, `isValidResponse`, `generateResponse`, `markConversationActive`, `isConversationActive`, `findTeamJid`, `extractMentionsFromText`, `generateDailyReport`, `handleManagedClientMessage`, `handlePublicDM`

**Componentes:**

| Componente | Descrição |
|-----------|-----------|
| **Agent Loop** | `agentLoop()` — loop `while(stop_reason === 'tool_use')` até resposta final (máx 10 iterações) |
| **Extended Thinking** | `thinking: { type: "enabled", budget_tokens: N }` — Opus: 8192, Sonnet: 4096 |
| **Interleaved Thinking** | Header beta `interleaved-thinking-2025-05-14` para raciocínio entre tool calls |
| **Prompt Caching** | System prompt como array com `cache_control: { type: "ephemeral" }` nos blocos estáticos |
| **Model Routing** | `chooseModel()` → Opus para queries complexas (análise, estratégia), Sonnet para o resto |
| **Anti-alucinação** | `antiHallucinationCheck()` — bloqueia respostas fabricadas sem base em tools |
| **Anti-vazamento v3** | `checkInternalLeak()` + `sanitizeClientResponse()` — proteção tripla expandida (ver seção 6) |
| **Modo Conversa** | Janela de 3 minutos ativa após resposta — responde sem precisar de @menção |
| **Atendimento Público** | `handlePublicDM()` — atende leads com limite de 20 mensagens, horário comercial, tom profissional, anti-repetição, detecção de troll |
| **Showcase Mode** | Modo apresentação com Opus, auto-venda inteligente, timeout 4min, anti-troll, blindagem anti-alucinação |
| **Handoff** | Equipe silencia Jarvis por lead ("eu assumo") e reativa ("Jarvis volta") |
| **Retry 429/529** | `claudeWithRetry()` — backoff exponencial (2s, 4s, 8s) em TODAS as chamadas Claude |
| **Escalação 3 Níveis** | Cobranças com `cobranca_log`: 1ª normal → 2ª urgente (24h) → 3ª escalar pro Gui (48h) — **DESABILITADO temporariamente** |

**Agente Proativo (`handleManagedClientMessage`):**
- Opera autonomamente em grupos de clientes autorizados
- Consolida mensagens rápidas (buffer 15s) + rate limit (30s entre respostas)
- Claude decide: responder, criar task, notificar equipe ou silenciar
- Quando não sabe → pergunta à equipe no grupo interno e aprende com a resposta
- Erro → silêncio absoluto (nunca expõe erro ao cliente)

**Atendimento Público (`handlePublicDM`) — v5.0:**
- Ativado quando DM é de pessoa desconhecida (não é equipe nem cliente gerenciado)
- Usa `JARVIS_IDENTITY + CHANNEL_CONTEXT.whatsapp_public`
- **Horário comercial:** 8h-18h BRT (`isBusinessHours()`). Fora do horário: resposta automática
- **Limite de 20 mensagens:** após 20 mensagens, silencia (era 10 → 20)
- **Primeiro contato:** detectado via `public_conversations` — tom especialmente acolhedor
- **Modelo:** Sonnet (respostas rápidas, máx 1024 tokens — era 512)
- **Anti-repetição:** nunca repete a mesma resposta para o mesmo lead
- **Detecção de troll:** identifica e lida com mensagens abusivas de forma inteligente
- **Validação de dados:** valida telefone e datas fornecidos pelo lead
- **Consciência temporal:** sabe que dia é hoje, adapta respostas a contexto temporal
- Registra conversa na tabela `public_conversations` (contagem, timestamps)

**Showcase Mode — NOVO v5.0:**
- Ativado quando lead manda "Quero conhecer o Jarvis" (ou variações) no WhatsApp
- Usa **Opus** para respostas impressionantes e detalhadas
- Pergunta preferência de áudio no início da conversa
- **Timeout de 4 minutos** de inatividade — encerra sessão showcase
- **Auto-venda inteligente:** pergunta sobre o negócio da pessoa e mostra como o Jarvis se encaixa
- **Anti-troll sofisticado:** detecta e neutraliza tentativas de trollagem
- **Blindagem contra alucinação:** nunca inventa dados, funcionalidades ou métricas fictícias

**Handoff (Equipe → Lead) — NOVO v5.0:**
- Quando equipe manda "eu assumo", "não responda mais", "deixa comigo" → Jarvis silencia para aquele lead
- "Jarvis volta" → reativa o atendimento automático para o lead
- Controle granular por lead (não afeta outros atendimentos)

**Escalação de Cobranças — NOVO v5.0:**
- Usa tabela `cobranca_log` para rastrear quantas vezes cada task foi cobrada
- 3 níveis: `normal` (1ª) → `urgent` (2ª, 24h depois) → `escalate_gui` (3ª, 48h depois)
- Tasks já cobradas hoje são puladas automaticamente
- Informação de escalação passada ao Claude para ajustar o tom da cobrança

### 4.6 `src/agents/master.mjs` — Time de Agentes

**Exporta:** `classifyIntent`, `JARVIS_IDENTITY`, `CHANNEL_CONTEXT`, `AGENT_EXPERTISE`, `MASTER_SYSTEM_PROMPT`, `AGENT_PROMPTS`

| Agente | Especialidade | Triggers (regex) | Prioridade |
|--------|--------------|-------------------|-----------|
| **Traffic** | Tráfego pago, Meta Ads, campanhas, métricas | campanha, CPC, CTR, ads, verba, ROAS, pixel | 1 (mais específico) |
| **Social** | Publicação, agendamento, calendário editorial | publicar, agendar post, engajamento, alcance orgânico | 2 |
| **Creative** | Copy, legendas, roteiros, CTAs, briefings | copy, arte, conteúdo, roteiro, headline, CTA | 3 |
| **Manager** | Gestão de projetos, prazos, Asana | tarefa, prazo, status, cobrança, sprint, board | 4 |
| **Researcher** | Pesquisa, dados, tendências, benchmarks | pesquisar, dados, benchmark, tendência, análise | 5 |
| **Master** | Conversação geral, personalidade Jarvis | Default (fallback) | 6 |

> **Nota:** O classificador avalia na ordem de prioridade. Traffic e Social são avaliados ANTES de Creative para evitar conflitos em palavras como "post" e "stories".

### 4.7 `src/skills/loader.mjs` — Tools do Claude

**Exporta:** `asanaRequest`, `asanaWrite`, `asanaCreateTask`, `asanaAddToProject`, `asanaAddComment`, `asanaUploadAttachment`, `getOverdueTasks`, `getGCalClient`, `createGoogleCalendarEvent`, `JARVIS_TOOLS`, `executeJarvisTool`, `registerSendFunction`, `registerSendWithMentionsFunction`, `getSendFunction`

**17 tools disponíveis:**

| Tool | Agente | Descrição | Campos obrigatórios |
|------|--------|-----------|-------------------|
| `agendar_captacao` | Manager | Cria evento no Google Calendar + task no Asana | titulo, data, horario |
| `consultar_tarefas` | Manager | Busca tarefas no Asana (filtro por projeto/responsável) | — |
| `lembrar` | Manager | Registra lembrete/memória | conteudo |
| `criar_demanda_cliente` | Manager | Cria task no Asana (Cabine de Comando) com custom fields | titulo, cliente |
| `enviar_mensagem_grupo` | Todos | Envia mensagem no WhatsApp com menções reais | grupo, mensagem |
| `anexar_midia_asana` | Manager | Upload de mídia do WhatsApp como anexo em task | task_id |
| `comentar_task` | Manager | Adiciona comentário em task do Asana | task_id, comentario |
| `buscar_mensagens` | Todos | Busca mensagens reais do WhatsApp no banco (links, aprovações, etc.) | palavras_chave |
| `criar_campanha` | Traffic | Cria campanha Meta Ads (SEMPRE pausada) | nome, objetivo, orcamento_diario |
| `relatorio_ads` | Traffic | Relatório de métricas (CPC, CTR, ROAS, CPA) | periodo |
| `pausar_campanha` | Traffic | Pausa ou retoma campanha | campanha_id, acao |
| `agendar_post` | Social | Publica ou agenda post no Facebook/Instagram | texto |
| `calendario_editorial` | Social | Consulta/planeja grade de conteúdo | acao |
| `metricas_post` | Social | Métricas de posts orgânicos (alcance, engajamento) | — |
| `mover_task_secao` | Manager | **NOVO v5.0** — Move task para outra seção no Asana (ex: "A Fazer" → "Em Andamento") | task_gid, projeto, secao |
| `atribuir_task` | Manager | **NOVO v5.0** — Altera o responsável de uma task no Asana | task_gid, responsavel |
| `gerar_imagem` | Creative | **NOVO v5.0** — Gera imagem via DALL-E 3 (grupos internos apenas) | prompt |
| `criar_sticker` | Creative | **NOVO v5.0** — Cria sticker WebP 512x512 (grupos internos apenas) | prompt |

**Sistema de menções na tool `enviar_mensagem_grupo`:**
```
Input: { grupo: "tarefas", mensagem: "Oi @Bruna!", mencoes: ["Bruna"] }

Resolução (3 tiers):
  1. Exato:   teamWhatsApp.get("bruna") → "555584016111@s.whatsapp.net"
  2. Parcial: key.includes(nome) ou nome.includes(key) → match
  3. Fuzzy:   levenshtein("brusna", "bruna") = 1 ≤ 2 → match

Substituição no texto:
  "Oi @Bruna!" → "Oi @555584016111!"

Envio:
  sendTextWithMentions(jid, "Oi @555584016111!", ["555584016111@s.whatsapp.net"])
```

### 4.8 `src/skills/meta-ads.mjs` — Meta Ads

**Exporta:** `listCampaigns`, `getCampaignInsights`, `createCampaign`, `createAdSet`, `createAd`, `updateCampaignStatus`, `getAccountInsights`, `getPagePosts`, `publishPagePost`

- Wrapper `metaRequest()` para Graph API v25.0 com retry em rate limit (429) e backoff exponencial
- Multi-cliente via `META_PAGES_MAP` (JSON env var: `{"minner":"page-id-1","rossato":"page-id-2"}`)
- Mapeamento automático de objetivos PT→EN (tráfego→OUTCOME_TRAFFIC, leads→OUTCOME_LEADS)
- Orçamento em centavos na API (R$50 = 5000)
- **Regra de segurança:** campanhas SEMPRE criadas como `PAUSED` — ativação manual obrigatória

### 4.9 `src/audio.mjs` — Voz

**Exporta:** `voiceConfig`, `loadVoiceConfig`, `saveVoiceConfig`, `transcribeAudio`, `generateAudio`

- TTS primário: ElevenLabs v3 (stability, similarity_boost, style, speaker_boost configuráveis via dashboard)
- TTS fallback automático: OpenAI TTS (em caso de erro ou indisponibilidade)
- STT: Whisper (OpenAI) para transcrição de áudios recebidos no WhatsApp

### 4.10 `src/channels/instagram.mjs` — Canal Instagram DM (NOVO v5.0)

**Exporta:** `processInstagramMessage`

- Recebe mensagens via webhook Meta Graph API (`POST /webhooks/instagram`)
- Gera resposta com `JARVIS_IDENTITY + CHANNEL_CONTEXT.instagram_dm`
- Armazena histórico em `jarvis_messages` com `chat_id = instagram_{senderId}`
- Busca últimas 10 mensagens como contexto
- Envia resposta via Instagram Messaging API
- Usa Sonnet para respostas rápidas (máx 500 tokens)
- **Regra:** respostas curtas (máx 3 frases), sem markdown, sem mencionar ferramentas internas

### 4.11 `src/channels/email.mjs` — Canal Email (NOVO v5.0)

**Exporta:** `startChannelEmailMonitor`, `stopChannelEmailMonitor`, `channelEmailState`, `classifyEmail`

- Monitora caixa de entrada genérica (leads/contato) via IMAP — diferente do `asana-email-monitor.mjs` que só processa @menções do Asana
- Poll a cada 5 minutos (`setInterval`)
- **Classificação:** `classifyEmail()` → `urgent` (urgente/crítico), `normal` (genérico), `newsletter` (spam/noreply)
- **Ações por classificação:**
  - `urgent` → notifica Gui + equipe via WhatsApp com preview do email
  - `normal` → auto-resposta via SMTP ("Recebemos seu email! Retornamos em breve.")
  - `newsletter` → ignora silenciosamente
- Armazena em `email_log` (from, subject, preview, classificação)
- Estado exposto via `channelEmailState` (running, lastCheck, processed, errors)

### 4.12 `src/webhooks/asana-webhook.mjs` — Webhooks Asana (NOVO v5.0)

**Exporta:** `processAsanaWebhookEvent`, `registerAsanaWebhooks`

- Processa eventos em tempo real do Asana (tasks changed, added, deleted)
- **Ignora eventos do próprio Jarvis** (GID `1213583219463912`) para evitar loops
- **Task concluída** (movida para seção "Concluído") → notifica grupo interno com nome, responsável e projeto
- **Task sem responsável** → notifica grupo interno pedindo atribuição
- **Notificações sem spam:** lead notifica 1x na entrada + 1x quando pedir reunião. Sem número LID falso
- Registra eventos como memória via `processMemory()`
- **Handshake:** endpoint `POST /webhooks/asana` responde `X-Hook-Secret` na primeira requisição (padrão Asana)
- **Registro:** `registerAsanaWebhooks(callbackUrl)` registra webhooks em todos os projetos públicos (`PUBLIC_ASANA_PROJECTS`)
- Endpoint de registro: `POST /dashboard/webhooks/register` (protegido por JWT)

### 4.13 `src/mcp-server.mjs` — MCP Server (NOVO v5.0)

**Entry point separado:** `node src/mcp-server.mjs`

Expõe 6 tools via Model Context Protocol (stdio transport) para integração com Claude Code, Cursor e outras ferramentas:

| Tool MCP | Descrição |
|---------|-----------|
| `jarvis_send_message` | Envia mensagem via WhatsApp (grupo por nome ou número de telefone) |
| `jarvis_search_memories` | Busca semântica nas memórias (query + scope opcional) |
| `jarvis_create_task` | Cria task no Asana (Cabine de Comando) com cliente e responsável |
| `jarvis_get_client_status` | Status de cliente gerenciado (ativo, mensagens 24h/7d, config) |
| `jarvis_get_metrics` | Métricas Meta Ads (impressões, cliques, CPC, CTR, ROAS) |
| `jarvis_memory_stats` | Estatísticas do sistema de memória (total, por escopo, pgvector) |

- Depende do `@modelcontextprotocol/sdk` e `zod` para validação de schemas
- Resolve grupos por nome via query no banco (`jarvis_groups`)
- Comunica com a API interna do Jarvis via `fetch` localhost (reusa `x-api-key`)

### 4.14 WebSocket Voice (`/ws/voice`) — NOVO v5.0

Implementado diretamente em `jarvis-v2.mjs` usando a lib `ws`.

**Protocolo:**
- **Conexão:** `wss://guardiaolab.com.br/ws/voice?token=JWT`
- **Auth:** JWT validado no query string (mesmo token do dashboard)
- **Cliente → Servidor:**
  - Chunks binários de áudio (acumulados em buffer)
  - JSON commands: `{ type: "end_audio" }` para finalizar gravação, `{ type: "interrupt" }` para cancelar resposta em andamento
- **Servidor → Cliente:**
  - JSON: `{ type: "transcription", text: "..." }` — transcrição do áudio recebido
  - JSON: `{ type: "response_start" }` — início da resposta
  - Chunks binários de áudio TTS (streaming por frases)
  - JSON: `{ type: "response_text", text: "..." }` — texto completo da resposta
  - JSON: `{ type: "response_end" }` — fim da resposta
- **Interrupção:** ao receber `{ type: "interrupt" }`, cancela processamento de TTS em andamento
- **Latência:** < 2s (divide resposta em frases e gera TTS por frase, streaming paralelo)

### 4.15 Módulos auxiliares

| Módulo | Exporta | Descrição |
|--------|---------|-----------|
| `src/profiles.mjs` | `synthesizeProfile`, `getProfile`, `listProfiles`, `syncProfiles` | Sintetiza perfis via Haiku a partir de memórias acumuladas. 4 tipos: client, group, team_member, process |
| `src/batch-asana.mjs` | `startAsanaStudy`, `stopAsanaStudy`, `asanaBatchState` | Ingestão em 3 fases (Projetos→Tarefas→Comentários). Resumível, rate limited, somente leitura |
| `src/asana-email-monitor.mjs` | `startEmailMonitor`, `stopEmailMonitor`, `emailMonitorState` | Monitor de @menções do Asana via IMAP (responde a comentários marcando @jarvis) |
| `src/brain-document.mjs` | `generateBrainDocument`, `loadBrainDocument`, `invalidateBrainCache`, `getBrainStatus` | Gera documento de contexto consolidado do cérebro. Usa `claudeWithRetry()` |
| `src/helpers.mjs` | `getMediaType`, `extractSender` | Detecção de tipo de mídia e extração de JID do remetente |

---

## 5. Sistema de Menções no WhatsApp

> Este sistema foi desenvolvido para resolver a incompatibilidade do Baileys v7 com menções nativas do WhatsApp. Documentado aqui como referência obrigatória para qualquer modificação futura.

### 5.1 Requisitos para menção funcional

Para que uma menção gere **notificação push** e **highlight azul** no WhatsApp, são necessários **DOIS** requisitos simultâneos:

1. O JID do mencionado no array `mentions` — formato `@s.whatsapp.net` (NÃO `@lid`)
2. O texto da mensagem DEVE conter `@<número>` literalmente (ex: `@555584016111`)

> ❌ `@Bruna` no texto = texto plano, sem notificação
> ✅ `@555584016111` no texto + JID no array = menção real

### 5.2 Problema: LIDs vs Phone Numbers

O Baileys v7 retorna participantes de grupo com JIDs no formato `@lid` (IDs internos do WhatsApp). Menções com `@lid` **NÃO geram notificação**.

**Solução:** Usar o campo `p.phoneNumber` do objeto `GroupParticipant` (Baileys), que contém o JID no formato `@s.whatsapp.net` com o número de telefone real.

### 5.3 Mapeamento de contatos — `teamWhatsApp` Map

O mapa global `teamWhatsApp` (Map<string, string>) traduz nomes para JIDs `@s.whatsapp.net`. Populado em **3 camadas progressivas**:

**Camada 1 — Boot (T+5s):** `groupMetadata()` dos grupos internos + clientes gerenciados

**Camada 2 — Background (T+30s):** `mapAllKnownGroups()` — mapeamento massivo de contatos do banco e de todos os grupos

**Camada 3 — Tempo real:** Cada mensagem recebida atualiza o mapa via `upsertContact()` no handler

### 5.4 Resolução fuzzy (loader.mjs)

| Tier | Método | Exemplo |
|------|--------|---------|
| 1. Exato | `teamWhatsApp.get("bruna")` | "bruna" → match direto |
| 2. Parcial | key.includes(nome) ou nome.includes(key) | "bru" → match "bruna" |
| 3. Fuzzy | **Levenshtein real** (`findTeamJid`) — distância ≤ 2 | "brusna" → "bruna" (distância 1) |

---

## 6. Proteção contra Vazamento de Informações (Anti-leak v3)

### 6.1 Contexto

O Jarvis opera em **múltiplos canais com públicos diferentes**: grupos internos (equipe), grupos de clientes, DMs públicos (leads), Instagram DM e Email. Informações internas **NUNCA** devem vazar para nenhum canal externo.

### 6.2 Proteção tripla (v3)

**Camada 1 — Prompt reinforcement** (`buildClientAgentPrompt()` em brain.mjs):
- Bloco `REGRA #1` com exemplos concretos de CORRETO vs ERRADO
- Regra de autonomia: "FAÇA, NÃO DELEGUE" — usar `comentar_task` em vez de pedir a alguém

**Camada 2 — Filtro no código** (brain.mjs):
- `INTERNAL_LEAK_PATTERNS` — array de regexes expandido para:
  - Nomes da equipe (Bruna, Nicolas, Arthur, Bruno, Rigon, Guilherme)
  - "Gui" case-sensitive (evita pegar "guia", "guitarra")
  - Termos cross-client (nomes de outros clientes mencionados em contexto errado)
  - Termos de IA (tool_use, system prompt, thinking, embeddings)
  - Nomes de ferramentas internas (Asana, Baileys, ElevenLabs)
- `checkInternalLeak(text)` — retorna `{ leaked: true, match }` se detectar conteúdo interno
- `sanitizeClientResponse(text)` — tenta remover linhas problemáticas, retorna null se inviável

**Camada 3 — Silêncio normalizado** (brain.mjs):
- Check de `[SILENCIO]` com regex normalizado: `/\[\s*sil[eê]ncio\s*\]/i`
- Se modelo retorna `[SILÊNCIO]` ou `[SILENCIO]` (com ou sem acento) → silêncio total
- Aplicado tanto no agente proativo quanto no `generateResponse()`

**Camada 4 — Memórias escopadas:**
- Memórias são salvas com escopo (`user`, `chat`, `agent`) e `scope_id`
- Contexto de cliente X não contamina respostas para cliente Y
- Homework não é incluído em contexto de canais públicos

---

## 7. Fluxo de Mensagem

```
Mensagem recebida (WhatsApp via Baileys)
  │
  ├─ Filtros iniciais
  │   ├─ sentByBot? → ignora (evita loop)
  │   ├─ status@broadcast? → ignora
  │   └─ grupo permitido? (JARVIS_ALLOWED_GROUPS + managedClients)
  │
  ├─ Persistência
  │   ├─ storeMessage() → PostgreSQL
  │   ├─ upsertContact() → atualiza diretório + teamWhatsApp map
  │   └─ upsertGroup() → registra grupo se novo
  │
  ├─ Aprendizado Passivo (SEMPRE, antes de decidir se responde)
  │   └─ processMemory() → extractFacts(Haiku) → storeFacts(user + chat) + generateEmbedding()
  │
  ├─ Homework (se mensagem do Gui com padrão de instrução)
  │   └─ Salva na tabela homework → prioridade máxima no contexto futuro
  │
  ├─ Autorização de Cliente (se Gui no PV + regex de autorização)
  │   └─ Adiciona/remove managedClients → persiste no banco → confirma
  │
  ├─ AGENTE PROATIVO (se grupo + managedClient + sender ≠ equipe)
  │   └─ handleManagedClientMessage():
  │       ├─ Buffer 15s (consolida mensagens rápidas)
  │       ├─ Rate limit 30s entre respostas
  │       ├─ Contexto: memórias + perfis + homework + histórico
  │       ├─ Claude decide: responder / criar task / notificar equipe / silêncio
  │       ├─ Anti-leak v3 check antes de enviar
  │       └─ return (NÃO continua fluxo normal)
  │
  ├─ ATENDIMENTO PÚBLICO (se DM + sender desconhecido)
  │   └─ handlePublicDM():
  │       ├─ Horário comercial? (8h-18h BRT)
  │       ├─ Limite de 10 mensagens?
  │       ├─ JARVIS_IDENTITY + CHANNEL_CONTEXT.whatsapp_public
  │       ├─ Sonnet (máx 512 tokens)
  │       └─ return (NÃO continua fluxo normal)
  │
  ├─ shouldJarvisRespond()
  │   ├─ @mencionou Jarvis? → sim
  │   ├─ Reply a msg do Jarvis? → sim
  │   ├─ Modo conversa ativo? (janela 3min) → sim
  │   ├─ DM direta? → sim
  │   └─ Nenhum → para aqui (mas já aprendeu)
  │
  └─ generateResponse():
      ├─ getRecentMessages() — 20 últimas do chat
      ├─ Consolida mensagens consecutivas do mesmo remetente
      ├─ getMemoryContext() — 6 camadas de contexto
      ├─ classifyIntent() → traffic/social/creative/manager/researcher/master
      ├─ chooseModel() → Opus (complexo) ou Sonnet (simples)
      ├─ System prompt com cache_control + agente especializado
      ├─ agentLoop() com Extended Thinking:
      │   └─ while(tool_use) → executa tool → alimenta resultado → repete (máx 10)
      ├─ antiHallucinationCheck() — valida resposta
      ├─ Anti-leak v3 check (se grupo de cliente)
      ├─ extractMentionsFromText() — detecta @menções
      ├─ sendText() ou sendTextWithMentions()
      └─ markConversationActive() — abre janela de 3 min
```

---

## 8. API Endpoints

**Base:** `http://localhost:{API_PORT}` (default: 3100)
**Auth interna:** header `x-api-key` · **Auth dashboard:** `Authorization: Bearer <JWT>`

### 8.1 Autenticação (públicos)

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/dashboard/auth/status` | Verifica se existe conta cadastrada |
| `POST` | `/dashboard/auth/setup` | Cadastro inicial (funciona apenas 1x) |
| `POST` | `/dashboard/auth/login` | Login email+senha → envia código 2FA via WhatsApp |
| `POST` | `/dashboard/auth/verify` | Valida 2FA → retorna JWT (validade: 8h) |
| `POST` | `/dashboard/auth/resend` | Reenvia código 2FA |

### 8.2 Webhooks (públicos — validados por token/secret)

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/webhooks/instagram` | Verificação do webhook Instagram (hub.verify_token) |
| `POST` | `/webhooks/instagram` | Recebe mensagens do Instagram DM via Meta Graph API |
| `POST` | `/webhooks/asana` | Recebe eventos do Asana (handshake X-Hook-Secret + eventos de tasks) |

### 8.3 Protegidos (JWT ou x-api-key)

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/status` | Status do bot (versão, uptime, contadores) |
| `POST` | `/send/text` | Enviar mensagem de texto via API |
| `POST` | `/send/audio` | Enviar áudio (TTS) via API |
| `GET` | `/dashboard/health` | Health check (WhatsApp + PostgreSQL + Redis) |
| `GET` | `/dashboard/intelligence` | Score de inteligência (6 eixos + patente) |
| `GET/POST` | `/dashboard/voice` | Configurações de voz (get/set) |
| `GET` | `/dashboard/memory` | Estatísticas de memória (inclui pgvector stats) |
| `GET` | `/dashboard/memory/search` | Buscar memórias por query (busca híbrida se pgvector ativo) |
| `GET` | `/dashboard/memory/recent` | Memórias recentes (com limit) |
| `GET` | `/dashboard/memory/today` | Estatísticas do dia |
| `POST` | `/dashboard/memory/add` | Adicionar memória manualmente |
| `POST` | `/dashboard/memory/backfill` | **NOVO v5.0** — Gera embeddings para memórias antigas (batch) |
| `POST` | `/dashboard/chat` | Chat com Jarvis via dashboard (usa mesmo brain) |
| `GET` | `/dashboard/qr` | QR code para reconexão WhatsApp |
| `GET` | `/dashboard/profiles` | Listar perfis sintetizados |
| `GET` | `/dashboard/profiles/:type/:id` | Perfil específico |
| `POST` | `/dashboard/profiles/sync` | Forçar sincronização de perfis |
| `POST` | `/dashboard/profiles/synthesize` | Sintetizar perfil específico |
| `POST` | `/dashboard/asana/study/start` | Iniciar estudo exaustivo do Asana |
| `GET` | `/dashboard/asana/study/status` | Status do estudo (progresso em tempo real) |
| `POST` | `/dashboard/asana/study/stop` | Parar estudo em andamento |
| `POST` | `/dashboard/auth/change-password` | Alterar senha |
| `GET` | `/dashboard/auth/access-log` | Histórico de acessos |
| `GET` | `/dashboard/agents` | Lista agentes disponíveis e seus status |
| `GET` | `/dashboard/groups` | Listar todos os grupos WhatsApp |
| `POST` | `/dashboard/groups/toggle` | Ativar/desativar grupo |
| `POST` | `/dashboard/webhooks/register` | **NOVO v5.0** — Registra webhooks nos projetos do Asana |
| `GET` | `/dashboard/email-channel` | **NOVO v5.0** — Status do monitor de email + logs recentes |
| `WS` | `/ws/voice` | **NOVO v5.0** — WebSocket para voice mode (streaming bidirecional) |

---

## 9. CI/CD Pipeline

```
git push origin master
  │
  ├─ GitHub Actions: CI (ci.yml)
  │   ├─ Node 20
  │   ├─ npm ci
  │   └─ npm test (60+ testes + scan de credenciais)
  │
  └─ Se CI passou → Deploy (deploy.yml)
      ├─ SSH via chave Ed25519 (GitHub Secrets: VPS_SSH_KEY, VPS_HOST, VPS_USER)
      ├─ ssh-keyscan com fallback StrictHostKeyChecking=no
      ├─ rsync (exclui: .env, auth_session, node_modules, *.bak)
      ├─ npm ci --production
      └─ PM2 restart jarvis (path dinâmico)
```

**Secrets necessários no GitHub:**
- `VPS_SSH_KEY` — chave privada Ed25519
- `VPS_HOST` — IP do servidor
- `VPS_USER` — usuário SSH

---

## 10. Segurança

### 10.1 Dashboard — Autenticação 2FA

| Etapa | Mecanismo |
|-------|-----------|
| 1. Login | Email + senha (bcrypt hash, custo 12) |
| 2. Verificação | Código 6 dígitos via WhatsApp (expira 5min, single-use) |
| 3. Sessão | Token JWT (expira 8h, secret no .env) |

### 10.2 Proteções ativas

- Bloqueio após 5 tentativas erradas (lockout 15 minutos)
- Rate limiting: 10 tentativas/min por IP
- Alerta via WhatsApp para login de IP desconhecido
- Geolocalização de acessos via ip-api.com (cache 1h)
- API key interna (`x-api-key`) para chamadas máquina-a-máquina
- **helmet** — headers de segurança HTTP (NOVO v5.0)
- **cors** — controle de origem (NOVO v5.0)
- Anti-vazamento v3 — proteção expandida em todos os canais externos

### 10.3 Credenciais

- **Zero segredos no código** — auditoria automática em cada CI run
- Todas as credenciais em `.env` (não versionado, excluído do rsync)
- Docker Compose usa variáveis de ambiente
- Scan automatizado: regex para padrões de API keys, tokens, senhas em `*.mjs`

---

## 11. Infraestrutura

### 11.1 VPS (Produção)

| Item | Valor |
|------|-------|
| **Provider** | Azure |
| **OS** | Ubuntu 24.04.4 LTS |
| **IP** | Configurado em `VPS_HOST` (GitHub Secrets) |
| **Processo** | PM2 fork mode, restart automático em crash |
| **Logs** | `/root/.pm2/logs/jarvis-out.log` e `jarvis-error.log` |
| **Domínio** | guardiaolab.com.br (dashboard) |

### 11.2 Docker Compose (PostgreSQL + Redis)

| Serviço | Imagem | Porta | Persistência | Health check |
|---------|--------|-------|-------------|-------------|
| PostgreSQL | postgres:16-alpine | 127.0.0.1:5432 | Volume `postgres_data` | pg_isready |
| Redis | redis:7-alpine | 127.0.0.1:6379 | AOF habilitado | redis-cli ping |

> Ambos com bind exclusivo em localhost — sem exposição externa.
> **pgvector:** extensão instalada no PostgreSQL para busca semântica de memórias.

---

## 12. Testes

```bash
npm test   # Roda suite completa (60+ testes)
```

**Cobertura:**

| Categoria | Testes | Descrição |
|-----------|--------|-----------|
| Helpers | 8 | `getMediaType()`, `extractSender()` — todos os tipos de mídia e cenários DM/grupo |
| Validação | 5 | `isValidResponse()` — rejeita vazias, só pontuação, <3 letras |
| Roteamento | 6+ | `classifyIntent()` — verifica roteamento correto para cada agente |
| Clientes gerenciados | 3 | `isManagedClientGroup()` — ativo, inativo, não cadastrado |
| Agente proativo | 3 | Exports e callbacks do sistema proativo |
| Anti-alucinação | 5 | Bloqueia fabricações, permite respostas legítimas |
| Modelo forte | 2 | `AI_MODEL_STRONG` existe e difere de `AI_MODEL` |
| Mídia/Upload | 4 | Tools de anexo e gestão existem e aceitam parâmetros corretos |
| Estrutura | 2 | `.env.example` completo + scan de credenciais hardcoded |

---

## 13. Variáveis de Ambiente

Consulte `.env.example` para a lista completa. Variáveis organizadas por domínio:

### 13.1 API Keys

| Variável | Serviço |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API (Anthropic) |
| `OPENAI_API_KEY` | Whisper STT + TTS fallback + Embeddings (pgvector) |
| `ELEVENLABS_API_KEY` | TTS primário |
| `ELEVENLABS_VOICE_ID` | ID da voz ElevenLabs |
| `ASANA_PAT` | Asana Personal Access Token |

### 13.2 Infraestrutura

| Variável | Descrição |
|----------|-----------|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL |
| `REDIS_PASSWORD` | Redis |
| `JWT_SECRET` | Secret para tokens JWT |
| `JARVIS_API_KEY` | Chave interna da API (header x-api-key) |
| `API_PORT` | Porta do Express (default: 3100) |

### 13.3 Modelos de IA

| Variável | Exemplo | Uso |
|----------|---------|-----|
| `AI_MODEL` | claude-sonnet-4-6 | Respostas padrão |
| `AI_MODEL_STRONG` | claude-opus-4-6 | Queries complexas |
| `MEMORY_MODEL` | claude-sonnet-4-5 | Extração de fatos + perfis (Sonnet pra inteligência real, sem economizar) |

> ⚠️ **Modelos deprecados — NUNCA usar:** `claude-3-haiku-20240307`, `claude-3-sonnet-20240229`, `claude-3-opus-20240229`. A Anthropic remove modelos antigos e o Jarvis começa a retornar 404 silenciosamente em background.

### 13.4 WhatsApp

| Variável | Descrição |
|----------|-----------|
| `GUI_JID` | JID do dono (para homework e autorizações) |
| `GROUP_TAREFAS` | JID do grupo interno de tarefas |
| `GROUP_GALAXIAS` | JID do grupo interno da equipe |

### 13.5 Asana

| Variável | Descrição |
|----------|-----------|
| `ASANA_WORKSPACE` | GID do workspace |
| `TEAM_ASANA` | JSON: nome→GID dos membros |
| `ASANA_PROJECTS` | JSON: nome→GID dos projetos |
| `ASANA_SECTIONS` | JSON: nome→GID das seções |
| `PUBLIC_ASANA_PROJECTS` | GIDs separados por vírgula |
| `ASANA_CUSTOM_FIELDS` | JSON: nome→GID dos custom fields |
| `ASANA_CLIENTE_MAP` | JSON: cliente→GID enum option |
| `ASANA_URGENCIA_MAP` | JSON: urgência→GID enum option |
| `ASANA_TIER_MAP` | JSON: tier→GID enum option |
| `ASANA_TIPO_DEMANDA_MAP` | JSON: tipo→GID enum option |

### 13.6 Meta Ads

| Variável | Descrição |
|----------|-----------|
| `META_APP_ID` | ID do app Meta Business |
| `META_APP_SECRET` | Secret do app |
| `META_ACCESS_TOKEN` | Token de longa duração (60 dias) |
| `META_AD_ACCOUNT_ID` | ID da conta de anúncios (ex: `act_123`) |
| `META_PAGE_ID` | ID da página Facebook padrão |
| `META_PAGES_MAP` | JSON: cliente→Page ID para multi-cliente |
| `META_WHATSAPP_MAP` | JSON: cliente→número WhatsApp |
| `META_PIXEL_ID` | ID do pixel Facebook |
| `META_API_VERSION` | Versão da Graph API (default: v25.0) |

### 13.7 Google Calendar

| Variável | Descrição |
|----------|-----------|
| `GCAL_KEY_PATH` | Caminho para o JSON da service account |
| `GCAL_CALENDAR_ID` | ID do calendário (email) |

### 13.8 IMAP (Asana Email Monitor)

| Variável | Descrição |
|----------|-----------|
| `IMAP_HOST` | Servidor IMAP |
| `IMAP_PORT` | Porta IMAP (default: 993) |
| `IMAP_USER` | Email do Jarvis no Asana |
| `IMAP_PASSWORD` | Senha do email |
| `IMAP_POLL_INTERVAL` | Intervalo de poll em segundos (default: 90) |

### 13.9 Instagram DM (NOVO v5.0)

| Variável | Descrição |
|----------|-----------|
| `INSTAGRAM_VERIFY_TOKEN` | Token de verificação do webhook Instagram (definido no Meta for Developers) |

### 13.10 Email Channel — Leads/Contato (NOVO v5.0)

| Variável | Descrição |
|----------|-----------|
| `EMAIL_IMAP_HOST` | Servidor IMAP para email genérico |
| `EMAIL_IMAP_PORT` | Porta IMAP (default: 993) |
| `EMAIL_SMTP_HOST` | Servidor SMTP para auto-respostas |
| `EMAIL_SMTP_PORT` | Porta SMTP (default: 587) |
| `EMAIL_USER` | Email da caixa genérica (ex: contato@streamlab.com.br) |
| `EMAIL_PASSWORD` | Senha do email |

---

## 14. Dependências Principais

| Pacote | Versão | Uso |
|--------|--------|-----|
| `@anthropic-ai/sdk` | ^0.78.0 | Claude API (IA principal) |
| `@modelcontextprotocol/sdk` | ^1.27.1 | MCP Server (NOVO v5.0) |
| `@whiskeysockets/baileys` | ^7.0.0 | WhatsApp multi-device |
| `bcrypt` | ^6.0.0 | Hash de senhas (dashboard) |
| `cors` | ^2.8.6 | Controle de CORS (NOVO v5.0) |
| `dotenv` | ^17.3.1 | Variáveis de ambiente |
| `express` | ^5.2.1 | API REST |
| `googleapis` | ^171.4.0 | Google Calendar API |
| `helmet` | ^8.1.0 | Headers de segurança HTTP (NOVO v5.0) |
| `imapflow` | ^1.2.15 | Monitor de email IMAP |
| `jsonwebtoken` | ^9.0.3 | JWT (dashboard auth) |
| `mailparser` | ^3.9.4 | Parse de emails |
| `node-cron` | ^4.2.1 | Jobs agendados |
| `nodemailer` | ^8.0.3 | Envio de email SMTP (NOVO v5.0) |
| `openai` | ^6.27.0 | Whisper STT + TTS fallback + Embeddings |
| `pg` | ^8.20.0 | PostgreSQL driver |
| `qrcode` | ^1.5.4 | QR code para WhatsApp |
| `ws` | ^8.20.0 | WebSocket server (NOVO v5.0) |
| `zod` | — | Validação de schemas (MCP Server, via sdk) |

---

## 15. Changelog

### v5.0.0 (2026-03-25)
- **pgvector** — Busca semântica de memórias via OpenAI embeddings (text-embedding-3-small, 1536 dims). Busca híbrida (vetor + texto) com peso configurável. Índice HNSW. Cache de embeddings em memória (TTL 1h). Endpoint `/dashboard/memory/backfill` para gerar embeddings em batch
- **Showcase Mode** — Modo apresentação ativado por "Quero conhecer o Jarvis" no WhatsApp. Usa Opus para respostas impressionantes. Pergunta preferência de áudio. Timeout de 4 min de inatividade. Auto-venda inteligente (pergunta sobre o negócio e mostra como o Jarvis se encaixa). Anti-troll sofisticado. Blindagem contra alucinação (nunca inventa dados fictícios)
- **Handoff** — Quando equipe manda "eu assumo", "não responda mais", "deixa comigo", o Jarvis silencia para aquele lead. "Jarvis volta" reativa o atendimento
- **handlePublicDM inteligente** — Anti-repetição (nunca repete mesma resposta), detecção de troll, validação de dados (telefone/data), consciência temporal (sabe que dia é hoje), limite de 20 msgs → silêncio (era 10). Tokens 1024 (era 512)
- **Retry automático 429/529** — `claudeWithRetry()` em TODAS as chamadas Claude (brain.mjs, memory.mjs, loader.mjs, instagram.mjs, brain-document.mjs). Backoff exponencial 2s, 4s, 8s
- **Levenshtein em findTeamJid** — Fuzzy matching real que resolve "brusna" → "bruna" (distância ≤ 2)
- **Geração de imagens e stickers** — Tools `gerar_imagem` (DALL-E 3) e `criar_sticker` (WebP 512x512) nos grupos internos
- **Som de peido** — Easter egg nos grupos internos
- **Notificações sem spam** — Lead: notifica 1x na entrada + 1x quando pedir reunião. Sem número LID falso
- **Cobranças e relatório diário** — DESABILITADOS temporariamente até corrigir formato
- **extractFacts com contexto** — Prompt inclui nome/tipo do grupo de origem e lista da equipe para classificação correta (equipe vs cliente)
- **Tom humanizado** — Máx 1 emoji por mensagem em todos os canais. Sem exageros
- **Deploy pipeline** — ssh-keyscan com fallback StrictHostKeyChecking=no. PM2 path dinâmico
- **App Meta Ads publicado** — Modo Live (não mais desenvolvimento)
- **Atendimento Público** — `handlePublicDM()` para DMs de leads/desconhecidos. Limite de 20 mensagens por conversa. Horário comercial (8h-18h BRT). Tabela `public_conversations`. Tom profissional e acolhedor via `CHANNEL_CONTEXT.whatsapp_public`
- **Autonomia Nível 2** — Tools `mover_task_secao` e `atribuir_task` no Asana. Tabela `cobranca_log` para escalação de cobranças em 3 níveis (normal → urgente → escalar pro Gui)
- **Webhooks Asana** — Endpoint `/webhooks/asana` para eventos em tempo real. Notificação automática de tasks concluídas e tasks sem responsável. `processAsanaWebhookEvent()` com filtro anti-loop (ignora eventos do próprio Jarvis). `registerAsanaWebhooks()` para registro automático nos projetos públicos
- **WebSocket Voice** — Servidor WebSocket em `/ws/voice` para streaming de voz bidirecional. Protocolo: chunks binários (áudio) + JSON (comandos). Suporte a interrupção. TTS por frases para latência < 2s
- **Instagram DM** — Canal `src/channels/instagram.mjs`. Webhook Meta Graph API (`/webhooks/instagram`). Histórico em `jarvis_messages`. `CHANNEL_CONTEXT.instagram_dm` (respostas curtas, sem markdown)
- **Email Channel** — Canal `src/channels/email.mjs`. Monitor IMAP (poll 5min) + auto-resposta SMTP. Classificação automática (urgent/normal/newsletter). Tabela `email_log`. Notificação WhatsApp para emails urgentes. `CHANNEL_CONTEXT.email`
- **Dashboard v2** — `dashboard-v2/` com Next.js 16 + TypeScript + React 19 + Tailwind. 9 páginas: Home, Login, Agentes, Chat, Clientes, Grupos, Memória, Segurança, Configurações. Recharts para gráficos. Lucide para ícones
- **MCP Server** — `src/mcp-server.mjs` com 6 tools (send_message, search_memories, create_task, get_client_status, get_metrics, memory_stats). Integração via stdio com Claude Code, Cursor e outros clientes MCP
- **CHANNEL_CONTEXT expandido** — Adicionados 3 novos canais: `instagram_dm`, `email`, `whatsapp_public` (total: 7 canais)
- **Anti-leak v3** — `INTERNAL_LEAK_PATTERNS` expandido com padrões para: Gui (case-sensitive), termos cross-client, termos de IA. Check normalizado de `[SILENCIO]`/`[SILÊNCIO]`. Memórias escopadas impedem contaminação cross-client. Homework excluído de contexto público
- **Segurança** — helmet (headers HTTP), cors (controle de origem)
- **Dependências novas** — ws, helmet, cors, nodemailer, @modelcontextprotocol/sdk, zod, openai (DALL-E 3)

### v4.1.0 (2026-03-19)
- Toggle de grupos no dashboard — ativa/desativa Jarvis por grupo em tempo real
- Tool `buscar_mensagens` — busca no histórico real do WhatsApp por palavras-chave
- Anti-leak v2 — silêncio total em vez de sanitização parcial
- Cobrança inteligente — lê atividades do Asana (não só comentários)
- Áudio em respostas de humor (35% de chance em respostas curtas)
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

## 16. Roadmap

- [x] ~~Rotinas proativas~~ — Agente Proativo para clientes gerenciados
- [x] ~~Arquitetura Claude Code~~ — Agent Loop, Extended Thinking, Prompt Caching
- [x] ~~Meta Ads~~ — 6 agentes, 7 tools novas, multi-cliente
- [x] ~~Menções WhatsApp~~ — phoneNumber JIDs, fuzzy matching, mapeamento massivo
- [x] ~~Anti-vazamento~~ — proteção dupla → tripla (v3) em todos os canais
- [x] ~~pgvector~~ — busca semântica de memórias com embeddings OpenAI
- [x] ~~Webhooks Asana~~ — acompanhamento em tempo real de tasks
- [x] ~~Mover tasks entre seções~~ — tool `mover_task_secao` + `atribuir_task`
- [x] ~~MCP Server~~ — integração com Claude Code, Cursor e ferramentas externas
- [x] ~~Multi-canal~~ — Instagram DM + Email (IMAP/SMTP)
- [x] ~~WebSocket Voice~~ — streaming bidirecional com interrupção
- [x] ~~Dashboard v2~~ — Next.js 16 + TypeScript + 9 páginas
- [x] ~~Showcase Mode~~ — modo apresentação com Opus, auto-venda inteligente, anti-troll
- [x] ~~Handoff equipe~~ — silencia Jarvis por lead quando equipe assume
- [x] ~~Retry automático 429/529~~ — `claudeWithRetry()` com backoff exponencial em todos os módulos
- [x] ~~Levenshtein real~~ — fuzzy matching com distância ≤ 2 em `findTeamJid`
- [x] ~~Geração de imagens/stickers~~ — DALL-E 3 + WebP 512x512 nos grupos internos
- [x] ~~App Meta Ads publicado~~ — modo Live
- [x] ~~Deploy pipeline robusto~~ — ssh-keyscan com fallback, PM2 path dinâmico
- [ ] Cobranças e relatório diário — corrigir formato e reabilitar
- [ ] Ingestão de conteúdo do Google Drive (planners antigos)
- [ ] System User Token Meta (token permanente, sem expiração de 60 dias)
- [ ] RAG completo (chunks + retrieval) para documentos longos
- [ ] Dashboard v2: deploy em produção (substituir v1)
- [ ] Integração Slack/Discord como canais adicionais
