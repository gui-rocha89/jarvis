# Meta System User Token — Guia de migração (Sprint 7)

> **Status:** Manual obrigatório. Esta etapa não pode ser automatizada via código — depende de configuração no [Meta Business Manager](https://business.facebook.com/).

---

## Por que migrar?

Hoje o Jarvis usa um **Token de Acesso de Usuário** no Meta Ads (variável `META_ACCESS_TOKEN` no `.env`). Esse token tem **limite de 60 dias** — quando expira:

- ❌ Todas as campanhas param de poder ser modificadas
- ❌ Posts orgânicos param de ser publicados
- ❌ Métricas param de ser puxadas
- ❌ Anúncios param de ser criados/pausados
- ❌ Page IDs deixam de ser resolvidos

Em produção isso é **inaceitável**. A solução é o **System User Token** — token de máquina que **NÃO expira**, é o que empresas grandes usam.

---

## Pré-requisitos

- [ ] Conta administradora do Meta Business Manager da Stream Lab
- [ ] App Meta já criado e em modo "Live" (já está)
- [ ] Acesso ao `.env` da produção (VPS)
- [ ] ~15 minutos do Gui

---

## Passo a passo (uma vez só)

### 1. Acessar Configurações do Business

1. Entrar em <https://business.facebook.com/settings>
2. Conta usada: a que tem acesso ao Ad Account `act_3552749448279158` da Stream Lab
3. No menu lateral esquerdo, ir em **"Usuários" → "Usuários do sistema"**

### 2. Criar System User

1. Clicar em **"Adicionar"**
2. Nome: `Jarvis API`
3. Função: **Administrador**
4. Salvar

### 3. Atribuir ativos ao System User

O System User precisa de permissão explícita pra cada coisa que vai usar:

**3a. Contas de anúncios:**
1. Selecionar o System User `Jarvis API`
2. Clicar em **"Adicionar ativos"**
3. Aba **"Contas de anúncios"**
4. Selecionar a conta `act_3552749448279158` (Stream Lab Ads)
5. Acesso completo: ✅ **Gerenciamento da conta de anúncios**
6. Salvar

**3b. Páginas (TODAS as 14 que o Jarvis usa):**
1. Aba **"Páginas"**
2. Selecionar TODAS as 14 páginas:
   - Stream Lab
   - Streamlab Academy
   - Dra. Fernanda Bressan
   - Grupo Capilar Barazzetti
   - Pode Que Chá
   - Clínica de Olhos Carrion
   - Digal Pneus
   - Imobiliária Quintino
   - Dr. Diogo Balbinot
   - Minner
   - Villa Rica Imóveis
   - Dr. Mauro
   - Pippi
   - Rossato Stara
   - Medical Planner
   - MSG Master Leds
   - (qualquer nova que entrar)
3. Acesso completo: ✅ **Criar conteúdo**, ✅ **Mensagens**, ✅ **Análises**, ✅ **Anúncios**
4. Salvar

**3c. Pixel (se aplicável):**
1. Aba **"Pixels"**
2. Adicionar o pixel da Stream Lab (`META_PIXEL_ID`)
3. Acesso completo

**3d. Catálogos (se houver):**
1. Aba **"Catálogos"**
2. Adicionar todos os catálogos relevantes

### 4. Gerar o Token

1. Selecionar o System User `Jarvis API` novamente
2. Clicar em **"Gerar novo token"**
3. App: selecionar **"Jarvis Ads"** (App ID `1938572933696481`)
4. **Permissões necessárias** (marcar TODAS):
   - `ads_management` — gerenciar campanhas
   - `ads_read` — ler métricas
   - `pages_manage_posts` — publicar posts
   - `pages_read_engagement` — ler engajamento
   - `pages_show_list` — listar páginas (CRÍTICO pra resolvePageId automático)
   - `pages_manage_metadata` — gerenciar webhooks de páginas
   - `pages_messaging` — Instagram DM
   - `instagram_basic`
   - `instagram_manage_messages`
   - `instagram_manage_insights`
   - `business_management` — operar no Business Manager
   - `read_insights`
5. **Tipo de token:** **Nunca expira** ✅ (essa é a chave!)
6. Clicar em **"Gerar"**
7. **COPIAR O TOKEN AGORA** — só aparece uma vez. Guardar em local seguro.

### 5. Atualizar o `.env` no VPS

```bash
ssh root@31.97.160.141
cd /opt/jarvis
cp .env .env.bak.$(date +%s)        # backup
nano .env
```

Substituir a linha:
```env
META_ACCESS_TOKEN=EAAbjHy8ViZB...   # (token antigo de 60 dias)
```

Pelo novo:
```env
META_ACCESS_TOKEN=<token_novo_do_system_user>
```

Salvar e sair (`Ctrl+O`, `Ctrl+X`).

### 6. Reiniciar o Jarvis

Via deploy normal (push de qualquer commit no master) **OU** via:

```bash
export PATH=$PATH:/root/.nvm/versions/node/v20.19.0/bin
npx pm2 restart jarvis --update-env
```

### 7. Validar

Logo após o restart, testar via Bash:

```bash
TOKEN=$(grep META_ACCESS_TOKEN /opt/jarvis/.env | cut -d= -f2)
curl -s "https://graph.facebook.com/v25.0/me?access_token=$TOKEN" | python3 -m json.tool
```

Resposta esperada:
```json
{ "id": "...", "name": "Jarvis API" }
```

Se vier `{"error":...}`, refazer permissões no passo 3.

Validar no Jarvis no WhatsApp:
> Tu: "Jarvis, lista as páginas que você acessa"
> Jarvis: lista 14+ páginas

---

## Limpeza pós-migração

Após confirmar que tudo funciona com o token novo:

1. **Revogar o token antigo de usuário:**
   - <https://business.facebook.com/settings> → "Usuários" → "Pessoas" → seu usuário
   - "Histórico de acessos" → revogar tokens antigos

2. **Documentar no `MEMORY.md` do Gui:**
   ```
   - [Meta Token migrado pra System User](feedback_meta_system_user.md) — 
     não expira mais, configurado em <data>
   ```

3. **Remover backup do `.env`:** após 1 semana funcionando, deletar o `.env.bak.*`

---

## Detecção de problemas

### Cenário 1: Token retorna `OAuthException` ao reiniciar

Causa: permissão faltando no System User.
Fix: voltar passo 3 e marcar TODOS os ativos.

### Cenário 2: Páginas não aparecem em `listar_paginas_ads`

Causa: System User não tem acesso "Pages" às páginas.
Fix: passo 3b, adicionar páginas explicitamente.

### Cenário 3: Erro `(#10) This Pixel is restricted`

Causa: Pixel não atribuído ao System User.
Fix: passo 3c.

### Cenário 4: Post não publica

Causa: faltam scopes `pages_manage_posts` ou `pages_read_engagement`.
Fix: re-gerar token com TODOS os scopes do passo 4.

---

## Vantagens depois da migração

| Antes (Token de usuário) | Depois (System User Token) |
|--------------------------|----------------------------|
| Expira em 60 dias | **Nunca expira** |
| Ligado a uma pessoa física | Ligado à empresa (Business Manager) |
| Quando pessoa sai da empresa, token cai | Token permanece independente de turnover |
| Sem auditoria nativa | Auditoria completa no Business Manager |
| Refresh manual a cada 2 meses | Zero manutenção |

---

## Quando re-fazer este processo

**Nunca** (se feito corretamente). Só refazer se:
- Adicionar nova permissão (scope) — precisa re-gerar
- Comprometimento de segurança — revogar e gerar novo
- Mudança no Business Manager — atribuir novos ativos ao System User

---

**Última atualização:** v6.0 · Sprint 7
