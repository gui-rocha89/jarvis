# Jarvis 4.0 — Technical Reference

> **Projeto:** Jarvis · **Organização:** Stream Lab · **Versão:** 4.0.0
> **Última atualização:** 2026-03-17 · **Autores:** Equipe Stream Lab + Claude Code

---

## 0. PRINCÍPIOS DE DESENVOLVIMENTO (LEIA PRIMEIRO)

> ⚠️ **OBRIGATÓRIO.** Estas regras existem porque erros foram cometidos. Cada regra aqui foi escrita com sangue (metafórico). Se você é uma sessão futura do Claude Code, LEIA TUDO antes de tocar em qualquer código.

### 0.1 Arquitetura de Prompts — UMA IDENTIDADE

O Jarvis usa a mesma arquitetura do Claude: **uma identidade que nunca muda, contexto adapta por canal**.

```
src/agents/master.mjs
├── JARVIS_IDENTITY      → Quem ele é. Regras. Equipe. Tom. NUNCA DUPLICAR.
├── CHANNEL_CONTEXT       → Adapta por canal (WhatsApp/Asana/Dashboard/Voz)
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
| Criar prompt separado para email monitor, dashboard, etc | Usar `JARVIS_IDENTITY + CHANNEL_CONTEXT.asana` (ou outro canal) |
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
4. Rodar npm test (52 testes devem passar)
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

Jarvis 4.0 é um **sistema de IA multi-agente autônomo** que opera via WhatsApp como gestor de projetos virtual 24/7 para a Stream Lab (agência de marketing digital). A arquitetura é inspirada na [Claude Code](https://claude.com/claude-code), com Agent Loop real, Extended Thinking, Prompt Caching e Model Routing dinâmico.

### 1.1 Capacidades Principais

| Capacidade | Descrição |
|-----------|-----------|
| **6 Agentes Especializados** | Master, Creative, Manager, Researcher, Traffic, Social — roteamento automático por intenção |
| **Gestão Proativa de Clientes** | Opera autonomamente em grupos de clientes autorizados (responde, cria tasks, notifica equipe) |
| **Meta Ads Multi-cliente** | Gerencia campanhas de tráfego pago via Graph API v25.0 para múltiplos clientes |
| **Menções Inteligentes** | Sistema de @menções com resolução fuzzy (Levenshtein), mapeamento massivo via histórico |
| **Memória Persistente** | Sistema Mem0-inspired com aprendizado passivo em TODA mensagem recebida |
| **Anti-vazamento** | Filtro duplo (prompt + código) impede exposição de informações internas em grupos de clientes |
| **Dashboard Seguro** | SPA com autenticação 2FA via WhatsApp, JWT, rate limiting e geolocalização |

### 1.2 Stack Tecnológico

```
Runtime:      Node.js 20 (ESM)
WhatsApp:     Baileys v7 (multi-device, auto-reconnect)
IA:           Claude API (Anthropic) — Sonnet 4 + Opus 4
Banco:        PostgreSQL 16 (via pg pool)
Cache:        Redis 7 (AOF habilitado)
TTS:          ElevenLabs v3 (primário) + OpenAI TTS (fallback)
STT:          Whisper (OpenAI)
Calendário:   Google Calendar API (JWT service account)
Ads:          Meta Graph API v25.0 (Facebook/Instagram Ads)
Gestão:       Asana REST API (Personal Access Token)
Frontend:     Tailwind CSS + Chart.js (SPA)
CI/CD:        GitHub Actions → rsync → PM2
Infra:        Ubuntu 24.04 LTS (Azure VPS)
```

---

## 2. Estrutura do Projeto

```
jarvis-v2.mjs                     # Entry point — WhatsApp + Express API + Cron + Mapeamento
src/
├── config.mjs                    # Configurações centrais (100% via process.env)
├── database.mjs                  # PostgreSQL — pool, initDB, CRUD mensagens/contatos/grupos
├── memory.mjs                    # Sistema de memória Mem0-inspired (3 escopos, 10 categorias)
├── brain.mjs                     # Cérebro IA — Agent Loop, roteamento, agente proativo
├── audio.mjs                     # TTS (ElevenLabs/OpenAI) + STT (Whisper)
├── profiles.mjs                  # Síntese de perfis (clientes, equipe, processos)
├── batch-asana.mjs               # Estudo exaustivo do Asana (ingestão 3 fases, resumível)
├── helpers.mjs                   # Utilitários (getMediaType, extractSender)
├── agents/
│   └── master.mjs                # Prompts dos 6 agentes + classificador de intenção
└── skills/
    ├── loader.mjs                # 13 tools do Claude (Asana + Calendar + Meta Ads + WhatsApp)
    └── meta-ads.mjs              # Meta Ads — Graph API wrapper multi-cliente
