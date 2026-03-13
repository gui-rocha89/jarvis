# CLAUDE.md — Jarvis 2.0 (Stream Lab)

> Documento de referência técnica para desenvolvimento assistido por IA.
> Última atualização: 2026-03-13

---

## Visão Geral

Jarvis 2.0 é um agente de IA autônomo no WhatsApp para a **Stream Lab** (agência de marketing digital). Arquitetura modular inspirada em Mem0 (memória), CrewAI (agentes) e NanoClaw (skills).

**Stack principal:** Node.js (ESM) · Baileys v7 · Claude API (Anthropic) · PostgreSQL 16 · Redis 7 · ElevenLabs · Google Calendar

---

## Estrutura do Projeto

```
jarvis-v2.mjs                  # Entry point (~1200 linhas) — WhatsApp + Express API + Cron
src/
├── config.mjs                  # Configurações centrais (100% via process.env)
├── database.mjs                # PostgreSQL — pool, initDB, CRUD de mensagens/contatos/grupos
├── memory.mjs                  # Sistema de memória Mem0-inspired (3 escopos, 10 categorias)
├── brain.mjs                   # Cérebro IA — roteamento de agentes, geração de respostas
├── audio.mjs                   # TTS (ElevenLabs/OpenAI) + STT (Whisper)
├── profiles.mjs                # Síntese de perfis (clientes, equipe, processos)
├── batch-asana.mjs             # Estudo exaustivo do Asana (ingestão em 3 fases)
├── helpers.mjs                 # Utilitários (getMediaType, extractSender)
├── agents/
│   └── master.mjs              # Prompts dos 4 agentes + classificador de intenção
└── skills/
    └── loader.mjs              # Tools do Claude (Asana + Google Calendar)
dashboard/
└── index.html                  # SPA do dashboard (Tailwind, Chart.js, auto-refresh)
tests/
└── unit.test.mjs               # Suite de testes (35 casos + scan de credenciais)
.github/workflows/
├── ci.yml                      # CI — Node 20, npm ci, npm test
└── deploy.yml                  # CD — rsync para VPS via SSH (auto após CI)
docker-compose.yml              # PostgreSQL 16 + Redis 7 (credenciais via .env)
.env                            # Credenciais (NÃO VERSIONADO)
auth_session/                   # Sessão WhatsApp (NÃO VERSIONADO)
```

---

## Regras Críticas (NUNCA VIOLAR)

### Asana
- **NUNCA alterar descrições de tasks** — usar SOMENTE comentários
- Projetos públicos: Cabine de Comando, Produção de Design, Produção de Audiovisual, Captações
- Demais projetos são CONFIDENCIAIS

### Código
- **Pool PostgreSQL:** usar `pool` exportado de `database.mjs` (NUNCA `CONFIG.DATABASE_URL`)
- **Auth interna (WhatsApp → API):** header `x-api-key`
- **Auth Dashboard:** JWT via `Authorization: Bearer <token>` (login + 2FA obrigatório)
- **Google JWT:** sintaxe de objeto `new google.auth.JWT({ email, key, scopes })`
- **Credenciais:** TODAS vêm do `.env` — NUNCA hardcodar senhas, tokens, IPs, telefones ou GIDs
- **Português SEMPRE com acentos** em respostas e documentação voltada ao usuário

### Deploy
- **NUNCA fazer deploy manual direto no servidor** — deploy SOMENTE via GitHub CI/CD (`git push`)
- O pipeline é: `git push` → CI (testes) → Deploy automático (rsync + PM2 restart)

### Arquivos NÃO versionados
- `.env` — chaves de API, senhas, IDs sensíveis
- `auth_session/` — sessão do WhatsApp
- `node_modules/`
- `google-calendar-key.json`
- `audio_files/` — arquivos de áudio temporários

---

## Módulos

### jarvis-v2.mjs (Entry Point)
**Exporta:** nada (entry point)

