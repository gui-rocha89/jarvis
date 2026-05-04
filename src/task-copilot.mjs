// ============================================
// TASK COPILOT (v6.0 — Sprint 6)
// ============================================
// Filosofia: NÃO é cobrador robotizado. É co-piloto que AJUDA.
//
// Funcionalidades:
// 1. Polling de tasks atribuídas ao Jarvis (sem precisar @ explícita)
// 2. Análise contextual de cada task (descrição + comentários + cliente)
// 3. Identificação de oportunidades de ajuda
// 4. Cobrança HUMANA com escalação leve (3/6/9 dias)
// 5. Daily Briefing matinal motivacional (08:50 BRT)
//
// Decisões do Gui:
// - Cobrança leve (3/6/9 dias)
// - Daily SÓ tasks da equipe (sem leads/campanhas)
// - Comentários direto na task do Asana (não no grupo)
// - Sempre PERGUNTA antes de fazer (nunca executa sem ok)
// ============================================

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG, TEAM_ASANA, ASANA_PROJECTS } from './config.mjs';
import { pool, getCobrancaLog, upsertCobrancaLog } from './database.mjs';

// findEntity (Knowledge Graph) é opcional — só funciona se Sprint 2 já foi merged
async function tryFindEntity(termo, opts) {
  try {
    const db = await import('./database.mjs');
    if (typeof db.findEntity === 'function') return await db.findEntity(termo, opts);
  } catch {}
  return null;
}
import { asanaRequest, asanaWrite } from './skills/loader.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

const JARVIS_ASANA_GID = TEAM_ASANA?.jarvis || '1213583219463912';

// ============================================
// MODELO IA — usa AI_MODEL (Sonnet) com fallback
// ============================================
const TASK_COPILOT_MODEL = CONFIG.AI_MODEL || 'claude-sonnet-4-6';

// ============================================
// 1. ANÁLISE CONTEXTUAL DE UMA TASK
// ============================================
/**
 * Lê a task completa: descrição, comentários, anexos, projeto, responsável, custom fields.
 * Retorna objeto rico pra ser usado pra gerar oferta de ajuda ou cobrança contextual.
 */
export async function analyzeTask(taskGid) {
  if (!taskGid) return null;
  try {
    // Detalhes completos da task
    const task = await asanaRequest(
      `/tasks/${taskGid}?opt_fields=name,notes,assignee.name,assignee.gid,due_on,completed,memberships.project.name,memberships.section.name,custom_fields.name,custom_fields.display_value,created_at,modified_at`
    );
    if (!task) return null;

    // Últimos 10 comentários
    let comentarios = [];
    try {
      const stories = await asanaRequest(
        `/tasks/${taskGid}/stories?opt_fields=text,created_by.name,created_at,type&limit=20`
      );
      comentarios = (stories || [])
        .filter(s => s.type === 'comment' && s.text)
        .slice(-10)
        .map(s => ({ autor: s.created_by?.name || '?', texto: s.text.substring(0, 800), em: s.created_at }));
    } catch {}

    // Tem anexo?
    let temAnexos = false;
    try {
      const att = await asanaRequest(`/tasks/${taskGid}/attachments?opt_fields=name`);
      temAnexos = (att || []).length > 0;
    } catch {}

    // Cliente associado (se nome da task ou projeto bater no Knowledge Graph)
    let cliente = null;
    const textoBusca = `${task.name || ''} ${task.notes || ''}`;
    cliente = await tryFindEntity(textoBusca.split(/\s+/).slice(0, 5).join(' '), { tipo: 'cliente' });

    // Dias desde última atividade
    const ultimaModificacao = new Date(task.modified_at || task.created_at);
    const diasInativa = Math.floor((Date.now() - ultimaModificacao.getTime()) / (1000 * 60 * 60 * 24));

    // Dias de atraso (se tem prazo)
    let diasAtraso = 0;
    if (task.due_on && !task.completed) {
      const due = new Date(task.due_on);
      diasAtraso = Math.floor((Date.now() - due.getTime()) / (1000 * 60 * 60 * 24));
    }

    return {
      gid: task.gid,
      nome: task.name,
      descricao: task.notes || '',
      responsavel: task.assignee ? { nome: task.assignee.name, gid: task.assignee.gid } : null,
      prazo: task.due_on,
      diasAtraso,
      diasInativa,
      concluida: task.completed,
      projeto: task.memberships?.[0]?.project?.name || null,
      secao: task.memberships?.[0]?.section?.name || null,
      customFields: (task.custom_fields || []).filter(f => f.display_value).map(f => ({ nome: f.name, valor: f.display_value })),
      comentarios,
      temAnexos,
      cliente: cliente ? { nome: cliente.nome, descricao: cliente.descricao } : null,
      url: `https://app.asana.com/0/0/${taskGid}`,
    };
  } catch (err) {
    console.error(`[TASK-COPILOT] Erro ao analisar ${taskGid}:`, err.message);
    return null;
  }
}