dashboard/
└── index.html                    # SPA do dashboard (Tailwind, Chart.js, auto-refresh)
tests/
└── unit.test.mjs                 # Suite de testes (47 casos + scan de credenciais)
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
- **Anti-vazamento:** NUNCA expor nomes de equipe, tools ou processos internos em grupos de clientes

### 3.3 Deploy
- **NUNCA fazer deploy manual direto no servidor** — deploy SOMENTE via GitHub CI/CD (`git push`)
- Pipeline: `git push` → CI (testes) → Deploy automático (rsync + PM2 restart)
- Fallback emergencial: `scp` manual + `pm2 restart jarvis` via SSH

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
- **Mapeamento de contatos** — 3 camadas (boot + background + tempo real) para sistema de menções
- Express API com autenticação dupla (`x-api-key` para bot, JWT para dashboard)
- Cron jobs: syncProfiles (6h), estudo Asana incremental (5x/dia seg-sex), cobrança de tarefas (2x/dia), relatório diário (08h)
- Sistema `sentByBot` para evitar auto-resposta
- Gamificação: patentes (10 níveis: Recruta → Diretor da S.H.I.E.L.D.) e score de inteligência (6 eixos)

**Funções-chave:**
| Função | Descrição |
|--------|-----------|
| `handleIncomingMessage(m)` | Pipeline completo: filtro → store → aprendizado → homework → proativo → resposta |
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

**Exporta:** `pool`, `initDB`, `storeMessage`, `getRecentMessages`, `getContactInfo`, `getGroupInfo`, `upsertContact`, `upsertGroup`, `getMessageCount`

**Esquema de tabelas:**

| Tabela | Propósito | Campos-chave |
|--------|-----------|-------------|
| `jarvis_messages` | Histórico completo de mensagens | message_id, chat_id, sender, push_name, text, is_audio, transcription, media_type |
| `jarvis_contacts` | Diretório de contatos WhatsApp | jid, push_name, role, updated_at |
| `jarvis_groups` | Registro de grupos | jid, name |
| `jarvis_config` | Key-value store (JSONB) | key, value |
| `jarvis_memories` | Fatos extraídos por IA | content, category, importance, scope, entity_id |
| `jarvis_profiles` | Perfis sintetizados | entity_type, entity_id, profile (JSONB) |
| `homework` | Instruções de treinamento manual | instruction, context, created_at |
| `gcal_sync` | Sincronização Asana ↔ Google Calendar | asana_task_gid, gcal_event_id |
| `group_events` | Eventos de participantes | group_jid, participant_jid, event_type |
| `asana_study_log` | Progresso do estudo exaustivo | phase, entity_gid, status |
| `dashboard_users` | Contas do dashboard | email, password_hash, totp_secret |
| `dashboard_access_log` | Auditoria de acessos | user_id, ip, user_agent, geo |
| `dashboard_2fa_codes` | Códigos 2FA temporários | code, expires_at, used |

### 4.4 `src/memory.mjs` — Sistema de Memória (Mem0-inspired)

**Exporta:** `initMemory`, `extractFacts`, `storeFacts`, `searchMemories`, `getMemoryContext`, `processMemory`, `getMemoryStats`

**Arquitetura:**
```
Mensagem recebida
  └─ processMemory() [background, non-blocking]
       └─ extractFacts() [Claude Haiku]
            └─ storeFacts() [ADD/UPDATE pipeline]
                 └─ deduplica fatos existentes via ILIKE
```

- **3 escopos:** `user` (pessoas), `chat` (conversas), `agent` (operacional)
- **10 categorias:** preference, client, client_profile, decision, deadline, rule, style, team_member, process, pattern
- **Aprendizado passivo:** `processMemory()` roda em TODA mensagem ≥20 chars — Jarvis aprende 24/7
- **Contexto multicamada:** `getMemoryContext()` agrega 6 fontes (user, chat, agent, client profile, sender profile, homework)

### 4.5 `src/brain.mjs` — Cérebro IA

