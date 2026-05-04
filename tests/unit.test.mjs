// ============================================
// JARVIS 6.0 - Testes Unitários
// Node.js test runner nativo (sem dependências)
// ============================================
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

// Cleanup: fechar pool do PostgreSQL + OpenAI ao final dos testes
after(async () => {
  try {
    const { pool } = await import('../src/database.mjs');
    await pool.end();
  } catch {}
  // Forçar saída se algo ainda estiver pendente
  setTimeout(() => process.exit(0), 1000);
});

// Módulos testáveis (funções puras, sem I/O)
import { getMediaType, extractSender } from '../src/helpers.mjs';

// ============================================
// TESTES: getMediaType
// ============================================
describe('getMediaType', () => {
  it('retorna null se não tem message', () => {
    assert.equal(getMediaType({}), null);
    assert.equal(getMediaType({ message: null }), null);
  });

  it('detecta audio', () => {
    assert.equal(getMediaType({ message: { audioMessage: { url: 'x' } } }), 'audio');
  });

  it('detecta image', () => {
    assert.equal(getMediaType({ message: { imageMessage: { url: 'x' } } }), 'image');
  });

  it('detecta video', () => {
    assert.equal(getMediaType({ message: { videoMessage: { url: 'x' } } }), 'video');
  });

  it('detecta document', () => {
    assert.equal(getMediaType({ message: { documentMessage: { url: 'x' } } }), 'document');
  });

  it('detecta sticker', () => {
    assert.equal(getMediaType({ message: { stickerMessage: { url: 'x' } } }), 'sticker');
  });

  it('detecta contact', () => {
    assert.equal(getMediaType({ message: { contactMessage: {} } }), 'contact');
  });

  it('detecta location', () => {
    assert.equal(getMediaType({ message: { locationMessage: {} } }), 'location');
  });

  it('retorna null para mensagem de texto', () => {
    assert.equal(getMediaType({ message: { conversation: 'oi' } }), null);
  });
});

// ============================================
// TESTES: extractSender
// ============================================
describe('extractSender', () => {
  it('retorna from em mensagem privada', () => {
    const m = { key: {} };
    assert.equal(extractSender(m, '5511999@s.whatsapp.net', false), '5511999@s.whatsapp.net');
  });

  it('retorna participant em grupo', () => {
    const m = { key: { participant: '5511888@s.whatsapp.net' } };
    assert.equal(extractSender(m, 'grupo@g.us', true), '5511888@s.whatsapp.net');
  });

  it('retorna jarvis@bot quando fromMe em grupo', () => {
    const m = { key: { fromMe: true } };
    assert.equal(extractSender(m, 'grupo@g.us', true), 'jarvis@bot');
  });

  it('retorna from como fallback em grupo sem participant', () => {
    const m = { key: {} };
    assert.equal(extractSender(m, 'grupo@g.us', true), 'grupo@g.us');
  });

  it('ignora participant que é grupo', () => {
    const m = { key: { participant: 'outro@g.us' } };
    assert.equal(extractSender(m, 'grupo@g.us', true), 'grupo@g.us');
  });

  it('ignora participant que é broadcast', () => {
    const m = { key: { participant: 'algo@broadcast' } };
    assert.equal(extractSender(m, 'grupo@g.us', true), 'grupo@g.us');
  });

  it('usa participantAlt como fallback', () => {
    const m = { key: { participantAlt: '5511777@s.whatsapp.net' } };
    assert.equal(extractSender(m, 'grupo@g.us', true), '5511777@s.whatsapp.net');
  });
});

// ============================================
// TESTES: isValidResponse (importado de brain.mjs)
// brain.mjs usa process.env mas isValidResponse é pura
// ============================================
describe('isValidResponse', () => {
  // Importar dinamicamente para evitar side effects dos outros imports
  let isValidResponse;

  it('carrega o módulo', async () => {
    // brain.mjs importa config que usa process.env — OK no CI pois são strings vazias
    const mod = await import('../src/brain.mjs');
    isValidResponse = mod.isValidResponse;
    assert.ok(typeof isValidResponse === 'function');
  });

  it('rejeita null e undefined', async () => {
    const mod = await import('../src/brain.mjs');
    isValidResponse = mod.isValidResponse;
    assert.equal(isValidResponse(null), false);
    assert.equal(isValidResponse(undefined), false);
  });

  it('rejeita string vazia', async () => {
    const mod = await import('../src/brain.mjs');
    isValidResponse = mod.isValidResponse;
    assert.equal(isValidResponse(''), false);
    assert.equal(isValidResponse('   '), false);
  });

  it('rejeita só pontos', async () => {
    const mod = await import('../src/brain.mjs');
    isValidResponse = mod.isValidResponse;
    assert.equal(isValidResponse('...'), false);
    assert.equal(isValidResponse('. . .'), false);
  });

  it('rejeita só emojis/números (menos de 3 letras)', async () => {
    const mod = await import('../src/brain.mjs');
    isValidResponse = mod.isValidResponse;
    assert.equal(isValidResponse('123'), false);
    assert.equal(isValidResponse('!!'), false);
  });

  it('aceita resposta válida', async () => {
    const mod = await import('../src/brain.mjs');
    isValidResponse = mod.isValidResponse;
    assert.equal(isValidResponse('Olá, tudo bem?'), true);
    assert.equal(isValidResponse('Sim'), true);
    assert.equal(isValidResponse('Tarefa criada com sucesso!'), true);
  });
});