- Conexão WhatsApp via Baileys (multi-device, auto-reconnect)
- Handler de mensagens (texto, áudio, captions de imagem/vídeo)
- Aprendizado passivo em tempo real (processMemory em TODAS as mensagens ≥20 chars)
- **Homework via WhatsApp** — detecta instruções/correções do dono e salva como homework (prioridade máxima)
- **Autorização de clientes** — detecta "autorizo você a operar no cliente X" via regex, salva no banco
- **Agente Proativo** — intercepta mensagens de grupos gerenciados antes do fluxo normal, delega para `handleManagedClientMessage()`
- `registerSendFunction(sendText)` — registra callback após criar o socket para tools proativas
- `loadManagedClients(pool)` — carrega clientes gerenciados no boot
- Express API com autenticação dupla (x-api-key + JWT)
- Cron jobs: syncProfiles a cada 6h, estudo Asana incremental 5x/dia (seg-sex)
- Sistema sentByBot para evitar auto-resposta
- Sistema de patentes (10 níveis: Recruta → Diretor da S.H.I.E.L.D.)
- Score de inteligência (6 eixos: empresa, equipe, clientes, projetos, comunicação, processos)

### src/config.mjs
**Exporta:** `CONFIG`, `TEAM_ASANA`, `ASANA_PROJECTS`, `ASANA_SECTIONS`, `PUBLIC_ASANA_PROJECTS`, `JARVIS_ALLOWED_GROUPS`, `AUDIO_ALLOWED`, `teamPhones`, `teamWhatsApp`, `managedClients`, `loadManagedClients`, `saveManagedClients`, `isManagedClientGroup`

- Todas as configurações centralizadas via `process.env`
- Parsing de JSON para maps de equipe/projetos/seções do Asana
- **Managed Clients:** Map persistido no `jarvis_config` (key: `managed_clients`) com clientes autorizados para operação proativa
  - `loadManagedClients(pool)` — carrega do banco no boot
  - `saveManagedClients(pool)` — persiste após autorizar/revogar
  - `isManagedClientGroup(jid)` — retorna objeto do cliente se ativo, senão null

### src/database.mjs
**Exporta:** `pool`, `initDB`, `storeMessage`, `getRecentMessages`, `getContactInfo`, `getGroupInfo`, `upsertContact`, `upsertGroup`, `getMessageCount`

- Pool PostgreSQL com credenciais via .env
- `initDB()` cria todas as tabelas automaticamente (idempotente)

**Tabelas:**
| Tabela | Função |
|--------|--------|
| `jarvis_messages` | Histórico de mensagens (text, audio, transcription) |
| `jarvis_contacts` | Contatos do WhatsApp (jid, push_name, role) |
| `jarvis_groups` | Grupos do WhatsApp (jid, name) |
| `jarvis_config` | Configurações key-value (JSONB) |
| `jarvis_memories` | Memórias extraídas (content, category, importance, scope) |
| `jarvis_profiles` | Perfis sintetizados (entity_type, entity_id, profile JSONB) |
| `homework` | Instruções de treinamento manual |
| `gcal_sync` | Sincronização Asana ↔ Google Calendar |
| `group_events` | Eventos de grupo (entrada/saída de participantes) |
| `asana_study_log` | Controle do estudo exaustivo do Asana (resumível) |
| `dashboard_users` | Usuários do dashboard (email, bcrypt hash, 2FA) |
| `dashboard_access_log` | Log de acessos (IP, user-agent, geolocalização) |
| `dashboard_2fa_codes` | Códigos 2FA temporários (6 dígitos, 5min TTL) |

### src/memory.mjs (Mem0-inspired)
**Exporta:** `initMemory`, `extractFacts`, `storeFacts`, `searchMemories`, `getMemoryContext`, `processMemory`, `getMemoryStats`

- **3 escopos de memória:** user (pessoas), chat (conversas), agent (operacional)
- **10 categorias:** preference, client, client_profile, decision, deadline, rule, style, team_member, process, pattern
- Extração de fatos via Claude Haiku (model configurável via `MEMORY_MODEL` no .env)
- Pipeline ADD/UPDATE similar ao Mem0 (deduplica fatos existentes)
- Busca por ILIKE (sem pgvector no momento)
- `processMemory()` — roda em background em TODA mensagem recebida (aprendizado passivo)
- `getMemoryContext()` — 6 camadas (user, chat, agent, client profile, sender profile, homework)

### src/brain.mjs (Cérebro + Agent Teams + Agente Proativo)
**Exporta:** `shouldJarvisRespond`, `isValidResponse`, `generateResponse`, `markConversationActive`, `isConversationActive`, `findTeamJid`, `extractMentionsFromText`, `generateDailyReport`, `handleManagedClientMessage`

