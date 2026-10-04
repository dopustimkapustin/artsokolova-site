// Builds the static site from content/site.json + content/originals/* into dist/.
// No framework: one HTML page, responsive images, auto layout per series.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CONTENT = path.join(ROOT, 'content');
const DIST = path.join(ROOT, 'dist');
const WIDTHS = [640, 1280, 2000];

const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const money = n => (n || n === 0) ? '$' + Number(n).toLocaleString('en-US') : '';
const dims = size => (size || '').toLowerCase().replace(/[хx×]/g, 'x').split('x').map(Number).filter(Boolean);

// ---------- images ----------
const imgCache = new Map();
async function processImage(name) {
  if (imgCache.has(name)) return imgCache.get(name);
  const files = await fs.readdir(path.join(CONTENT, 'originals'));
  const file = files.find(f => f.replace(/\.[^.]+$/, '') === name);
  if (!file) { console.warn('missing image', name); imgCache.set(name, null); return null; }
  const src = path.join(CONTENT, 'originals', file);
  const meta = await sharp(src).rotate().metadata();
  const w0 = meta.autoOrient?.width ?? meta.width, h0 = meta.autoOrient?.height ?? meta.height;
  const widths = WIDTHS.filter(w => w < w0).concat(w0 <= 2000 ? [w0] : []).filter((v, i, a) => a.indexOf(v) === i);
  const out = [];
  for (const w of widths) {
    const fn = `img/${name}-${w}.webp`;
    const dest = path.join(DIST, fn);
    try { await fs.access(dest); } catch { await sharp(src).rotate().resize({ width: w }).webp({ quality: 82 }).toFile(dest); }
    out.push({ w, src: fn });
  }
  const res = { w: w0, h: h0, srcset: out.map(o => `${o.src} ${o.w}w`).join(', '), src: out[Math.min(1, out.length - 1)].src, large: out[out.length - 1].src };
  imgCache.set(name, res);
  return res;
}

const picture = (im, alt, sizes, cls = '', eager = false) => im ? `<img class="${cls}" src="${im.src}" srcset="${im.srcset}" sizes="${sizes}" width="${im.w}" height="${im.h}" alt="${esc(alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">` : '';

// ---------- auto layout ----------
// Consecutive works of the same size form a row group. Column count depends on
// how many works there are and how big they physically are.
// Size classes: L = 36in+ on the long side, M = 17–35in, S = 16in and under.
const sizeClass = size => { const d = Math.max(...dims(size), 0); return !d ? 'M' : d >= 36 ? 'L' : d <= 16 ? 'S' : 'M'; };
function layoutRows(works) {
  const groups = [];
  for (const w of works) {
    const cls = w.layout || sizeClass(w.size);
    const last = groups[groups.length - 1];
    if (last && last.cls === cls) last.items.push(w); else groups.push({ cls, items: [w] });
  }
  return groups.map(g => {
    const n = g.items.length;
    let cols;
    if (g.cls === 'L') cols = n <= 3 ? n : (n % 2 === 0 ? 2 : 3);
    else cols = n <= 4 ? n : (n % 4 === 0 ? 4 : n % 3 === 0 ? 3 : 4);
    return { ...g, cols, small: g.cls === 'S' };
  });
}

