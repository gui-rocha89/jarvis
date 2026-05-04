// ============================================
// JARVIS 6.0 - Estudo Exaustivo do Asana
// Ingere projetos, tarefas e comentários
// Extrai conhecimento via extractFacts (Haiku)
// ============================================
import { CONFIG } from './config.mjs';
import { pool } from './database.mjs';
import { extractFacts, storeFacts } from './memory.mjs';
import { syncProfiles } from './profiles.mjs';

const ASANA_BASE = 'https://app.asana.com/api/1.0';
const ASANA_DELAY = 1000;  // 1 req/sec para Asana API (60/min, bem abaixo do limite de 1500/min)
const HAIKU_DELAY = 500;   // 2 extrações/sec para Claude Haiku

// Estado global do estudo
export let asanaBatchState = {
  running: false,
  phase: 'idle',
  projects: { total: 0, processed: 0 },
  tasks: { total: 0, processed: 0 },
  comments: { total: 0, processed: 0 },
  facts: 0,
  errors: 0,
  startedAt: null,
  stoppedAt: null,
};

// ============================================
// ASANA API HELPERS
// ============================================
async function asanaGet(endpoint) {
  if (!CONFIG.ASANA_PAT) throw new Error('ASANA_PAT não configurado');
  const response = await fetch(`${ASANA_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${CONFIG.ASANA_PAT}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
      console.log(`[ASANA-STUDY] Rate limited! Aguardando ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      return asanaGet(endpoint); // Retry
    }
    throw new Error(`Asana API ${response.status}: ${response.statusText}`);
  }
  const json = await response.json();
  return { data: json.data, nextPage: json.next_page?.offset || null };
}

