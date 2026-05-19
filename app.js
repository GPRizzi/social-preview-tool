// ===== Social Preview Inspector - app logic =====

// --- CORS proxies (fallback cascade) ---
// Ordine aggiornato 2026-05-19: corsproxy.io e' diventato a pagamento
// (HTTP 403 "Server-side requests not allowed on your plan"),
// allorigins.win down (Cloudflare 520/522). codetabs e' l'unico
// proxy gratuito stabile rimasto, va in cima. Gli altri stanno come
// fallback se temporaneamente OK.
const PROXIES = [
    { name: 'codetabs',         url: (u) => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u), raw: true  },
    { name: 'allorigins-raw',   url: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),       raw: true  },
    { name: 'allorigins-json',  url: (u) => 'https://api.allorigins.win/get?url=' + encodeURIComponent(u),       raw: false },
    { name: 'corsproxy.io',     url: (u) => 'https://corsproxy.io/?' + encodeURIComponent(u),                    raw: true  }
];
const FETCH_TIMEOUT_MS = 8000;
const MAX_LINKS = 100;

const htmlCache = new Map();
let currentUrl = null;
let currentFetchId = 0;
let scannedLinks = [];

// --- THEME TOGGLE ---
(function initTheme() {
    const saved = localStorage.getItem('spi-theme') || 'dark';
    document.documentElement.dataset.theme = saved;
    updateThemeIcon(saved);
})();
function toggleTheme() {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('spi-theme', next);
    updateThemeIcon(next);
}
function updateThemeIcon(theme) {
    document.getElementById('theme-icon-moon').style.display = theme === 'dark' ? 'block' : 'none';
    document.getElementById('theme-icon-sun').style.display  = theme === 'dark' ? 'none' : 'block';
}

// --- fetch helpers ---
// cache:'no-store' bypassa la HTTP cache del browser per i fetch
// del proxy (i proxy cachano server-side, ma noi vogliamo ALMENO che
// il browser non rappresenti vecchie risposte cachate dei proxy stessi).
function fetchWithTimeout(url, ms, opts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const init = Object.assign({ signal: ctrl.signal, cache: 'no-store' }, opts || {});
    return fetch(url, init).finally(() => clearTimeout(t));
}

// Append `_t=<now>` al URL target prima di passarlo al proxy:
// forza i proxy CORS (corsproxy.io, allorigins, ecc.) a NON servire
// risposte cachate. La QS extra e' invisibile al sito target ai fini
// del rendering, e per la maggior parte dei siti statici (incluso
// Caddy) restituisce comunque la stessa HTML.
function bustUrl(url) {
    try {
        const u = new URL(url);
        u.searchParams.set('_t', Date.now().toString(36));
        return u.toString();
    } catch (e) {
        return url + (url.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now().toString(36);
    }
}

async function fetchViaProxies(url) {
    let lastErr = null;
    const busted = bustUrl(url);
    for (const p of PROXIES) {
        try {
            const resp = await fetchWithTimeout(p.url(busted), FETCH_TIMEOUT_MS);
            if (!resp.ok) {
                lastErr = new Error('HTTP ' + resp.status);
                console.warn('[spi] proxy', p.name, 'failed:', resp.status);
                continue;
            }
            if (p.raw) {
                const text = await resp.text();
                if (text && text.length > 200) {
                    console.log('[spi] proxy', p.name, 'ok (' + text.length + ' chars)');
                    return text;
                }
                lastErr = new Error('Empty response');
                console.warn('[spi] proxy', p.name, 'empty body (' + (text ? text.length : 0) + ' chars)');
            } else {
                const data = await resp.json();
                if (data && data.contents) {
                    console.log('[spi] proxy', p.name, 'ok (' + data.contents.length + ' chars json)');
                    return data.contents;
                }
                lastErr = new Error('No contents in JSON');
                console.warn('[spi] proxy', p.name, 'no contents in JSON');
            }
        } catch (e) {
            lastErr = e;
            console.warn('[spi] proxy', p.name, 'threw:', e.message);
        }
    }
    throw lastErr || new Error('All CORS proxies failed');
}

// Cache-buster per URL di immagini renderizzate negli <img>.
// L'OG image del sito target e' servita con cache 'immutable' (1 anno):
// senza buster, il browser tiene la versione vecchia anche dopo che il
// sito aggiorna il file. Aggiungiamo un nonce per session (NON per fetch,
// altrimenti ogni render fa download) cosi' un Refresh = nuova versione.
let _imgBust = Date.now().toString(36);
function bustImg(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        u.searchParams.set('_t', _imgBust);
        return u.toString();
    } catch (e) {
        return url + (url.indexOf('?') === -1 ? '?' : '&') + '_t=' + _imgBust;
    }
}