- Classifica intenção e roteia para agente especializado (master/creative/manager/researcher)
- Modo conversa: janela de 3 minutos ativa após resposta
- Consolidação de mensagens consecutivas do mesmo remetente
- Detecção de @mentions no texto da resposta
- **Agente Proativo:** `handleManagedClientMessage()` processa mensagens de grupos de clientes gerenciados
  - Busca contexto completo: memórias, perfis, homework, histórico do chat
  - Deixa o Claude decidir autonomamente (sem regras rígidas) usando tools disponíveis
  - Consolida mensagens rápidas (buffer 15s) + rate limit (30s entre respostas)
  - Quando não sabe, pergunta pra equipe no grupo interno e aprende com a resposta
  - Em caso de erro → silêncio (nunca mostra erro para o cliente)

### src/agents/master.mjs
**Exporta:** `classifyIntent`, `MASTER_SYSTEM_PROMPT`, `AGENT_PROMPTS`

| Agente | Especialidade | Triggers |
|--------|--------------|----------|
| Master | Conversação geral, personalidade Jarvis (Tony Stark) | Default |
| Creative | Copy, legendas, roteiros, CTAs | copy, arte, conteúdo, post... |
| Manager | Gestão de projetos, prazos, Asana | tarefa, prazo, status, cobrança... |
| Researcher | Pesquisa, dados, tendências | pesquisar, dados, benchmark... |

### src/audio.mjs
**Exporta:** `voiceConfig`, `loadVoiceConfig`, `saveVoiceConfig`, `transcribeAudio`, `generateAudio`

- TTS primário: ElevenLabs v3 (stability, similarity_boost, style, speaker_boost configuráveis)
- TTS fallback: OpenAI TTS
- STT: Whisper (OpenAI) para transcrição de áudios recebidos
- Configurações de voz persistidas e editáveis via dashboard

### src/profiles.mjs
**Exporta:** `synthesizeProfile`, `getProfile`, `listProfiles`, `syncProfiles`

- Sintetiza perfis estruturados a partir de memórias acumuladas (via Claude Haiku)
- 4 tipos de entidade: client, group, team_member, process
- `syncProfiles()` — identifica entidades com ≥3 memórias e gera perfis automaticamente
- Roda via cron (a cada 6h) e após conclusão de batch/estudo

### src/batch-asana.mjs (Estudo Exaustivo do Asana)
**Exporta:** `startAsanaStudy`, `stopAsanaStudy`, `asanaBatchState`

- Ingestão em 3 fases: Projetos → Tarefas → Comentários
- Extrai fatos via Claude Haiku e salva na memória (escopos agent + user)
- Rate limiting: 1 req/s para Asana API (60/min), 2 extrações/s para Haiku
- Retry automático em 429 (Retry-After)
- Paginação completa via `asanaGetAll()`
- Resumível: controle de progresso via tabela `asana_study_log`
- Auto `syncProfiles()` após conclusão
- Somente leitura (GET) — ZERO escrita no Asana

### src/skills/loader.mjs
**Exporta:** `asanaRequest`, `asanaCreateTask`, `asanaAddToProject`, `asanaAddComment`, `getOverdueTasks`, `getGCalClient`, `createGoogleCalendarEvent`, `JARVIS_TOOLS`, `executeJarvisTool`, `registerSendFunction`, `getSendFunction`

- Tools disponíveis para o Claude: `agendar_captacao`, `consultar_tarefas`, `lembrar`, `criar_demanda_cliente`, `enviar_mensagem_grupo`
- `criar_demanda_cliente` — cria task no Asana (Cabine de Comando) com prefixo [CLIENTE], atribui responsável
- `enviar_mensagem_grupo` — envia mensagem no WhatsApp (resolve nome → JID: "tarefas", "galaxias", ou nome do cliente)
- `registerSendFunction(fn)` — registra callback de envio (o `jarvis-v2.mjs` registra `sendText` após criar o socket)
- Integração Asana: GET/POST com Bearer token do .env
- Integração Google Calendar: JWT auth com service account

### src/helpers.mjs
**Exporta:** `getMediaType`, `extractSender`

- `getMediaType()` — detecta tipo de mídia (audio, image, video, document, sticker, contact, location)
- `extractSender()` — extrai JID do remetente (trata DMs vs. grupos, participant/participantAlt)

---

## API Endpoints

**Base:** porta configurada em `API_PORT` (.env)
**Auth interna:** header `x-api-key` | **Auth dashboard:** `Authorization: Bearer <JWT>`