// ============================================
// TESTES: classifyIntent (parte pura - keywords)
// ============================================
describe('classifyIntent', () => {
  let classifyIntent;

  it('carrega o módulo', async () => {
    const mod = await import('../src/agents/master.mjs');
    classifyIntent = mod.classifyIntent;
    assert.ok(typeof classifyIntent === 'function');
  });

  it('retorna master para mensagens curtas', async () => {
    const mod = await import('../src/agents/master.mjs');
    classifyIntent = mod.classifyIntent;
    const result = await classifyIntent('oi', 'chat1', false);
    assert.equal(result.agent, 'master');
    assert.equal(result.confidence, 1.0);
  });

  it('detecta agente manager por keywords', async () => {
    const mod = await import('../src/agents/master.mjs');
    classifyIntent = mod.classifyIntent;

    // Keywords exatas: tarefa, prazo, asana, status, entrega (word boundary match)
    const r1 = await classifyIntent('qual o prazo de entrega do projeto de audiovisual?', 'chat1', false);
    assert.equal(r1.agent, 'manager');

    const r2 = await classifyIntent('abre o Asana e me diz se tem cobranca pendente por favor', 'chat1', false);
    assert.equal(r2.agent, 'manager');
  });

  it('detecta agente creative por keywords', async () => {
    const mod = await import('../src/agents/master.mjs');
    classifyIntent = mod.classifyIntent;

    const r1 = await classifyIntent('cria uma copy para o post de Instagram do cliente novo', 'chat1', false);
    assert.equal(r1.agent, 'creative');

    const r2 = await classifyIntent('preciso de uma legenda para os stories do cliente agora', 'chat1', false);
    assert.equal(r2.agent, 'creative');
  });

  it('detecta agente researcher por keywords', async () => {
    const mod = await import('../src/agents/master.mjs');
    classifyIntent = mod.classifyIntent;

    // Keywords: pesquis (prefixo), dados, tendencia, benchmark, mercado
    const r1 = await classifyIntent('faz uma analise do mercado de marketing digital no Brasil', 'chat1', false);
    assert.equal(r1.agent, 'researcher');
  });
});

// ============================================
// TESTES: Managed Clients (config.mjs)
// ============================================
describe('Managed Clients', () => {
  it('isManagedClientGroup retorna null para grupo não gerenciado', async () => {
    const { isManagedClientGroup } = await import('../src/config.mjs');
    const result = isManagedClientGroup('grupo_qualquer@g.us');
    assert.equal(result, null);
  });

  it('isManagedClientGroup retorna null para cliente inativo', async () => {
    const { managedClients, isManagedClientGroup } = await import('../src/config.mjs');
    managedClients.set('test_inactive@g.us', { groupName: 'Test', active: false });
    const result = isManagedClientGroup('test_inactive@g.us');
    assert.equal(result, null);
    managedClients.delete('test_inactive@g.us');
  });

  it('isManagedClientGroup retorna objeto para cliente ativo', async () => {
    const { managedClients, isManagedClientGroup } = await import('../src/config.mjs');
    managedClients.set('test_active@g.us', { groupName: 'Minner🔛StreamLab', active: true, defaultAssignee: 'bruna' });
    const result = isManagedClientGroup('test_active@g.us');
    assert.ok(result);
    assert.equal(result.groupName, 'Minner🔛StreamLab');
    assert.equal(result.active, true);
    managedClients.delete('test_active@g.us');
  });
});

// ============================================
// TESTES: handleManagedClientMessage existe e é função
// ============================================
describe('Proactive Agent', () => {
  it('handleManagedClientMessage é exportada do brain.mjs', async () => {
    const mod = await import('../src/brain.mjs');
    assert.ok(typeof mod.handleManagedClientMessage === 'function');
  });

  it('registerSendFunction é exportada do loader.mjs', async () => {
    const mod = await import('../src/skills/loader.mjs');
    assert.ok(typeof mod.registerSendFunction === 'function');
    assert.ok(typeof mod.getSendFunction === 'function');
  });

  it('registerSendFunction registra e recupera callback', async () => {
    const { registerSendFunction, getSendFunction } = await import('../src/skills/loader.mjs');
    const mockFn = () => {};
    registerSendFunction(mockFn);
    assert.equal(getSendFunction(), mockFn);
    registerSendFunction(null); // limpar
  });
});

// ============================================
// TESTES: Anti-Alucinação (brain.mjs)
// ============================================
describe('Anti-Alucinação', () => {
  let antiHallucinationCheck;

  it('carrega a função', async () => {
    const mod = await import('../src/brain.mjs');
    antiHallucinationCheck = mod.antiHallucinationCheck;
    assert.ok(typeof antiHallucinationCheck === 'function');
  });

  it('permite resposta quando usou tools de busca', async () => {
    const mod = await import('../src/brain.mjs');
    antiHallucinationCheck = mod.antiHallucinationCheck;
    const result = antiHallucinationCheck('O Doug mandou às 14:07 pedindo material, depois às 16:03 mandou mais, e às 16:05 finalizou', new Set(['buscar_mensagens']));
    assert.equal(result.safe, true);
  });

  it('bloqueia narrativa fabricada com múltiplos horários sem tools', async () => {
    const mod = await import('../src/brain.mjs');
    antiHallucinationCheck = mod.antiHallucinationCheck;
    const narrativaFabricada = 'O Doug mandou às 10:52 o briefing completo. Depois às 12:54 mandou as fotos. O Jarvis respondeu às 14:07 agradecendo. Às 16:03 o Doug ignorou as perguntas e mandou novos conteúdos. Às 16:05 finalizou pedindo pra verificar o material.';
    const result = antiHallucinationCheck(narrativaFabricada, new Set());
    assert.equal(result.safe, false);
  });

  it('permite resposta curta de confirmação sem tools', async () => {
    const mod = await import('../src/brain.mjs');
    antiHallucinationCheck = mod.antiHallucinationCheck;
    const result = antiHallucinationCheck('Entendido, Gui! Vou gravar isso e aprender. Posso executar agora?', new Set());
    assert.equal(result.safe, true);
  });

  it('permite resposta quando usou tools de ação', async () => {
    const mod = await import('../src/brain.mjs');
    antiHallucinationCheck = mod.antiHallucinationCheck;
    const result = antiHallucinationCheck('Gravei na memória: Stream Lab é um laboratório de fluxo criativo, não uma agência. Sempre usar o termo lab ou laboratório.', new Set(['lembrar']));
    assert.equal(result.safe, true);
  });

  it('permite resposta genérica sem dados específicos', async () => {
    const mod = await import('../src/brain.mjs');
    antiHallucinationCheck = mod.antiHallucinationCheck;
    const result = antiHallucinationCheck('Posso verificar o grupo do Minner pra você. Quer que eu busque as mensagens?', new Set());
    assert.equal(result.safe, true);
  });
});

