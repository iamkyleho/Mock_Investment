import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

await mkdir(new URL('../src/vendor/', import.meta.url), { recursive: true });
await build({
  stdin: { contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: process.cwd() },
  outfile: 'src/vendor/supabase.js', bundle: true, format: 'esm', platform: 'browser',
  target: ['es2022'], minify: true, legalComments: 'eof',
});
const license = await readFile(new URL('../node_modules/@supabase/supabase-js/LICENSE', import.meta.url), 'utf8');
await writeFile(new URL('../src/vendor/SUPABASE-LICENSE.txt', import.meta.url), license);
