// Pulls Works / Series / CV / Site Texts from Notion into content/site.json
// and downloads work images into content/originals/.
// Needs NOTION_TOKEN (an internal integration with access to the "Artsokolova Site" page).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CONTENT = path.join(ROOT, 'content');
const ORIG = path.join(CONTENT, 'originals');
const DB = {
  works: '3a3d2574285440d682e04e432a9c5390',
  series: '586244ccda5443bd9fa92b077a3edc44',
  cv: '1f7e1cc50da347488e28b878a8e59915',
  texts: '8cd49d5c2a834a6fbf50d8b5d5847758',
};
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.log('NOTION_TOKEN not set — skipping sync, using committed content.'); process.exit(0); }

const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function notion(pathname, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.notion.com/v1/' + pathname, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
    return res.json();
  }
  throw new Error('Notion rate limit');
}
async function queryAll(id) {
  const out = []; let cursor;
  do {
    const r = await notion(`databases/${id}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out.filter(p => !p.archived && !p.in_trash);
}

// property readers
const P = (page, name) => page.properties[name];
const text = (page, name) => { const p = P(page, name); if (!p) return ''; const arr = p.title || p.rich_text || []; return arr.map(t => t.plain_text).join('').trim(); };
const num = (page, name) => P(page, name)?.number ?? null;
const sel = (page, name) => P(page, name)?.select?.name || '';
const box = (page, name) => !!P(page, name)?.checkbox;
const rel = (page, name) => (P(page, name)?.relation || []).map(r => r.id.replace(/-/g, ''));
const files = (page, name) => (P(page, name)?.files || []).map(f => ({ name: f.name, url: f.file?.url || f.external?.url })).filter(f => f.url);

// image download with a manifest so unchanged files aren't fetched twice
const manifestPath = path.join(CONTENT, 'images.json');
let manifest = {};
try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch {}
const used = new Set();
async function download(f, baseName) {
  const key = f.url.split('?')[0]; // S3 path is stable per uploaded file
  const ext = (path.extname(new URL(f.url).pathname) || path.extname(f.name) || '.jpg').toLowerCase().replace('.jpeg', '.jpg');
  const name = `${baseName}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
  used.add(name);
  if (manifest[key] === name) { try { await fs.access(path.join(ORIG, name + ext)); return name; } catch {} }
  const res = await fetch(f.url);
  if (!res.ok) { console.warn('image download failed', f.name, res.status); return null; }
  await fs.writeFile(path.join(ORIG, name + ext), Buffer.from(await res.arrayBuffer()));
  manifest[key] = name;
  console.log('downloaded', name + ext);
  return name;
}

async function main() {
  await fs.mkdir(ORIG, { recursive: true });
  let prev = { works: [], texts: {} };
  try { prev = JSON.parse(await fs.readFile(path.join(CONTENT, 'site.json'), 'utf8')); } catch {}
  const prevBySlug = Object.fromEntries((prev.works || []).map(w => [slugify(w.title), w]));

  const [seriesPages, workPages, cvPages, textPages] = await Promise.all([queryAll(DB.series), queryAll(DB.works), queryAll(DB.cv), queryAll(DB.texts)]);

  const seriesById = {};
  const series = seriesPages.map(p => {
    const s = { id: slugify(text(p, 'Name')), name: text(p, 'Name'), order: num(p, 'Order') ?? 99, ar: box(p, 'AR'), description: text(p, 'Description'), show: box(p, 'Show on site'), large: box(p, 'Large works') || undefined, menuLabel: text(p, 'Menu label') || undefined, hideInMenu: box(p, 'Hide in menu') || undefined };
    seriesById[p.id.replace(/-/g, '')] = s.id;
    return s;
  }).filter(s => s.name).sort((a, b) => a.order - b.order);

  const works = [];
  for (const p of workPages) {
    const title = text(p, 'Title'); if (!title) continue;
    const slug = slugify(title);
    const imgs = [];
    for (const [i, f] of files(p, 'Images').entries()) { const n = await download(f, `${slug}-${i + 1}`); if (n) imgs.push(n); }
    // Until photos are uploaded to Notion, keep the images the site already had.
    const images = imgs.length ? imgs : (prevBySlug[slug]?.images || []);
    images.forEach(n => used.add(n));
    works.push({
      title, slug, series: seriesById[rel(p, 'Series')[0]] || '', order: num(p, 'Order') ?? 99, year: num(p, 'Year'),
      size: text(p, 'Size (in)'), medium: text(p, 'Medium'), price: num(p, 'Price'), status: sel(p, 'Status') || 'Available',
      ar: box(p, 'AR'), note: text(p, 'Note'), show: box(p, 'Show on site'), shape: sel(p, 'Shape').toLowerCase() === 'round' ? 'round' : undefined, layout: ({ 'Auto': undefined, '4 in a row': 'grid4', 'Pair at edges': 'pair-wide', 'Pair right': 'pair-right', 'Single center': 'single', 'Three full width': 'trio-full', 'Three center': 'trio-center', 'One row center': 'row-center', 'Pairs staggered': 'stagger' })[sel(p, 'Layout')], joinPrev: box(p, 'Same row as previous') || undefined, images,
    });
  }

  const cv = cvPages.map(p => ({ section: sel(p, 'Section'), year: text(p, 'Year'), entry: text(p, 'Entry'), venue: text(p, 'Venue'), city: text(p, 'City'), show: box(p, 'Show on site') }))
    .filter(c => c.entry)
    .sort((a, b) => (parseInt(b.year.match(/\d{4}(?!.*\d{4})/)?.[0] || 0)) - (parseInt(a.year.match(/\d{4}(?!.*\d{4})/)?.[0] || 0)));

  // Site texts: key -> value
  const T = { ...prev.texts };
  const KEYS = { 'Intro': 'intro', 'About': 'about', 'Email': 'email', 'Instagram': 'instagram', 'Facebook': 'facebook', 'Artfinder': 'artfinder', 'CV link': 'cvUrl', 'Page title': 'title', 'Search description': 'metaDescription' };
  for (const p of textPages) {
    const key = text(p, 'Key'), val = text(p, 'Text');
    if (KEYS[key] !== undefined && val) T[KEYS[key]] = val;
    if (key === 'Hero photo' || key === 'About photo') {
      const f = files(p, 'Image')[0];
      if (f) { const n = await download(f, key === 'Hero photo' ? 'hero' : 'about'); if (n) T[key === 'Hero photo' ? 'heroImage' : 'aboutImage'] = n; }
    }
  }
  [T.heroImage, T.aboutImage, ...(T.arImages || [])].forEach(n => n && used.add(n));

  const site = { texts: T, series, works, cv };
  await fs.writeFile(path.join(CONTENT, 'site.json'), JSON.stringify(site, null, 2) + '\n');

  // drop originals nothing points to anymore
  for (const [k, v] of Object.entries(manifest)) if (!used.has(v)) delete manifest[k];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  for (const f of await fs.readdir(ORIG)) if (!used.has(f.replace(/\.[^.]+$/, ''))) { await fs.rm(path.join(ORIG, f)); console.log('removed', f); }

  console.log(`synced: ${series.length} series, ${works.length} works, ${cv.length} CV rows`);
}
main().catch(e => { console.error(e); process.exit(1); });