**Exporta:** `shouldJarvisRespond`, `isValidResponse`, `generateResponse`, `markConversationActive`, `isConversationActive`, `findTeamJid`, `extractMentionsFromText`, `generateDailyReport`, `handleManagedClientMessage`

**Componentes:**

| Componente | Descrição |
|-----------|-----------|
| **Agent Loop** | `agentLoop()` — loop `while(stop_reason === 'tool_use')` até resposta final (máx 10 iterações) |
| **Extended Thinking** | `thinking: { type: "enabled", budget_tokens: N }` — Opus: 8192, Sonnet: 4096 |
| **Interleaved Thinking** | Header beta `interleaved-thinking-2025-05-14` para raciocínio entre tool calls |
| **Prompt Caching** | System prompt como array com `cache_control: { type: "ephemeral" }` nos blocos estáticos |
| **Model Routing** | `chooseModel()` → Opus para queries complexas (análise, estratégia), Sonnet para o resto |
| **Anti-alucinação** | `antiHallucinationCheck()` — bloqueia respostas fabricadas sem base em tools |
| **Anti-vazamento** | `checkInternalLeak()` + `sanitizeClientResponse()` — proteção dupla em grupos de clientes |
| **Modo Conversa** | Janela de 3 minutos ativa após resposta — responde sem precisar de @menção |

**Agente Proativo (`handleManagedClientMessage`):**
- Opera autonomamente em grupos de clientes autorizados
- Consolida mensagens rápidas (buffer 15s) + rate limit (30s entre respostas)
- Claude decide: responder, criar task, notificar equipe ou silenciar
- Quando não sabe → pergunta à equipe no grupo interno e aprende com a resposta
- Erro → silêncio absoluto (nunca expõe erro ao cliente)

### 4.6 `src/agents/master.mjs` — Time de Agentes

**Exporta:** `classifyIntent`, `MASTER_SYSTEM_PROMPT`, `AGENT_PROMPTS`

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

**Exporta:** `asanaRequest`, `asanaCreateTask`, `asanaAddToProject`, `asanaAddComment`, `asanaUploadAttachment`, `getOverdueTasks`, `getGCalClient`, `createGoogleCalendarEvent`, `JARVIS_TOOLS`, `executeJarvisTool`, `registerSendFunction`, `registerSendWithMentionsFunction`, `getSendFunction`

**13 tools disponíveis:**

| Tool | Agente | Descrição | Campos obrigatórios |
|------|--------|-----------|-------------------|
| `agendar_captacao` | Manager | Cria evento no Google Calendar + task no Asana | titulo, data, horario |
| `consultar_tarefas` | Manager | Busca tarefas no Asana (filtro por projeto/responsável) | — |
| `lembrar` | Manager | Registra lembrete/memória | conteudo |
| `criar_demanda_cliente` | Manager | Cria task no Asana (Cabine de Comando) com custom fields | titulo, cliente |
| `enviar_mensagem_grupo` | Todos | Envia mensagem no WhatsApp com menções reais | grupo, mensagem |
| `anexar_midia_asana` | Manager | Upload de mídia do WhatsApp como anexo em task | task_id |
| `comentar_task` | Manager | Adiciona comentário em task do Asana | task_id, comentario |
| `criar_campanha` | Traffic | Cria campanha Meta Ads (SEMPRE pausada) | nome, objetivo, orcamento_diario |
| `relatorio_ads` | Traffic | Relatório de métricas (CPC, CTR, ROAS, CPA) | periodo |
| `pausar_campanha` | Traffic | Pausa ou retoma campanha | campanha_id, acao |
| `agendar_post` | Social | Publica ou agenda post no Facebook/Instagram | texto |
| `calendario_editorial` | Social | Consulta/planeja grade de conteúdo | acao |
| `metricas_post` | Social | Métricas de posts orgânicos (alcance, engajamento) | — |