// --- URL normalization ---
function normalizeUrl(input) {
    let u = (input || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
}

// --- inspect current URL from input ---
function inspectCurrent() {
    const raw = document.getElementById('url-input').value;
    const url = normalizeUrl(raw);
    if (!url) return;
    document.getElementById('url-input').value = url;
    loadUrl(url);
    // Also clear active state in link list
    document.querySelectorAll('.link-item').forEach(b => b.classList.remove('active'));
}

function refreshCurrent() {
    if (currentUrl) loadUrl(currentUrl, true);
}

// --- scan site: scrape base URL and extract internal links (max 100) ---
async function scanSite() {
    const raw = document.getElementById('url-input').value;
    const url = normalizeUrl(raw);
    if (!url) return;
    document.getElementById('url-input').value = url;

    const btn = document.getElementById('scan-btn');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ Scanning…';

    document.getElementById('links-title').textContent = 'Scanning…';
    document.getElementById('links-count').textContent = '';
    document.getElementById('link-items').innerHTML = '<div class="empty-links">Fetching the page and extracting internal links…</div>';

    try {
        const html = await fetchViaProxies(url);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const base = new URL(url);
        const pageTitle = (doc.querySelector('title') && doc.querySelector('title').textContent.trim()) || base.hostname;
        const linksMap = new Map();

        // Always include the base URL itself first
        linksMap.set(url, { title: 'Homepage · ' + pageTitle.slice(0, 60), url: url });

        doc.querySelectorAll('a[href]').forEach(a => {
            if (linksMap.size >= MAX_LINKS) return;
            try {
                const abs = new URL(a.getAttribute('href'), base);
                if (abs.protocol !== 'https:' && abs.protocol !== 'http:') return;
                if (abs.hostname !== base.hostname) return;
                abs.hash = '';
                const clean = abs.toString();
                if (linksMap.has(clean)) return;
                const title = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) || abs.pathname;
                linksMap.set(clean, { title, url: clean });
            } catch (e) { /* invalid href */ }
        });

        scannedLinks = Array.from(linksMap.values());
        renderLinkList(scannedLinks);
        document.getElementById('links-title').textContent = base.hostname;
        document.getElementById('links-count').textContent = scannedLinks.length + (scannedLinks.length >= MAX_LINKS ? '+ (max)' : '');

        // Auto-load the first link (the homepage itself)
        if (scannedLinks.length > 0) {
            const firstBtn = document.querySelector('.link-item');
            if (firstBtn) selectLink(scannedLinks[0].url, firstBtn);
        }
    } catch (err) {
        console.error(err);
        document.getElementById('link-items').innerHTML =
            '<div class="empty-links" style="color:#ff6b6b">Scan failed: ' + (err.message || err) + '</div>';
        document.getElementById('links-title').textContent = 'Scan error';
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}

function renderLinkList(items) {
    const container = document.getElementById('link-items');
    if (!items.length) {
        container.innerHTML = '<div class="empty-links">No internal links found on this page.</div>';
        return;
    }
    container.innerHTML = '';
    items.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'link-item';
        btn.dataset.url = item.url;
        const relUrl = item.url.replace(/^https?:\/\/[^/]+/, '') || '/';
        btn.innerHTML =
            '<span class="item-title">' + escapeHtml(item.title) + '</span>' +
            '<span class="item-url">' + escapeHtml(relUrl) + '</span>';
        btn.onclick = () => selectLink(item.url, btn);
        container.appendChild(btn);
    });
}

