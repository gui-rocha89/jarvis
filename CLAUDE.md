# CLAUDE.md - Jarvis 2.0 (Stream Lab)

## Visao Geral

Jarvis 2.0 e o assistente de IA da Stream Lab no WhatsApp, construido com arquitetura modular inspirada nos melhores frameworks de agentes (Mem0, CrewAI, NanoClaw, MCP).

**Stack:** Node.js + Baileys (WhatsApp) + Claude API (Anthropic) + PostgreSQL + Redis + ElevenLabs TTS + Google Calendar

## Estrutura do Projeto

```
jarvis-v2.mjs               # Entry point principal (~700 linhas)
src/
├── config.mjs               # Configuracoes centrais (via .env)
├── database.mjs             # PostgreSQL - CRUD
├── memory.mjs               # Sistema de memoria Mem0-inspired
├── brain.mjs                # Cerebro IA + roteamento de agentes
├── audio.mjs                # TTS (ElevenLabs) + STT (Whisper)
├── agents/
│   └── master.mjs           # Prompts dos agentes + classificador
└── skills/
    └── loader.mjs           # Skills/Tools do Claude
docker-compose.yml           # PostgreSQL + Redis (senhas via .env)
.env                         # Credenciais (NAO versionado!)
auth_session/                # Sessao WhatsApp (NAO versionado!)
```

## Regras Criticas (NUNCA VIOLAR)

### Asana
- **NUNCA alterar descricoes de tasks** no Asana — usar SOMENTE comentarios
- Projetos publicos: Cabine de Comando, Producao de Design, Producao de Audiovisual, Captacoes
- Demais projetos sao CONFIDENCIAIS

### Codigo
- **Pool PostgreSQL:** usar a variavel global `pool` exportada de `database.mjs` (NUNCA `CONFIG.DATABASE_URL`)
- **Auth da API:** header `x-api-key` (NUNCA `Authorization: Bearer`)
- **Google JWT:** usar sintaxe de objeto `new google.auth.JWT({ email, key, scopes })`
- **Credenciais:** TODAS vem do `.env` — NUNCA hardcodar senhas, tokens, IPs, telefones ou GIDs no codigo
- **Portugues SEMPRE com acentos** em todas as respostas e documentacao voltada ao usuario

### Arquivos que NAO devem ser versionados
- `.env` (chaves de API, senhas, IDs sensiveis)
- `auth_session/` (sessao do WhatsApp)
- `node_modules/`
- `google-calendar-key.json`
- Qualquer arquivo com credenciais

## Modulos

### jarvis-v2.mjs (Entry Point)
- Conexao WhatsApp via Baileys (multi-device)
- Handler de mensagens (texto + audio)
- Express API (porta configuravel via .env)
- Cron jobs (relatorio diario)
- Sistema sentByBot para nao responder a si mesmo

### src/config.mjs
Exporta: `CONFIG`, `TEAM_ASANA`, `ASANA_PROJECTS`, `ASANA_SECTIONS`, `PUBLIC_ASANA_PROJECTS`, `JARVIS_ALLOWED_GROUPS`, `AUDIO_ALLOWED`, `teamPhones`, `teamWhatsApp`
- **Tudo via `process.env`** — nenhum valor sensivel hardcoded

### src/database.mjs
Exporta: `pool`, `initDB`, `storeMessage`, `getRecentMessages`, `getContactInfo`, `getGroupInfo`, `upsertContact`, `upsertGroup`, `getMessageCount`
- Credenciais PostgreSQL via .env (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)

### src/memory.mjs (Mem0-inspired)
Exporta: `initMemory`, `extractFacts`, `storeFacts`, `searchMemories`, `getMemoryContext`, `processMemory`, `getMemoryStats`
- 3 escopos de memoria: user, chat, agent
- Extrai fatos via Claude (JSON com content/category/importance)
- Pipeline ADD/UPDATE similar ao Mem0
- Busca por ILIKE (sem pgvector no momento)