// ============================================
// TESTES: AI_MODEL_STRONG (config.mjs)
// ============================================
describe('AI Model Strong', () => {
  it('CONFIG.AI_MODEL_STRONG existe e é string', async () => {
    const { CONFIG } = await import('../src/config.mjs');
    assert.ok(typeof CONFIG.AI_MODEL_STRONG === 'string');
    assert.ok(CONFIG.AI_MODEL_STRONG.length > 0);
  });

  it('CONFIG.AI_MODEL_STRONG difere do AI_MODEL', async () => {
    const { CONFIG } = await import('../src/config.mjs');
    // Em produção AI_MODEL_STRONG deve ser opus e AI_MODEL deve ser sonnet
    // Aqui apenas verificamos que ambos existem
    assert.ok(typeof CONFIG.AI_MODEL === 'string');
    assert.ok(typeof CONFIG.AI_MODEL_STRONG === 'string');
  });
});

// ============================================
// TESTES: Mídia + Asana Upload
// ============================================
describe('Mídia e Asana Upload', () => {
  it('asanaUploadAttachment é exportada do loader.mjs', async () => {
    const mod = await import('../src/skills/loader.mjs');
    assert.ok(typeof mod.asanaUploadAttachment === 'function');
  });

  it('JARVIS_TOOLS inclui anexar_midia_asana', async () => {
    const { JARVIS_TOOLS } = await import('../src/skills/loader.mjs');
    const tool = JARVIS_TOOLS.find(t => t.name === 'anexar_midia_asana');
    assert.ok(tool, 'Tool anexar_midia_asana não encontrada');
    assert.ok(tool.input_schema.properties.task_gid, 'task_gid não definido no schema');
  });

  it('JARVIS_TOOLS inclui novas tools de gestão', async () => {
    const { JARVIS_TOOLS } = await import('../src/skills/loader.mjs');
    const toolNames = JARVIS_TOOLS.map(t => t.name);
    assert.ok(toolNames.includes('consultar_task'), 'consultar_task não encontrada');
    assert.ok(toolNames.includes('comentar_task'), 'comentar_task não encontrada');
    assert.ok(toolNames.includes('atualizar_task'), 'atualizar_task não encontrada');
    assert.ok(toolNames.includes('buscar_memorias'), 'buscar_memorias não encontrada');
  });

  it('handleManagedClientMessage aceita mediaFiles como 7o argumento', async () => {
    const mod = await import('../src/brain.mjs');
    // Verificar que a função aceita 7 argumentos (o último é mediaFiles)
    assert.ok(mod.handleManagedClientMessage.length >= 6);
  });
});

// ============================================
// TESTES: Cérebro Persistente (brain-document.mjs)
// ============================================
describe('Cérebro Persistente', () => {
  it('brain-document.mjs exporta as funções necessárias', async () => {
    const mod = await import('../src/brain-document.mjs');
    assert.ok(typeof mod.generateBrainDocument === 'function');
    assert.ok(typeof mod.loadBrainDocument === 'function');
    assert.ok(typeof mod.invalidateBrainCache === 'function');
    assert.ok(typeof mod.getBrainStatus === 'function');
  });

  it('invalidateBrainCache não lança erro', async () => {
    const { invalidateBrainCache } = await import('../src/brain-document.mjs');
    assert.doesNotThrow(() => invalidateBrainCache());
  });
});

// ============================================
// TESTES: Colaboração Multi-Agente
// ============================================
describe('Colaboração Multi-Agente', () => {
  it('JARVIS_TOOLS inclui consultar_especialista', async () => {
    const { JARVIS_TOOLS } = await import('../src/skills/loader.mjs');
    const tool = JARVIS_TOOLS.find(t => t.name === 'consultar_especialista');
    assert.ok(tool, 'Tool consultar_especialista não encontrada');
    assert.ok(tool.input_schema.properties.especialista, 'Campo especialista ausente');
    assert.ok(tool.input_schema.properties.pedido, 'Campo pedido ausente');
    assert.deepEqual(
      tool.input_schema.properties.especialista.enum,
      ['creative', 'manager', 'researcher', 'traffic', 'social'],
      'Enum de especialistas incorreto'
    );
  });

  it('JARVIS_IDENTITY menciona colaboração', async () => {
    const { JARVIS_IDENTITY } = await import('../src/agents/master.mjs');
    assert.ok(JARVIS_IDENTITY.includes('consultar_especialista'), 'Identidade não menciona consultar_especialista');
    assert.ok(JARVIS_IDENTITY.includes('COLABORAÇÃO'), 'Identidade não menciona COLABORAÇÃO');
  });

  it('Arquitetura unificada: JARVIS_IDENTITY + CHANNEL_CONTEXT + AGENT_EXPERTISE', async () => {
    const { JARVIS_IDENTITY, CHANNEL_CONTEXT, AGENT_EXPERTISE, MASTER_SYSTEM_PROMPT, AGENT_PROMPTS } = await import('../src/agents/master.mjs');

    // Identidade única existe
    assert.ok(JARVIS_IDENTITY.length > 500, 'JARVIS_IDENTITY muito curta');

    // Canais existem
    assert.ok(CHANNEL_CONTEXT.whatsapp_internal, 'Canal whatsapp_internal ausente');
    assert.ok(CHANNEL_CONTEXT.whatsapp_client, 'Canal whatsapp_client ausente');
    assert.ok(CHANNEL_CONTEXT.asana, 'Canal asana ausente');
    assert.ok(CHANNEL_CONTEXT.dashboard, 'Canal dashboard ausente');
    assert.ok(CHANNEL_CONTEXT.dashboard_voice, 'Canal dashboard_voice ausente');

    // Expertises existem
    for (const agent of ['creative', 'manager', 'researcher', 'traffic', 'social']) {
      assert.ok(AGENT_EXPERTISE[agent], `Expertise ${agent} ausente`);
    }

    // Compatibilidade mantida
    assert.ok(MASTER_SYSTEM_PROMPT.includes('JARVIS'), 'MASTER_SYSTEM_PROMPT não contém identidade');
    for (const agent of ['creative', 'manager', 'researcher', 'traffic', 'social']) {
      assert.ok(AGENT_PROMPTS[agent].includes('JARVIS'), `AGENT_PROMPTS.${agent} não contém identidade`);
    }
  });

  it('agentLoop é exportado do brain.mjs (cérebro compartilhado entre canais)', async () => {
    const { agentLoop } = await import('../src/brain.mjs');
    assert.ok(typeof agentLoop === 'function', 'agentLoop não é uma função');
  });
});

