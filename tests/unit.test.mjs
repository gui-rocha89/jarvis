// ============================================
// JARVIS 2.0 - Testes Unitários
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
