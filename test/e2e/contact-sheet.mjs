// Combines screenshots into one image: node test/e2e/contact-sheet.mjs <dir> <out.png> [cols] [files...]
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './launch.mjs';
const [dir, out, colsArg, ...only] = process.argv.slice(2);
const cols = Number(colsArg || 4);
const files = (only.length ? only : fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort()).map((f) => path.join(dir, f));
const imgs = files.map((f) => `<figure><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}"><figcaption>${path.basename(f)}</figcaption></figure>`).join('');
const html = `<html><body style="margin:0;background:#222;font:12px sans-serif;color:#ddd"><div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:6px">${imgs}</div><style>figure{margin:0}img{width:100%;display:block}figcaption{padding:2px}</style></body></html>`;
const b = await launch({ width: cols * 300, height: 800 });
const p = await b.newPage();
await p.setViewport({ width: cols * 300, height: 800 });
await p.setContent(html);
await p.screenshot({ path: out, fullPage: true });
await b.close();
console.log('wrote', out, files.length, 'images');