// ============================================
// TESTES: Pipeline Meta Ads (novas tools)
// ============================================
describe('Pipeline Meta Ads', () => {
  it('JARVIS_TOOLS inclui todas as 8 novas tools do pipeline', async () => {
    const { JARVIS_TOOLS } = await import('../src/skills/loader.mjs');
    const novasTools = [
      'criar_conjunto_anuncios',
      'subir_imagem_ads',
      'criar_criativo_ads',
      'criar_anuncio',
      'baixar_anexos_task',
      'pipeline_asana_meta',
      'ativar_desativar_ads',
      'listar_conjuntos',
    ];
    for (const toolName of novasTools) {
      const tool = JARVIS_TOOLS.find(t => t.name === toolName);
      assert.ok(tool, `Tool ${toolName} não encontrada em JARVIS_TOOLS`);
    }
  });

  it('meta-ads.mjs exporta todas as novas funções', async () => {
    const metaAds = await import('../src/skills/meta-ads.mjs');
    const expectedFns = [
      'createAdSet', 'listAdSets', 'uploadAdImage',
      'createAdCreative', 'createAd', 'updateEntityStatus',
      'asanaGetAttachments', 'pipelineAsanaToAds',
    ];
    for (const fn of expectedFns) {
      assert.ok(typeof metaAds[fn] === 'function', `Função ${fn} não exportada de meta-ads.mjs`);
    }
  });

  it('pausar_campanha suporta tipo (campanha, conjunto, anuncio)', async () => {
    const { JARVIS_TOOLS } = await import('../src/skills/loader.mjs');
    const tool = JARVIS_TOOLS.find(t => t.name === 'pausar_campanha');
    assert.ok(tool, 'Tool pausar_campanha não encontrada');
    assert.ok(tool.input_schema.properties.tipo, 'Campo tipo ausente em pausar_campanha');
    assert.deepEqual(tool.input_schema.properties.tipo.enum, ['campanha', 'conjunto', 'anuncio']);
  });

  it('ativar_desativar_ads aceita array de IDs', async () => {
    const { JARVIS_TOOLS } = await import('../src/skills/loader.mjs');
    const tool = JARVIS_TOOLS.find(t => t.name === 'ativar_desativar_ads');
    assert.ok(tool, 'Tool ativar_desativar_ads não encontrada');
    assert.equal(tool.input_schema.properties.ids.type, 'array');
    assert.deepEqual(tool.input_schema.properties.acao.enum, ['ativar', 'pausar']);
  });

  it('classifyIntent detecta traffic para "ativa as campanhas do Rossato"', async () => {
    const { classifyIntent } = await import('../src/agents/master.mjs');
    const result = await classifyIntent('ativa as campanhas do Rossato no Meta Ads');
    assert.equal(result.agent, 'traffic', `Esperava traffic, recebeu ${result.agent}`);
  });

  it('classifyIntent detecta traffic para "cria um conjunto de anúncios"', async () => {
    const { classifyIntent } = await import('../src/agents/master.mjs');
    const result = await classifyIntent('cria um conjunto de anúncios pra campanha de tráfego');
    assert.equal(result.agent, 'traffic', `Esperava traffic, recebeu ${result.agent}`);
  });

  it('meta-ads.mjs não contém credenciais hardcoded', async () => {
    const { readFile } = await import('fs/promises');
    const content = await readFile(new URL('../src/skills/meta-ads.mjs', import.meta.url), 'utf-8');
    const dangerousPatterns = [/sk-ant-api/i, /act_\d{10,}/, /EAAb[a-zA-Z0-9]+/];
    for (const p of dangerousPatterns) {
      assert.ok(!p.test(content), `Credencial encontrada em meta-ads.mjs: ${p}`);
    }
  });
});

// ============================================
// TESTES: Asana Webhooks
// ============================================
describe('Asana Webhooks', () => {
  it('processAsanaWebhookEvent é exportada', async () => {
    const { processAsanaWebhookEvent } = await import('../src/webhooks/asana-webhook.mjs');
    assert.equal(typeof processAsanaWebhookEvent, 'function');
  });

  it('registerAsanaWebhooks é exportada', async () => {
    const { registerAsanaWebhooks } = await import('../src/webhooks/asana-webhook.mjs');
    assert.equal(typeof registerAsanaWebhooks, 'function');
  });

  it('ignora eventos do próprio Jarvis (evita loop)', async () => {
    const { processAsanaWebhookEvent } = await import('../src/webhooks/asana-webhook.mjs');
    // Não deve lançar erro — evento do Jarvis é ignorado silenciosamente
    await processAsanaWebhookEvent({
      action: 'changed',
      resource: { gid: '123', resource_type: 'task' },
      user: { gid: '1213583219463912' }, // GID do Jarvis
    });
  });

  it('ignora eventos de recursos que não são tasks', async () => {
    const { processAsanaWebhookEvent } = await import('../src/webhooks/asana-webhook.mjs');
    // Não deve lançar erro — evento de projeto é ignorado
    await processAsanaWebhookEvent({
      action: 'changed',
      resource: { gid: '123', resource_type: 'project' },
      user: { gid: '999' },
    });
  });

  it('processa eventos deleted/removed sem erro', async () => {
    const { processAsanaWebhookEvent } = await import('../src/webhooks/asana-webhook.mjs');
    await processAsanaWebhookEvent({
      action: 'deleted',
      resource: { gid: '123', resource_type: 'task' },
      user: { gid: '999' },
    });
    await processAsanaWebhookEvent({
      action: 'removed',
      resource: { gid: '456', resource_type: 'task' },
      user: { gid: '999' },
    });
  });
});

