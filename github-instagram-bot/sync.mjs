import { chromium } from 'playwright';

const SITE = String(process.env.BEITNA_SITE_URL || '').replace(/\/$/, '');
const SECRET = String(process.env.BEITNA_CRON_SECRET || '');
const SESSION_ID = String(process.env.INSTAGRAM_SESSIONID || '').trim();
const LIMIT = Math.max(1, Math.min(50, Number(process.env.BATCH_LIMIT || 25)));

if (!SITE || !SECRET) {
  throw new Error('Missing BEITNA_SITE_URL or BEITNA_CRON_SECRET GitHub secret.');
}

const headers = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'X-Beitna-Key': SECRET,
};

let apiPage;

function parseApiText(text) {
  try { return text ? JSON.parse(text) : {}; }
  catch { return { raw: text }; }
}

function looksLikeInfinityFreeChallenge(text) {
  return /aes\.js|document\.cookie\s*=\s*["']__test=|This site requires Javascript/i.test(String(text || ''));
}

async function warmInfinityFreeSession(targetUrl = `${SITE}/`) {
  await apiPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  // InfinityFree sets the __test cookie in JavaScript and immediately reloads the URL.
  // Give that redirect enough time to finish before the API fetch is retried.
  await apiPage.waitForTimeout(2_500);
}

async function api(path, options = {}) {
  const url = `${SITE}/api${path}`;
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body ?? null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await apiPage.evaluate(async ({ url, method, headers, body }) => {
      const response = await fetch(url, {
        method,
        headers,
        body: body == null ? undefined : body,
        credentials: 'include',
        cache: 'no-store',
      });
      return {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type') || '',
        text: await response.text(),
      };
    }, { url, method, headers: { ...headers, ...(options.headers || {}) }, body });

    if (looksLikeInfinityFreeChallenge(result.text)) {
      console.log(`InfinityFree browser check detected for ${path}; refreshing browser session (attempt ${attempt}/3).`);
      await warmInfinityFreeSession(method === 'GET' ? url : `${SITE}/`);
      continue;
    }

    const data = parseApiText(result.text);
    if (!result.ok) {
      throw new Error(`Beitna API ${result.status}: ${data.error || result.text.slice(0, 500)}`);
    }
    if (!result.contentType.toLowerCase().includes('json') && data.raw !== undefined) {
      throw new Error(`Unexpected Beitna API response: ${String(result.text).slice(0, 800)}`);
    }
    return data;
  }

  throw new Error(`InfinityFree browser verification could not be completed for ${path}.`);
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0660-\u0669]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\u06F0-\u06F9]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[,،\s]/g, '')
    .trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KkMm])?$/);
  if (!match) return null;
  let n = Number(match[1]);
  if (match[2]?.toLowerCase() === 'k') n *= 1_000;
  if (match[2]?.toLowerCase() === 'm') n *= 1_000_000;
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function collectKnownNumbers(value, out, depth = 0) {
  if (depth > 22 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectKnownNumbers(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [rawKey, child] of Object.entries(value)) {
    const key = rawKey.toLowerCase();
    const n = typeof child === 'number' || typeof child === 'string' ? toNumber(String(child)) : null;
    if (n !== null) {
      if (['like_count', 'likes_count', 'likecount', 'likes'].includes(key)) out.likes.push(n);
      if ([
        'play_count', 'plays_count', 'total_play_count', 'view_count', 'views_count', 'views', 'plays',
        'video_view_count', 'video_views_count', 'video_play_count', 'ig_play_count', 'clips_play_count',
        'reel_view_count', 'reels_view_count', 'clips_replays_count', 'video_view_play_count'
      ].includes(key)) out.views.push(n);
      if (['comment_count', 'comments_count', 'comments'].includes(key)) out.comments.push(n);
    }
    if ((key === 'owner' || key === 'user' || key === 'author') && child && typeof child === 'object') {
      const username = String(child.username || child.user_name || '').trim();
      if (username) out.usernames.unshift(username);
    }
    if ((key === 'username' || key === 'user_name') && typeof child === 'string' && /^[A-Za-z0-9._]{1,30}$/.test(child)) {
      out.usernames.push(child);
    }
    if (key === 'edge_media_preview_like' && child && typeof child === 'object') {
      const count = toNumber(String(child.count ?? ''));
      if (count !== null) out.likes.push(count);
    }
    if ((key === 'edge_media_to_comment' || key === 'edge_media_preview_comment') && child && typeof child === 'object') {
      const count = toNumber(String(child.count ?? ''));
      if (count !== null) out.comments.push(count);
    }
    collectKnownNumbers(child, out, depth + 1);
  }
}

function collectFromText(text, out) {
  if (!text) return;
  const source = String(text).replace(/\\u0022/g, '"').replace(/&quot;/g, '"');
  const patterns = [
    ['likes', /["'](?:like_count|likes_count|likeCount|likes)["']\s*:\s*["']?([\d,.]+\s*[KkMm]?)/gi],
    ['views', /["'](?:play_count|plays_count|total_play_count|view_count|views_count|views|plays|video_view_count|video_views_count|video_play_count|ig_play_count|clips_play_count|reel_view_count|clips_replays_count)["']\s*:\s*["']?([\d,.]+\s*[KkMm]?)/gi],
    ['comments', /["'](?:comment_count|comments_count|comments)["']\s*:\s*["']?([\d,.]+\s*[KkMm]?)/gi],
    ['likes', /\\"(?:like_count|likes_count|likeCount|likes)\\"\s*:\s*\\"?([\d,.]+\s*[KkMm]?)/gi],
    ['views', /\\"(?:play_count|plays_count|total_play_count|view_count|views_count|views|plays|video_view_count|video_views_count|video_play_count|ig_play_count|clips_play_count|reel_view_count|clips_replays_count)\\"\s*:\s*\\"?([\d,.]+\s*[KkMm]?)/gi],
    ['comments', /\\"(?:comment_count|comments_count|comments)\\"\s*:\s*\\"?([\d,.]+\s*[KkMm]?)/gi],
    ['likes', /([\d,.]+\s*[KkMm]?)\s+(?:likes?|إعجاب(?:ات)?)/gi],
    ['views', /([\d,.]+\s*[KkMm]?)\s+(?:views?|plays?|reproductions?|مشاهد(?:ة|ات)?|تشغيل(?:ات)?)/gi],
    ['comments', /([\d,.]+\s*[KkMm]?)\s+(?:comments?|تعليقات?)/gi],
    ['likes', /(?:likes?|إعجاب(?:ات)?)\s*[:·-]?\s*([\d,.]+\s*[KkMm]?)/gi],
    ['views', /(?:views?|plays?|مشاهد(?:ة|ات)?|تشغيل(?:ات)?)\s*[:·-]?\s*([\d,.]+\s*[KkMm]?)/gi],
  ];
  for (const [bucket, regex] of patterns) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      const n = toNumber(match[1]);
      if (n !== null) out[bucket].push(n);
    }
  }
}

function standaloneNumbers(text) {
  const values = [];
  for (const token of String(text || '').split(/\s+/)) {
    const n = toNumber(token.replace(/[()]/g, ''));
    if (n !== null) values.push(n);
  }
  return [...new Set(values)];
}

function cleanUsername(value) {
  const username = String(value || '').replace(/^@/, '').trim();
  return /^[A-Za-z0-9._]{1,30}$/.test(username) ? username : '';
}

function best(values) {
  const clean = values.filter(Number.isFinite).filter(v => v >= 0);
  return clean.length ? Math.max(...clean) : null;
}

function shortcodeToMediaId(shortcode) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 0n;
  for (const ch of shortcode || '') {
    const index = alphabet.indexOf(ch);
    if (index < 0) return null;
    id = id * 64n + BigInt(index);
  }
  return id > 0n ? id.toString() : null;
}

async function inspectInstagram(context, job) {
  const page = await context.newPage();
  const found = { likes: [], views: [], comments: [], usernames: [] };
  const jsonResponses = [];

  page.on('response', async response => {
    const url = response.url();
    if (!/instagram\.com\/(?:api\/v1|api\/graphql|graphql|ajax)/i.test(url)) return;
    const type = response.headers()['content-type'] || '';
    if (!type.includes('json')) return;
    try { jsonResponses.push(await response.json()); } catch { /* response body may no longer be available */ }
  });

  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(4_000);

    // Public meta description often contains likes/comments.
    const pageData = await page.evaluate(() => ({
      text: document.body?.innerText || '',
      meta: [...document.querySelectorAll('meta')].map(m => m.content || '').filter(Boolean).join('\n'),
      scripts: [...document.scripts].map(s => s.textContent || '').filter(Boolean).join('\n'),
      html: document.documentElement?.innerHTML || '',
      links: [...document.querySelectorAll('a[href]')].map(a => ({ href: a.getAttribute('href') || '', text: a.textContent || '', aria: a.getAttribute('aria-label') || '' })),
      canonical: document.querySelector('link[rel="canonical"]')?.href || '',
      title: document.title || '',
    }));
    collectFromText(pageData.text, found);
    collectFromText(pageData.meta, found);
    collectFromText(pageData.scripts, found);
    collectFromText(pageData.html, found);

    for (const payload of jsonResponses) collectKnownNumbers(payload, found);

    // Owner username hints from the public page. These are later used to inspect the Reels grid,
    // where Instagram often exposes the play count even when the permalink page only exposes likes.
    const titleUsername = pageData.title.match(/^@?([A-Za-z0-9._]{1,30})\s+(?:on Instagram|• Instagram)/i)?.[1]
      || pageData.meta.match(/@([A-Za-z0-9._]{1,30})/)?.[1]
      || '';
    if (titleUsername) found.usernames.unshift(titleUsername);
    for (const link of pageData.links) {
      const match = link.href.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
      if (match && !['explore', 'accounts', 'reels', 'direct', 'about'].includes(match[1].toLowerCase())) {
        found.usernames.push(match[1]);
      }
    }

    // A logged-in browser session can sometimes access the media info JSON for public posts.
    const shortcode = job.externalId || (job.url.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i)?.[1] ?? '');

    // Current Instagram web fallback (PolarisPostRootQuery). Instagram retired the older
    // xdt_shortcode_media query in June 2026. Resolve the live document id from the page
    // module when possible, then fall back to the current and previous known ids.
    if (shortcode && best(found.views) === null) {
      const graphqlDocIds = await page.evaluate(() => {
        const ids = [];
        try {
          const live = globalThis.require?.('PolarisPostRootQuery')?.params?.id;
          if (live) ids.push(String(live));
        } catch { /* module is not available on every page variant */ }
        ids.push('27128499623469141', '26130443479876713');
        return [...new Set(ids.filter(Boolean))];
      }).catch(() => ['27128499623469141', '26130443479876713']);

      for (const docId of graphqlDocIds) {
        try {
          const graph = await page.evaluate(async ({ shortcode, docId }) => {
            const cookie = Object.fromEntries(document.cookie.split(';').map(part => {
              const index = part.indexOf('=');
              return index < 0 ? [part.trim(), ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
            }));
            let fbDtsg = '';
            try { fbDtsg = String(globalThis.fb_dtsg || ''); } catch { /* ignore */ }
            if (!fbDtsg) fbDtsg = document.querySelector('input[name="fb_dtsg"]')?.value || '';
            if (!fbDtsg) {
              const inline = [...document.scripts].map(s => s.textContent || '').join('\n');
              fbDtsg = inline.match(/"DTSGInitialData"[^}]+"token"\s*:\s*"([^"]+)"/)?.[1]
                || inline.match(/"token"\s*:\s*"([^"]+)"[^}]+"DTSGInitialData"/)?.[1]
                || '';
            }
            const userId = cookie.ds_user_id || '0';
            const body = new URLSearchParams({
              av: userId,
              __d: 'www',
              __user: userId,
              __a: '1',
              __req: '1',
              dpr: String(window.devicePixelRatio || 1),
              __ccg: 'EXCELLENT',
              fb_api_caller_class: 'RelayModern',
              fb_api_req_friendly_name: 'PolarisPostRootQuery',
              variables: JSON.stringify({ shortcode }),
              doc_id: String(docId),
            });
            if (fbDtsg) body.set('fb_dtsg', fbDtsg);
            const headers = {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-IG-App-ID': '936619743392459',
              'X-FB-Friendly-Name': 'PolarisPostRootQuery',
              'X-Requested-With': 'XMLHttpRequest',
            };
            if (cookie.csrftoken) headers['X-CSRFToken'] = cookie.csrftoken;
            const response = await fetch('/api/graphql', {
              method: 'POST',
              headers,
              body: body.toString(),
              credentials: 'include',
            });
            return { status: response.status, text: await response.text() };
          }, { shortcode, docId });
          if (graph.status >= 200 && graph.status < 300) {
            collectFromText(graph.text, found);
            try { collectKnownNumbers(JSON.parse(graph.text), found); } catch { /* keep text candidates */ }
          }
        } catch { /* try the next GraphQL document id */ }
        if (best(found.views) !== null) break;
      }
    }

    const mediaId = shortcodeToMediaId(shortcode);
    if (mediaId) {
      for (const endpoint of [
        `https://www.instagram.com/api/v1/media/${mediaId}/info/`,
        `https://i.instagram.com/api/v1/media/${mediaId}/info/`,
      ]) {
        try {
          const response = await context.request.get(endpoint, {
            timeout: 25_000,
            headers: {
              'Accept': '*/*',
              'X-IG-App-ID': '936619743392459',
              'X-ASBD-ID': '129477',
              'X-Requested-With': 'XMLHttpRequest',
              'Referer': job.url,
            },
          });
          if (response.ok()) collectKnownNumbers(await response.json(), found);
        } catch { /* keep the public-page result */ }
      }
    }

    // Instagram's embed and legacy JSON variants sometimes contain play_count/video_view_count
    // even when the normal permalink only contains likes and comments.
    const fallbackUrls = shortcode ? [
      `https://www.instagram.com/reel/${shortcode}/embed/`,
      `https://www.instagram.com/p/${shortcode}/embed/`,
      `https://www.instagram.com/reel/${shortcode}/?__a=1&__d=dis`,
      `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`,
    ] : [];
    for (const fallbackUrl of fallbackUrls) {
      try {
        const response = await context.request.get(fallbackUrl, {
          timeout: 25_000,
          headers: { 'Accept': '*/*', 'Referer': job.url, 'X-IG-App-ID': '936619743392459' },
        });
        const body = await response.text();
        collectFromText(body, found);
        try { collectKnownNumbers(JSON.parse(body), found); } catch { /* HTML or escaped JSON */ }
      } catch { /* continue with the next public source */ }
    }

    // Last public fallback: locate the same Reel in the owner's Reels grid. The grid frequently
    // exposes a standalone play count on the thumbnail although the permalink page does not.
    if (shortcode && best(found.views) === null) {
      const usernames = [...new Set(found.usernames.map(cleanUsername).filter(Boolean))].slice(0, 5);
      for (const username of usernames) {
        for (const profileUrl of [
          `https://www.instagram.com/${username}/reels/`,
          `https://www.instagram.com/${username}/`,
        ]) {
          try {
            const profile = await context.newPage();
            await profile.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
            await profile.waitForTimeout(3_000);
            let target = profile.locator(`a[href*="/reel/${shortcode}/"], a[href*="/p/${shortcode}/"]`).first();
            for (let scroll = 0; scroll < 7 && await target.count() === 0; scroll += 1) {
              await profile.mouse.wheel(0, 1800);
              await profile.waitForTimeout(1_000);
              target = profile.locator(`a[href*="/reel/${shortcode}/"], a[href*="/p/${shortcode}/"]`).first();
            }
            if (await target.count()) {
              const beforeHover = await target.evaluate(el => {
                let node = el;
                let text = '';
                for (let i = 0; i < 5 && node; i += 1, node = node.parentElement) {
                  text += '\n' + (node.innerText || '') + '\n' + (node.getAttribute?.('aria-label') || '') + '\n' + (node.getAttribute?.('title') || '');
                }
                for (const child of el.querySelectorAll('[aria-label],[title]')) {
                  text += '\n' + (child.getAttribute('aria-label') || '') + '\n' + (child.getAttribute('title') || '');
                }
                return text;
              });
              collectFromText(beforeHover, found);
              const standalone = standaloneNumbers(beforeHover);
              if (standalone.length === 1) found.views.push(standalone[0]);

              await target.hover().catch(() => {});
              await profile.waitForTimeout(700);
              const afterHover = await target.evaluate(el => el.parentElement?.parentElement?.innerText || el.parentElement?.innerText || el.innerText || '');
              collectFromText(afterHover, found);
            }
            await profile.close();
          } catch { /* a private profile or temporary challenge; try the next username */ }
          if (best(found.views) !== null) break;
        }
        if (best(found.views) !== null) break;
      }
    }

    let likes = best(found.likes);
    let views = best(found.views);
    const comments = best(found.comments);

    // Reliability filters: never store unrelated tiny page counters as Reel views.
    if (views !== null && likes !== null && likes >= 20 && views < likes) views = null;
    if (views !== null && views <= 5 && (likes ?? job.currentLikes ?? 0) >= 20) views = null;

    if (likes === null && views === null) {
      throw new Error('Instagram did not expose reliable public likes/views in this run.');
    }

    return {
      views,
      likes,
      comments,
      metadata: {
        provider: 'github-playwright',
        pageTitle: pageData.title,
        checkedAt: new Date().toISOString(),
        usedSession: Boolean(SESSION_ID),
        viewCandidates: found.views.length,
        likeCandidates: found.likes.length,
      },
    };
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'UTC',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