// Busca paginada — retorna TODOS os resultados
async function asanaGetAll(endpoint) {
  const allData = [];
  let offset = null;
  const separator = endpoint.includes('?') ? '&' : '?';
  do {
    const url = offset ? `${endpoint}${separator}offset=${offset}` : endpoint;
    const result = await asanaGet(url);
    if (result.data) allData.push(...result.data);
    offset = result.nextPage;
    if (offset) await sleep(ASANA_DELAY);
  } while (offset);
  return allData;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// CONTROLE DE PROGRESSO (banco)
// ============================================
async function isProcessed(entityType, entityGid) {
  const { rows } = await pool.query(
    'SELECT processed FROM asana_study_log WHERE entity_type = $1 AND entity_gid = $2',
    [entityType, entityGid]
  );
  return rows.length > 0 && rows[0].processed;
}

async function markProcessed(entityType, entityGid, projectName, factsCount) {
  await pool.query(`
    INSERT INTO asana_study_log (entity_type, entity_gid, project_name, processed, facts_extracted)
    VALUES ($1, $2, $3, true, $4)
    ON CONFLICT (entity_type, entity_gid)
    DO UPDATE SET processed = true, facts_extracted = $4
  `, [entityType, entityGid, projectName, factsCount]);
}

// ============================================
// EXTRAÇÃO ESPECIALIZADA PARA ASANA
// ============================================
async function extractAsanaFacts(text, context) {
  // Usa extractFacts existente mas com contexto enriquecido
  // O senderName vira o contexto (ex: "Tarefa do projeto X")
  // chatId = 'asana' para escopo
  const facts = await extractFacts(text, context, 'asana', false);
  return facts;
}

// ============================================
// ENGINE PRINCIPAL
// ============================================
// Busca a data da última execução concluída
async function getLastStudyDate() {
  const { rows } = await pool.query(
    "SELECT value FROM jarvis_config WHERE key = 'asana_study_last_run'"
  );
  return rows.length > 0 ? rows[0].value : null;
}

// Salva a data de conclusão
async function setLastStudyDate(isoDate) {
  await pool.query(`
    INSERT INTO jarvis_config (key, value) VALUES ('asana_study_last_run', $1)
    ON CONFLICT (key) DO UPDATE SET value = $1
  `, [isoDate]);
}

// Marca itens para reprocessamento (tasks/comments modificados)
async function markForReprocess(entityType, entityGid) {
  await pool.query(
    'UPDATE asana_study_log SET processed = false WHERE entity_type = $1 AND entity_gid = $2',
    [entityType, entityGid]
  );
}

export async function startAsanaStudy(options = {}) {
  const { incremental = false } = options;
  if (asanaBatchState.running) throw new Error('Estudo já em execução');

  // Criar tabela se não existe
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asana_study_log (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_gid TEXT NOT NULL,
      project_name TEXT,
      processed BOOLEAN DEFAULT false,
      facts_extracted INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(entity_type, entity_gid)
    )
  `);

  // Buscar data da última execução para modo incremental
  let modifiedSince = null;
  if (incremental) {
    modifiedSince = await getLastStudyDate();
    if (!modifiedSince) {
      console.log('[ASANA-STUDY] Sem execução anterior — rodando varredura completa');
    }
  }

  const runStart = new Date().toISOString();

  // Reset state
  asanaBatchState = {
    running: true,
    phase: 'projects',
    projects: { total: 0, processed: 0 },
    tasks: { total: 0, processed: 0 },
    comments: { total: 0, processed: 0 },
    facts: 0,
    errors: 0,
    startedAt: runStart,
    stoppedAt: null,
    incremental: !!modifiedSince,
  };

  console.log(`[ASANA-STUDY] Iniciando estudo ${modifiedSince ? 'INCREMENTAL (desde ' + modifiedSince.split('T')[0] + ')' : 'COMPLETO'}...`);

  // Rodar em background
  (async () => {
    try {
      // ========== FASE 1: LISTAR PROJETOS ==========
      asanaBatchState.phase = 'projects';
      console.log('[ASANA-STUDY] Fase 1: Listando projetos...');

      const projects = await asanaGetAll(
        `/projects?workspace=${CONFIG.ASANA_WORKSPACE}&opt_fields=name,archived,created_at,owner.name,members.name&limit=100`
      );
      asanaBatchState.projects.total = projects.length;
      console.log(`[ASANA-STUDY] ${projects.length} projetos encontrados`);

      // Extrair fato sobre cada projeto
      for (const project of projects) {
        if (!asanaBatchState.running) break;
        if (await isProcessed('project', project.gid)) {
          asanaBatchState.projects.processed++;
          continue;
        }

        const projectText = `Projeto da Stream Lab: "${project.name}" (${project.archived ? 'ARQUIVADO' : 'ATIVO'}). Dono: ${project.owner?.name || 'desconhecido'}. Membros: ${(project.members || []).map(m => m.name).join(', ') || 'nenhum listado'}.`;

        try {
          const facts = await extractAsanaFacts(projectText, `Projeto ${project.name}`);
          if (facts.length > 0) {
            await storeFacts(facts, 'agent', null);
            asanaBatchState.facts += facts.length;
          }
          await markProcessed('project', project.gid, project.name, facts.length);
        } catch (err) {
          asanaBatchState.errors++;
          console.error(`[ASANA-STUDY] Erro projeto ${project.name}:`, err.message);
          await markProcessed('project', project.gid, project.name, 0);
        }

        asanaBatchState.projects.processed++;
        await sleep(HAIKU_DELAY);
      }

      if (!asanaBatchState.running) { finish('Parado pelo usuário'); return; }
      console.log(`[ASANA-STUDY] Fase 1 concluída: ${asanaBatchState.projects.processed} projetos`);

      // ========== FASE 2: TAREFAS DE CADA PROJETO ==========
      asanaBatchState.phase = 'tasks';
      console.log('[ASANA-STUDY] Fase 2: Lendo tarefas...');

      // Primeiro contar total de tarefas
      const allTasks = [];
      for (const project of projects) {
        if (!asanaBatchState.running) break;
        try {
          const modFilter = modifiedSince ? `&modified_since=${modifiedSince}` : '';
          const tasks = await asanaGetAll(
            `/tasks?project=${project.gid}&opt_fields=name,notes,assignee.name,due_on,completed,completed_at,created_at,memberships.section.name&limit=100${modFilter}`
          );
          for (const task of tasks) {
            task._projectName = project.name;
            task._projectGid = project.gid;
          }
          allTasks.push(...tasks);
          await sleep(ASANA_DELAY);
        } catch (err) {
          asanaBatchState.errors++;
          console.error(`[ASANA-STUDY] Erro listando tasks de ${project.name}:`, err.message);
        }
      }

      asanaBatchState.tasks.total = allTasks.length;
      console.log(`[ASANA-STUDY] ${allTasks.length} tarefas ${modifiedSince ? 'modificadas' : 'encontradas'}`);

      // No modo incremental, marcar tasks modificadas para reprocessamento
      if (modifiedSince) {
        for (const task of allTasks) {
          await markForReprocess('task', task.gid);
        }
      }

      // Processar cada tarefa
      for (const task of allTasks) {
        if (!asanaBatchState.running) break;
        if (await isProcessed('task', task.gid)) {
          asanaBatchState.tasks.processed++;
          continue;
        }

        // Montar texto da tarefa
        const sections = (task.memberships || []).map(m => m.section?.name).filter(Boolean).join(' → ');
        const taskText = [
          `Projeto: ${task._projectName}`,
          `Tarefa: ${task.name}`,
          task.assignee?.name ? `Responsável: ${task.assignee.name}` : null,
          task.due_on ? `Prazo: ${task.due_on}` : null,
          `Status: ${task.completed ? 'Concluída' + (task.completed_at ? ` em ${task.completed_at.split('T')[0]}` : '') : 'Pendente'}`,
          sections ? `Seção: ${sections}` : null,
          task.notes ? `Descrição: ${task.notes.substring(0, 500)}` : null,
        ].filter(Boolean).join(' | ');

        // Só processar se tem conteúdo suficiente
        if (taskText.length >= 40) {
          try {
            const facts = await extractAsanaFacts(taskText, `Task de ${task._projectName}`);
            if (facts.length > 0) {
              await storeFacts(facts, 'agent', null);
              // Se tem assignee, salvar como conhecimento sobre a pessoa
              if (task.assignee?.name) {
                await storeFacts(facts, 'user', `asana:${task.assignee.name.toLowerCase().replace(/\s+/g, '_')}`);
              }
              asanaBatchState.facts += facts.length;
            }
            await markProcessed('task', task.gid, task._projectName, facts.length);
          } catch (err) {
            asanaBatchState.errors++;
            console.error(`[ASANA-STUDY] Erro task ${task.gid}:`, err.message);
            await markProcessed('task', task.gid, task._projectName, 0);
          }
          await sleep(HAIKU_DELAY);
        } else {
          await markProcessed('task', task.gid, task._projectName, 0);
        }

        asanaBatchState.tasks.processed++;
        if (asanaBatchState.tasks.processed % 50 === 0) {
          console.log(`[ASANA-STUDY] Tasks: ${asanaBatchState.tasks.processed}/${asanaBatchState.tasks.total} | Fatos: ${asanaBatchState.facts}`);
        }
      }

      if (!asanaBatchState.running) { finish('Parado pelo usuário'); return; }
      console.log(`[ASANA-STUDY] Fase 2 concluída: ${asanaBatchState.tasks.processed} tarefas`);

      // ========== FASE 3: COMENTÁRIOS DE CADA TAREFA ==========
      asanaBatchState.phase = 'comments';
      console.log('[ASANA-STUDY] Fase 3: Lendo comentários...');

      let commentCount = 0;
      for (const task of allTasks) {
        if (!asanaBatchState.running) break;

        try {
          const stories = await asanaGetAll(
            `/tasks/${task.gid}/stories?opt_fields=text,created_by.name,created_at,type&limit=100`
          );
          await sleep(ASANA_DELAY);

          // Filtrar só comentários de humanos (type='comment')
          const comments = (stories || []).filter(s =>
            s.type === 'comment' && s.text && s.text.length >= 20
          );

          asanaBatchState.comments.total += comments.length;
          commentCount += comments.length;

          for (const comment of comments) {
            if (!asanaBatchState.running) break;
            if (await isProcessed('comment', comment.gid || `${task.gid}_${comment.created_at}`)) {
              asanaBatchState.comments.processed++;
              continue;
            }

            const commentGid = comment.gid || `${task.gid}_${comment.created_at}`;
            const author = comment.created_by?.name || 'Desconhecido';
            const commentText = `Projeto: ${task._projectName} | Tarefa: ${task.name} | Comentário de ${author}: ${comment.text.substring(0, 500)}`;

            try {
              const facts = await extractAsanaFacts(commentText, `Comentário de ${author}`);
              if (facts.length > 0) {
                // Salvar como conhecimento global
                await storeFacts(facts, 'agent', null);
                // Salvar como conhecimento sobre quem comentou
                await storeFacts(facts, 'user', `asana:${author.toLowerCase().replace(/\s+/g, '_')}`);
                asanaBatchState.facts += facts.length;
              }
              await markProcessed('comment', commentGid, task._projectName, facts.length);
            } catch (err) {
              asanaBatchState.errors++;
              await markProcessed('comment', commentGid, task._projectName, 0);
            }

            asanaBatchState.comments.processed++;
            await sleep(HAIKU_DELAY);
          }
        } catch (err) {
          asanaBatchState.errors++;
          console.error(`[ASANA-STUDY] Erro stories task ${task.gid}:`, err.message);
        }

        if (asanaBatchState.comments.processed % 50 === 0 && asanaBatchState.comments.processed > 0) {
          console.log(`[ASANA-STUDY] Comentários: ${asanaBatchState.comments.processed}/${asanaBatchState.comments.total} | Fatos: ${asanaBatchState.facts}`);
        }
      }

      // ========== CONCLUÍDO ==========
      await setLastStudyDate(runStart);
      finish('Concluído com sucesso');

      // Auto-sync de perfis após estudo
      console.log('[ASANA-STUDY] Iniciando sync de perfis...');
      syncProfiles()
        .then(r => console.log(`[ASANA-STUDY] Perfis sincronizados: ${r.synced} perfis`))
        .catch(err => console.error('[ASANA-STUDY] Erro sync perfis:', err.message));

    } catch (err) {
      console.error('[ASANA-STUDY] Erro fatal:', err.message);
      finish(`Erro: ${err.message}`);
    }
  })();
}

function finish(reason) {
  asanaBatchState.running = false;
  asanaBatchState.phase = 'done';
  asanaBatchState.stoppedAt = new Date().toISOString();
  console.log(`[ASANA-STUDY] ${reason} | Projetos: ${asanaBatchState.projects.processed} | Tasks: ${asanaBatchState.tasks.processed} | Comentários: ${asanaBatchState.comments.processed} | Fatos: ${asanaBatchState.facts} | Erros: ${asanaBatchState.errors}`);
}

export function stopAsanaStudy() {
  asanaBatchState.running = false;
  asanaBatchState.stoppedAt = new Date().toISOString();
}
