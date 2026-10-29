#!/usr/bin/env node
// Executa: node commit.js "mensagem do commit"
// Faz git add + commit + push automaticamente

const { execSync } = require('child_process');
const msg = process.argv[2] || 'chore: atualizacao';

try {
  const status = execSync('git status --porcelain', { encoding: 'utf8' });
  if (!status.trim()) {
    console.log('Nada para commitar. Tudo está atualizado!');
    process.exit(0);
  }
  console.log('Arquivos alterados:\n' + status);
  execSync('git add -A', { stdio: 'inherit' });
  execSync(`git commit -m "${msg.replace(/"/g, "'")}"`, { stdio: 'inherit' });
  execSync('git push', { stdio: 'inherit' });
  console.log('\n✅ Enviado para o GitHub com sucesso!');
} catch (e) {
  console.error('\n❌ Erro:', e.message);
  console.log('\nSe o push falhou por autenticação, configure o token:\n  git push https://JoaoReis583:SEU_TOKEN@github.com/JoaoReis583/rumo-teste.git main');
  process.exit(1);
}