function selectLink(url, btnEl) {
    document.querySelectorAll('.link-item').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    document.getElementById('url-input').value = url;
    loadUrl(url);
}

// --- main load flow ---
async function loadUrl(url, forceRefresh) {
    currentUrl = url;
    const fetchId = ++currentFetchId;
    document.getElementById('current-title').textContent = 'Loading…';
    document.getElementById('current-url').textContent = url;
    document.getElementById('refresh-btn').disabled = false;
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('loading').classList.add('active');
    document.getElementById('error-state').classList.remove('active');
    document.getElementById('preview-grid').innerHTML = '';
    document.getElementById('meta-section').style.display = 'none';
    document.getElementById('preview-info').classList.remove('active');

    // Ogni "Inspect" o "Refresh" bumpa il nonce per le immagini renderizzate.
    // Cosi' un click di Refresh forza il browser a riscaricare tutte le
    // OG image dai vari <img>, bypassando la cache immutable=1y dei siti
    // statici. Senza, vedevi sempre la stessa immagine "vecchia".
    _imgBust = Date.now().toString(36);

    try {
        // SEMPRE fresh fetch: l'utente clicca "Inspect" aspettandosi
        // di vedere lo stato corrente del sito, non una versione cachata.
        // (Il `forceRefresh` resta accettato per backward-compat ma non
        // cambia nulla, e' sempre forzato.)
        const html = await fetchViaProxies(url);
        htmlCache.set(url, html);
        if (fetchId !== currentFetchId) return;

        const meta = parseMetaTags(html, url);
        renderMetaInfo(meta);
        renderAllPreviews(meta);
        document.getElementById('current-title').textContent = meta.title || '(no title)';
    } catch (err) {
        if (fetchId !== currentFetchId) return;
        console.error(err);
        const errBox = document.getElementById('error-state');
        errBox.textContent = 'Failed to load: ' + (err.message || err) + '. All CORS proxies seem unreachable — try again in a few seconds.';
        errBox.classList.add('active');
        document.getElementById('current-title').textContent = 'Error';
    } finally {
        if (fetchId === currentFetchId) document.getElementById('loading').classList.remove('active');
    }
}

// --- parse meta tags from HTML ---
function parseMetaTags(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const getMeta = (selectors) => {
        for (const sel of selectors) {
            const el = doc.querySelector(sel);
            if (el) {
                const v = el.getAttribute('content') || el.textContent;
                if (v && v.trim()) return v.trim();
            }
        }
        return '';
    };

    const titleEl = doc.querySelector('title');
    const title = getMeta(['meta[property="og:title"]', 'meta[name="twitter:title"]'])
        || (titleEl ? titleEl.textContent.trim() : '');

    const description = getMeta([
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
        'meta[name="description"]'
    ]);

    let image = getMeta([
        'meta[property="og:image:secure_url"]',
        'meta[property="og:image"]',
        'meta[name="twitter:image"]'
    ]);

    const siteName = getMeta(['meta[property="og:site_name"]']);
    const canonicalEl = doc.querySelector('link[rel="canonical"]');
    const canonical = (canonicalEl && canonicalEl.getAttribute('href'))
        || getMeta(['meta[property="og:url"]'])
        || pageUrl;

    if (image && !image.startsWith('http')) {
        if (image.startsWith('//')) image = 'https:' + image;
        else if (image.startsWith('/')) {
            try { const u = new URL(pageUrl); image = u.origin + image; } catch (e) {}
        }
    }

    let hostname = '';
    try { hostname = new URL(canonical || pageUrl).hostname.replace(/^www\./, ''); } catch (e) {}

    return { title, description, image, siteName, canonical: canonical || pageUrl, hostname, pageUrl };
}

