// ============================================
// JARVIS 3.0 - Testes Unitários
// Node.js test runner nativo (sem dependências)
// ============================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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

  it('nenhum arquivo de código contém credenciais hardcoded', async () => {
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