// ============================================
// 2. IDENTIFICAR OPORTUNIDADES DE AJUDA
// ============================================
/**
 * Olha o nome/descrição da task e decide se Jarvis pode oferecer ajuda concreta.
 * Retorna lista de ofertas relevantes.
 */
export function identifyHelpOpportunities(taskAnalysis) {
  if (!taskAnalysis) return [];
  const oportunidades = [];
  const texto = `${taskAnalysis.nome || ''} ${taskAnalysis.descricao || ''}`.toLowerCase();

  // Padrões + ofertas (cada match adiciona oferta)
  const patterns = [
    {
      keywords: ['planner', 'planejamento', 'planning', 'cronograma'],
      offer: 'Posso compilar histórico de aprovações anteriores deste cliente pra te economizar tempo de busca.',
    },
    {
      keywords: ['referenc', 'reference', 'inspirac'],
      offer: 'Posso buscar referências relevantes no histórico (mensagens, anexos de tasks anteriores).',
    },
    {
      keywords: ['copy', 'legenda', 'caption', 'roteiro', 'script'],
      offer: 'Posso rascunhar uma primeira versão pra tu revisar — tenho o tom de voz do cliente nas memórias.',
    },
    {
      keywords: ['briefing', 'brief'],
      offer: 'Posso compilar tudo que conversamos com o cliente nos últimos 30 dias num briefing pronto.',
    },
    {
      keywords: ['captacao', 'captação', 'gravacao', 'gravação', 'shooting'],
      offer: 'Posso confirmar equipamentos, locação e enviar lembrete pro responsável.',
    },
    {
      keywords: ['relatorio', 'relatório', 'report', 'analise', 'análise'],
      offer: 'Posso puxar números do Meta Ads e montar primeiro draft do relatório.',
    },
    {
      keywords: ['campanha', 'tráfego', 'trafego', 'ads'],
      offer: 'Posso analisar as campanhas ativas deste cliente e trazer recomendações.',
    },
    {
      keywords: ['arte', 'design', 'banner', 'feed', 'stories', 'reel'],
      offer: 'Posso buscar referências similares e separar exemplos do que já fizemos pra esse tipo de entrega.',
    },
    {
      keywords: ['aprovacao', 'aprovação', 'aprovar'],
      offer: 'Posso buscar conversas recentes do cliente sobre aprovações pra entender preferências.',
    },
    {
      keywords: ['follow', 'cobrar', 'cobranca', 'cobrança'],
      offer: 'Posso fazer o follow-up educadamente comentando na task ou mandando msg pro responsável.',
    },
  ];

  for (const p of patterns) {
    if (p.keywords.some(k => texto.includes(k))) {
      oportunidades.push(p.offer);
    }
  }

  // Sem comentários nos últimos 5 dias = pode oferecer destravamento
  if (taskAnalysis.diasInativa >= 3 && taskAnalysis.comentarios.length === 0) {
    oportunidades.push('Vi que está sem comentários — tem algo travando? Posso ajudar a destravar.');
  }

  return [...new Set(oportunidades)].slice(0, 3); // máx 3 ofertas pra não poluir
}

// ============================================
// 3. GERAR TEXTO DE COBRANÇA HUMANA
// ============================================
/**
 * Gera comentário pra task de acordo com o nível de atraso.
 * Sempre inclui oferta de ajuda + tom amigo.
 * Níveis:
 *   3 dias  = primeira chamada, leve
 *   6 dias  = segunda, mais direto mas ainda amigo
 *   9+ dias = NÃO comenta na task — escala pro Gui via WhatsApp privado
 */
