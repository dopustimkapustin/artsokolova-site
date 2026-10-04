// Builds the static site from content/site.json + content/originals/* into dist/.
// Layout follows the Figma file "artsokolova.com" (frame Desktop - 18, 1440px).
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CONTENT = path.join(ROOT, 'content');
const DIST = path.join(ROOT, 'dist');
const WIDTHS = [480, 960, 1600, 2400];

const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const money = n => (n || n === 0) ? '$' + Number(n).toLocaleString('en-US') : '';
const dims = size => (size || '').toLowerCase().replace(/[хx×]/g, 'x').split('x').map(Number).filter(Boolean);

// ---------- images ----------
const imgCache = new Map();
let originals;
async function processImage(name) {
  if (!name) return null;
  if (imgCache.has(name)) return imgCache.get(name);
  originals ??= await fs.readdir(path.join(CONTENT, 'originals'));
  const file = originals.find(f => f.replace(/\.[^.]+$/, '') === name);
  if (!file) { console.warn('missing image', name); imgCache.set(name, null); return null; }
  const src = path.join(CONTENT, 'originals', file);
  const meta = await sharp(src).metadata();
  const rot = (meta.orientation || 1) >= 5;
  const w0 = rot ? meta.height : meta.width, h0 = rot ? meta.width : meta.height;
  const hash = (await import('node:crypto')).createHash('sha1').update(await fs.readFile(src)).digest('hex').slice(0, 8);
  const widths = [...new Set(WIDTHS.filter(w => w < w0).concat(w0 <= 2400 ? [w0] : [2400]))];
  const out = [];
  for (const w of widths) {
    const fn = `img/${name}-${hash}-${w}.webp`;
    const dest = path.join(DIST, fn);
    try { await fs.access(dest); } catch {
      await sharp(src).rotate().resize({ width: w }).toColourspace('srgb').webp({ quality: 84 }).toFile(dest);
    }
    out.push({ w, src: fn });
  }
  const res = { w: w0, h: h0, srcset: out.map(o => `${o.src} ${o.w}w`).join(', '), src: out[Math.min(1, out.length - 1)].src, large: out[out.length - 1].src };
  imgCache.set(name, res);
  return res;
}
const img = (im, alt, sizes, extra = '') => im ? `<img src="${im.src}" srcset="${im.srcset}" sizes="${sizes}" width="${im.w}" height="${im.h}" alt="${esc(alt)}" loading="lazy" decoding="async" ${extra}>` : '';

// ---------- layout logic ----------
// Each series is split into groups of consecutive works of the same size class
// (L = 36in+ on the long side, M = 17–35in, S = up to 16in). Each group gets one
// of the compositions used in the Figma design. A work can force a new group with
// a specific composition via its "layout" field (set in Notion).
function staggerWidth(data) {
  // equal-height trio across 1360 - 2*32: width of its first work
  for (const s of [...data.series].sort((a, b) => a.order - b.order)) {
    const ws = data.works.filter(w => w.series === s.id && w.show !== false && w.imgs?.length).sort((a, b) => a.order - b.order);
    const rows = groupWorks(ws);
    const r = rows.find(r => r.layout === 'trio-full' && r.items.length === 3);
    if (r) { const as = r.items.map(w => w.imgs[0].w / w.imgs[0].h); return (1360 - 64) / as.reduce((a, b) => a + b) * as[0]; }
  }
  return 385;
}
const LAYOUTS = ['grid4', 'pair-wide', 'pair-right', 'single', 'trio-full', 'trio-center', 'row-center', 'stagger'];
const sizeClass = size => { const d = Math.max(...dims(size), 0); return !d ? 'M' : d >= 36 ? 'L' : d <= 16 ? 'S' : 'M'; };
function autoLayout(cls, n) {
  if (n === 1) return 'single';
  if (n === 2) return cls === 'L' ? 'pair-wide' : 'pair-right';
  if (n === 3) return cls === 'L' ? 'trio-full' : 'trio-center';
  if (n === 4) return 'grid4';
  return cls === 'L' ? 'trio-full' : 'grid4';
}
// Split a group into rows without leaving a lonely last work.
function chunk(items, per) {
  const rows = [];
  for (let i = 0; i < items.length; i += per) rows.push(items.slice(i, i + per));
  const last = rows[rows.length - 1];
  if (rows.length > 1 && last.length === 1 && per > 2) { const prev = rows[rows.length - 2]; last.unshift(prev.pop()); }
  return rows;
}
function groupWorks(works) {
  const groups = [];
  for (const w of works) {
    const cls = sizeClass(w.size);
    const forced = LAYOUTS.includes(w.layout) ? w.layout : null;
    const last = groups[groups.length - 1];
    if (last && w.joinPrev) last.items.push(w);
    else if (last && !forced && last.cls === cls) last.items.push(w);
    else groups.push({ cls, forced, items: [w] });
  }
  const rows = [];
  for (const g of groups) {
    const layout = g.forced || autoLayout(g.cls, g.items.length);
    const per = { grid4: 4, 'pair-wide': 2, 'pair-right': 2, single: 1, 'trio-full': 3, 'trio-center': 3, 'row-center': 99, stagger: 2 }[layout];
    let si = 0;
    for (const items of chunk(g.items, per)) {
      if (layout === 'stagger') { rows.push({ layout, items, side: si++ % 2 ? 'right' : 'left' }); continue; }
      const l = items.length === per ? layout : items.length === 1 ? 'single' : layout === 'trio-full' ? 'pair-wide' : layout === 'trio-center' ? 'pair-right' : layout;
      rows.push({ layout: l, items });
    }
  }
  return rows;
}
const SIZES = { grid4: '(max-width: 900px) 50vw, 24vw', 'pair-wide': '(max-width: 900px) 100vw, 32vw', 'pair-right': '(max-width: 900px) 50vw, 23vw', single: '(max-width: 900px) 100vw, 33vw', 'trio-full': '(max-width: 900px) 100vw, 32vw', 'trio-center': '(max-width: 900px) 50vw, 22vw' };