### Autenticação (públicos)
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | /dashboard/auth/status | Verifica se existe conta cadastrada |
| POST | /dashboard/auth/setup | Cadastro inicial (funciona apenas 1x) |
| POST | /dashboard/auth/login | Login email+senha → envia 2FA via WhatsApp |
| POST | /dashboard/auth/verify | Valida 2FA → retorna JWT (8h) |
| POST | /dashboard/auth/resend | Reenvia código 2FA |

### Protegidos (JWT ou x-api-key)
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | /status | Status do bot (versão, contadores) |
| POST | /send/text | Enviar mensagem de texto |
| POST | /send/audio | Enviar mensagem de áudio (TTS) |
| GET | /dashboard/health | Health check |
| GET | /dashboard/intelligence | Score de inteligência (6 eixos + patente) |
| GET/POST | /dashboard/voice | Configurações de voz |
| GET | /dashboard/memory | Estatísticas de memória |
| GET | /dashboard/memory/search | Buscar memórias |
| GET | /dashboard/memory/recent | Memórias recentes (limit) |
| GET | /dashboard/memory/today | Estatísticas do dia |
| POST | /dashboard/memory/add | Adicionar memória manualmente |
| POST | /dashboard/chat | Chat com Jarvis via dashboard |
| GET | /dashboard/qr | QR code para reconexão WhatsApp |
| GET | /dashboard/profiles | Listar perfis sintetizados |
| GET | /dashboard/profiles/:type/:id | Perfil específico |
| POST | /dashboard/profiles/sync | Forçar sincronização de perfis |
| POST | /dashboard/profiles/synthesize | Sintetizar perfil específico |
| POST | /dashboard/asana/study/start | Iniciar estudo exaustivo do Asana |
| GET | /dashboard/asana/study/status | Status do estudo (progresso em tempo real) |
| POST | /dashboard/asana/study/stop | Parar estudo |
| POST | /dashboard/auth/change-password | Alterar senha |
| GET | /dashboard/auth/access-log | Histórico de acessos |

---

## Fluxo de Mensagem

```
Mensagem recebida (WhatsApp)
  │
  ├─ Filtros: sentByBot? grupo permitido? tamanho mínimo?
  ├─ storeMessage() → PostgreSQL
  ├─ upsertContact() / upsertGroup()
  │
  ├─ Aprendizado Passivo (SEMPRE, antes de decidir se responde):
  │   └─ processMemory() → extractFacts (Haiku) → storeFacts (user + chat)
  │
  ├─ Homework (se mensagem do Gui com padrão de instrução):
  │   └─ Salva na tabela homework → carregada como "PRIORIDADE MAXIMA" no contexto
  │
  ├─ Autorização de Cliente (se Gui no PV + regex de autorização/revogação):
  │   └─ Adiciona/remove do managedClients → salva no banco → confirma pro Gui
  │
  ├─ AGENTE PROATIVO (se grupo + managedClient + sender não é equipe):
  │   └─ handleManagedClientMessage():
  │       1. Consolida mensagens rápidas (buffer 15s)
  │       2. Busca contexto completo (memórias, perfis, homework)
  │       3. Claude decide autonomamente com tools disponíveis
  │       4. Responde ao cliente / cria task / notifica equipe / silêncio
  │       → return (NÃO continua fluxo normal)
  │
  ├─ shouldJarvisRespond() — mencionou? reply? modo conversa? grupo permitido?
  │   └─ Se NÃO → para aqui (mas já aprendeu)
  │
  └─ generateResponse():
      1. getRecentMessages() — 20 últimas do chat
      2. Consolida mensagens consecutivas do mesmo role
      3. getMemoryContext() — 6 camadas de contexto
      4. classifyIntent() → master/creative/manager/researcher
      5. System prompt + contexto + agente especializado
      6. Claude API com tools (agendar_captacao, consultar_tarefas, lembrar,
         criar_demanda_cliente, enviar_mensagem_grupo)
      7. Se tool_use → executa → follow-up com resultado
      8. extractMentionsFromText()
      → Envia resposta no WhatsApp
      → markConversationActive() (janela de 3 min)
```

---

## CI/CD Pipeline

```
git push origin master
  │
  ├─ GitHub Actions: CI - Testes (ci.yml)
  │   ├─ Node 20 + npm ci
  │   └─ npm test (25 testes + scan de credenciais)
  │
  └─ Se CI passou → Deploy para VPS (deploy.yml)
      ├─ SSH via chave Ed25519 (GitHub Secrets)
      ├─ rsync (exclui .env, auth_session, node_modules, *.bak)
      ├─ npm ci --production
      └─ PM2 restart jarvis
```