function renderMetaInfo(m) {
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        el.textContent = val || '(missing)';
        el.className = 'val' + (val ? '' : ' missing');
    };
    setVal('m-title', m.title);
    setVal('m-desc', m.description);
    setVal('m-image', m.image);
    setVal('m-site', m.siteName);
    setVal('m-url', m.canonical);
    document.getElementById('meta-section').style.display = 'block';
    document.getElementById('m-image-info').textContent = '…';
    document.getElementById('wa-warning').style.display = 'none';

    if (m.image) inspectImage(m.image);
    else {
        document.getElementById('m-image-info').textContent = '—';
        showWarnings({ noImage: true });
    }
}

async function inspectImage(url) {
    const info = document.getElementById('m-image-info');
    const img = new Image();
    let size = null;
    // bustImg: forza fresh fetch dell'OG image, evita di leggere
    // dalla disk cache del browser (siti statici servono OG con
    // Cache-Control immutable=1y).
    const bustedUrl = bustImg(url);
    try {
        const resp = await fetchWithTimeout(bustedUrl, 5000);
        if (resp.ok) { const blob = await resp.blob(); size = blob.size; }
    } catch (e) { /* CORS: fine, we still get dimensions */ }

    img.onload = () => {
        const ratio = (img.naturalWidth / img.naturalHeight).toFixed(2);
        const kb = size ? Math.round(size / 1024) : null;
        const parts = [
            img.naturalWidth + '×' + img.naturalHeight + 'px',
            'ratio ' + ratio + ':1',
            kb !== null ? '~' + kb + ' KB' : 'size unknown (CORS)'
        ];
        info.textContent = parts.join(' · ');
        showWarnings({
            width: img.naturalWidth,
            height: img.naturalHeight,
            ratio: parseFloat(ratio),
            sizeKb: kb,
            ratioFromStandard: Math.abs(ratio - 1.91)
        });
    };
    img.onerror = () => {
        info.textContent = '⚠️ image failed to load';
        showWarnings({ notLoadable: true });
    };
    img.src = bustedUrl;
}

function showWarnings(ctx) {
    const box = document.getElementById('wa-warning');
    const issues = [];
    if (ctx.noImage) issues.push('⚠️ <strong>og:image missing</strong> — no image preview on any social. Add <code>&lt;meta property="og:image"&gt;</code> to the page head.');
    if (ctx.notLoadable) issues.push('⚠️ <strong>Image failed to load</strong> — the URL is broken or requires auth. Make sure it is public and served over HTTPS.');
    if (ctx.width && ctx.width < 400) issues.push('⚠️ <strong>Image too small</strong> (' + ctx.width + 'px) — Telegram won\'t show the large preview (min 400×400), Facebook rejects anything under 200×200.');
    if (ctx.width && ctx.width >= 400 && ctx.width < 600) issues.push('⚠️ Small image (' + ctx.width + 'px) — Twitter/X needs min 300×157 for large card, LinkedIn recommends 1200×627.');
    if (ctx.sizeKb !== null && ctx.sizeKb > 300) issues.push('🚨 <strong>Image ' + ctx.sizeKb + ' KB (above 300 KB)</strong> — <strong>WhatsApp may not load it</strong> (non-official but observed limit). Compress to under 300 KB.');
    if (ctx.sizeKb !== null && ctx.sizeKb > 5000) issues.push('🚨 Image > 5 MB — Telegram and iMessage will likely fail.');
    if (ctx.ratioFromStandard !== undefined && ctx.ratioFromStandard > 0.4) issues.push('ℹ️ Ratio not 1.91:1 — Facebook, Twitter and LinkedIn will crop the center (you may lose important content at top/bottom).');

    if (!issues.length) { box.style.display = 'none'; return; }
    box.innerHTML = issues.map(i => '<div style="margin-bottom:4px">' + i + '</div>').join('');
    box.style.display = 'block';
}