// ---------- page ----------
async function build() {
  const data = JSON.parse(await fs.readFile(path.join(CONTENT, 'site.json'), 'utf8'));
  const T = data.texts;
  await fs.rm(path.join(DIST, 'index.html'), { force: true });
  await fs.mkdir(path.join(DIST, 'img'), { recursive: true });
  await fs.cp(path.join(ROOT, 'assets'), path.join(DIST, 'assets'), { recursive: true });
  const logoSvg = (await fs.readFile(path.join(ROOT, 'assets/svg/logo.svg'), 'utf8')).replace(/preserveAspectRatio="none" overflow="visible" style="display: block;" /, 'role="img" aria-label="Alëna Sokolova" ').replace(/fill="var\(--fill-0, black\)"/g, 'fill="currentColor"');
  const socialSvg = (await fs.readFile(path.join(ROOT, 'assets/svg/instagram.svg'), 'utf8')).replace(/preserveAspectRatio="none" overflow="visible" style="display: block;" /, 'aria-hidden="true" ');

  const series = data.series.filter(s => s.show !== false).sort((a, b) => a.order - b.order);
  for (const w of data.works) if (w.images?.length) { w.slug ||= slugify(w.title); w.imgs = (await Promise.all(w.images.map(processImage))).filter(Boolean); }
  const viewer = []; // flat list for the slideshow
  let worksHtml = '';
  for (const s of series) {
    const works = data.works.filter(w => w.series === s.id && w.show !== false && w.images?.length).sort((a, b) => a.order - b.order);
    for (const w of works) { w.slug ||= slugify(w.title); w.imgs = (await Promise.all(w.images.map(processImage))).filter(Boolean); }
    const rows = groupWorks(works.filter(w => w.imgs.length));
    if (!rows.length) continue;
    // A lone work after a row of smaller ones matches their height instead of
    // being blown up to full single-column width.
    const STAGGER_W = staggerWidth(data);
    const COLW = { grid4: 325, 'pair-wide': 427, 'pair-right': 310, single: 441, 'trio-center': 288 };
    rows.forEach((r, k) => {
      const prev = rows[k - 1];
      if (r.layout !== 'single' || !prev || !COLW[prev.layout]) return;
      const pim = prev.items[0].imgs[0], im = r.items[0].imgs[0];
      const prevH = COLW[prev.layout] * pim.h / pim.w;
      r.width = Math.min(441, prevH * im.w / im.h);
    });
    // Small works (up to 16in) after bigger ones in the same series are shown
    // at their real size relative to those (e.g. 14in next to 30in).
    rows.forEach((r, k) => {
      const prev = rows[k - 1];
      if (!prev || r.width || r.items[0].shape === 'round' || !COLW[prev.layout] || sizeClass(r.items[0].size) !== 'S' || sizeClass(prev.items[0].size) === 'S') return;
      const pim = prev.items[0].imgs[0], im = r.items[0].imgs[0];
      const prevH = COLW[prev.layout] * pim.h / pim.w;
      const ratio = Math.max(...dims(r.items[0].size)) / Math.max(...dims(prev.items[0].size));
      const H = prevH * ratio;
      r.itemWidth = H * (r.items[0].shape === 'round' ? 1 : im.w / im.h);
    });
    // Series marked "large" show every work at the width of Balance 01.
    if (s.large) rows.forEach(r => { if (r.layout !== 'trio-full') { r.width = 0; r.itemWidth = STAGGER_W; } });
    worksHtml += `<section class="series" id="${s.id}" aria-label="${esc(s.name)}">` + rows.map(r => `<div class="row ${r.layout}${r.side ? ' ' + r.side : ''}${(r.itemWidth && r.itemWidth < 250) || (r.width && r.width < 250) ? ' compact' : ''}">` + r.items.map(w => {
      const i = viewer.length, im = w.imgs[0];
      const sold = w.status === 'Sold';
      viewer.push({ slug: w.slug, title: w.title, year: w.year, size: w.size, medium: w.medium, note: w.note || '', price: !sold && w.status === 'Available' ? money(w.price) : '', sold, imgs: w.imgs.map(x => ({ src: x.large, w: x.w, h: x.h })) });
      const rc = r.layout === 'row-center' ? (() => { const f = r.items[0].imgs[0]; const H = 288 * f.h / f.w; return ` style="width:${u(H * im.w / im.h)}"`; })() : '';
      const flex = r.layout === 'stagger' ? ` style="width:${u(STAGGER_W)}"` : rc ? rc : r.width ? ` style="width:${u(r.width)}"` : r.itemWidth ? ` style="width:${u(r.itemWidth)}"` : r.layout === 'trio-full' ? ` style="flex:${(w.shape === 'round' ? 1 : im.w / im.h).toFixed(4)} 1 0"` : '';
      return `<figure class="work reveal" id="${w.slug}"${flex}>
  <button class="pic${w.shape === 'round' ? ' round' : ''}" data-i="${i}" aria-label="Open ${esc(w.title)}" style="aspect-ratio:${w.shape === 'round' ? '1/1' : im.w + '/' + im.h}">${img(im, `${w.title}, ${w.year || ''}`, SIZES[r.layout])}</button>
  <figcaption><div class="cap-l"><p class="t">${esc(w.title)}</p>${!sold && w.status === 'Available' && w.price ? `<p class="t">${money(w.price)}</p>` : ''}${sold ? '<p class="sold"><span class="dot"></span>Sold</p>' : ''}</div><div class="cap-r"><p>${esc(w.size ? w.size + ' in' : '')}</p><p>${esc(w.medium)}</p>${w.note ? `<p>${esc(w.note)}</p>` : ''}</div></figcaption>
</figure>`;
    }).join('') + `</div>`).join('') + `</section>`;
  }

  const hero = await processImage(T.heroImage);
  const about = await processImage(T.aboutImage);
  const ar = await processImage(T.arImage);
  const year = new Date().getFullYear();
  const jsonld = { '@context': 'https://schema.org', '@type': 'Person', name: 'Alena Sokolova', jobTitle: 'Painter', url: 'https://artsokolova.com', email: T.email, address: { '@type': 'PostalAddress', addressLocality: 'Boston', addressRegion: 'MA' }, sameAs: [T.instagram, T.facebook, T.artfinder].filter(Boolean) };
  const mail = `mailto:${esc(T.email)}`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(T.title)}</title>