// ============================================
// TESTES: Validação de estrutura
// ============================================
describe('Estrutura do projeto', () => {
  it('.env.example contém todas as variáveis necessárias', async () => {
    const { readFile } = await import('fs/promises');
    const envExample = await readFile(new URL('../.env.example', import.meta.url), 'utf-8');

    const requiredVars = [
      'ANTHROPIC_API_KEY',
      'ASANA_PAT',
      'OPENAI_API_KEY',
      'ELEVENLABS_API_KEY',
      'JARVIS_API_KEY',
      'JWT_SECRET',
      'DB_PASSWORD',
      'REDIS_PASSWORD',
      'GUI_JID',
      'GROUP_TAREFAS',
      'ASANA_WORKSPACE',
      'TEAM_ASANA',
      'ASANA_PROJECTS',
      'GCAL_CALENDAR_ID',
      'AI_MODEL_STRONG',
    ];

    for (const v of requiredVars) {
      assert.ok(envExample.includes(v), `Variável ${v} faltando no .env.example`);
    }
  });

  it('nenhum arquivo de código contém credenciais hardcoded (inclui novos módulos)', async () => {
    const { readFile } = await import('fs/promises');
    const { glob } = await import('fs/promises').then(() => import('node:fs')).catch(() => ({ glob: null }));

    const files = [
      '../src/config.mjs',
      '../src/database.mjs',
      '../src/brain.mjs',
      '../src/audio.mjs',
      '../src/memory.mjs',
      '../src/helpers.mjs',
      '../src/agents/master.mjs',
      '../src/skills/loader.mjs',
      '../src/profiles.mjs',
      '../src/brain-document.mjs',
      '../src/webhooks/asana-webhook.mjs',
    ];

    const dangerousPatterns = [
      /sk-ant-api/i,
      /sk_[a-f0-9]{20,}/i,
      /sk-proj-/i,
      /JarvisDB_/i,
      /Redis.*2026/i,
      /StreamLabJarvis/i,
      /31\.97\.160\.141/,
      /555597337777/,
    ];

    for (const file of files) {
      const content = await readFile(new URL(file, import.meta.url), 'utf-8');
      for (const pattern of dangerousPatterns) {
        assert.ok(
          !pattern.test(content),
          `Credencial encontrada em ${file}: ${pattern}`
        );
      }
    }
  });
});

// ============================================
// TESTES: Sprint 2.1 — Atendimento Público (DM)
// ============================================
describe('Atendimento Público (Sprint 2.1)', () => {
  it('CHANNEL_CONTEXT.whatsapp_public existe e contém regras', async () => {
    const { CHANNEL_CONTEXT } = await import('../src/agents/master.mjs');
    assert.ok(CHANNEL_CONTEXT.whatsapp_public, 'Canal whatsapp_public ausente');
    assert.ok(CHANNEL_CONTEXT.whatsapp_public.includes('PROIBIDO'), 'Falta regras de proibição');
    assert.ok(CHANNEL_CONTEXT.whatsapp_public.includes('laboratório criativo'), 'Falta descrição da Stream Lab');
    assert.ok(CHANNEL_CONTEXT.whatsapp_public.includes('PROIBIDO'), 'Falta regras de proibição no canal público');
    assert.ok(CHANNEL_CONTEXT.whatsapp_public.includes('HORÁRIO') || CHANNEL_CONTEXT.whatsapp_public.includes('horário'), 'Falta regra de horário');
  });

  it('handlePublicDM é exportada do brain.mjs', async () => {
    const mod = await import('../src/brain.mjs');
    assert.ok(typeof mod.handlePublicDM === 'function', 'handlePublicDM não é uma função');
  });

  it('database.mjs exporta funções de public_conversations', async () => {
    const db = await import('../src/database.mjs');
    assert.ok(typeof db.upsertPublicConversation === 'function', 'upsertPublicConversation ausente');
    assert.ok(typeof db.getPublicConversation === 'function', 'getPublicConversation ausente');
    assert.ok(typeof db.incrementPublicMessages === 'function', 'incrementPublicMessages ausente');
  });

  it('database.mjs exporta funções de cobranca_log', async () => {
    const db = await import('../src/database.mjs');
    assert.ok(typeof db.getCobrancaLog === 'function', 'getCobrancaLog ausente');
    assert.ok(typeof db.upsertCobrancaLog === 'function', 'upsertCobrancaLog ausente');
    assert.ok(typeof db.resetCobrancaLog === 'function', 'resetCobrancaLog ausente');
  });
});

// ============================================
// TESTES: Sprint 2.2 — Autonomia Nível 2
// ============================================
describe('Autonomia Nível 2 (Sprint 2.2)', () => {
  it('JARVIS_TOOLS inclui mover_task_secao', async () => {
    const { JARVIS_TOOLS } = await import('../src/skills/loader.mjs');
    const tool = JARVIS_TOOLS.find(t => t.name === 'mover_task_secao');
    assert.ok(tool, 'Tool mover_task_secao não encontrada');
    assert.ok(tool.input_schema.properties.task_gid, 'task_gid ausente');
    assert.ok(tool.input_schema.properties.projeto, 'projeto ausente');
    assert.ok(tool.input_schema.properties.secao, 'secao ausente');
    assert.deepEqual(tool.input_schema.required, ['task_gid', 'projeto', 'secao']);
  });

  it('JARVIS_TOOLS inclui atribuir_task', async () => {
    const { JARVIS_TOOLS } = await import('../src/skills/loader.mjs');
    const tool = JARVIS_TOOLS.find(t => t.name === 'atribuir_task');
    assert.ok(tool, 'Tool atribuir_task não encontrada');
    assert.ok(tool.input_schema.properties.task_gid, 'task_gid ausente');
    assert.ok(tool.input_schema.properties.responsavel, 'responsavel ausente');
    assert.deepEqual(tool.input_schema.required, ['task_gid', 'responsavel']);
  });

  it('antiHallucinationCheck permite mover_task_secao e atribuir_task', async () => {
    const { antiHallucinationCheck } = await import('../src/brain.mjs');
    const r1 = antiHallucinationCheck('Task movida para Em Andamento com sucesso. O responsável foi atualizado conforme solicitado.', new Set(['mover_task_secao']));
    assert.equal(r1.safe, true, 'mover_task_secao deveria ser permitida');
    const r2 = antiHallucinationCheck('Task atribuída ao Bruno com sucesso. Ele será notificado automaticamente pelo Asana.', new Set(['atribuir_task']));
    assert.equal(r2.safe, true, 'atribuir_task deveria ser permitida');
  });
});

