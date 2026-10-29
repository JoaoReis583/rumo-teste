// Build script do Rumo — gera a pasta dist/ com todos os arquivos estáticos.
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Arquivos estáticos raiz
const statics = ['index.html', 'favicon.png', 'privacidade.html', 'termos.html', 'blog.html', 'login.html', 'registro.html', 'convite.html'];

for (const file of statics) {
  const from = path.join(root, file);
  if (!fs.existsSync(from)) {
    if (file === 'index.html') { console.error('ERRO: index.html não encontrado.'); process.exit(1); }
    console.warn('Aviso: ' + file + ' não encontrado, pulando.');
    continue;
  }
  fs.copyFileSync(from, path.join(out, file));
}

// Copia diretório de artigos recursivamente
const artigosIn  = path.join(root, 'artigos');
const artigosOut = path.join(out, 'artigos');
if (fs.existsSync(artigosIn)) {
  fs.mkdirSync(artigosOut, { recursive: true });
  for (const file of fs.readdirSync(artigosIn)) {
    if (file.endsWith('.html')) {
      fs.copyFileSync(path.join(artigosIn, file), path.join(artigosOut, file));
    }
  }
  console.log('Artigos copiados: ' + fs.readdirSync(artigosOut).length + ' arquivo(s).');
}

console.log('Rumo static site built into dist/');