<meta name="description" content="${esc(T.metaDescription)}">
<meta property="og:title" content="${esc(T.title)}">
<meta property="og:description" content="${esc(T.metaDescription)}">
${hero ? `<meta property="og:image" content="${hero.large}">` : ''}
<link rel="preload" href="assets/fonts/PPTelegraf-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="assets/fonts/PPWriter-BookItalic.woff2" as="font" type="font/woff2" crossorigin>
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="wrap top-row">
    <nav><a href="#work">Work</a><a href="#about">About</a><a href="#contact">Contact</a></nav>
    <a class="mail" href="${mail}">${esc(T.email)}</a>
  </div>
  <div class="wrap line"></div>
</header>

<section class="hero">
  <h1 class="logo">${logoSvg}</h1>
  <p class="intro">${esc(T.intro)}</p>
  <div class="hero-photo">${img(hero, 'Alena Sokolova in her studio', '(max-width: 900px) 100vw, 52vw', 'fetchpriority="high" loading="eager"')}</div>
  <a class="touch" href="${mail}"><span>Get in<br>touch</span></a>
</section>

<main class="wrap">
  <section class="ar" id="ar" aria-label="AR Experience">
    <div class="ar-pin">
      <div class="ar-stage">
        <div class="ar-3d"><iframe data-src="${esc(T.splineUrl || 'https://my.spline.design/buterfliesdesktopcopy-WeVWnXqP8g8xECApmB7JiAVJ/')}" data-src-mobile="${esc(T.splineUrlMobile || 'https://my.spline.design/buterfliesmobile-vQu7VkJi1QRvhTH2sEvEQbhD/')}" title="3D artwork" frameborder="0" allow="autoplay; fullscreen"></iframe></div>
        ${['ladybugs','butterflies','dragonflies','balance'].map((n,i)=>`<div class="ar-dot d${i+1}"><video src="assets/video/ar-${n}.mp4" poster="assets/video/ar-${n}.jpg" muted loop playsinline preload="none" aria-hidden="true"></video></div>`).join('')}
      </div>
      <h2 class="h">AR Experience</h2>
    </div>
  </section>
  <div class="work-head" id="work"><h2 class="h"><span>Work</span></h2></div>
  <div class="works">${worksHtml}</div>

  <section class="about" id="about">
    <div class="about-photo reveal">${img(about, 'Alena Sokolova', '(max-width: 900px) 80vw, 30vw')}</div>
    <div class="about-text">
      <h2 class="h">About</h2>
      <div class="about-p">${T.about.split(/\n\s*\n/).map(p => `<p class="reveal">${esc(p)}</p>`).join('')}</div>
      <div class="btns"><a class="btn" href="${mail}">Get in touch</a>${T.cvUrl ? `<a class="btn" href="${esc(T.cvUrl)}" target="_blank" rel="noopener">Get CV</a>` : ''}</div>
    </div>
  </section>

  <footer id="contact">
    <div class="line"></div>
    <div class="foot">
      <p class="copy">© ${year} — Alena Sokolova</p>
      <span class="social">${socialSvg}${T.instagram ? `<a class="ig" href="${esc(T.instagram)}" target="_blank" rel="noopener" aria-label="Instagram"></a>` : ''}${T.facebook ? `<a class="fb" href="${esc(T.facebook)}" target="_blank" rel="noopener" aria-label="Facebook"></a>` : ''}</span>
      <a class="mail" href="${mail}">${esc(T.email)}</a>
    </div>
  </footer>
