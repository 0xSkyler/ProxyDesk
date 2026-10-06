'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const reachable = new Set();
function visit(file) {
    if (reachable.has(file)) return;
    reachable.add(file);
    const source = fs.readFileSync(file, 'utf8');
    new vm.Script(source, { filename: file });
    for (const [, specifier] of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
        if (specifier === 'electron' || require('node:module').isBuiltin(specifier)) continue;
        if (!specifier.startsWith('.')) throw new Error(`Unexpected production dependency: ${specifier}`);
        const base = path.resolve(path.dirname(file), specifier);
        const next = [base, `${base}.js`, path.join(base, 'index.js')].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (!next) throw new Error(`Missing import: ${file} -> ${specifier}`);
        visit(next);
    }
}
visit(path.join(root, 'src/main/main.js'));
visit(path.join(root, 'src/preload/preload.js'));
for (const file of files(path.join(root, 'src'))) {
    if (file.endsWith('.node')) throw new Error(`Unrebuilt native module: ${file}`);
}
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
for (const [, asset] of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) {
    if (!fs.existsSync(path.join(root, 'src/renderer', asset))) throw new Error(`Missing renderer asset: ${asset}`);
}
console.log(`Source check passed: ${reachable.size} reachable modules, zero external production dependencies.`);