// ---------- page ----------
async function build() {
  const data = JSON.parse(await fs.readFile(path.join(CONTENT, 'site.json'), 'utf8'));
  const T = data.texts;
  await fs.rm(path.join(DIST, 'index.html'), { force: true });
  await fs.mkdir(path.join(DIST, 'img'), { recursive: true });
  await fs.cp(path.join(ROOT, 'assets'), path.join(DIST, 'assets'), { recursive: true });

  const series = data.series.filter(s => s.show !== false).sort((a, b) => a.order - b.order);
  const lightbox = []; // flat list for slideshow
  let seriesHtml = '';

  for (const s of series) {
    const works = data.works.filter(w => w.series === s.id && w.show !== false && w.images?.length).sort((a, b) => a.order - b.order);
    if (!works.length) continue;
    for (const w of works) {
      w.slug = w.slug || slugify(w.title);
      w.imgs = (await Promise.all(w.images.map(processImage))).filter(Boolean);
    }
    const rows = layoutRows(works.filter(w => w.imgs.length));
    let rowsHtml = '';
    for (const r of rows) {
      const sizes = `(max-width: 700px) ${r.cols >= 3 ? '50vw' : '100vw'}, ${Math.round(100 / r.cols)}vw`;
      rowsHtml += `<div class="row c${r.cols}${r.small ? ' small' : ''}">` + r.items.map(w => {
        const idx = lightbox.length;
        lightbox.push({ slug: w.slug, title: w.title, year: w.year, size: w.size, medium: w.medium, price: w.status === 'Available' ? money(w.price) : '', status: w.status, note: w.note || '', ar: !!w.ar, imgs: w.imgs.map(i => ({ src: i.large, w: i.w, h: i.h })) });
        const im = w.imgs[0];
        const status = w.status === 'Sold' ? '<span class="sold">Sold</span>' : w.status === 'On hold' ? '<span class="hold">On hold</span>' : '';
        return `<figure class="work" id="${w.slug}">
  <button class="open" data-i="${idx}" aria-label="View ${esc(w.title)}"><span class="frame" style="aspect-ratio:${im.w}/${im.h}">${picture(im, `${w.title}, ${w.year}, ${w.medium}`, sizes)}</span>${w.imgs.length > 1 ? `<span class="count">${w.imgs.length}</span>` : ''}${w.ar ? '<span class="ar">AR</span>' : ''}</button>
  <figcaption><span class="t">${esc(w.title)}${w.year ? `, ${w.year}` : ''}</span><span class="m">${esc(w.size ? w.size + ' in' : '')}<br>${esc(w.medium)}${w.note ? `<br>${esc(w.note)}` : ''}<br>${status || (w.status === 'Available' && w.price ? `<span class="price">${money(w.price)}</span>` : '')}</span></figcaption>
</figure>`;
      }).join('') + `</div>`;
    }
    seriesHtml += `<section class="series" id="${s.id}">
  <header class="series-head"><h2>${esc(s.name)}</h2>${s.ar ? '<span class="tag">Includes Augmented Reality</span>' : ''}${s.description ? `<p>${esc(s.description)}</p>` : ''}</header>
  ${rowsHtml}
</section>`;
  }

  const hero = await processImage(T.heroImage);
  const aboutImg = await processImage(T.aboutImage);
  const arImgs = (await Promise.all((T.arImages || []).map(processImage))).filter(Boolean);

  const cvSections = ['Exhibitions', 'Publications', 'Affiliations', 'Collections'];
  const cvHtml = cvSections.map(sec => {
    const rows = data.cv.filter(c => c.section === sec && c.show !== false);
    if (!rows.length) return '';
    return `<div class="cv-sec"><h3>${sec === 'Exhibitions' ? 'Selected Exhibitions' : sec}</h3><ul>${rows.map(c => `<li><span class="y">${esc(c.year)}</span><span>${esc(c.entry)}${c.venue ? `, <em>${esc(c.venue)}</em>` : ''}${c.city ? `, ${esc(c.city)}` : ''}</span></li>`).join('')}</ul></div>`;
  }).join('');

  const nameParts = T.name.toUpperCase().split(' ');
  const year = new Date().getFullYear();
  const jsonld = { '@context': 'https://schema.org', '@type': 'Person', name: 'Alena Sokolova', jobTitle: 'Painter', url: 'https://artsokolova.com', email: T.email, address: { '@type': 'PostalAddress', addressLocality: 'Boston', addressRegion: 'MA' }, sameAs: [T.instagram, T.facebook, T.artfinder].filter(Boolean) };

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
  <nav><a href="#work">Work</a><a href="#about">About</a><a href="#contact">Contact</a></nav>
</header>

<section class="hero">
  <div class="hero-text">
    <h1>${nameParts.map(p => `<span>${esc(p)}</span>`).join('')}</h1>
    <p>${esc(T.intro)}</p>
  </div>
  <div class="hero-img">${picture(hero, 'Alena Sokolova', '(max-width: 700px) 100vw, 50vw', '', true)}</div>
  <a class="circle red" href="mailto:${esc(T.email)}">Get<br>in Touch</a>
</section>

${arImgs.length ? `<section class="ar-block" id="ar">
  <h2 class="label">AR Experience</h2>
  <div class="ar-stage">
    <div class="ar-main">${picture(arImgs[0], 'Augmented reality artwork', '(max-width: 700px) 80vw, 40vw')}</div>
    ${arImgs.slice(1, 5).map((im, i) => `<div class="ar-dot d${i + 1}">${picture(im, 'Artwork in augmented reality', '200px')}</div>`).join('')}
  </div>
</section>` : ''}

<main id="work">
  <div class="marquee" aria-hidden="true"><span>Work</span><span>Work</span><span>Work</span><span>Work</span><span>Work</span><span>Work</span></div>
  ${seriesHtml}
</main>

<section class="about" id="about">
  <div class="arch">${picture(aboutImg, 'Alena Sokolova in the studio', '(max-width: 700px) 90vw, 40vw')}</div>
  <div class="about-text">
    <h2 class="label">About</h2>
    ${T.about.split(/\n\s*\n/).map(p => `<p>${esc(p)}</p>`).join('')}
    <div class="btns"><a class="btn dark" href="mailto:${esc(T.email)}">Get in Touch</a>${T.cvUrl ? `<a class="btn" href="${esc(T.cvUrl)}" target="_blank" rel="noopener">Get CV</a>` : ''}</div>
    <div class="cv">${cvHtml}</div>
  </div>
</section>

<footer id="contact">
  <a class="big-mail" href="mailto:${esc(T.email)}">${esc(T.email)}</a>
  <div class="foot-row">
    <span>© ${year} — Alena Sokolova</span>
    <span class="social">${T.instagram ? `<a href="${esc(T.instagram)}" target="_blank" rel="noopener">Instagram</a>` : ''}${T.facebook ? `<a href="${esc(T.facebook)}" target="_blank" rel="noopener">Facebook</a>` : ''}${T.artfinder ? `<a href="${esc(T.artfinder)}" target="_blank" rel="noopener">Artfinder</a>` : ''}</span>
  </div>
</footer>

${T.artfinder ? `<a class="follow" href="${esc(T.artfinder)}" target="_blank" rel="noopener"><b>Follow me</b><i>Artfinder</i></a>` : ''}
<a class="circle black float" href="mailto:${esc(T.email)}">Get in Touch</a>

<div class="lb" hidden role="dialog" aria-modal="true" aria-label="Artwork viewer">
  <button class="lb-x" aria-label="Close">Close</button>
  <button class="lb-prev" aria-label="Previous">←</button>
  <div class="lb-stage"><img alt=""></div>
  <button class="lb-next" aria-label="Next">→</button>
  <div class="lb-cap"><div class="t"></div><div class="m"></div><div class="dots"></div><a class="inq" href="#">Inquire</a></div>
</div>

<script>window.WORKS=${JSON.stringify(lightbox)};window.EMAIL=${JSON.stringify(T.email)};</script>
<script>${JS}</script>
</body>
</html>`;
  await fs.writeFile(path.join(DIST, 'index.html'), html);
  console.log(`built: ${lightbox.length} works, ${imgCache.size} images`);
}

const CSS = String.raw`
@font-face{font-family:Telegraf;src:url(assets/fonts/PPTelegraf-Regular.woff2) format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:Writer;src:url(assets/fonts/PPWriter-BookItalic.woff2) format('woff2');font-style:italic;font-weight:300;font-display:swap}
:root{--pad:46px;--gap:30px;--ink:#0a0a0a;--grey:#a9a9a9;--line:#d6d6d6;--red:#f0154f;--navy:#1e2a38;--sans:Telegraf,Helvetica,Arial,sans-serif;--serif:Writer,'Times New Roman',serif}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;scroll-padding-top:70px}
body{font-family:var(--sans);color:var(--ink);background:#fff;font-size:17px;line-height:1.45;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{display:block;max-width:100%;height:auto}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.top{position:fixed;inset:0 0 auto;z-index:20;background:#fff}
.top nav{margin:0 var(--pad);height:54px;display:flex;align-items:center;gap:54px;padding-left:28px;border-bottom:1px solid var(--line);text-transform:uppercase;font-size:15px}
.top nav a:hover{color:var(--red)}
.hero{position:relative;display:grid;grid-template-columns:1fr 1fr;min-height:100vh;padding-top:54px}
.hero-text{display:flex;flex-direction:column;justify-content:space-between;padding:48px var(--pad) 40px}
.hero h1{font-weight:400;font-size:clamp(56px,8.6vw,136px);line-height:1;letter-spacing:-.01em}
.hero h1 span{display:block}
.hero-text p{max-width:470px;font-size:18px;margin-top:40px}
.hero-img{position:relative;overflow:hidden;background:#f4f4f4}
.hero-img img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.circle{display:flex;align-items:center;justify-content:center;text-align:center;border-radius:50%;font-family:var(--serif);font-style:italic;color:#fff;line-height:1.05;transition:transform .3s}
.circle:hover{transform:scale(1.06)}
.circle.red{position:absolute;left:50%;bottom:9%;transform:translateX(-60%);width:162px;height:162px;background:var(--red);font-size:26px}
.circle.red:hover{transform:translateX(-60%) scale(1.06)}
.circle.black{position:fixed;right:28px;bottom:80px;z-index:15;width:130px;height:130px;background:#000;font-size:17px}
.follow{position:fixed;left:0;bottom:170px;z-index:15;background:var(--navy);color:#fff;padding:8px 46px 8px 14px;line-height:1.1;overflow:hidden}
.follow b{display:block;font-size:22px;font-weight:700}
.follow i{font-style:normal;color:var(--red);font-size:14px;font-weight:700}
.follow::after{content:'';position:absolute;right:-12px;bottom:-14px;width:58px;height:58px;border-radius:50%;background:var(--red)}
.label{font-weight:400;text-transform:uppercase;font-size:15px;letter-spacing:.02em}
.ar-block{padding:120px var(--pad) 60px;text-align:center}
.ar-stage{position:relative;max-width:1180px;margin:50px auto 0;aspect-ratio:16/8}
.ar-main{position:absolute;left:50%;top:50%;width:40%;transform:translate(-50%,-50%)}
.ar-dot{position:absolute;width:19%;aspect-ratio:1;border-radius:50%;overflow:hidden}
.ar-dot img{width:100%;height:100%;object-fit:cover}
.ar-dot.d1{left:2%;top:4%}.ar-dot.d2{left:9%;top:60%}.ar-dot.d3{right:2%;top:4%}.ar-dot.d4{right:9%;top:56%;opacity:.55}
.marquee{overflow:hidden;white-space:nowrap;font-family:var(--serif);font-style:italic;font-size:clamp(70px,11vw,170px);line-height:1.2;padding:40px 0 10px;pointer-events:none}
.marquee span{display:inline-block;padding-right:.5em;animation:mq 22s linear infinite}
@keyframes mq{to{transform:translateX(-100%)}}
@media (prefers-reduced-motion:reduce){.marquee span{animation:none}}
.series{padding:70px var(--pad) 40px}
.series-head{max-width:760px;margin:0 auto 56px;text-align:center}
.series-head h2{font-family:var(--serif);font-style:italic;font-weight:300;font-size:clamp(34px,4vw,56px);line-height:1.1}
.series-head p{color:#555;margin-top:18px}
.tag{display:inline-block;margin-top:14px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;border:1px solid var(--ink);border-radius:20px;padding:3px 12px}
.row{display:grid;gap:var(--gap);align-items:end;margin:0 auto 70px}
.row.c4{grid-template-columns:repeat(4,1fr)}
.row.c3{grid-template-columns:repeat(3,1fr)}
.row.c2{grid-template-columns:repeat(2,1fr);max-width:1060px;gap:56px}
.row.c1{grid-template-columns:1fr;max-width:520px}
.row.small{max-width:900px}
.row.small.c4{max-width:1100px}
.open{position:relative;display:block;width:100%;cursor:zoom-in}
.frame{display:block;overflow:hidden;background:#f6f6f6}
.frame img{width:100%;height:100%;object-fit:cover;transition:transform .6s cubic-bezier(.2,.7,.2,1)}
.open:hover .frame img{transform:scale(1.025)}
.count,.ar{position:absolute;top:10px;font-size:12px;line-height:1;padding:6px 8px;border-radius:20px;background:#fff}
.count{right:10px}.ar{left:10px;background:#000;color:#fff}
figcaption{display:flex;justify-content:space-between;gap:16px;margin-top:18px;font-size:17px;line-height:1.5}
figcaption .t{font-family:var(--serif);font-style:italic;font-size:19px;line-height:1.35;max-width:55%}
figcaption .m{color:var(--grey);text-align:right}
.price{color:var(--ink)}
.sold,.hold{color:var(--red)}
.sold::before,.hold::before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--red);margin-right:6px;vertical-align:1px}
.hold{color:#c08a00}.hold::before{background:#e0a800}
.about{display:grid;grid-template-columns:1fr 1fr;gap:80px;padding:120px var(--pad);align-items:start}
.arch{border-radius:999px 999px 0 0;overflow:hidden;position:sticky;top:90px;max-width:560px;justify-self:center;width:100%;aspect-ratio:3/4}
.arch img{width:100%;height:100%;object-fit:cover}
.about-text{max-width:620px}
.about-text p{margin-top:22px;font-size:18px}
.btns{display:flex;gap:14px;margin-top:36px;flex-wrap:wrap}
.btn{border:1px solid var(--ink);border-radius:40px;padding:12px 26px;font-family:var(--serif);font-style:italic;font-size:19px}
.btn.dark{background:var(--ink);color:#fff}
.btn:hover{background:var(--red);border-color:var(--red);color:#fff}
.cv{margin-top:64px}
.cv-sec{margin-top:36px}
.cv-sec h3{font-family:var(--serif);font-style:italic;font-weight:300;font-size:24px;margin-bottom:10px}
.cv li{list-style:none;display:grid;grid-template-columns:110px 1fr;gap:14px;padding:10px 0;border-top:1px solid var(--line);font-size:16px}
.cv li .y{color:var(--grey)}
.cv em{font-style:normal;color:#555}
footer{padding:80px var(--pad) 40px;border-top:1px solid var(--line);margin:0 var(--pad);padding-left:0;padding-right:0}
.big-mail{font-family:var(--serif);font-style:italic;font-size:clamp(34px,6vw,96px);line-height:1.1;word-break:break-word}
.big-mail:hover{color:var(--red)}
.foot-row{display:flex;justify-content:space-between;gap:20px;margin-top:60px;color:var(--grey);font-size:15px;flex-wrap:wrap}
.social{display:flex;gap:28px}.social a:hover{color:var(--ink)}
.lb{position:fixed;inset:0;z-index:50;background:#fff;display:grid;grid-template-columns:80px 1fr 80px;grid-template-rows:1fr auto}
.lb[hidden]{display:none}
.lb-stage{grid-column:2;display:flex;align-items:center;justify-content:center;padding:60px 0 20px;min-height:0}
.lb-stage img{max-height:100%;max-width:100%;width:auto;height:auto;object-fit:contain;box-shadow:0 10px 40px rgba(0,0,0,.08)}
.lb-prev,.lb-next{font-size:30px;align-self:center}
.lb-prev{grid-column:1;grid-row:1}.lb-next{grid-column:3;grid-row:1}
.lb-prev:hover,.lb-next:hover,.lb-x:hover{color:var(--red)}
.lb-x{position:absolute;top:18px;right:var(--pad);text-transform:uppercase;font-size:15px}
.lb-cap{grid-column:2;display:flex;justify-content:space-between;align-items:flex-end;gap:20px;padding:10px 0 34px}
.lb-cap .t{font-family:var(--serif);font-style:italic;font-size:22px}
.lb-cap .m{color:var(--grey);flex:1}
.lb-cap .dots{display:flex;gap:6px}
.lb-cap .dots button{width:9px;height:9px;border-radius:50%;background:var(--line)}
.lb-cap .dots button.on{background:var(--ink)}
.inq{border:1px solid var(--ink);border-radius:40px;padding:8px 20px;font-family:var(--serif);font-style:italic;font-size:17px;white-space:nowrap}
.inq:hover{background:var(--red);border-color:var(--red);color:#fff}
@media (max-width:1100px){.row.c4{grid-template-columns:repeat(3,1fr)}.row.c4.small{grid-template-columns:repeat(4,1fr)}}
@media (max-width:900px){:root{--pad:24px;--gap:22px}.row.c4,.row.c3{grid-template-columns:repeat(2,1fr)}.row.c4.small{grid-template-columns:repeat(2,1fr)}.about{grid-template-columns:1fr;gap:50px}.arch{position:relative;top:0;max-width:440px}}
@media (max-width:700px){
  :root{--pad:16px;--gap:16px}
  body{font-size:15px}
  .top nav{gap:28px;padding-left:0;font-size:14px;height:50px}
  .hero{grid-template-columns:1fr;min-height:0;padding-top:50px}
  .hero-text{padding:28px var(--pad) 24px}
  .hero h1{font-size:clamp(48px,15vw,76px)}
  .hero-text p{font-size:16px;margin-top:22px}
  .hero-img{aspect-ratio:4/5}
  .circle.red{left:auto;right:16px;bottom:auto;top:calc(50px + 28px);transform:none;width:104px;height:104px;font-size:18px}
  .circle.red:hover{transform:scale(1.06)}
  .circle.black{width:86px;height:86px;font-size:13px;right:14px;bottom:18px}
  .follow{bottom:18px;padding:6px 34px 6px 10px}.follow b{font-size:16px}.follow i{font-size:11px}.follow::after{width:40px;height:40px;right:-10px;bottom:-12px}
  .ar-block{padding:70px var(--pad) 20px}.ar-stage{aspect-ratio:1/1;margin-top:30px}.ar-main{width:62%}.ar-dot{width:26%}
  .series{padding:46px var(--pad) 10px}.series-head{margin-bottom:34px}
  .row{margin-bottom:46px}
  .row.c2,.row.c1{grid-template-columns:1fr;gap:40px}
  .row.small.c2{grid-template-columns:repeat(2,1fr);gap:16px}
  figcaption{flex-direction:column;gap:4px;margin-top:10px;font-size:13px}
  figcaption .t{max-width:none;font-size:16px}
  figcaption .m{text-align:left}
  .row.c1 figcaption,.row.c2:not(.small) figcaption{flex-direction:row;font-size:14px}
  .row.c1 figcaption .m,.row.c2:not(.small) figcaption .m{text-align:right}
  .about{padding:70px var(--pad)}.about-text p{font-size:16px}
  .cv li{grid-template-columns:80px 1fr;font-size:14px}
  footer{padding:50px 0 110px}
  .lb{grid-template-columns:1fr;grid-template-rows:1fr auto}
  .lb-stage{grid-column:1;padding:56px 12px 10px}
  .lb-prev,.lb-next{display:none}
  .lb-cap{grid-column:1;flex-wrap:wrap;padding:10px 16px 24px}.lb-cap .m{flex-basis:100%;order:3}
}`;

const JS = String.raw`
(()=>{const W=window.WORKS,lb=document.querySelector('.lb'),img=lb.querySelector('.lb-stage img'),t=lb.querySelector('.lb-cap .t'),m=lb.querySelector('.lb-cap .m'),dots=lb.querySelector('.dots'),inq=lb.querySelector('.inq');let i=0,j=0;
function show(){const w=W[i],im=w.imgs[j];img.src=im.src;img.width=im.w;img.height=im.h;img.alt=w.title;t.textContent=w.title+(w.year?', '+w.year:'');m.textContent=[w.size&&w.size+' in',w.medium,w.note,w.status==='Sold'?'Sold':w.price].filter(Boolean).join(' · ');dots.innerHTML=w.imgs.length>1?w.imgs.map((_,k)=>'<button class="'+(k===j?'on':'')+'" data-k="'+k+'" aria-label="Image '+(k+1)+'"></button>').join(''):'';inq.style.display=w.status==='Sold'?'none':'';inq.href='mailto:'+window.EMAIL+'?subject='+encodeURIComponent('Inquiry: '+w.title);history.replaceState(null,'','#'+w.slug);const n=W[(i+1)%W.length];if(n){const p=new Image();p.src=n.imgs[0].src}}
function open(k){i=k;j=0;lb.hidden=false;document.body.style.overflow='hidden';show();lb.querySelector('.lb-x').focus()}
function close(){lb.hidden=true;document.body.style.overflow='';history.replaceState(null,'',location.pathname);document.getElementById(W[i].slug)?.scrollIntoView({block:'center'})}
function step(d){const w=W[i];if(j+d>=0&&j+d<w.imgs.length){j+=d}else{i=(i+d+W.length)%W.length;j=d>0?0:W[i].imgs.length-1}show()}
document.querySelectorAll('.open').forEach(b=>b.addEventListener('click',()=>open(+b.dataset.i)));
lb.querySelector('.lb-x').onclick=close;lb.querySelector('.lb-prev').onclick=()=>step(-1);lb.querySelector('.lb-next').onclick=()=>step(1);
dots.onclick=e=>{if(e.target.dataset.k){j=+e.target.dataset.k;show()}};
lb.querySelector('.lb-stage').onclick=e=>{if(e.target===e.currentTarget)close()};
addEventListener('keydown',e=>{if(lb.hidden)return;if(e.key==='Escape')close();if(e.key==='ArrowRight')step(1);if(e.key==='ArrowLeft')step(-1)});
let x0=null;lb.addEventListener('touchstart',e=>x0=e.touches[0].clientX,{passive:true});lb.addEventListener('touchend',e=>{if(x0===null)return;const dx=e.changedTouches[0].clientX-x0;if(Math.abs(dx)>50)step(dx<0?1:-1);x0=null});
const h=location.hash.slice(1),k=W.findIndex(w=>w.slug===h);if(k>=0)open(k);
})();`;

build().catch(e => { console.error(e); process.exit(1); });