</main>

<div class="cursor" aria-hidden="true">View work</div>
<div class="lb" hidden role="dialog" aria-modal="true" aria-label="Artwork viewer">
  <button class="lb-x" aria-label="Close">Close</button>
  <button class="lb-prev" aria-label="Previous">←</button>
  <div class="lb-stage"><img alt=""></div>
  <button class="lb-next" aria-label="Next">→</button>
  <div class="lb-cap"><div><p class="t"></p><p class="pr"></p></div><p class="m"></p><a class="btn inq" href="#">Inquire</a></div>
</div>

<script>window.WORKS=${JSON.stringify(viewer)};window.EMAIL=${JSON.stringify(T.email)};</script>
<script>${JS}</script>
</body>
</html>`;
  await fs.writeFile(path.join(DIST, 'index.html'), html);
  // demo pages (e.g. hover-demo.html): IMG -> a real artwork image
  try { const demo = await fs.readFile(path.join(ROOT, 'pages/hover-demo.html'), 'utf8'); const im = await processImage('twelve-months-1'); await fs.writeFile(path.join(DIST, 'hover-demo.html'), demo.replaceAll('IMG', im.large)); } catch {}
  console.log(`built: ${viewer.length} works, ${imgCache.size} images`);
}

// u(x): a Figma pixel value (1440px frame) that scales with the viewport.
const u = x => `min(${(x / 14.4).toFixed(4)}vw, ${(x * 1.2).toFixed(1)}px)`;

const CSS = String.raw`
@font-face{font-family:Telegraf;src:url(assets/fonts/PPTelegraf-Regular.woff2) format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:Writer;src:url(assets/fonts/PPWriter-BookItalic.woff2) format('woff2');font-style:italic;font-weight:300;font-display:swap}
:root{--wrap:${u(1360)};--ink:#000;--ink2:#333;--red:#ff0749;--dot:#ff0000;--sans:Telegraf,Helvetica,Arial,sans-serif;--serif:Writer,'Times New Roman',serif;--ease:cubic-bezier(.2,.7,.1,1)}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;scroll-padding-top:${u(80)}}
body{font-family:var(--sans);color:var(--ink);background:#fff;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}
img{display:block;max-width:100%;height:auto}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.wrap{width:var(--wrap);margin:0 auto}
.line{height:1px;background:var(--ink)}
.top .line{opacity:.15}
.mail{font-size:${u(16)};text-decoration:underline;text-underline-offset:.15em;text-decoration-thickness:1px}
.mail:hover{color:var(--red)}
.h{font-family:var(--serif);font-style:italic;font-weight:300;font-size:${u(36)};line-height:1.35;text-transform:uppercase;text-align:center}

/* header */
.top{position:fixed;inset:0 0 auto;z-index:30;background:#fff;padding-top:${u(20)}}
.top-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:${u(20)}}
.top nav{display:flex;gap:${u(44)};font-size:${u(15)};line-height:1.35;text-transform:uppercase}
.top nav a,.top .mail{transition:opacity .18s}.top nav a:hover,.top .mail:hover{opacity:.45;color:inherit}

/* hero */
.hero{position:relative;height:${u(802)}}
.logo{position:absolute;left:${u(40)};top:${u(109)};width:${u(543)};line-height:0;color:var(--ink)}
.logo svg{width:100%;height:auto;overflow:visible}
.intro{position:absolute;left:${u(40)};top:${u(639)};width:${u(427)};font-size:${u(21)};line-height:1.45}
.hero-photo{position:absolute;left:calc(50% - ${u(20)});top:${u(60)};right:0;height:${u(742)};overflow:hidden;background:#eee}
.hero-photo img{width:100%;height:100%;object-fit:cover;object-position:50% 0}
.touch{position:absolute;left:calc(33.333% + ${u(104)});top:${u(557)};width:${u(187)};height:${u(187)};color:#fff;display:flex;align-items:center;justify-content:center;transform:rotate(-8deg);z-index:2}
.touch::before{content:'';position:absolute;inset:0;border-radius:50%;background:var(--red);transition:transform .45s var(--ease)}
.touch span{position:relative;font-family:var(--serif);font-style:italic;font-size:${u(30.2)};line-height:1.12;text-transform:uppercase;text-align:center}
.touch:hover::before{transform:scale(1.1)}

/* AR */
.ar{position:relative;height:220vh;margin-top:${u(40)}}
.ar-pin{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${u(32)};padding-top:${u(60)}}
.ar-stage{position:relative;width:${u(1191)};height:${u(560)}}
.ar-3d{position:absolute;left:50%;top:50%;width:${u(560)};height:${u(560)};transform:translate(-50%,-50%) scale(calc(.85 + .15*var(--c,0)));opacity:var(--c,0)}
.ar-3d iframe{width:100%;height:100%;border:0;display:block}
.ar-dot{position:absolute;width:${u(210)};height:${u(210)};border-radius:50%;overflow:hidden;background:#f2f2f2;opacity:var(--t,0);transform:translate(calc((1 - var(--t,0)) * var(--dx)),calc((1 - var(--t,0)) * var(--dy))) scale(calc(.4 + .6*var(--t,0)))}
.ar-dot video{width:100%;height:100%;object-fit:cover;display:block}
.ar-dot.d1{left:${u(20)};top:${u(10)};--dx:${u(260)};--dy:${u(120)}}
.ar-dot.d2{left:${u(110)};top:${u(330)};--dx:${u(200)};--dy:${u(-60)}}
.ar-dot.d3{right:${u(20)};top:${u(10)};--dx:${u(-260)};--dy:${u(120)}}
.ar-dot.d4{right:${u(110)};top:${u(330)};--dx:${u(-200)};--dy:${u(-60)}}
@media (prefers-reduced-motion:reduce){.ar{height:auto}.ar-pin{position:relative;height:auto;padding:${u(120)} 0 0}.ar-3d,.ar-dot{--t:1!important;--c:1!important}}

/* WORK label */
.work-head{position:relative;height:${u(107)};display:flex;align-items:flex-end;justify-content:center;margin-top:${u(100)};pointer-events:none}


/* works */
.works{display:flex;flex-direction:column;gap:${u(160)};margin-top:${u(100)}}
.series{display:flex;flex-direction:column;gap:${u(160)}}
.row{display:flex;align-items:flex-start;gap:${u(20)}}
.row.grid4{gap:${u(20)};flex-wrap:wrap;row-gap:${u(32)}}
.row.grid4 .work{width:${u(325)}}
.series .row.grid4+.row.grid4{margin-top:${u(-128)}}
.row.pair-wide{justify-content:space-between}
.row.pair-wide .work{width:${u(427)}}
.row.single{justify-content:center}
.row.single .work{width:${u(441)}}
.row.single figcaption{gap:${u(88)}}
.row.pair-right{justify-content:flex-end;gap:${u(32)}}
.row.pair-right .work{width:${u(310)}}
.row.trio-full{gap:${u(32)}}
.row.trio-full .work{flex:1 1 0}
.row.trio-center{justify-content:center;gap:${u(32)}}
.row.trio-center .work{width:${u(288)}}
.row.row-center{justify-content:center;gap:${u(32)}}
.row.stagger{gap:${u(32)}}.row.stagger.right{justify-content:flex-end}
.row.trio-center.wide,.row.pair-right.wide{gap:${u(32)}}
.row.compact figcaption{flex-direction:column;gap:${u(6)}}.row.compact .cap-r{text-align:left;max-width:none}
.work{display:flex;flex-direction:column;gap:${u(16)}}
.pic{display:block;width:100%;overflow:hidden;cursor:zoom-in;background:#f3f3f3}
.pic{position:relative;border-radius:0;transition:border-radius .55s var(--ease)}.pic img{width:100%;height:100%;object-fit:cover;transition:transform .9s var(--ease)}
.pic:hover{border-radius:${u(18)}}
.pic.round,.pic.round:hover{border-radius:50%;background:transparent}.pic:hover img{transform:scale(1.03)}
@media (hover:hover) and (pointer:fine){.pic{cursor:none}}
.cursor{position:fixed;left:0;top:0;z-index:40;pointer-events:none;padding:${u(8)} ${u(18)} ${u(7)};border:1px solid #000;border-radius:999px;background:#000;color:#fff;font-size:${u(12)};letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;line-height:1;opacity:0;transform:translate(-50%,-50%) scale(.6);transition:opacity .25s,transform .35s var(--ease)}
.cursor.on{opacity:1;transform:translate(-50%,-50%) scale(1)}
figcaption{display:flex;justify-content:space-between;align-items:flex-start;gap:${u(16)};font-size:${u(14)};line-height:1.35;color:var(--ink2)}
.cap-l{display:flex;flex-direction:column;gap:${u(4)};min-width:0}
.cap-l .t{font-family:var(--serif);font-style:italic}
.sold{display:flex;align-items:center;gap:${u(6)};margin-top:${u(2)};font-size:${u(12)};letter-spacing:.06em;text-transform:uppercase;color:var(--dot)}
.dot{display:block;width:${u(9)};height:${u(9)};border-radius:50%;background:var(--dot);flex-shrink:0}
.cap-r{display:flex;flex-direction:column;gap:${u(4)};text-align:right;opacity:.3;flex-shrink:0;max-width:60%}

/* about */
.about{position:relative;display:grid;grid-template-columns:${u(116)} ${u(426)} 1fr;margin-top:${u(120)};min-height:${u(569)}}
.about-photo{grid-column:2;height:${u(569)};border-radius:${u(228.5)};overflow:hidden;background:#eee}
.about-photo img{width:100%;height:100%;object-fit:cover;object-position:50% 100%}
.about-text{grid-column:3;margin-left:${u(159)};width:${u(543)};display:flex;flex-direction:column;gap:${u(44)}}
.about-text .h{text-align:left}
.about-p{display:flex;flex-direction:column;gap:${u(22)};font-size:${u(18)};line-height:1.35}
.btns{display:flex;gap:${u(10)};margin-top:${u(20)}}
.btn{display:inline-flex;align-items:center;justify-content:center;width:${u(155)};height:${u(32)};border-radius:${u(12)};background:#000;color:#fff;font-size:${u(12)};text-transform:uppercase;line-height:1;transition:background .3s}
.btn{border:1px solid #000}.btn:hover{background:#fff;color:#000}

/* footer */
footer{margin-top:${u(120)};padding-bottom:${u(20)};display:flex;flex-direction:column;gap:${u(20)}}
.foot{display:flex;align-items:flex-end;justify-content:space-between}
.copy{font-size:${u(16)};opacity:.3;width:${u(326)}}
.social{position:relative;display:block;width:${u(37.6)};height:${u(16)}}
.social svg{width:100%;height:100%}
.social a{position:absolute;top:0;bottom:0}
.social .ig{left:0;width:45%}.social .fb{right:0;width:35%}
.social:hover svg{opacity:.6}

/* reveal animation */
.reveal{opacity:0;transform:translateY(40px);transition:opacity 1s var(--ease),transform 1.2s var(--ease)}
.reveal.in{opacity:1;transform:none}
.js-off .reveal{opacity:1;transform:none}
.hero .logo path{transform:translateY(30px);opacity:0;animation:up 1.2s var(--ease) .15s forwards}
.intro{opacity:0;animation:fade 1.2s var(--ease) .6s forwards}
.hero-photo img{transform:scale(1.08);animation:settle 2.2s var(--ease) forwards}
.touch{opacity:0;animation:pop .9s var(--ease) .9s forwards}
@keyframes up{to{transform:none;opacity:1}}
@keyframes fade{to{opacity:1}}
@keyframes settle{to{transform:scale(1)}}
@keyframes pop{from{opacity:0;transform:rotate(-30deg) scale(.6)}to{opacity:1;transform:rotate(-8deg) scale(1)}}
@media (prefers-reduced-motion:reduce){.reveal,.hero .logo path,.intro,.hero-photo img,.touch{animation:none!important;opacity:1!important;transform:none!important}.touch{transform:rotate(-8deg)!important}}

/* viewer */
.lb{position:fixed;inset:0;z-index:50;background:#fff;display:grid;grid-template-columns:80px 1fr 80px;grid-template-rows:1fr auto}
.lb[hidden]{display:none}
.lb-stage{grid-column:2;display:flex;align-items:center;justify-content:center;padding:70px 0 20px;min-height:0}
.lb-stage img{max-height:100%;max-width:100%;width:auto;height:auto;object-fit:contain}
.lb-prev,.lb-next{font-size:28px;align-self:center}
.lb-prev{grid-column:1;grid-row:1}.lb-next{grid-column:3;grid-row:1}
.lb-x{position:absolute;top:20px;right:40px;font-size:15px;text-transform:uppercase}
.lb-prev:hover,.lb-next:hover,.lb-x:hover{color:var(--red)}
.lb-cap{grid-column:2;display:flex;justify-content:space-between;align-items:flex-end;gap:20px;padding:12px 0 30px;font-size:14px;color:var(--ink2)}
.lb-cap .t,.lb-cap .pr{font-family:var(--serif);font-style:italic;font-size:16px}
.lb-cap .m{opacity:.4;flex:1;text-align:right}
.lb-cap .btn{width:auto;padding:0 18px;font-size:12px;height:32px;border-radius:12px}

/* mobile */
@media (max-width:900px){
  :root{--wrap:calc(100vw - 32px)}
  .mail{font-size:14px}
  .h{font-size:28px}
  .top{padding-top:14px}.top-row{margin-bottom:14px}.top nav{gap:22px;font-size:13px}
  .top .mail{font-size:13px}
  .hero{height:auto;min-height:700px;padding:86px 16px 32px}
  .logo{position:relative;left:0;top:0;width:88%;z-index:3}
  .intro{position:relative;left:0;top:0;width:100%;margin-top:400px;font-size:15px;z-index:3}
  .top .mail{display:none}
  .hero-photo{top:220px;left:auto;right:0;width:75%;height:340px}
  .touch{left:56%;top:462px;width:104px;height:104px}
  .touch span{font-size:16px}
  .ar{height:180vh;margin-top:24px}
  .ar-pin{gap:20px;padding-top:40px}
  .ar-stage{width:100%;height:min(120vw,560px)}
  .ar-3d{width:78vw;height:78vw}
  .ar-dot{width:26vw;height:26vw}
  .ar-dot.d1{left:0;top:0;--dx:20vw;--dy:20vw}.ar-dot.d3{right:0;top:0;--dx:-20vw;--dy:20vw}
  .ar-dot.d2{left:0;top:auto;bottom:0;--dx:20vw;--dy:-20vw}.ar-dot.d4{right:0;top:auto;bottom:0;--dx:-20vw;--dy:-20vw}
  .work-head{height:64px;margin-top:56px}
  .works,.series{gap:64px}
  .works{margin-top:40px}
  .row,.row.grid4,.row.pair-right,.row.trio-full,.row.trio-center,.row.row-center,.row.stagger{flex-wrap:wrap;gap:28px 12px;justify-content:space-between}
  .series .row.grid4+.row.grid4{margin-top:-36px}
  .row.grid4 .work,.row.pair-right .work,.row.trio-center .work,.row.row-center .work{width:calc(50% - 6px)!important}
  .row.pair-wide .work,.row.single .work,.row.trio-full .work{width:100%;flex:none}
  .row.stagger .work{width:calc(50% - 6px)!important}
  .row.single figcaption{gap:16px}
  .work{gap:10px}
  figcaption{font-size:12px;flex-direction:column;gap:4px}
  .cap-r{text-align:left;max-width:none}
  .row.pair-wide figcaption,.row.single figcaption,.row.trio-full figcaption{flex-direction:row;font-size:13px}
  .row.pair-wide .cap-r,.row.single .cap-r,.row.trio-full .cap-r{text-align:right}
  .dot{width:8px;height:8px}
  .about{display:flex;flex-direction:column;gap:36px;margin-top:80px}
  .about-photo{width:72%;height:auto;aspect-ratio:426/569;border-radius:999px;align-self:center}
  .about-text{margin:0;width:100%;gap:24px}
  .about-p{font-size:16px;gap:16px}
  .btns{margin-top:8px}.btn{width:150px;height:36px;font-size:12px;border-radius:12px}
  footer{margin-top:72px;gap:16px}
  .foot{flex-wrap:wrap;gap:14px;align-items:center}
  .copy{width:auto;font-size:13px;order:3;flex-basis:100%}
  .social{width:38px;height:16px}
  .lb{grid-template-columns:1fr}.lb-stage{grid-column:1;padding:56px 12px 10px}.lb-prev,.lb-next{display:none}
  .lb-x{right:16px;top:16px}
  .lb-cap{grid-column:1;flex-wrap:wrap;padding:10px 16px 24px}.lb-cap .m{flex-basis:100%;order:3;text-align:left}
}`;

const JS = String.raw`
(()=>{
// reveal on scroll
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{rootMargin:'0px 0px -8% 0px'});
document.querySelectorAll('.reveal').forEach((el,i)=>{const row=el.parentElement;const k=row?[...row.children].indexOf(el):0;el.style.transitionDelay=(k*0.08)+'s';io.observe(el)});
// AR: scroll-driven appearance of the 3D piece and the video circles
const ar=document.querySelector('.ar');
if(ar){const c3=ar.querySelector('.ar-3d'),ifr=ar.querySelector('iframe'),dots=[...ar.querySelectorAll('.ar-dot')],vids=dots.map(d=>d.querySelector('video'));
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){if(!ifr.src)ifr.src=matchMedia('(max-width: 900px)').matches?ifr.dataset.srcMobile:ifr.dataset.src;vids.forEach(v=>v.play().catch(()=>{}))}else vids.forEach(v=>v.pause())}),{rootMargin:'300px 0px'}).observe(ar);
  const cl=x=>Math.max(0,Math.min(1,x)),ease=x=>1-Math.pow(1-x,3);
  let tick=false;function upd(){tick=false;const r=ar.getBoundingClientRect(),vh=innerHeight;const p=reduce?1:cl((vh-r.top)/(r.height));
    c3.style.setProperty('--c',ease(cl((p-.12)/.25)));
    dots.forEach((d,i)=>d.style.setProperty('--t',ease(cl((p-.3-i*.07)/.22))))}
  addEventListener('scroll',()=>{if(!tick){tick=true;requestAnimationFrame(upd)}},{passive:true});addEventListener('resize',upd);upd()}
// hover label that follows the cursor (Haus-style)
const cur=document.querySelector('.cursor');
if(cur&&matchMedia('(hover: hover) and (pointer: fine)').matches){let x=0,y=0,cx=0,cy=0,raf=0;
  addEventListener('mousemove',e=>{x=e.clientX;y=e.clientY;if(!raf)raf=requestAnimationFrame(move)},{passive:true});
  function move(){cx+=(x-cx)*.25;cy+=(y-cy)*.25;cur.style.left=cx+'px';cur.style.top=cy+'px';raf=(Math.abs(x-cx)+Math.abs(y-cy)>.5)?requestAnimationFrame(move):0}
  document.querySelectorAll('.pic').forEach(p=>{p.addEventListener('mouseenter',e=>{cx=x=e.clientX;cy=y=e.clientY;move();cur.classList.add('on')});p.addEventListener('mouseleave',()=>cur.classList.remove('on'))})}
// slideshow
const W=window.WORKS,lb=document.querySelector('.lb'),im=lb.querySelector('.lb-stage img'),t=lb.querySelector('.lb-cap .t'),pr=lb.querySelector('.lb-cap .pr'),m=lb.querySelector('.lb-cap .m'),inq=lb.querySelector('.inq');let i=0,j=0;
function show(){const w=W[i],x=w.imgs[j];im.src=x.src;im.width=x.w;im.height=x.h;im.alt=w.title;t.textContent=w.title+(w.year?', '+w.year:'');pr.textContent=w.sold?'Sold':w.price;m.textContent=[w.size&&w.size+' in',w.medium,w.note].filter(Boolean).join(' · ');inq.style.display=w.sold?'none':'';inq.href='mailto:'+window.EMAIL+'?subject='+encodeURIComponent('Inquiry: '+w.title);history.replaceState(null,'','#'+w.slug);const n=W[(i+1)%W.length];if(n){new Image().src=n.imgs[0].src}}
function open(k){i=k;j=0;lb.hidden=false;document.body.style.overflow='hidden';show()}
function close(){lb.hidden=true;document.body.style.overflow='';history.replaceState(null,'',location.pathname);document.getElementById(W[i].slug)?.scrollIntoView({block:'center'})}
function step(d){const w=W[i];if(j+d>=0&&j+d<w.imgs.length)j+=d;else{i=(i+d+W.length)%W.length;j=d>0?0:W[i].imgs.length-1}show()}
document.querySelectorAll('.pic').forEach(b=>b.addEventListener('click',()=>open(+b.dataset.i)));
lb.querySelector('.lb-x').onclick=close;lb.querySelector('.lb-prev').onclick=()=>step(-1);lb.querySelector('.lb-next').onclick=()=>step(1);
lb.querySelector('.lb-stage').onclick=e=>{if(e.target===e.currentTarget)close()};
addEventListener('keydown',e=>{if(lb.hidden)return;if(e.key==='Escape')close();if(e.key==='ArrowRight')step(1);if(e.key==='ArrowLeft')step(-1)});
let x0=null;lb.addEventListener('touchstart',e=>x0=e.touches[0].clientX,{passive:true});lb.addEventListener('touchend',e=>{if(x0===null)return;const dx=e.changedTouches[0].clientX-x0;if(Math.abs(dx)>50)step(dx<0?1:-1);x0=null});
const h=location.hash.slice(1),k=W.findIndex(w=>w.slug===h);if(k>=0)open(k);
})();`;

build().catch(e => { console.error(e); process.exit(1); });