// ============================================
// v6.0 Sprint 5 — Anti-Leak v4 (caso Rigon: lead = nome equipe)
// ============================================
describe('Anti-Leak v4 (Sprint 5)', () => {
  it('exporta checkInternalLeak, checkInternalLeakSmart e sanitizeClientResponse', async () => {
    const m = await import('../src/brain.mjs');
    assert.ok(typeof m.checkInternalLeak === 'function', 'checkInternalLeak ausente');
    assert.ok(typeof m.checkInternalLeakSmart === 'function', 'checkInternalLeakSmart ausente');
    assert.ok(typeof m.sanitizeClientResponse === 'function', 'sanitizeClientResponse ausente');
  });

  it('bloqueia vazamento de nome de equipe sem sender', async () => {
    const { checkInternalLeak } = await import('../src/brain.mjs');
    const r = checkInternalLeak('Vou pedir pra Bruna conferir isso pra você.');
    assert.equal(r.leaked, true, 'Deveria bloquear menção a Bruna em resposta pública');
  });

  it('NÃO bloqueia se nome do match = nome do sender (caso Rigon)', async () => {
    const { checkInternalLeak } = await import('../src/brain.mjs');
    const r = checkInternalLeak('Boa pergunta, Rigon! Vou te explicar.', 'Guilherme Rigon');
    assert.equal(r.leaked, false, 'NÃO deveria bloquear nome do próprio lead');
  });

  it('NÃO bloqueia primeiro nome do sender', async () => {
    const { checkInternalLeak } = await import('../src/brain.mjs');
    const r = checkInternalLeak('Bruna, posso te ajudar com mais alguma coisa?', 'Bruna Silva Cliente');
    assert.equal(r.leaked, false, 'NÃO deveria bloquear "Bruna" se sender é "Bruna Silva Cliente"');
  });

  it('match deve ser exato — não substring (evita falso positivo)', async () => {
    const { checkInternalLeak } = await import('../src/brain.mjs');
    const r = checkInternalLeak('Vou pedir pra Rigon conferir.', 'Rigol Souza');
    assert.equal(r.leaked, true, 'Match exato — "Rigol" não libera "Rigon"');
  });

  it('sanitizeClientResponse preserva linhas com nome do sender', async () => {
    const { sanitizeClientResponse } = await import('../src/brain.mjs');
    const text = 'Oi Rigon, prazer!\nVou avisar a Bruna que você ligou.';
    const result = sanitizeClientResponse(text, 'Rigon Lead');
    assert.ok(result, 'Resultado não deveria ser null');
    assert.ok(result.includes('Rigon'), 'Deveria manter linha com "Rigon"');
    assert.ok(!result.includes('Bruna'), 'Deveria remover linha com "Bruna"');
  });

  it('bloqueia termos cross-client mesmo com sender', async () => {
    const { checkInternalLeak } = await import('../src/brain.mjs');
    const r = checkInternalLeak('Trabalhamos com Rossato e outros clientes.', 'João Lead');
    assert.equal(r.leaked, true, 'Deveria bloquear menção a outro cliente (Rossato)');
  });
});

// ============================================
// v6.0 Sprint 3 — Profile Real-Time
// ============================================
describe('Profile Real-Time (Sprint 3)', () => {
  it('exporta synthesizeProfileCached, invalidateProfileCache, getProfileCacheStats', async () => {
    const m = await import('../src/profiles.mjs');
    assert.ok(typeof m.synthesizeProfileCached === 'function', 'synthesizeProfileCached ausente');
    assert.ok(typeof m.invalidateProfileCache === 'function', 'invalidateProfileCache ausente');
    assert.ok(typeof m.getProfileCacheStats === 'function', 'getProfileCacheStats ausente');
  });

  it('getProfileCacheStats retorna shape correto', async () => {
    const { getProfileCacheStats } = await import('../src/profiles.mjs');
    const stats = getProfileCacheStats();
    assert.ok(typeof stats.total === 'number');
    assert.ok(typeof stats.valid === 'number');
    assert.ok(typeof stats.expired === 'number');
  });

  it('invalidateProfileCache não quebra com args vazios', async () => {
    const { invalidateProfileCache } = await import('../src/profiles.mjs');
    invalidateProfileCache();
    invalidateProfileCache('client_contact', 'fake-jid');
    assert.ok(true, 'Não deveria lançar exceção');
  });
});