apiPage = await context.newPage();
await warmInfinityFreeSession(`${SITE}/`);

const queue = await api(`/automation/instagram-jobs?limit=${LIMIT}`);
if (!queue || queue.success !== true || !Array.isArray(queue.jobs)) {
  throw new Error(`Unexpected Beitna API response. Make sure the v19/v20 API folder is uploaded to the live site. Response: ${JSON.stringify(queue).slice(0, 800)}`);
}
console.log(`Received ${queue.count || 0} Instagram job(s). API server time: ${queue.serverTime || '-'}; candidates: ${queue.candidateCount ?? '-'}.`);
if (!queue.jobs.length) {
  throw new Error('No Instagram jobs were returned. Make sure Instagram links are enabled and saved in video_platform_records, then upload the v19/v20 API patch.');
}

if (SESSION_ID) {
  await context.addCookies([
    { name: 'sessionid', value: SESSION_ID, domain: '.instagram.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
}

let succeeded = 0;
for (const job of queue.jobs) {
  try {
    const result = await inspectInstagram(context, job);
    await api('/automation/instagram-result', {
      method: 'POST',
      body: JSON.stringify({ recordId: job.recordId, ...result }),
    });
    succeeded += 1;
    console.log(`✓ ${job.externalId || job.recordId}: views=${result.views ?? '-'} likes=${result.likes ?? '-'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await api('/automation/instagram-result', {
      method: 'POST',
      body: JSON.stringify({ recordId: job.recordId, error: message }),
    }).catch(() => {});
    console.log(`✗ ${job.externalId || job.recordId}: ${message}`);
  }
  // Keep the run gentle and reduce temporary blocks.
  await new Promise(resolve => setTimeout(resolve, 1_500));
}

await apiPage.close();
await browser.close();
console.log(`Finished: ${succeeded}/${queue.jobs.length} updated.`);
