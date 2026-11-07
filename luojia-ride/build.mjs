import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const home = readFileSync('dist/index.html', 'utf8');
const hash = tag => {
  const match = home.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  if (!match) throw new Error('Missing inline ' + tag);
  return "'sha256-" + createHash('sha256').update(match[1].replace(/\r\n?/g, '\n')).digest('base64') + "'";
};
const policy = [
  "default-src 'none'", "script-src " + hash('script'), "style-src " + hash('style'),
  "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"
].join('; ');
mkdirSync('dist/server', { recursive: true });
copyFileSync('worker/index.mjs', 'dist/server/index.js');
writeFileSync('dist/server/content.mjs', 'export const home = ' + JSON.stringify(home) +
  ';\nexport const policy = ' + JSON.stringify(policy) + ';\n');
