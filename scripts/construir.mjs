// Copia a dist/ solo los archivos de la web (sin backend, node_modules ni recursos)
// para publicarla en Cloudflare Pages: npm run publicar-web
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const files = [
  'index.html', 'estilo.css', 'juego.js', 'textos.js', 'reglas.js', 'musica.js',
  ...readdirSync(root).filter((f) => /^compartir-\w+\.png$/.test(f)),
  'es/index.html', 'zh/index.html',
];

rmSync(dist, { recursive: true, force: true });
for (const file of files) {
  const from = join(root, file);
  if (!existsSync(from)) throw new Error(`Falta ${file}`);
  mkdirSync(dirname(join(dist, file)), { recursive: true });
  cpSync(from, join(dist, file));
}
console.log(`dist/ listo con ${files.length} archivos`);