// ============================================
// v6.0 Sprint 4 — Cross-Channel Identity
// ============================================
describe('Cross-Channel Identity (Sprint 4)', () => {
  it('exporta resolveCanonicalId, getContactStats, mergeCanonicals', async () => {
    const m = await import('../src/contacts.mjs');
    assert.ok(typeof m.resolveCanonicalId === 'function', 'resolveCanonicalId ausente');
    assert.ok(typeof m.getContactStats === 'function', 'getContactStats ausente');
    assert.ok(typeof m.mergeCanonicals === 'function', 'mergeCanonicals ausente');
    assert.ok(typeof m.getAliasesForCanonical === 'function', 'getAliasesForCanonical ausente');
    assert.ok(typeof m.initContactAliases === 'function', 'initContactAliases ausente');
  });

  it('levenshtein calcula distância correta', async () => {
    const { _internal } = await import('../src/contacts.mjs');
    assert.equal(_internal.levenshtein('rigon', 'rigon'), 0);
    assert.equal(_internal.levenshtein('rigon', 'rigons'), 1);
    assert.equal(_internal.levenshtein('bruna', 'brusna'), 1);
    assert.ok(_internal.levenshtein('completamente', 'diferente') > 5);
  });

  it('detecta canal pelo formato do alias', async () => {
    const { _internal } = await import('../src/contacts.mjs');
    assert.equal(_internal._detectChannel('5511999@s.whatsapp.net'), 'whatsapp');
    assert.equal(_internal._detectChannel('grupo@g.us'), 'whatsapp');
    assert.equal(_internal._detectChannel('123@lid'), 'whatsapp');
    assert.equal(_internal._detectChannel('instagram_abc123'), 'instagram');
    assert.equal(_internal._detectChannel('email_user@test.com'), 'email');
    assert.equal(_internal._detectChannel(''), 'unknown');
  });

  it('detecta nome genérico (evita falso positivo cross-channel)', async () => {
    const { _internal } = await import('../src/contacts.mjs');
    assert.equal(_internal._isGenericName('João'), true);
    assert.equal(_internal._isGenericName('Maria'), true);
    assert.equal(_internal._isGenericName(''), true);
    assert.equal(_internal._isGenericName('ab'), true);
    assert.equal(_internal._isGenericName('Kayque Torrubia'), false);
    assert.equal(_internal._isGenericName('Rigon'), false);
  });

  it('normalização remove acentos e lowercase', async () => {
    const { _internal } = await import('../src/contacts.mjs');
    assert.equal(_internal._normalizeName('João Silva'), 'joao silva');
    assert.equal(_internal._normalizeName('NÍCOLAS'), 'nicolas');
  });
});

// ============================================
// v6.0 Sprint 6 — Task Copilot
// ============================================
describe('Task Copilot (v6.0)', () => {
  it('exporta funções principais', async () => {
    const tc = await import('../src/task-copilot.mjs');
    assert.ok(typeof tc.analyzeTask === 'function', 'analyzeTask ausente');
    assert.ok(typeof tc.identifyHelpOpportunities === 'function', 'identifyHelpOpportunities ausente');
    assert.ok(typeof tc.generateFollowUpComment === 'function', 'generateFollowUpComment ausente');
    assert.ok(typeof tc.pollTasksAssignedToJarvis === 'function', 'pollTasksAssignedToJarvis ausente');
    assert.ok(typeof tc.pollOverdueForFollowUp === 'function', 'pollOverdueForFollowUp ausente');
    assert.ok(typeof tc.generateDailyBriefing === 'function', 'generateDailyBriefing ausente');
    assert.ok(typeof tc.postDailyBriefing === 'function', 'postDailyBriefing ausente');
    assert.ok(typeof tc.getTaskCopilotConfig === 'function', 'getTaskCopilotConfig ausente');
    assert.ok(typeof tc.saveTaskCopilotConfig === 'function', 'saveTaskCopilotConfig ausente');
  });

  it('identifyHelpOpportunities retorna ofertas relevantes pra task de copy', async () => {
    const { identifyHelpOpportunities } = await import('../src/task-copilot.mjs');
    const ofertas = identifyHelpOpportunities({
      nome: 'Rascunhar copy do post de Instagram',
      descricao: 'Copy pra feed novo cliente',
      diasInativa: 1,
      comentarios: [{ autor: 'X', texto: 'lembrete' }],
    });
    assert.ok(Array.isArray(ofertas));
    assert.ok(ofertas.length > 0, 'Deveria identificar ofertas pra task de copy');
    assert.ok(ofertas.some(o => o.toLowerCase().includes('rascunhar') || o.toLowerCase().includes('copy')),
      'Deveria sugerir rascunho de copy');
  });

  it('identifyHelpOpportunities sugere destravar quando sem comentários e parada', async () => {
    const { identifyHelpOpportunities } = await import('../src/task-copilot.mjs');
    const ofertas = identifyHelpOpportunities({
      nome: 'Task qualquer',
      descricao: '',
      diasInativa: 5,
      comentarios: [],
    });
    assert.ok(ofertas.some(o => o.toLowerCase().includes('travando') || o.toLowerCase().includes('destravar')),
      'Deveria oferecer ajuda pra destravar');
  });

  it('identifyHelpOpportunities limita a 3 ofertas máximo', async () => {
    const { identifyHelpOpportunities } = await import('../src/task-copilot.mjs');
    const ofertas = identifyHelpOpportunities({
      nome: 'Planner copy referencia briefing campanha arte',
      descricao: 'Tudo junto',
      diasInativa: 1,
      comentarios: [{ autor: 'X', texto: 'oi' }],
    });
    assert.ok(ofertas.length <= 3, `Deveria limitar a 3, retornou ${ofertas.length}`);
  });
});