**GitHub Secrets necessários:**
- `VPS_SSH_KEY` — chave privada Ed25519
- `VPS_HOST` — IP do servidor
- `VPS_USER` — usuário SSH (root)

---

## Segurança

### Dashboard (2FA obrigatório)
1. **Email + Senha** — bcrypt hash, custo 12
2. **Código 2FA via WhatsApp** — 6 dígitos, expira 5min, single-use
3. **Token JWT** — expira 8h, secret no .env

### Proteções
- Bloqueio após 5 tentativas erradas (15min lockout)
- Rate limiting: 10 tentativas/min por IP
- Alerta via WhatsApp para IP desconhecido
- Geolocalização via ip-api.com (cache 1h)
- API key interna (`x-api-key`) para chamadas do bot (backward compat)

### Credenciais
- **Zero segredos no código** — auditoria automática via `unit.test.mjs`
- Todas as credenciais em `.env` (não versionado)
- Docker Compose usa variáveis de ambiente (sem senhas hardcoded)
- Deploy exclui `.env` e `google-calendar-key.json` via rsync

---

## Infraestrutura

### Docker Compose
| Serviço | Imagem | Porta | Persistência |
|---------|--------|-------|-------------|
| PostgreSQL | postgres:16-alpine | 127.0.0.1:5432 | Volume `postgres_data` |
| Redis | redis:7-alpine | 127.0.0.1:6379 | AOF habilitado |

Ambos com health check habilitado e bind apenas em localhost.

### PM2
- Processo: `jarvis` (fork mode)
- Restart automático em crash
- Logs: `/root/.pm2/logs/jarvis-out.log` e `jarvis-error.log`

---

## Testes

```bash
npm test   # Roda suite completa
```

**35 casos de teste:**
- `getMediaType()` — detecção de tipos de mídia (audio, image, video, etc.)
- `extractSender()` — extração de JID em DMs e grupos
- `isValidResponse()` — validação de respostas (rejeita vazias, só pontuação, <3 letras)
- `classifyIntent()` — roteamento para agente correto por keywords
- `isManagedClientGroup()` — ativação/desativação de clientes gerenciados
- `handleManagedClientMessage()` — export e existência do agente proativo
- `registerSendFunction()` — registro e recuperação de callback de envio
- `.env.example` — valida que todas as variáveis obrigatórias estão documentadas
- **Scan de credenciais** — varre todos os `.mjs` por padrões de chaves/tokens hardcoded

---

## Variáveis de Ambiente

Consulte `.env.example` para a lista completa. Variáveis críticas:

| Variável | Descrição |
|----------|-----------|
| `ANTHROPIC_API_KEY` | Chave da API Claude |
| `OPENAI_API_KEY` | Chave OpenAI (Whisper + TTS fallback) |
| `ELEVENLABS_API_KEY` | Chave ElevenLabs (TTS primário) |
| `ASANA_PAT` | Personal Access Token do Asana |
| `ASANA_WORKSPACE` | GID do workspace Asana |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL |
| `REDIS_PASSWORD` | Senha do Redis |
| `JWT_SECRET` | Secret para tokens JWT do dashboard |
| `API_KEY` | Chave interna da API (header x-api-key) |
| `API_PORT` | Porta do Express (default: 3100) |
| `MEMORY_MODEL` | Modelo para extração de fatos (ex: claude-3-haiku-20240307) |
| `AI_MODEL` | Modelo principal para respostas (ex: claude-sonnet-4-20250514) |

---

## Evolução Futura

- [x] ~~Rotinas proativas~~ — Agente Proativo implementado (opera em grupos de clientes autorizados)
- [x] ~~Novos tools~~ — `criar_demanda_cliente`, `enviar_mensagem_grupo` implementados
- [ ] pgvector para busca semântica de memórias
- [ ] Webhooks Asana para acompanhamento em tempo real
- [ ] Novos tools: mover tarefas entre seções no Asana
- [ ] Ingestão de conteúdo do Google Drive (planners antigos)
- [ ] MCP server para integração com ferramentas externas
- [ ] Agente de vendas para atendimento automático
- [ ] Relatório diário automático (cron + envio no grupo)