**Sistema de menções na tool `enviar_mensagem_grupo`:**
```
Input: { grupo: "tarefas", mensagem: "Oi @Bruna!", mencoes: ["Bruna"] }

Resolução (3 tiers):
  1. Exato:   teamWhatsApp.get("bruna") → "555584016111@s.whatsapp.net"
  2. Parcial: key.includes("brun") → match
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

### 4.10 Módulos auxiliares

| Módulo | Exporta | Descrição |
|--------|---------|-----------|
| `src/profiles.mjs` | `synthesizeProfile`, `getProfile`, `listProfiles`, `syncProfiles` | Sintetiza perfis via Haiku a partir de memórias acumuladas. 4 tipos: client, group, team_member, process |
| `src/batch-asana.mjs` | `startAsanaStudy`, `stopAsanaStudy`, `asanaBatchState` | Ingestão em 3 fases (Projetos→Tarefas→Comentários). Resumível, rate limited, somente leitura |
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
```
Para cada participante:
  mentionJid = p.phoneNumber || p.id  (preferir @s.whatsapp.net)
  pushName obtido via getContactInfo() ou p.notify
  Registra: firstName, cleanName (só letras), fullClean (sem emojis)
  Equipe interna tem PRIORIDADE (não é sobrescrita por contatos de cliente)
```

**Camada 2 — Background (T+30s):** `mapAllKnownGroups()` — mapeamento massivo
```
1. SELECT * FROM jarvis_contacts WHERE jid LIKE '%@s.whatsapp.net'
   → Mapeia TODOS os contatos que já mandaram mensagem (histórico completo)

2. SELECT * FROM jarvis_contacts WHERE jid LIKE '%@lid'
   → Cross-reference com jarvis_messages (mesmo push_name) para resolver LID→phone

3. SELECT * FROM jarvis_groups WHERE jid LIKE '%@g.us'
   → groupMetadata() de todos os grupos restantes (rate limited: 5 por vez, 2s pausa)
```

**Camada 3 — Tempo real:** Cada mensagem recebida atualiza o mapa via `upsertContact()` no handler

### 5.4 Resolução fuzzy (loader.mjs)

Quando o Claude chama `enviar_mensagem_grupo` com `mencoes: ["Bruna"]`, a resolução acontece em 3 tiers:

| Tier | Método | Exemplo |
|------|--------|---------|
| 1. Exato | `teamWhatsApp.get("bruna")` | "bruna" → match direto |
| 2. Parcial | key.includes(nome) ou nome.includes(key) | "bru" → match "bruna" |
| 3. Fuzzy | Levenshtein distance ≤ 2 | "brusna" → "bruna" (distância 1) |

A função `fuzzyMatch()` implementa Levenshtein com matrix DP e threshold de distância 2.

### 5.5 Substituição no texto

Após resolver os JIDs, o sistema substitui `@NomePessoa` por `@número` no texto antes de enviar:

```javascript
// Para cada menção resolvida:
const phoneNum = jid.replace(/@s\.whatsapp\.net$/, '');
msgText = msgText.replace(/@Bruna/gi, `@${phoneNum}`);
// "Oi @Bruna, tudo bem?" → "Oi @555584016111, tudo bem?"
```

---

## 6. Proteção contra Vazamento de Informações

### 6.1 Contexto

O Jarvis opera simultaneamente em grupos internos (equipe) e grupos de clientes. Informações internas (nomes de equipe, tools usadas, processos) **NUNCA** devem vazar para clientes.

### 6.2 Proteção dupla

**Camada 1 — Prompt reinforcement** (`buildClientAgentPrompt()` em brain.mjs):
- Bloco `🚨🚨🚨 REGRA #1` com exemplos concretos de CORRETO vs ERRADO
- Regra de autonomia: "FAÇA, NÃO DELEGUE" — usar `comentar_task` em vez de pedir a alguém

**Camada 2 — Filtro no código** (brain.mjs):
- `INTERNAL_LEAK_PATTERNS` — array de regexes para nomes de equipe, tools, processos
- `checkInternalLeak(text)` — retorna true se detectar conteúdo interno
- `sanitizeClientResponse(text)` — tenta remover linhas problemáticas, retorna null se inviável
- Fluxo: leak detectado → tenta sanitizar → se não conseguir → silêncio total

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
  │   └─ processMemory() → extractFacts(Haiku) → storeFacts(user + chat)
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
  │       ├─ Anti-leak check antes de enviar
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