// --- previews rendering ---
function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Official SVGs (Simple Icons) - normalized to 24x24
const SOCIAL_SVG = {
    whatsapp: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347M12.05 21.785h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>',
    telegram: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
    imessage: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2C5.373 2 0 6.656 0 12.398c0 3.285 1.744 6.197 4.504 8.107-.072 1.336-.297 2.516-.682 3.42-.132.31-.04.52.117.52.12 0 .245-.068.304-.104 1.576-.97 2.96-2.3 3.866-3.25A14.56 14.56 0 0012 22.8c6.627 0 12-4.656 12-10.4S18.627 2 12 2z"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
    twitter:  '<svg viewBox="0 0 24 24" fill="#fff"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    linkedin: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
    slack:    '<svg viewBox="0 0 24 24"><path fill="#E01E5A" d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313z"/><path fill="#36C5F0" d="M8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312z"/><path fill="#2EB67D" d="M18.956 8.834a2.528 2.528 0 012.522-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 01-2.523 2.521 2.527 2.527 0 01-2.52-2.521V2.522A2.527 2.527 0 0115.165 0a2.528 2.528 0 012.523 2.522v6.312z"/><path fill="#ECB22E" d="M15.165 18.956a2.528 2.528 0 012.523 2.522A2.528 2.528 0 0115.165 24a2.527 2.527 0 01-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 01-2.52-2.523 2.526 2.526 0 012.52-2.52h6.313A2.527 2.527 0 0124 15.165a2.528 2.528 0 01-2.522 2.523h-6.313z"/></svg>',
    discord:  '<svg viewBox="0 0 24 24" fill="#fff"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>',
    reddit:   '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 01.042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 014.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 01.14-.197.35.35 0 01.238-.042l2.906.617a1.214 1.214 0 011.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.687 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 00-.231.094.33.33 0 000 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 00.029-.463.33.33 0 00-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 00-.232-.095z"/></svg>',
    google:   '<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>',
    pinterest:'<svg viewBox="0 0 24 24" fill="#fff"><path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.402.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.357-.629-2.748-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12.017 24c6.624 0 11.99-5.367 11.99-11.988C24.007 5.367 18.641.001 12.017.001z"/></svg>',
    mastodon: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 00.023-.043v-1.809a.052.052 0 00-.02-.041.053.053 0 00-.046-.01 20.282 20.282 0 01-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 01-.319-1.433.053.053 0 01.066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/></svg>',
    bluesky:  '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 01-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z"/></svg>',
    skype:    '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 0C5.374 0 0 5.374 0 12c0 .612.046 1.213.134 1.801C1.347 22.038 7.994 24 12 24c6.626 0 12-5.374 12-12 0-.612-.046-1.213-.134-1.801C22.653 1.962 16.006 0 12 0zm0 18.5c-3.584 0-6.5-1.9-6.5-4.232 0-.89.676-1.613 1.512-1.613.767 0 1.264.437 1.614.82.42.46.84.83 1.876 1.197.63.222 1.46.328 2.298.328 2.21 0 3.394-.896 3.394-1.765 0-.51-.273-1.046-2.62-1.6-1.09-.257-2.346-.547-3.524-.96-1.544-.542-3.348-1.62-3.348-3.94 0-2.29 2.29-3.985 5.445-3.985 1.27 0 4.266.265 5.53 2.52.33.59.422 1.033.422 1.48 0 .823-.633 1.607-1.567 1.607-.832 0-1.326-.35-1.7-.82-.44-.554-.9-1.197-2.905-1.197-1.633 0-2.69.602-2.69 1.535 0 .99 1.185 1.294 3.63 1.884 3.036.733 5.872 1.67 5.872 4.603 0 2.613-2.507 4.138-6.74 4.138z"/></svg>',
    signal:   '<svg viewBox="0 0 24 24" fill="#fff"><path d="m9.12.35.27 1.09a10.845 10.845 0 00-3.015 1.248L5.8 1.747A11.982 11.982 0 019.12.35zm5.76 0-.27 1.09a10.845 10.845 0 013.015 1.248l.575-.94A11.982 11.982 0 0014.88.35zM1.747 5.8l.94.576A10.845 10.845 0 001.44 9.39L.35 9.12A11.982 11.982 0 011.747 5.8zM1.125 12c0-.547.041-1.094.122-1.635L.133 10.2a12.12 12.12 0 000 3.6l1.114-.165A10.995 10.995 0 011.125 12zm17.088 9.253-.576-.94a10.845 10.845 0 01-3.014 1.247l.27 1.09a11.982 11.982 0 003.32-1.397zM22.875 12c0 .547-.041 1.094-.122 1.635l1.114.165a12.12 12.12 0 000-3.6l-1.114.165c.081.541.122 1.088.122 1.635zm.775 2.88-1.09-.27a10.845 10.845 0 01-1.248 3.015l.94.575a11.982 11.982 0 001.398-3.32zm-10.015 7.995a10.995 10.995 0 01-3.27 0l-.165 1.114a12.12 12.12 0 003.6 0zm7.605-4.47a10.91 10.91 0 01-2.313 2.313l.682.899a12.027 12.027 0 002.53-2.53zM18.532 3.18a10.91 10.91 0 012.313 2.313l.9-.682a12.027 12.027 0 00-2.53-2.53zM3.155 5.493A10.91 10.91 0 015.468 3.18l-.682-.9a12.027 12.027 0 00-2.53 2.53zM22.253 5.8l-.94.576a10.845 10.845 0 011.247 3.014l1.09-.27A11.982 11.982 0 0022.253 5.8zM10.365 1.247a10.995 10.995 0 013.27 0L13.8.133a12.12 12.12 0 00-3.6 0zM2.749 18.894l-1.526.43 1.41 1.433 1.433 1.409.43-1.526a11.937 11.937 0 01-1.747-1.746zM12 2.25a9.75 9.75 0 00-8.475 14.556l-.867 3.076 3.15-.786A9.75 9.75 0 1012 2.25z"/></svg>'
};