### src/brain.mjs (Cerebro + Agent Teams)
Exporta: `shouldJarvisRespond`, `isValidResponse`, `generateResponse`, `markConversationActive`, `isConversationActive`, `findTeamJid`, `extractMentionsFromText`, `generateDailyReport`
- Classifica intencao e roteia para agente especializado
- Modo conversa: 3 minutos de janela ativa apos resposta

### src/agents/master.mjs
Exporta: `classifyIntent`, `MASTER_SYSTEM_PROMPT`, `AGENT_PROMPTS`
- **Master:** Personalidade Jarvis (Tony Stark style)
- **Creative:** Copy, legendas, roteiros, CTAs
- **Manager:** Gestao de projetos, Asana, prazos
- **Researcher:** Pesquisa, dados, tendencias

### src/audio.mjs
Exporta: `voiceConfig`, `loadVoiceConfig`, `saveVoiceConfig`, `transcribeAudio`, `generateAudio`
- TTS: ElevenLabs (primario) ou OpenAI (fallback)
- STT: Whisper (OpenAI)
- Voice settings com sliders: stability, similarity_boost, style, use_speaker_boost

### src/skills/loader.mjs
Exporta: `asanaRequest`, `asanaCreateTask`, `asanaAddToProject`, `asanaAddComment`, `getOverdueTasks`, `getGCalClient`, `createGoogleCalendarEvent`, `JARVIS_TOOLS`, `executeJarvisTool`
- Tools disponiveis: `agendar_captacao`, `consultar_tarefas`, `lembrar`

## API Endpoints

Base: porta configurada em `API_PORT` (.env)
Auth: header `x-api-key`

| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | /status | Status do bot (versao, mensagens, memorias) |
| POST | /send/text | Enviar mensagem de texto |
| POST | /send/audio | Enviar mensagem de audio (TTS) |
| GET | /dashboard/health | Health check do dashboard |
| GET | /dashboard/voice | Configuracoes de voz atuais |
| POST | /dashboard/voice | Atualizar configuracoes de voz (sliders) |
| GET | /dashboard/memory | Estatisticas de memoria |
| GET | /dashboard/memory/search | Buscar memorias |
| POST | /dashboard/memory/add | Adicionar memoria manualmente |
| POST | /dashboard/chat | Chat com Jarvis (via dashboard) |
| GET | /dashboard/qr | QR code para reconexao |

## Fluxo de Mensagem

```
Mensagem recebida (WhatsApp)
  -> Filtros (grupo permitido? mencionou Jarvis? reply? modo conversa?)
  -> storeMessage() no PostgreSQL
  -> shouldJarvisRespond() — decide se responde
  -> generateResponse():
      1. Busca historico (20 ultimas mensagens)
      2. Consolida mensagens consecutivas do mesmo role
      3. Busca memorias relevantes (3 escopos)
      4. Classifica intencao (master/creative/manager/researcher)
      5. Monta system prompt + contexto + agente
      6. Claude API com tools (agendar_captacao, consultar_tarefas, lembrar)
      7. Se tool_use -> executa tool -> follow-up com resultado
      8. Extrai @mentions do texto
      9. processMemory() em background
  -> Envia resposta no WhatsApp
  -> markConversationActive() (janela de 3 min)
```

## Configuracao (.env)

Todas as credenciais, IDs e dados sensiveis ficam EXCLUSIVAMENTE no `.env`.
Consulte `.env.example` para a lista completa de variaveis necessarias.

## Evolucao Futura

- [ ] Upgrade PostgreSQL para imagem com pgvector (busca semantica de memorias)
- [ ] Mais skills/tools (web search, enviar email, gerar imagem)
- [ ] Dashboard frontend completo
- [ ] MCP server proprio para integracao com ferramentas externas
- [ ] Agente de vendas para atendimento automatico a clientes
- [ ] Webhooks Asana para reagir a mudancas em tempo real