### 8.2 Protegidos (JWT ou x-api-key)

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/status` | Status do bot (versão, uptime, contadores) |
| `POST` | `/send/text` | Enviar mensagem de texto via API |
| `POST` | `/send/audio` | Enviar áudio (TTS) via API |
| `GET` | `/dashboard/health` | Health check (WhatsApp + PostgreSQL + Redis) |
| `GET` | `/dashboard/intelligence` | Score de inteligência (6 eixos + patente) |
| `GET/POST` | `/dashboard/voice` | Configurações de voz (get/set) |
| `GET` | `/dashboard/memory` | Estatísticas de memória |
| `GET` | `/dashboard/memory/search` | Buscar memórias por query |
| `GET` | `/dashboard/memory/recent` | Memórias recentes (com limit) |
| `GET` | `/dashboard/memory/today` | Estatísticas do dia |
| `POST` | `/dashboard/memory/add` | Adicionar memória manualmente |
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

---

## 9. CI/CD Pipeline

```
git push origin master
  │
  ├─ GitHub Actions: CI (ci.yml)
  │   ├─ Node 20
  │   ├─ npm ci
  │   └─ npm test (47 testes + scan de credenciais)
  │
  └─ Se CI passou → Deploy (deploy.yml)
      ├─ SSH via chave Ed25519 (GitHub Secrets: VPS_SSH_KEY, VPS_HOST, VPS_USER)
      ├─ rsync (exclui: .env, auth_session, node_modules, *.bak)
      ├─ npm ci --production
      └─ PM2 restart jarvis
```

**Fallback (se SSH keyscan falhar):**
```bash
scp jarvis-v2.mjs root@31.97.160.141:/opt/jarvis/
scp -r src/ root@31.97.160.141:/opt/jarvis/
ssh root@31.97.160.141 "cd /opt/jarvis && npx pm2 restart jarvis"
```

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

---

## 12. Testes

```bash
npm test   # Roda suite completa (47 testes)
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
| `OPENAI_API_KEY` | Whisper STT + TTS fallback |
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
| `AI_MODEL_STRONG` | claude-opus-4-0-20250514 | Queries complexas |
| `MEMORY_MODEL` | claude-3-haiku-20240307 | Extração de fatos |

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
| `META_API_VERSION` | Versão da Graph API (default: v25.0) |

### 13.7 Google Calendar

| Variável | Descrição |
|----------|-----------|
| `GCAL_KEY_PATH` | Caminho para o JSON da service account |
| `GCAL_CALENDAR_ID` | ID do calendário (email) |

---

## 14. Changelog

### v4.0.0 (2026-03-16)
- **6 agentes** — adicionados Traffic (Meta Ads) e Social (redes sociais orgânicas)
- **Meta Ads** — 7 tools novas, multi-cliente via META_PAGES_MAP (15 páginas mapeadas)
- **Menções inteligentes** — sistema completo com phoneNumber JIDs, fuzzy matching (Levenshtein ≤ 2), mapeamento massivo via `jarvis_contacts`
- **Anti-vazamento** — filtro duplo (prompt reforçado + `checkInternalLeak()`) para grupos de clientes
- **Autonomia** — Jarvis executa tarefas em vez de delegar (usa `comentar_task` diretamente)
- **Mapeamento massivo** — `mapAllKnownGroups()` puxa todos os contatos do histórico do banco

### v3.0.0 (2026-03-01)
- Arquitetura Claude Code: Agent Loop real, Extended Thinking, Prompt Caching
- Model Routing dinâmico (Sonnet/Opus)
- Anti-alucinação
- Dashboard com 2FA via WhatsApp

### v2.0.0 (2026-02-01)
- Agente Proativo para clientes gerenciados
- Tools: `criar_demanda_cliente`, `enviar_mensagem_grupo`, `anexar_midia_asana`
- Sistema de memória Mem0-inspired

### v1.0.0 (2026-01-01)
- Bot WhatsApp básico com Claude API
- Integração Asana + Google Calendar
- TTS/STT

---

## 15. Roadmap

- [x] ~~Rotinas proativas~~ — Agente Proativo para clientes gerenciados
- [x] ~~Arquitetura Claude Code~~ — Agent Loop, Extended Thinking, Prompt Caching
- [x] ~~Meta Ads~~ — 6 agentes, 7 tools novas, multi-cliente
- [x] ~~Menções WhatsApp~~ — phoneNumber JIDs, fuzzy matching, mapeamento massivo
- [x] ~~Anti-vazamento~~ — proteção dupla em grupos de clientes
- [ ] pgvector para busca semântica de memórias
- [ ] Webhooks Asana para acompanhamento em tempo real
- [ ] Mover tarefas entre seções no Asana via tool
- [ ] Ingestão de conteúdo do Google Drive (planners antigos)
- [ ] MCP server para integração com ferramentas externas
- [ ] Agente de vendas para atendimento automático
- [ ] System User Token Meta (token permanente, sem expiração de 60 dias)