const WA_CHECK_SVG = '<svg viewBox="0 0 16 15" fill="#53bdeb" style="width:16px;height:auto;vertical-align:middle"><path d="M15.01 3.316l-.478-.372a.365.365 0 00-.51.063L8.666 9.879a.32.32 0 01-.484.033l-.358-.325a.319.319 0 00-.484.032l-.378.483a.418.418 0 00.036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366 0 00-.064-.512zm-4.1 0l-.478-.372a.365.365 0 00-.51.063L4.566 9.879a.32.32 0 01-.484.033L1.891 7.769a.366.366 0 00-.515.006l-.423.433a.364.364 0 00.006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 00-.063-.51z"/></svg>';

const SOCIALS = [
    { key: 'whatsapp',  name: 'WhatsApp',     iconClass: 'ic-whatsapp'  },
    { key: 'telegram',  name: 'Telegram',     iconClass: 'ic-telegram'  },
    { key: 'imessage',  name: 'iMessage',     iconClass: 'ic-imessage'  },
    { key: 'signal',    name: 'Signal',       iconClass: 'ic-signal'    },
    { key: 'skype',     name: 'Skype',        iconClass: 'ic-skype'     },
    { key: 'facebook',  name: 'Facebook',     iconClass: 'ic-facebook'  },
    { key: 'twitter',   name: 'X (Twitter)',  iconClass: 'ic-twitter'   },
    { key: 'linkedin',  name: 'LinkedIn',     iconClass: 'ic-linkedin'  },
    { key: 'mastodon',  name: 'Mastodon',     iconClass: 'ic-mastodon'  },
    { key: 'bluesky',   name: 'Bluesky',      iconClass: 'ic-bluesky'   },
    { key: 'slack',     name: 'Slack',        iconClass: 'ic-slack'     },
    { key: 'discord',   name: 'Discord',      iconClass: 'ic-discord'   },
    { key: 'reddit',    name: 'Reddit',       iconClass: 'ic-reddit'    },
    { key: 'pinterest', name: 'Pinterest',    iconClass: 'ic-pinterest' },
    { key: 'google',    name: 'Google',       iconClass: 'ic-google'    }
];

