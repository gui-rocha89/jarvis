#!/usr/bin/env node
// ============================================
// JARVIS — bump-version
// Atualiza TODAS as referências de versão de uma vez.
//
// Uso:
//   node scripts/bump-version.mjs 7.0.0
//
// O que faz:
//  1. Lê versão antiga do package.json
//  2. Atualiza package.json + roda `npm install --package-lock-only` pra sincronizar package-lock.json
//  3. Substitui em todos os arquivos rastreados:
//     - Headers `// JARVIS X.Y - ...`
//     - Strings `JARVIS vX.Y` (display em logs/UI)
//     - Title HTML `JARVIS X.Y | Guardiao Lab`
//     - Badge HTML `vX.Y` (header dashboard)
//     - status `'Jarvis X.Y'` (overview)
//     - JARVIS_VERSION em src/config.mjs
//     - Comentário em .env.example, tests/unit.test.mjs
//     - dashboard-v2 sidebar
//     - mcp-server log
//
// O que NÃO faz (intencionalmente):
//  - NÃO mexe no CLAUDE.md changelog (referências históricas tipo "(NOVO v5.0)" são corretas)
//  - NÃO mexe em README "Destaques v5.0 (mantidos)" (histórico)
//  - NÃO mexe em packages do node_modules
// ============================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Versão alvo (vinda do CLI)
const TARGET = process.argv[2];
if (!TARGET || !/^\d+\.\d+\.\d+$/.test(TARGET)) {
  console.error('Uso: node scripts/bump-version.mjs <X.Y.Z>');
  console.error('Exemplo: node scripts/bump-version.mjs 7.0.0');
  process.exit(1);
}
const TARGET_MAJOR_MINOR = TARGET.split('.').slice(0, 2).join('.'); // "7.0"

// Lê versão atual do package.json
const PKG_PATH = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const CURRENT = pkg.version;
const CURRENT_MAJOR_MINOR = CURRENT.split('.').slice(0, 2).join('.');

console.log(`\n🔢 Bumping version: ${CURRENT} → ${TARGET}\n`);

// 1. package.json
pkg.version = TARGET;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
console.log('✅ package.json');

