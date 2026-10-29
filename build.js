// Build script do Rumo — gera a pasta dist/ com todos os arquivos estáticos.
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Arquivos estáticos a copiar
const statics = ['index.html', 'favicon.png', 'privacidade.html', 'termos.html', 'blog.html'];

for (const file of statics) {
  const from = path.join(root, file);
  if (!fs.existsSync(from)) {
    // Não é fatal para arquivos opcionais
    if (file === 'index.html') { console.error('ERRO: index.html não encontrado.'); process.exit(1); }
    console.warn('Aviso: ' + file + ' não encontrado, pulando.');
    continue;
  }
  fs.copyFileSync(from, path.join(out, file));
}

console.log('Rumo static site built into dist/');
