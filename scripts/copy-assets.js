// Copies static renderer assets (html/css) into dist/renderer.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const out = path.join(root, 'dist', 'renderer');

fs.mkdirSync(out, { recursive: true });
for (const file of fs.readdirSync(src)) {
  if (file.endsWith('.html') || file.endsWith('.css') || file.endsWith('.svg')) {
    fs.copyFileSync(path.join(src, file), path.join(out, file));
  }
}
console.log('copy-assets: ok');
