// Prints a reviewable inventory; never modifies dependency files.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const meta = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml', '--filter-platform', 'x86_64-pc-windows-msvc'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const packages = meta.packages.filter(p => p.source).map(p => ({
  name: p.name, version: p.version, license: p.license, authors: p.authors, ecosystem: 'Cargo',
  source: `https://crates.io/api/v1/crates/${p.name}/${p.version}/download`,
  dir: path.dirname(p.manifest_path), licenseFile: p.license_file,
}));
const seen = new Set();
function addNpm(dir) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return;
  const real = fs.realpathSync(dir);
  if (seen.has(real)) return;
  seen.add(real);
  const p = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
  packages.push({ name: p.name, version: p.version, license: p.license, authors: p.author ? [p.author] : [], ecosystem: 'npm', dir: real,
    source: `https://registry.npmjs.org/${p.name}/-/${p.name.split('/').pop()}-${p.version}.tgz` });
}
for (const entry of fs.readdirSync('node_modules/.pnpm', { withFileTypes: true })) {
  const dir = path.join('node_modules/.pnpm', entry.name, 'node_modules');
  if (!entry.isDirectory() || !fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('@')) {
      for (const sub of fs.readdirSync(path.join(dir, name))) addNpm(path.join(dir, name, sub));
    } else addNpm(path.join(dir, name));
  }
}
function notices(dir, root = dir, depth = 0) {
  const result = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const file = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) result.push(...notices(file, root, depth + 1));
    else if (e.isFile() && /^(licen[sc]e|notice|copying|copyright|third.?party)([._-]|$)/i.test(e.name)) {
      result.push({ file: path.relative(root, file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'utf8') });
    }
  }
  return result;
}
const entries = packages.map(({ dir, licenseFile, ...p }) => {
  const texts = notices(dir);
  if (licenseFile && !texts.some(t => t.file === licenseFile)) texts.push({file: licenseFile, text: fs.readFileSync(path.resolve(dir, licenseFile), 'utf8')});
  if (!texts.length) {
    for (const file of fs.readdirSync(dir).filter(n => /^readme/i.test(n))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      if (/permission is hereby granted|redistribution and use|permission to use, copy/i.test(text)) texts.push({file, text});
    }
  }
  const supplemental = { 'alloc-stdlib': 'alloc-stdlib.txt', 'webview2-com': 'webview2.txt', 'webview2-com-sys': 'webview2.txt', 'webview2-com-macros': 'webview2.txt', saxes: 'saxes.txt' }[p.name];
  if (supplemental) texts.push({file: `upstream/${supplemental}`, text: fs.readFileSync(`licenses/upstream/${supplemental}`, 'utf8')});
  if (!texts.length && /Apache-2.0/.test(p.license)) texts.push({file: 'Apache-2.0 (selected license alternative)', text: fs.readFileSync('LICENSE', 'utf8').replace(/Copyright \(c\) 2026 SonSoft\s*$/, '')});
  if (!texts.length && p.name === 'selectors') {
    const sibling = packages.find(p => p.name === 'cssparser');
    texts.push(...notices(sibling.dir).filter(t => /Mozilla Public License/.test(t.text)));
  }
  if (!texts.length && p.name === '@rolldown/binding-win32-x64-msvc') {
    texts.push(...notices(packages.find(p => p.name === 'rolldown').dir));
  }
  if (p.name === 'stackback') {
    const header = fs.readFileSync(path.join(dir, 'formatstack.js'), 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n');
    texts.push({file:'formatstack.js copyright and license header',text:header});
    texts.push({file:'MIT (declared in package.json; attribution from author metadata)',text: fs.readFileSync('licenses/upstream/webview2.txt','utf8').replace('Copyright (c) 2021 Bill Avery','Copyright (c) Roman Shtylman')});
  }
  return { ...p, texts };
}).sort((a,b) => `${a.ecosystem}/${a.name}/${a.version}`.localeCompare(`${b.ecosystem}/${b.name}/${b.version}`));
if (process.argv.includes('--write')) {
  const missing = entries.filter(e => !e.texts.length || !e.license);
  if (missing.length) throw new Error(`Missing license data: ${missing.map(p => p.name).join(', ')}`);
  const unique = new Map();
  const inventory = entries.map(({texts,...p}) => ({...p, notices:texts.map(t => {
    const content = t.text.replaceAll('\r\n','\n');
    const hash = createHash('sha256').update(content).digest('hex');
    unique.set(hash, content);
    return {originalFile:t.file, file:`texts/${hash}.txt`};
  })}));
  fs.mkdirSync('licenses/texts', {recursive:true});
  for (const [hash,text] of unique) fs.writeFileSync(`licenses/texts/${hash}.txt`,text);
  fs.writeFileSync('licenses/dependencies.json',JSON.stringify(inventory,null,2)+'\n');
  const locks = Object.fromEntries(['Cargo.lock','pnpm-lock.yaml','src-tauri/Cargo.toml','package.json','scripts/license-inventory.mjs'].map(f => [f,createHash('sha256').update(fs.readFileSync(f,'utf8').replaceAll('\r\n','\n')).digest('hex')]));
  fs.writeFileSync('licenses/inputs.json',JSON.stringify(locks,null,2)+'\n');
  console.log(`Generated ${inventory.length} dependency entries and ${unique.size} distinct notice texts.`);
} else if (process.argv.includes('--summary')) {
  console.log(JSON.stringify({ count: entries.length, missing: entries.filter(e => !e.texts.length).map(({texts,...p}) => p), licenses: [...new Set(entries.map(e => JSON.stringify(e.license)))] }, null, 2));
} else if (process.argv.includes('--chunk')) {
  const start = Number(process.argv[process.argv.indexOf('--chunk') + 1]);
  process.stdout.write(JSON.stringify(entries).slice(start, start + 40000));
} else if (process.argv.includes('--length')) {
  console.log(JSON.stringify(entries).length);
} else if (process.argv.includes('--slice')) {
  const start = Number(process.argv[process.argv.indexOf('--slice') + 1]);
  console.log(JSON.stringify(entries.slice(start, start + 25)));
} else console.log(JSON.stringify(entries));
