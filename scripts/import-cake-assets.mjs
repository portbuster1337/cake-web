// One-time import of Cake Wallet's open-source (MIT) resources into public/,
// so the web client uses the same strings (all languages), icons, fonts, FAQ
// and legal texts as the official app.
//   node scripts/import-cake-assets.mjs [path/to/cake_wallet]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cake = process.argv[2] || path.join(root, '..', 'cake-refs', 'cake_wallet');
const pub = path.join(root, 'public');

function copyDir(src, dst, filter = () => true) {
  let n = 0;
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDir(s, d, filter);
    else if (filter(s)) {
      fs.copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

// 1. Localizations: res/values/strings_XX.arb -> public/locales/XX.json
const locDir = path.join(pub, 'locales');
fs.mkdirSync(locDir, { recursive: true });
const langs = [];
for (const f of fs.readdirSync(path.join(cake, 'res/values'))) {
  const m = /^strings_(\w+)\.arb$/.exec(f);
  if (!m) continue;
  const raw = JSON.parse(fs.readFileSync(path.join(cake, 'res/values', f), 'utf8'));
  const strings = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('@')));
  fs.writeFileSync(path.join(locDir, `${m[1]}.json`), JSON.stringify(strings));
  langs.push(m[1]);
}
// English is bundled into the app (src/core/strings_en.json) so the first paint never waits
fs.mkdirSync(path.join(root, 'src/core'), { recursive: true });
fs.copyFileSync(path.join(locDir, 'en.json'), path.join(root, 'src/core/strings_en.json'));
console.log('locales:', langs.join(' '));

// 2. Vector pictures (new UI): res/pictures/** -> public/cake/new-ui/**  (the app refers to them as assets/new-ui/…)
console.log('new-ui pictures:', copyDir(path.join(cake, 'res/pictures'), path.join(pub, 'cake/new-ui'), (f) => f.endsWith('.svg')));
// 3. Raster/vector images: assets/images/** -> public/cake/images/**
console.log('images:', copyDir(path.join(cake, 'assets/images'), path.join(pub, 'cake/images'), (f) => /\.(png|svg|jpg|jpeg|webp|gif)$/i.test(f) && !/(macos_icons|android_icon|_1024)/.test(f)));
// 4. Fonts
console.log('fonts:', copyDir(path.join(cake, 'assets/fonts'), path.join(pub, 'cake/fonts'), (f) => /WixMadeforText-VariableFont|IBMPlexMono-(Regular|Medium|SemiBold)\.ttf|OFL/i.test(f)));
// 5. FAQ + legal texts + changelog
console.log('faq:', copyDir(path.join(cake, 'assets/faq'), path.join(pub, 'cake/faq')));
console.log('text:', copyDir(path.join(cake, 'assets/text'), path.join(pub, 'cake/text')));
console.log('changelog:', copyDir(path.join(cake, 'assets/new-ui/changelog'), path.join(pub, 'cake/changelog')));
// 6. Node / server lists (yml), used to build src/coins/nodes.gen.ts
console.log('node lists:', copyDir(path.join(cake, 'assets'), path.join(root, 'scripts/cake-node-lists'), (f) => /(node_list|server_list)\.yml$/.test(f) && path.dirname(f) === path.join(cake, 'assets')));
fs.writeFileSync(path.join(pub, 'cake/LICENSE-cake-wallet.md'), fs.readFileSync(path.join(cake, 'LICENSE.md')));
