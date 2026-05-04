// ============================================
// JARVIS 6.0 - MCP Server (Model Context Protocol)
// Entry point separado para integração com
// ferramentas externas (Claude Code, Cursor, etc.)
// ============================================
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pool } from './database.mjs';
import { searchMemories, getMemoryStats } from './memory.mjs';
import { asanaCreateTask } from './skills/loader.mjs';
import { getAccountInsights } from './skills/meta-ads.mjs';
import { CONFIG, ASANA_PROJECTS, ASANA_SECTIONS, ASANA_CUSTOM_FIELDS, ASANA_CLIENTE_MAP, TEAM_ASANA, managedClients, loadManagedClients } from './config.mjs';

// ============================================
// HELPER: Enviar mensagem via API interna
// ============================================
async function sendViaAPI(endpoint, body) {
  const port = CONFIG.API_PORT || 3100;
  const url = `http://localhost:${port}${endpoint}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.API_KEY,
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ============================================
// HELPER: Resolver grupo por nome
// ============================================
async function resolveGroup(nameOrJid) {
  // Se já é um JID completo, retorna direto
  if (nameOrJid.includes('@')) return nameOrJid;

  // Busca no banco pelo nome do grupo
  const { rows } = await pool.query(
    `SELECT jid, name FROM jarvis_groups WHERE LOWER(name) LIKE $1 ORDER BY updated_at DESC LIMIT 1`,
    [`%${nameOrJid.toLowerCase()}%`]
  );

  if (rows.length > 0) return rows[0].jid;

  // Tenta grupos conhecidos por slug
  const lower = nameOrJid.toLowerCase();
  if (lower.includes('tarefa')) return CONFIG.GROUP_TAREFAS;
  if (lower.includes('galax') || lower.includes('galaxia')) return CONFIG.GROUP_GALAXIAS;

  return null;
}

// ============================================
// INICIALIZAÇÃO
// ============================================
async function main() {
  // Carregar clientes gerenciados do banco
  await loadManagedClients(pool);

  const server = new McpServer({
    name: 'jarvis',
    version: '5.0.0',
  });

  // ============================================
  // TOOL 1: jarvis_send_message
  // Envia mensagem via WhatsApp
  // ============================================
  server.tool(
    'jarvis_send_message',
    'Envia uma mensagem via WhatsApp. Pode ser para um grupo (pelo nome) ou para um número de telefone.',
    {
      to: z.string().describe('Nome do grupo (ex: "Tarefas Diárias") ou número de telefone (ex: "5511999999999")'),
      message: z.string().describe('Texto da mensagem a ser enviada'),
    },
    async ({ to, message }) => {
      try {
        const isGroup = !to.match(/^\d+$/);

        if (isGroup) {
          const groupJid = await resolveGroup(to);
          if (!groupJid) {
            return { content: [{ type: 'text', text: `Erro: grupo "${to}" não encontrado. Use o nome exato ou JID do grupo.` }] };
          }
          const result = await sendViaAPI('/send/group', { groupId: groupJid, message });
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, grupo: to, groupJid, messageId: result.messageId }) }] };
        } else {
          const result = await sendViaAPI('/send/text', { to, message });
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, to, messageId: result.messageId }) }] };
        }
      } catch (err) {
        return { content: [{ type: 'text', text: `Erro ao enviar mensagem: ${err.message}` }], isError: true };
      }
    }
  );

  // ============================================
  // TOOL 2: jarvis_search_memories
  // Busca memórias do Jarvis
  // ============================================
  server.tool(
    'jarvis_search_memories',
    'Busca nas memórias do Jarvis. Retorna fatos aprendidos sobre pessoas, clientes, processos, regras e preferências.',
    {
      query: z.string().describe('Texto de busca (ex: "preferências do cliente Minner", "processo de aprovação")'),
      scope: z.string().optional().describe('Escopo: "user", "chat" ou "agent". Deixe vazio para buscar em todos.'),
      limit: z.number().optional().describe('Número máximo de resultados (padrão: 10)'),
    },
    async ({ query, scope, limit }) => {
      try {
        const results = await searchMemories(query, scope || null, null, limit || 10);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              total: results.length,
              memorias: results.map(r => ({
                conteudo: r.content,
                categoria: r.category,
                importancia: r.importance,
                escopo: r.scope,
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Erro ao buscar memórias: ${err.message}` }], isError: true };
      }
    }
  );

  // ============================================
  // TOOL 3: jarvis_create_task
  // Cria uma task no Asana
  // ============================================
  server.tool(
    'jarvis_create_task',
    'Cria uma task no Asana (projeto Cabine de Comando). Retorna o GID e URL da task criada.',
    {
      titulo: z.string().describe('Título da task'),
      cliente: z.string().optional().describe('Nome do cliente (ex: "Minner", "Rossato")'),
      descricao: z.string().optional().describe('Descrição/notas da task'),
      responsavel: z.string().optional().describe('Nome do responsável (ex: "Nicolas", "Bruna")'),
    },
    async ({ titulo, cliente, descricao, responsavel }) => {
      try {
        // Montar taskData para o Asana
        const taskData = {
          name: titulo,
          workspace: CONFIG.ASANA_WORKSPACE,
        };

        // Projeto padrão: Cabine de Comando
        if (ASANA_PROJECTS.CABINE) {
          taskData.projects = [ASANA_PROJECTS.CABINE];
        }

        // Notas/descrição
        if (descricao) {
          taskData.notes = descricao;
        }

        // Responsável (assignee) por GID
        if (responsavel && TEAM_ASANA) {
          const normalizado = responsavel.charAt(0).toUpperCase() + responsavel.slice(1).toLowerCase();
          const gid = TEAM_ASANA[normalizado] || TEAM_ASANA[responsavel.toLowerCase()] || TEAM_ASANA[responsavel];
          if (gid) taskData.assignee = gid;
        }

        // Custom fields: cliente
        if (cliente && ASANA_CUSTOM_FIELDS && ASANA_CLIENTE_MAP) {
          const clienteNorm = cliente.toLowerCase();
          const clienteGid = ASANA_CLIENTE_MAP[clienteNorm] || ASANA_CLIENTE_MAP[cliente];
          if (clienteGid && ASANA_CUSTOM_FIELDS.CLIENTE) {
            taskData.custom_fields = taskData.custom_fields || {};
            taskData.custom_fields[ASANA_CUSTOM_FIELDS.CLIENTE] = clienteGid;
          }
        }

        const result = await asanaCreateTask(taskData);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Erro ao criar task: ${err.message}` }], isError: true };
      }
    }
  );

  // ============================================
  // TOOL 4: jarvis_get_client_status
  // Status de um cliente gerenciado
  // ============================================
  server.tool(
    'jarvis_get_client_status',
    'Retorna o status de um cliente gerenciado pelo Jarvis: configuração, se está ativo, e contagem de mensagens recentes.',
    {
      cliente: z.string().describe('Nome do cliente (ex: "Minner", "Rossato")'),
    },
    async ({ cliente }) => {
      try {
        const clienteLower = cliente.toLowerCase();

        // Buscar nos managedClients
        let clientData = null;
        let clientJid = null;
        for (const [jid, data] of managedClients) {
          if (
            data.slug?.toLowerCase().includes(clienteLower) ||
            data.groupName?.toLowerCase().includes(clienteLower)
          ) {
            clientData = data;
            clientJid = jid;
            break;
          }
        }

        if (!clientData) {
          return { content: [{ type: 'text', text: `Cliente "${cliente}" não encontrado nos clientes gerenciados.` }] };
        }

        // Contar mensagens recentes (últimas 24h)
        const { rows: msgCount } = await pool.query(
          `SELECT COUNT(*) as count FROM jarvis_messages
           WHERE chat_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
          [clientJid]
        );

        // Contar mensagens da semana
        const { rows: weekCount } = await pool.query(
          `SELECT COUNT(*) as count FROM jarvis_messages
           WHERE chat_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
          [clientJid]
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              cliente: clientData.groupName || clientData.slug,
              ativo: clientData.active || false,
              groupJid: clientJid,
              responsavel: clientData.defaultAssignee || null,
              mensagens_24h: parseInt(msgCount[0].count),
              mensagens_7d: parseInt(weekCount[0].count),
              config: {
                slug: clientData.slug,
                active: clientData.active,
                defaultAssignee: clientData.defaultAssignee || null,
              },
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Erro ao buscar status do cliente: ${err.message}` }], isError: true };
      }
    }
  );

  // ============================================
  // TOOL 5: jarvis_get_metrics
  // Métricas do Meta Ads
  // ============================================
  server.tool(
    'jarvis_get_metrics',
    'Retorna métricas de tráfego pago do Meta Ads (Facebook/Instagram). Inclui impressões, cliques, gasto, CPC, CTR, ROAS.',
    {
      periodo: z.string().optional().describe('Período: "hoje", "ontem", "7dias", "30dias", "last_7d", "last_30d" (padrão: "7dias")'),
      cliente: z.string().optional().describe('Nome do cliente para filtrar (usa conta padrão se não informado)'),
    },
    async ({ periodo, cliente }) => {
      try {
        // getAccountInsights aceita período como string
        const result = await getAccountInsights(periodo || '7dias');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Erro ao buscar métricas: ${err.message}` }], isError: true };
      }
    }
  );

  // ============================================
  // TOOL 6: jarvis_memory_stats
  // Estatísticas do sistema de memória
  // ============================================
  server.tool(
    'jarvis_memory_stats',
    'Retorna estatísticas do sistema de memória do Jarvis: total de memórias, distribuição por escopo e categoria, top memórias.',
    {},
    async () => {
      try {
        const stats = await getMemoryStats();
        return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Erro ao buscar estatísticas: ${err.message}` }], isError: true };
      }
    }
  );

  // ============================================
  // CONECTAR TRANSPORT
  // ============================================
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Jarvis MCP Server v6.0.0 iniciado via stdio');
}

main().catch((err) => {
  console.error('[MCP] Erro fatal:', err);
  process.exit(1);
});