export async function generateFollowUpComment(taskAnalysis, nivelCobranca = 1) {
  if (!taskAnalysis || !taskAnalysis.responsavel) return null;

  const oportunidades = identifyHelpOpportunities(taskAnalysis);
  const ofertasFmt = oportunidades.length > 0
    ? `\n\nO que posso fazer pra ajudar:\n${oportunidades.map(o => `• ${o}`).join('\n')}`
    : '';

  // Texto via Claude pra ficar humano e contextual
  const systemPrompt = `Você é o Jarvis (assistente da Stream Lab) escrevendo um comentário em task do Asana.

REGRAS:
- Tom: AMIGO e PRESTATIVO, NUNCA cobrador chato
- Português brasileiro com acentos
- Curto: 2-4 frases máximo
- Sempre OFERECE ajuda concreta, nunca só cobra
- Use o primeiro nome do responsável
- NÃO use emojis em excesso (máx 1)
- NÃO seja genérico — cite contexto real da task

Nível de cobrança: ${nivelCobranca}
- Nível 1 (3 dias): primeira menção, super leve, "vi que tá no radar"
- Nível 2 (6 dias): segundo follow-up, ainda amigo mas direto, "ainda sobre essa"`;

  const userMsg = `Task: "${taskAnalysis.nome}"
Responsável: ${taskAnalysis.responsavel.nome.split(' ')[0]}
Projeto: ${taskAnalysis.projeto || '?'}
Cliente: ${taskAnalysis.cliente?.nome || '?'}
Dias de atraso: ${taskAnalysis.diasAtraso}
Dias sem atividade: ${taskAnalysis.diasInativa}
Tem comentários: ${taskAnalysis.comentarios.length > 0 ? 'sim' : 'não'}
${ofertasFmt ? 'Ofertas relevantes que posso fazer:' + ofertasFmt : ''}

Escreva o comentário pra essa task. Lembre: oferecer ajuda, não cobrar.`;

  try {
    const resp = await anthropic.messages.create({
      model: TASK_COPILOT_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content?.[0]?.text?.trim();
    return text || null;
  } catch (err) {
    console.error('[TASK-COPILOT] Erro ao gerar comentário:', err.message);
    return null;
  }
}

// ============================================
// 4. POLLING DE TASKS ATRIBUÍDAS AO JARVIS
// ============================================
/**
 * Busca tasks atribuídas ao Jarvis no Asana e processa cada uma.
 * O Jarvis NÃO executa nada sem perguntar — apenas comenta oferecendo o que pode fazer.
 */
export async function pollTasksAssignedToJarvis() {
  try {
    const tasks = await asanaRequest(
      `/tasks?assignee=${JARVIS_ASANA_GID}&completed_since=now&workspace=${CONFIG.ASANA_WORKSPACE}&opt_fields=name,gid,modified_at,due_on&limit=20`
    );
    if (!tasks || tasks.length === 0) return { processed: 0 };

    let processed = 0;
    for (const t of tasks) {
      // Já comentou nos últimos 24h? Pula
      const log = await getCobrancaLog(t.gid).catch(() => null);
      if (log && log.last_cobrada_at) {
        const horasDesde = (Date.now() - new Date(log.last_cobrada_at).getTime()) / (1000 * 60 * 60);
        if (horasDesde < 24) continue;
      }

      const analysis = await analyzeTask(t.gid);
      if (!analysis) continue;

      const oportunidades = identifyHelpOpportunities(analysis);
      if (oportunidades.length === 0) continue;

      // Comenta na task perguntando o que pode fazer
      const comentario = `Oi! Vi essa task atribuída a mim. Antes de qualquer coisa, prefiro perguntar:\n\n${oportunidades.map(o => `• ${o}`).join('\n')}\n\nMe avisa qual dessas ajuda (ou outra coisa específica) e eu executo.`;
      try {
        await asanaWrite('POST', `/tasks/${t.gid}/stories`, { text: comentario });
        await upsertCobrancaLog(t.gid);
        processed++;
        console.log(`[TASK-COPILOT] ✅ Comentou em task atribuída: "${t.name?.substring(0, 60)}"`);
      } catch (err) {
        console.error(`[TASK-COPILOT] Erro ao comentar em ${t.gid}:`, err.message);
      }
    }
    return { processed, total: tasks.length };
  } catch (err) {
    console.error('[TASK-COPILOT] pollTasksAssignedToJarvis erro:', err.message);
    return { error: err.message };
  }
}

// ============================================
// 5. POLLING DE COBRANÇAS LEVES (3/6/9 dias)
// ============================================
/**
 * Busca tasks atrasadas e aplica cobrança leve com tom de ajuda.
 * - 3 dias: comentário leve com oferta de ajuda
 * - 6 dias: segundo follow-up, ainda amigo mas direto
 * - 9+ dias: escala privadamente pro Gui via WhatsApp (não comenta na task)
 */
export async function pollOverdueForFollowUp(sendTextFn = null) {
  try {
    const projetos = Object.values(ASANA_PROJECTS || {}).filter(Boolean);
    if (projetos.length === 0) return { processed: 0 };

    const todayISO = new Date().toISOString().split('T')[0];
    let processed = 0;
    const escalateToGui = [];

    for (const projGid of projetos) {
      try {
        // Busca tasks atrasadas neste projeto
        const tasks = await asanaRequest(
          `/projects/${projGid}/tasks?completed_since=now&opt_fields=name,gid,due_on,assignee.name,modified_at&limit=50`
        );
        if (!tasks) continue;

        for (const t of tasks) {
          if (!t.due_on || !t.assignee) continue;
          const due = new Date(t.due_on);
          const diasAtraso = Math.floor((Date.now() - due.getTime()) / (1000 * 60 * 60 * 24));
          if (diasAtraso < 3) continue;

          // Pular se task atribuída ao próprio Jarvis (já tem polling separado)
          if (t.assignee.gid === JARVIS_ASANA_GID) continue;

          // Determinar nível de cobrança
          let nivel;
          if (diasAtraso >= 9) nivel = 3;
          else if (diasAtraso >= 6) nivel = 2;
          else nivel = 1;

          // Já cobrou hoje?
          const log = await getCobrancaLog(t.gid).catch(() => null);
          if (log && log.last_cobrada_at) {
            const cobradaHoje = new Date(log.last_cobrada_at).toISOString().split('T')[0] === todayISO;
            if (cobradaHoje) continue;
          }

          if (nivel === 3) {
            // Escala pro Gui — não comenta na task
            escalateToGui.push({
              nome: t.name,
              responsavel: t.assignee.name,
              diasAtraso,
              url: `https://app.asana.com/0/0/${t.gid}`,
            });
            await upsertCobrancaLog(t.gid);
            continue;
          }

          // Nível 1 ou 2: comenta na task com tom humano
          const analysis = await analyzeTask(t.gid);
          if (!analysis) continue;
          const comentario = await generateFollowUpComment(analysis, nivel);
          if (!comentario) continue;

          try {
            await asanaWrite('POST', `/tasks/${t.gid}/stories`, { text: comentario });
            await upsertCobrancaLog(t.gid);
            processed++;
            console.log(`[TASK-COPILOT] ✅ Follow-up nível ${nivel} em "${t.name?.substring(0, 50)}" (${diasAtraso}d atraso)`);
          } catch (err) {
            console.error(`[TASK-COPILOT] Erro follow-up ${t.gid}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`[TASK-COPILOT] Erro projeto ${projGid}:`, err.message);
      }
    }

    // Escalar pro Gui se houver tasks 9+ dias
    if (escalateToGui.length > 0 && sendTextFn && CONFIG.GUI_JID) {
      let msg = `🚨 *Tasks com 9+ dias de atraso* (já fiz 2 follow-ups sem retorno):\n\n`;
      for (const t of escalateToGui.slice(0, 8)) {
        msg += `• ${t.responsavel.split(' ')[0]} — *${t.nome}* (${t.diasAtraso}d)\n  ${t.url}\n\n`;
      }
      msg += `\nQuer que eu reatribua, mude prazo ou tu fala diretamente?`;
      try {
        await sendTextFn(CONFIG.GUI_JID, msg);
      } catch {}
    }

    return { processed, escalated: escalateToGui.length };
  } catch (err) {
    console.error('[TASK-COPILOT] pollOverdueForFollowUp erro:', err.message);
    return { error: err.message };
  }
}

// ============================================
// 6. DAILY BRIEFING MATINAL (08:50 BRT)
// ============================================
/**
 * Compila resumo motivacional matinal pra postar no grupo de Tarefas.
 * Tom: humano, prático, sem rodeio.
 * SÓ tasks da equipe — não inclui leads/campanhas (decisão do Gui).
 */
export async function generateDailyBriefing() {
  try {
    const projetos = Object.values(ASANA_PROJECTS || {}).filter(Boolean);
    if (projetos.length === 0) return null;

    const todayISO = new Date().toISOString().split('T')[0];
    const tomorrowISO = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    // Coletar tasks por pessoa
    const porPessoa = new Map();

    for (const projGid of projetos) {
      try {
        const tasks = await asanaRequest(
          `/projects/${projGid}/tasks?completed_since=now&opt_fields=name,gid,due_on,assignee.name,assignee.gid&limit=80`
        );
        if (!tasks) continue;

        for (const t of tasks) {
          if (!t.assignee || !t.due_on) continue;
          // Só interessa: vence hoje, vence amanhã, ou já tá atrasada
          const due = new Date(t.due_on);
          const diasAtraso = Math.floor((Date.now() - due.getTime()) / (1000 * 60 * 60 * 24));
          if (diasAtraso < -1) continue; // só vencendo hoje, amanhã ou atrasadas

          // Pula tasks do Jarvis (não interessa pro grupo)
          if (t.assignee.gid === JARVIS_ASANA_GID) continue;

          const nome = t.assignee.name.split(' ')[0];
          if (!porPessoa.has(nome)) porPessoa.set(nome, []);
          porPessoa.get(nome).push({
            gid: t.gid,
            nome: t.name,
            prazo: t.due_on,
            diasAtraso,
            urgencia: diasAtraso > 0 ? 'atrasada' : (t.due_on === todayISO ? 'hoje' : 'amanhã'),
          });
        }
      } catch {}
    }

    if (porPessoa.size === 0) {
      return 'Bom dia, equipe! Hoje o radar tá limpo. Se aparecer algo, me chama. 👊';
    }

    // Gerar texto via IA com tom motivacional
    const dadosTexto = [...porPessoa.entries()]
      .map(([nome, tasks]) => {
        const lista = tasks.slice(0, 5).map(t => `  - ${t.nome} (${t.urgencia}${t.diasAtraso > 0 ? `, ${t.diasAtraso}d atraso` : ''})`).join('\n');
        return `${nome}:\n${lista}${tasks.length > 5 ? `\n  ... +${tasks.length - 5} outras` : ''}`;
      })
      .join('\n\n');

    const systemPrompt = `Você é o Jarvis (assistente da Stream Lab) escrevendo o daily briefing matinal no grupo de Tarefas.

REGRAS:
- Comece com "Bom dia, equipe."
- Tom MOTIVACIONAL, não cobrador. Tipo coach que tá no time.
- Português brasileiro com acentos
- Use @primeiro_nome quando se dirigir a alguém
- Seja PRÁTICO: cite as entregas + onde tu pode ajudar
- Máximo 1 emoji no total
- Sem markdown pesado (use *negrito* só pra destacar coisas importantes, e -bullets-)
- Seja CONCISO mas pessoal
- Termine convidando: "Tô aqui pra ajudar — me chama."
- NÃO inclua emojis tipo 🚨⚠️🔥 (deixa profissional)`;

    const userMsg = `Tasks por pessoa hoje:\n\n${dadosTexto}\n\nGere o briefing motivacional.`;

    const resp = await anthropic.messages.create({
      model: TASK_COPILOT_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });

    return resp.content?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error('[TASK-COPILOT] Erro generateDailyBriefing:', err.message);
    return null;
  }
}

/**
 * Wrapper que gera briefing E posta no grupo de Tarefas.
 */
export async function postDailyBriefing(sendTextFn) {
  if (!sendTextFn || !CONFIG.GROUP_TAREFAS) return false;

  // Verificar se hoje é dia útil (segunda a sexta)
  const dia = new Date().getDay(); // 0=Dom, 6=Sáb
  if (dia === 0 || dia === 6) {
    console.log('[TASK-COPILOT] Daily briefing pulado — fim de semana');
    return false;
  }

  // Verificar se feature está ativa
  try {
    const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'task_copilot_config'");
    const cfg = rows[0]?.value || {};
    if (cfg.daily_briefing_enabled === false) {
      console.log('[TASK-COPILOT] Daily briefing desabilitado via dashboard');
      return false;
    }
  } catch {}

  const briefing = await generateDailyBriefing();
  if (!briefing) return false;

  try {
    await sendTextFn(CONFIG.GROUP_TAREFAS, briefing);
    console.log(`[TASK-COPILOT] ✅ Daily briefing postado às ${new Date().toLocaleTimeString('pt-BR')}`);
    return true;
  } catch (err) {
    console.error('[TASK-COPILOT] Erro ao postar daily:', err.message);
    return false;
  }
}

// ============================================
// CONFIG TOGGLE (via dashboard)
// ============================================
export async function getTaskCopilotConfig() {
  try {
    const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'task_copilot_config'");
    return rows[0]?.value || {
      daily_briefing_enabled: true,
      poll_assigned_enabled: true,
      poll_overdue_enabled: true,
      daily_briefing_time: '08:50',
      followup_days: [3, 6, 9],
    };
  } catch {
    return { daily_briefing_enabled: true, poll_assigned_enabled: true, poll_overdue_enabled: true };
  }
}

export async function saveTaskCopilotConfig(config) {
  try {
    await pool.query(
      `INSERT INTO jarvis_config (key, value) VALUES ('task_copilot_config', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(config)]
    );
    return true;
  } catch (err) {
    console.error('[TASK-COPILOT] Erro ao salvar config:', err.message);
    return false;
  }
}
