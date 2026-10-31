// Junta en cloud/public lo que sirve el Worker como archivos estáticos:
//   /            la web (React), compilada desde frontend/
//   /simulador/  el gemelo digital (server/simulador)
// Uso: npm run preparar   (con --sin-web se salta la compilación de la web)
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cloud = join(dirname(fileURLToPath(import.meta.url)), '..');
const raiz = join(cloud, '..');
const salida = join(cloud, 'public');

rmSync(salida, { recursive: true, force: true });
mkdirSync(salida, { recursive: true });

if (!process.argv.includes('--sin-web')) {
  const front = join(raiz, 'frontend');
  execSync(existsSync(join(front, 'node_modules')) ? 'npm run build' : 'npm ci && npm run build', { cwd: front, stdio: 'inherit' });
}
const web = join(raiz, 'server', 'web');
if (existsSync(web)) cpSync(web, salida, { recursive: true });
cpSync(join(raiz, 'server', 'simulador'), join(salida, 'simulador'), { recursive: true });
cpSync(join(cloud, 'estaticos', '_headers'), join(salida, '_headers'));
console.log('Listo: cloud/public');
