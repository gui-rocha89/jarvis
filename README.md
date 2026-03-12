# Jarvis 2.0 - Stream Lab AI Assistant

Assistente de IA autonomo no WhatsApp para a Stream Lab, agencia de marketing digital.

Personalidade inspirada no JARVIS do Tony Stark — elegante, eficiente, com humor inteligente.

## Arquitetura

```
┌─────────────────────────────────────┐
│           WhatsApp (Baileys)         │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│         jarvis-v2.mjs                │
│    (Entry Point + Express API)       │
└──┬────┬────┬────┬────┬──────────────┘
   │    │    │    │    │
┌──▼─┐┌─▼──┐┌▼──┐┌▼──┐┌▼────────────┐
│Brain││Mem ││Aud││DB ││   Skills     │
│    ││    ││io ││   ││  (Tools)     │
└──┬─┘└────┘└───┘└───┘└─────────────┘
   │
┌──▼─────────────────────────────────┐
│          Agent Teams                │
│  Master | Creative | Manager |     │
│          Researcher                 │
└────────────────────────────────────┘
```

## Funcionalidades

- **Agent Teams** — Classificacao automatica de intencao e roteamento para agente especializado (CrewAI-inspired)
- **Memoria Inteligente** — Extracao e armazenamento automatico de fatos com 3 escopos: usuario, chat, agente (Mem0-inspired)
- **Skills Modulares** — Agendar captacoes, consultar tarefas, salvar memorias (NanoClaw-inspired)
- **Voz Premium** — TTS com ElevenLabs + STT com Whisper, com sliders de configuracao
- **Integracoes** — Asana (gestao de projetos) + Google Calendar (captacoes)
- **API REST** — Endpoints para dashboard, chat, voz, memoria e status

## Stack

| Componente | Tecnologia |
|-----------|-----------|
| Runtime | Node.js (ESM) |
| WhatsApp | Baileys v7 |
| IA | Claude API (Anthropic) |
| TTS | ElevenLabs v3 |
| STT | Whisper (OpenAI) |
| Banco | PostgreSQL 16 |
| Cache | Redis 7 |
| Gestao | Asana API |
| Calendario | Google Calendar API |
| Processo | PM2 |
| Containers | Docker Compose |

## Instalacao

### Pre-requisitos

- Node.js 20+
- Docker + Docker Compose
- FFmpeg (para conversao de audio)
- PM2 (`npm install -g pm2`)

### Setup

```bash
# 1. Clonar o repositorio
git clone https://github.com/streamlab/jarvis.git /opt/jarvis
cd /opt/jarvis

# 2. Instalar dependencias
npm install

# 3. Configurar variaveis de ambiente
cp .env.example .env
# Editar .env com suas chaves

# 4. Subir PostgreSQL e Redis
docker compose up -d

# 5. Iniciar com PM2
pm2 start jarvis-v2.mjs --name jarvis
pm2 save
```

### Variaveis de Ambiente (.env)

```env
ANTHROPIC_API_KEY=sua-chave-anthropic
ASANA_PAT=seu-token-asana
OPENAI_API_KEY=sua-chave-openai
ELEVENLABS_API_KEY=sua-chave-elevenlabs
```

## Estrutura de Arquivos

```
jarvis-v2.mjs              # Entry point (WhatsApp + API)
src/
├── config.mjs              # Configuracoes e constantes
├── database.mjs            # PostgreSQL (CRUD + init)
├── memory.mjs              # Sistema de memoria (Mem0)
├── brain.mjs               # Cerebro IA + Agent routing
├── audio.mjs               # TTS/STT + voice config
├── agents/
│   └── master.mjs          # Prompts e classificador
└── skills/
    └── loader.mjs          # Tools do Claude
docker-compose.yml          # PostgreSQL + Redis
package.json
.env                        # Credenciais (nao versionado)
auth_info/                  # Sessao WhatsApp (nao versionado)
```

## API

Porta: `3100` | Auth: header `x-api-key`

| Endpoint | Descricao |
|---------|-----------|
| `GET /status` | Status geral do bot |
| `POST /send/text` | Enviar mensagem |
| `POST /send/audio` | Enviar audio TTS |
| `GET /dashboard/health` | Health check |
| `GET/POST /dashboard/voice` | Config de voz |
| `GET /dashboard/memory` | Stats de memoria |
| `POST /dashboard/memory/search` | Buscar memorias |
| `POST /dashboard/chat` | Chat via dashboard |

## Agentes

| Agente | Especialidade | Trigger |
|--------|-------------|---------|
| Master | Conversacao geral, humor, personalidade | Default |
| Creative | Copy, legendas, roteiros, CTAs | copy, arte, conteudo, post... |
| Manager | Gestao de projetos, prazos, Asana | tarefa, prazo, status, cobranca... |
| Researcher | Pesquisa, dados, tendencias | pesquisar, dados, benchmark... |

## Comandos Uteis

```bash
# Status do PM2
pm2 status

# Logs em tempo real
pm2 logs jarvis

# Reiniciar
pm2 restart jarvis

# Docker
docker compose up -d     # Subir servicos
docker compose down       # Parar servicos
docker compose logs -f    # Logs dos containers
```

## Licenca

Projeto privado da Stream Lab. Todos os direitos reservados.
