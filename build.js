const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Só o que o site precisa para funcionar vai para a pasta publicada.
for (const file of ['index.html']) {
  const from = path.join(root, file);
  if (!fs.existsSync(from)) {
    console.error('Arquivo não encontrado: ' + file);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(out, file));
}

console.log('Rumo static site built into dist/');