function renderAllPreviews(m) {
    document.getElementById('preview-info').classList.add('active');
    const grid = document.getElementById('preview-grid');
    grid.innerHTML = '';
    // I renderer leggono m.image: usiamo una copia con l'URL bustato
    // cosi' il browser non serve la vecchia immagine dalla disk cache
    // dei siti statici con Cache-Control immutable.
    const mForRender = Object.assign({}, m, { image: bustImg(m.image) });
    SOCIALS.forEach(s => {
        const card = document.createElement('div');
        card.className = 'social-card sc-' + s.key;
        const body = RENDERERS[s.key](mForRender);
        card.innerHTML =
            '<div class="social-card-header">' +
                '<div class="icon ' + s.iconClass + '">' + (SOCIAL_SVG[s.key] || '') + '</div>' +
                '<div class="name">' + s.name + '</div>' +
            '</div>' +
            '<div class="social-card-body">' + body + '</div>';
        grid.appendChild(card);
    });
}

const RENDERERS = {
    whatsapp: (m) => `
        <div class="wa-msg">
            ${m.image ? `<img class="wa-msg-img" src="${escapeHtml(m.image)}" alt="">` : ''}
            <div class="wa-msg-card">
                <div class="title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="desc">${escapeHtml(m.description) || ''}</div>
                <div class="url">${escapeHtml(m.hostname)}</div>
            </div>
            <div class="wa-msg-link">${escapeHtml(m.canonical)}</div>
            <div class="wa-msg-time"><span>12:34</span>${WA_CHECK_SVG}</div>
        </div>`,
    telegram: (m) => `
        <div class="tg-msg">
            <div class="tg-msg-link">${escapeHtml(m.canonical)}</div>
            <div class="tg-large">
                <div class="tg-large-site">${escapeHtml(m.siteName || m.hostname)}</div>
                <div class="tg-large-title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="tg-large-desc">${escapeHtml(m.description) || ''}</div>
                ${m.image ? `<img class="tg-large-img" src="${escapeHtml(m.image)}" alt="">` : ''}
            </div>
            <div class="tg-msg-time">12:34</div>
        </div>`,
    imessage: (m) => `
        <div class="im-msg">
            ${m.image ? `<img class="im-msg-img" src="${escapeHtml(m.image)}" alt="">` : ''}
            <div class="im-msg-meta">
                <div class="im-msg-title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="im-msg-desc">${escapeHtml(m.description) || ''}</div>
                <div class="im-msg-host">${escapeHtml(m.hostname)}</div>
            </div>
        </div>`,
    signal: (m) => `
        <div class="sg-msg">
            <div class="sg-card">
                ${m.image ? `<img src="${escapeHtml(m.image)}" alt="">` : ''}
                <div class="sg-card-meta">
                    <div class="sg-card-title">${escapeHtml(m.title) || '(title missing)'}</div>
                    <div class="sg-card-desc">${escapeHtml(m.description) || ''}</div>
                    <div class="sg-card-host">${escapeHtml(m.hostname)}</div>
                </div>
            </div>
            <div class="sg-msg-link">${escapeHtml(m.canonical)}</div>
        </div>`,
    skype: (m) => `
        <div class="sk-msg">
            ${m.image ? `<img src="${escapeHtml(m.image)}" alt="">` : ''}
            <div class="sk-msg-meta">
                <div class="sk-msg-title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="sk-msg-desc">${escapeHtml(m.description) || ''}</div>
                <div class="sk-msg-host">${escapeHtml(m.hostname)}</div>
            </div>
        </div>`,
    facebook: (m) => `
        <div class="fb-card">
            ${m.image ? `<img class="fb-card-img" src="${escapeHtml(m.image)}" alt="">` : '<div class="fb-card-img"></div>'}
            <div class="fb-card-meta">
                <div class="fb-card-host">${escapeHtml(m.hostname)}</div>
                <div class="fb-card-title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="fb-card-desc">${escapeHtml(m.description) || ''}</div>
            </div>
        </div>`,
    twitter: (m) => `
        <div class="tw-card">
            ${m.image ? `<img class="tw-card-img" src="${escapeHtml(m.image)}" alt="">` : '<div class="tw-card-img"></div>'}
            <div class="tw-card-meta">
                <div class="tw-card-title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="tw-card-host">From ${escapeHtml(m.hostname)}</div>
            </div>
        </div>`,
    linkedin: (m) => `
        <div class="li-card">
            ${m.image ? `<img class="li-card-img" src="${escapeHtml(m.image)}" alt="">` : '<div class="li-card-img"></div>'}
            <div class="li-card-meta">
                <div class="li-card-title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="li-card-host">${escapeHtml(m.hostname)}</div>
            </div>
        </div>`,
    mastodon: (m) => `
        <div class="ms-card">
            ${m.image ? `<div class="ms-card-img" style="background-image:url('${escapeHtml(m.image).replace(/'/g,"\\'")}')"></div>` : ''}
            <div class="ms-card-meta">
                <div class="ms-card-host">${escapeHtml(m.hostname)}</div>
                <div class="ms-card-title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="ms-card-desc">${escapeHtml(m.description) || ''}</div>
            </div>
        </div>`,
    bluesky: (m) => `
        <div class="bs-card">
            ${m.image ? `<img src="${escapeHtml(m.image)}" alt="">` : ''}
            <div class="bs-card-meta">
                <div class="bs-card-host">${escapeHtml(m.hostname)}</div>
                <div class="bs-card-title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="bs-card-desc">${escapeHtml(m.description) || ''}</div>
            </div>
        </div>`,
    slack: (m) => `
        <div class="sl-msg">
            <div class="sl-link">${escapeHtml(m.canonical)}</div>
            <div class="sl-card">
                <div class="sl-card-text">
                    <div class="sl-card-site">${escapeHtml(m.siteName || m.hostname)}</div>
                    <div class="sl-card-title">${escapeHtml(m.title) || '(title missing)'}</div>
                    <div class="sl-card-desc">${escapeHtml(m.description) || ''}</div>
                </div>
                ${m.image ? `<div class="sl-card-img" style="background-image:url('${escapeHtml(m.image).replace(/'/g,"\\'")}')"></div>` : ''}
            </div>
        </div>`,
    discord: (m) => `
        <div class="ds-card">
            <div class="ds-card-site">${escapeHtml(m.siteName || m.hostname)}</div>
            <div class="ds-card-title">${escapeHtml(m.title) || '(title missing)'}</div>
            <div class="ds-card-desc">${escapeHtml(m.description) || ''}</div>
            ${m.image ? `<img class="ds-card-img" src="${escapeHtml(m.image)}" alt="">` : ''}
        </div>`,
    reddit: (m) => `
        <div class="rd-card">
            <div class="rd-card-text">
                <div class="rd-card-title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="rd-card-host">${escapeHtml(m.hostname)}</div>
            </div>
            ${m.image ? `<div class="rd-card-img" style="background-image:url('${escapeHtml(m.image).replace(/'/g,"\\'")}')"></div>` : ''}
        </div>`,
    pinterest: (m) => `
        <div class="pn-card">
            ${m.image ? `<img src="${escapeHtml(m.image)}" alt="">` : ''}
            <div class="pn-card-meta">
                <div class="pn-card-title">${escapeHtml(m.title) || '(title missing)'}</div>
                <div class="pn-card-host">${escapeHtml(m.hostname)}</div>
            </div>
        </div>`,
    google: (m) => `
        <div class="gg-result">
            <div class="gg-source">
                <div class="gg-favicon"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(m.hostname)}&sz=64" alt="" onerror="this.style.display='none'"></div>
                <div class="gg-source-info">
                    <div class="gg-source-name">${escapeHtml(m.siteName || m.hostname)}</div>
                    <div class="gg-source-url">${escapeHtml(m.canonical)}</div>
                </div>
            </div>
            <div class="gg-title">${escapeHtml(m.title) || '(title missing)'}</div>
            <div class="gg-desc">${escapeHtml(m.description) || ''}</div>
        </div>`
};

// Enter key in URL input triggers Inspect
document.getElementById('url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inspectCurrent(); }
});