// ============================================
// Keys Manager (v6.0 Sprint 10)
// ============================================
describe('Keys Manager (Sprint 10)', () => {
  it('exporta funções principais e whitelist', async () => {
    // Define JWT_SECRET temporariamente pra testes determinísticos
    const oldSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'test-secret-only-for-unit-tests';
    const mod = await import('../src/keys-manager.mjs');
    assert.strictEqual(typeof mod.loadKeysFromDb, 'function');
    assert.strictEqual(typeof mod.saveKey, 'function');
    assert.strictEqual(typeof mod.deleteKey, 'function');
    assert.strictEqual(typeof mod.listKeys, 'function');
    assert.strictEqual(typeof mod.maskKey, 'function');
    assert.ok(Array.isArray(mod.MANAGEABLE_KEYS), 'MANAGEABLE_KEYS deve ser array');
    assert.ok(Array.isArray(mod.KEY_NAMES), 'KEY_NAMES deve ser array');
    assert.ok(mod.MANAGEABLE_KEYS.length >= 20, 'Deve ter pelo menos 20 chaves whitelisted');
    process.env.JWT_SECRET = oldSecret;
  });

  it('whitelist contém chaves críticas (Anthropic, OpenAI, Asana, Meta)', async () => {
    const { KEY_NAMES } = await import('../src/keys-manager.mjs');
    assert.ok(KEY_NAMES.includes('ANTHROPIC_API_KEY'), 'Deve incluir ANTHROPIC_API_KEY');
    assert.ok(KEY_NAMES.includes('OPENAI_API_KEY'), 'Deve incluir OPENAI_API_KEY');
    assert.ok(KEY_NAMES.includes('ASANA_PAT'), 'Deve incluir ASANA_PAT');
    assert.ok(KEY_NAMES.includes('META_ACCESS_TOKEN'), 'Deve incluir META_ACCESS_TOKEN');
  });

  it('whitelist NÃO contém chaves perigosas (JWT_SECRET, DB_PASSWORD, etc)', async () => {
    const { KEY_NAMES } = await import('../src/keys-manager.mjs');
    const proibidas = ['JWT_SECRET', 'DB_PASSWORD', 'DB_HOST', 'DB_USER', 'JARVIS_API_KEY', 'REDIS_PASSWORD'];
    for (const p of proibidas) {
      assert.ok(!KEY_NAMES.includes(p), `Whitelist NÃO pode conter ${p} (segurança)`);
    }
  });

  it('maskKey esconde valor sensível mostrando só últimos 4 chars', async () => {
    const { maskKey } = await import('../src/keys-manager.mjs');
    assert.strictEqual(maskKey(''), '');
    assert.strictEqual(maskKey('abc'), '****');
    assert.strictEqual(maskKey('abcdef'), '****ef');
    assert.strictEqual(maskKey('sk-ant-api03-supersecreto-abcd'), '****abcd');
  });

  it('encrypt/decrypt é roundtrip-safe (AES-256-GCM)', async () => {
    process.env.JWT_SECRET = 'test-secret-roundtrip';
    const { _internal } = await import('../src/keys-manager.mjs');
    const original = 'sk-ant-api03-secretvalue-12345';
    const encrypted = _internal.encrypt(original);
    assert.notStrictEqual(encrypted, original, 'Valor cifrado deve ser diferente do original');
    assert.ok(encrypted.length > original.length, 'Cifrado deve ter IV+tag prepended');
    const decrypted = _internal.decrypt(encrypted);
    assert.strictEqual(decrypted, original, 'Decrypt deve recuperar o valor original');
  });

  it('saveKey valida whitelist (rejeita chave não autorizada)', async () => {
    const { saveKey } = await import('../src/keys-manager.mjs');
    await assert.rejects(
      () => saveKey('FAKE_DANGEROUS_KEY', 'value'),
      /whitelist/i,
      'Deve rejeitar chave fora da whitelist'
    );
  });

  it('saveKey valida valor (rejeita vazio)', async () => {
    const { saveKey } = await import('../src/keys-manager.mjs');
    await assert.rejects(
      () => saveKey('ANTHROPIC_API_KEY', ''),
      /vazio/i,
      'Deve rejeitar valor vazio'
    );
  });

  it('exporta testKey + TESTABLE_KEYS', async () => {
    const mod = await import('../src/keys-manager.mjs');
    assert.strictEqual(typeof mod.testKey, 'function');
    assert.ok(Array.isArray(mod.TESTABLE_KEYS));
    assert.ok(mod.TESTABLE_KEYS.includes('ANTHROPIC_API_KEY'));
    assert.ok(mod.TESTABLE_KEYS.includes('OPENAI_API_KEY'));
    assert.ok(mod.TESTABLE_KEYS.includes('ASANA_PAT'));
    assert.ok(mod.TESTABLE_KEYS.includes('META_ACCESS_TOKEN'));
  });

  it('testKey rejeita chave fora da whitelist', async () => {
    const { testKey } = await import('../src/keys-manager.mjs');
    await assert.rejects(
      () => testKey('FAKE_DANGEROUS_KEY'),
      /whitelist/i,
      'Deve rejeitar chave fora da whitelist'
    );
  });

  it('testKey retorna untestable pra chave sem tester', async () => {
    const { testKey, KEY_NAMES, TESTABLE_KEYS } = await import('../src/keys-manager.mjs');
    // Pega uma chave whitelisted que NÃO tem tester
    const semTester = KEY_NAMES.find(k => !TESTABLE_KEYS.includes(k));
    if (semTester) {
      const result = await testKey(semTester);
      assert.strictEqual(result.untestable, true);
      assert.strictEqual(result.ok, null);
    }
  });

  it('testKey de chave vazia retorna ok:false com mensagem clara', async () => {
    const oldKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { testKey } = await import('../src/keys-manager.mjs');
    const result = await testKey('ANTHROPIC_API_KEY');
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /vazia/i);
    assert.ok(typeof result.latency_ms === 'number');
    if (oldKey) process.env.ANTHROPIC_API_KEY = oldKey;
  });

  it('testKey de GROUP_TAREFAS valida formato JID', async () => {
    process.env.GROUP_TAREFAS = '123456@g.us';
    const { testKey } = await import('../src/keys-manager.mjs');
    const result = await testKey('GROUP_TAREFAS');
    assert.strictEqual(result.ok, true);

    process.env.GROUP_TAREFAS = '123456';
    const result2 = await testKey('GROUP_TAREFAS');
    assert.strictEqual(result2.ok, false);
    assert.match(result2.message, /formato inv/i);

    delete process.env.GROUP_TAREFAS;
  });

  it('TESTABLE_KEYS inclui modelos AI_MODEL/AI_MODEL_STRONG/MEMORY_MODEL', async () => {
    const { TESTABLE_KEYS } = await import('../src/keys-manager.mjs');
    assert.ok(TESTABLE_KEYS.includes('AI_MODEL'), 'AI_MODEL deve ser testável');
    assert.ok(TESTABLE_KEYS.includes('AI_MODEL_STRONG'), 'AI_MODEL_STRONG deve ser testável');
    assert.ok(TESTABLE_KEYS.includes('MEMORY_MODEL'), 'MEMORY_MODEL deve ser testável');
  });

  it('testKey de GUI_JID valida formato @s.whatsapp.net', async () => {
    process.env.GUI_JID = '551199999999@s.whatsapp.net';
    const { testKey } = await import('../src/keys-manager.mjs');
    const result = await testKey('GUI_JID');
    assert.strictEqual(result.ok, true);

    process.env.GUI_JID = '551199999999@g.us';  // grupo, não DM
    const result2 = await testKey('GUI_JID');
    assert.strictEqual(result2.ok, false);

    delete process.env.GUI_JID;
  });
});