// 2. Lista de arquivos com substituições direcionadas
//    (caminho relativo, regex de busca, substituição)
const REPLACEMENTS = [
  // ==== Headers de módulos (// JARVIS X.Y - ...) ====
  { file: 'jarvis-v2.mjs', from: /\/\/ JARVIS \d+\.\d+ - Stream Lab AI Bot/g, to: `// JARVIS ${TARGET_MAJOR_MINOR} - Stream Lab AI Bot` },
  { file: 'jarvis-v2.mjs', from: /JARVIS v\d+\.\d+ - Stream Lab AI Bot/g, to: `JARVIS v${TARGET_MAJOR_MINOR} - Stream Lab AI Bot` },
  { file: 'jarvis-v2.mjs', from: /\*JARVIS v\d+\.\d+ — O que eu sei fazer\*/g, to: `*JARVIS v${TARGET_MAJOR_MINOR} — O que eu sei fazer*` },

  // ==== src/ headers ====
  ...[
    'src/config.mjs', 'src/database.mjs', 'src/memory.mjs', 'src/brain.mjs',
    'src/brain-document.mjs', 'src/audio.mjs', 'src/profiles.mjs', 'src/helpers.mjs',
    'src/batch-asana.mjs', 'src/asana-email-monitor.mjs', 'src/mcp-server.mjs',
    'src/health.mjs', 'src/knowledge-graph.mjs', 'src/contacts.mjs', 'src/task-copilot.mjs',
    'src/keys-manager.mjs',
    'src/channels/instagram.mjs', 'src/channels/email.mjs',
    'src/webhooks/asana-webhook.mjs',
    'src/skills/loader.mjs', 'src/skills/meta-ads.mjs',
  ].flatMap(f => [
    { file: f, from: /\/\/ JARVIS \d+\.\d+ -/g, to: `// JARVIS ${TARGET_MAJOR_MINOR} -` },
    { file: f, from: /\/\/ JARVIS \d+\.\d+\.\d+ -/g, to: `// JARVIS ${TARGET_MAJOR_MINOR} -` },
  ]),

  // ==== JARVIS_VERSION em config.mjs ====
  { file: 'src/config.mjs', from: /JARVIS_VERSION: '\d+\.\d+\.\d+'/g, to: `JARVIS_VERSION: '${TARGET}'` },

  // ==== mcp-server log ====
  { file: 'src/mcp-server.mjs', from: /Jarvis MCP Server v\d+\.\d+\.\d+ iniciado/g, to: `Jarvis MCP Server v${TARGET} iniciado` },

  // ==== .env.example header ====
  { file: '.env.example', from: /# JARVIS \d+\.\d+ - Variáveis de Ambiente/g, to: `# JARVIS ${TARGET_MAJOR_MINOR} - Variáveis de Ambiente` },

  // ==== tests header ====
  { file: 'tests/unit.test.mjs', from: /\/\/ JARVIS \d+\.\d+ - Testes Unitários/g, to: `// JARVIS ${TARGET_MAJOR_MINOR} - Testes Unitários` },

  // ==== dashboard v1 ====
  { file: 'dashboard/index.html', from: /<title>JARVIS \d+\.\d+ \| Guardiao Lab<\/title>/g, to: `<title>JARVIS ${TARGET_MAJOR_MINOR} | Guardiao Lab</title>` },
  { file: 'dashboard/index.html', from: /<span class="text-xs text-stark-dim font-mono">v\d+\.\d+<\/span>/g, to: `<span class="text-xs text-stark-dim font-mono">v${TARGET_MAJOR_MINOR}</span>` },
  { file: 'dashboard/index.html', from: /'Jarvis \d+\.\d+'/g, to: `'Jarvis ${TARGET_MAJOR_MINOR}'` },

  // ==== dashboard v2 ====
  { file: 'dashboard-v2/src/components/layout/sidebar.tsx', from: /v\d+\.\d+ Dashboard/g, to: `v${TARGET_MAJOR_MINOR} Dashboard` },
];

let totalChanges = 0;
for (const { file, from, to } of REPLACEMENTS) {
  const fp = path.join(ROOT, file);
  if (!fs.existsSync(fp)) continue;
  const content = fs.readFileSync(fp, 'utf8');
  if (!from.test(content)) {
    from.lastIndex = 0;
    continue;
  }
  from.lastIndex = 0;
  const newContent = content.replace(from, to);
  if (newContent !== content) {
    fs.writeFileSync(fp, newContent);
    const count = (content.match(from) || []).length;
    console.log(`✅ ${file} (${count} substituição${count > 1 ? 'ões' : ''})`);
    totalChanges += count;
  }
  from.lastIndex = 0;
}

// 3. Sincroniza package-lock.json
console.log('\n📦 Atualizando package-lock.json...');
try {
  execSync('npm install --package-lock-only --no-audit --no-fund', { cwd: ROOT, stdio: 'pipe' });
  console.log('✅ package-lock.json sincronizado');
} catch (e) {
  console.error('⚠️  Erro ao rodar npm install:', e.message);
}

// 4. Auditoria final — busca refs não pegas
// (skipa se idempotente — versão atual == alvo)
if (CURRENT === TARGET) {
  console.log('\n🔍 Auditoria final pulada (versão atual == alvo, idempotente)');
} else {
console.log('\n🔍 Auditoria final...');
const STALE_PATTERN = new RegExp(`JARVIS\\s+v?${CURRENT_MAJOR_MINOR}\\b|\\bv${CURRENT_MAJOR_MINOR}\\s+Dashboard|<title>JARVIS\\s+${CURRENT_MAJOR_MINOR}|'Jarvis\\s+${CURRENT_MAJOR_MINOR}'`, 'g');

function* walk(dir) {
  const SKIP = new Set(['node_modules', '.git', '.next', 'out', 'dashboard-v2/.next', 'dashboard-v2/out']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(mjs|js|ts|tsx|html|md|json|env|example)$/.test(entry.name) || entry.name === '.env.example') yield full;
  }
}

const stale = [];
for (const fp of walk(ROOT)) {
  // Pula CLAUDE.md changelog/changelog histórico e README "Destaques v5.0 (mantidos)" (refs históricas)
  if (fp.endsWith('CLAUDE.md') || fp.endsWith('README.md') || fp.includes('package-lock.json')) continue;
  try {
    const content = fs.readFileSync(fp, 'utf8');
    const matches = content.match(STALE_PATTERN);
    if (matches) stale.push({ file: path.relative(ROOT, fp), matches });
  } catch { /* ignora binários */ }
}

if (stale.length === 0) {
  console.log(`✅ Nenhuma referência stale encontrada\n`);
} else {
  console.log(`⚠️  ${stale.length} arquivo(s) com refs ainda apontando pra ${CURRENT_MAJOR_MINOR}:`);
  for (const s of stale) console.log(`   - ${s.file}: ${s.matches.join(', ')}`);
  console.log('   Revise manualmente se quer atualizar (podem ser refs históricas legítimas)\n');
}
} // fim do else (auditoria)

console.log(`\n🎯 ${totalChanges} substituições aplicadas`);
console.log(`📋 Próximos passos:`);
console.log(`   1. npm test`);
console.log(`   2. git diff (revise as mudanças)`);
console.log(`   3. git commit -am "chore: bump version ${CURRENT} → ${TARGET}"`);
console.log(`   4. git push origin <sua-branch>\n`);
