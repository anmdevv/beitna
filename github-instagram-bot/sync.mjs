import { chromium } from 'playwright';

const SITE = String(process.env.BEITNA_SITE_URL || '').replace(/\/$/, '');
const SECRET = String(process.env.BEITNA_CRON_SECRET || '');
const SESSION_ID = String(process.env.INSTAGRAM_SESSIONID || '').trim();
const LIMIT = Math.max(1, Math.min(100, Number(process.env.BATCH_LIMIT || 75)));
const FORCE_SYNC = ['1', 'true', 'yes'].includes(String(process.env.FORCE_SYNC || '').trim().toLowerCase());

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

function consensus(values) {
  const clean = values.filter(Number.isFinite).filter(v => v >= 0).map(v => Math.trunc(v));
  if (!clean.length) return null;
  const counts = new Map();
  for (const value of clean) counts.set(value, (counts.get(value) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) return ranked[0][0];
  const sorted = [...clean].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function directMetric(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const n = toNumber(String(value[key] ?? ''));
    if (n !== null) return n;
  }
  return null;
}

function collectDirectMediaMetrics(media, out) {
  if (!media || typeof media !== 'object') return;
  const likes = directMetric(media, ['like_count', 'likes_count', 'likeCount']);
  const views = directMetric(media, [
    'play_count', 'plays_count', 'total_play_count', 'view_count', 'views_count',
    'video_view_count', 'video_views_count', 'video_play_count', 'ig_play_count',
    'clips_play_count', 'reel_view_count', 'reels_view_count', 'clips_replays_count'
  ]);
  const comments = directMetric(media, ['comment_count', 'comments_count']);
  if (likes !== null) out.likes.push(likes);
  if (views !== null) out.views.push(views);
  if (comments !== null) out.comments.push(comments);

  const edgeLikes = toNumber(String(media.edge_media_preview_like?.count ?? media.edge_liked_by?.count ?? ''));
  const edgeComments = toNumber(String(media.edge_media_to_comment?.count ?? media.edge_media_preview_comment?.count ?? ''));
  if (edgeLikes !== null) out.likes.push(edgeLikes);
  if (edgeComments !== null) out.comments.push(edgeComments);

  const username = cleanUsername(media.owner?.username || media.user?.username || media.author?.username || media.username || '');
  if (username) out.usernames.push(username);
}

function collectTargetMediaObjects(value, shortcode, mediaId, out, depth = 0, seen = new Set()) {
  if (depth > 24 || value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectTargetMediaObjects(item, shortcode, mediaId, out, depth + 1, seen);
    return;
  }

  const codes = [value.shortcode, value.code, value.short_code].filter(Boolean).map(String);
  const ids = [value.pk, value.id, value.media_id].filter(Boolean).map(v => String(v).split('_')[0]);
  const isTarget = (shortcode && codes.includes(String(shortcode))) || (mediaId && ids.includes(String(mediaId)));
  if (isTarget) collectDirectMediaMetrics(value, out);

  for (const child of Object.values(value)) collectTargetMediaObjects(child, shortcode, mediaId, out, depth + 1, seen);
}

function collectAroundToken(text, token, out) {
  const source = String(text || '');
  if (!source || !token) return;
  let offset = 0;
  let hits = 0;
  while (hits < 20) {
    const index = source.indexOf(token, offset);
    if (index < 0) break;
    collectFromText(source.slice(Math.max(0, index - 2500), Math.min(source.length, index + token.length + 5000)), out);
    offset = index + token.length;
    hits += 1;
  }
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
  const trusted = { likes: [], views: [], comments: [], usernames: [] };
  const jsonResponses = [];
  const shortcode = job.externalId || (job.url.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i)?.[1] ?? '');
  const mediaId = shortcodeToMediaId(shortcode);

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
    // Only the target post's meta/DOM context is trusted. Scanning the complete Instagram
    // HTML used to pick numbers from suggested posts and once stored a view count as likes.
    collectFromText(pageData.meta, trusted);
    const articleText = await page.locator('article').first().innerText().catch(() => '');
    collectFromText(articleText, trusted);
    collectAroundToken(pageData.scripts, shortcode, found);
    collectAroundToken(pageData.html, shortcode, found);

    for (const payload of jsonResponses) collectTargetMediaObjects(payload, shortcode, mediaId, trusted);

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

    // Current Instagram web fallback (PolarisPostRootQuery). Instagram retired the older
    // xdt_shortcode_media query in June 2026. Resolve the live document id from the page
    // module when possible, then fall back to the current and previous known ids.
    if (shortcode && best(trusted.views) === null && best(found.views) === null) {
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
            collectAroundToken(graph.text, shortcode, found);
            try { collectTargetMediaObjects(JSON.parse(graph.text), shortcode, mediaId, trusted); } catch { /* keep target text candidates */ }
          }
        } catch { /* try the next GraphQL document id */ }
        if (best(trusted.views) !== null || best(found.views) !== null) break;
      }
    }

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
          if (response.ok()) collectTargetMediaObjects(await response.json(), shortcode, mediaId, trusted);
        } catch { /* keep the public-page result */ }
      }

      // The browser-origin request carries the logged-in Instagram cookies exactly as the web app does.
      try {
        const mediaInfo = await page.evaluate(async mediaId => {
          const response = await fetch(`/api/v1/media/${mediaId}/info/`, {
            credentials: 'include',
            headers: {
              'Accept': '*/*',
              'X-IG-App-ID': '936619743392459',
              'X-ASBD-ID': '129477',
              'X-Requested-With': 'XMLHttpRequest',
            },
          });
          return { status: response.status, text: await response.text() };
        }, mediaId);
        if (mediaInfo.status >= 200 && mediaInfo.status < 300) {
          try { collectTargetMediaObjects(JSON.parse(mediaInfo.text), shortcode, mediaId, trusted); }
          catch { collectAroundToken(mediaInfo.text, shortcode, found); }
        }
      } catch { /* keep other target-specific sources */ }
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
        collectAroundToken(body, shortcode, found);
        try { collectTargetMediaObjects(JSON.parse(body), shortcode, mediaId, trusted); } catch { /* HTML or escaped JSON */ }
      } catch { /* continue with the next public source */ }
    }

    // Last public fallback: locate the same Reel in the owner's Reels grid. The grid frequently
    // exposes a standalone play count on the thumbnail although the permalink page does not.
    if (shortcode && best(trusted.views) === null && best(found.views) === null) {
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
              collectFromText(beforeHover, trusted);
              const standalone = standaloneNumbers(beforeHover).filter(n => n >= 10);
              if (standalone.length === 1) trusted.views.push(standalone[0]);
              else if (standalone.length > 1) trusted.views.push(Math.max(...standalone));

              await target.hover().catch(() => {});
              await profile.waitForTimeout(700);
              const afterHover = await target.evaluate(el => el.parentElement?.parentElement?.innerText || el.parentElement?.innerText || el.innerText || '');
              collectFromText(afterHover, trusted);
            }
            await profile.close();
          } catch { /* a private profile or temporary challenge; try the next username */ }
          if (best(trusted.views) !== null || best(found.views) !== null) break;
        }
        if (best(trusted.views) !== null || best(found.views) !== null) break;
      }
    }

    let likes = consensus(trusted.likes);
    let views = best(trusted.views);
    const comments = consensus(trusted.comments);

    // Use weak target-context candidates only when target-specific sources did not expose a field.
    if (likes === null) likes = consensus(found.likes);
    if (views === null) views = best(found.views);

    // Some Instagram payloads label both engagement numbers as like_count. When two clearly
    // separated target-context values exist, the smaller engagement value is likes and the
    // much larger one is the Reel play count. This also repairs the 817 / 857619 case safely.
    if (views === null) {
      const candidates = [...new Set([...trusted.likes, ...found.likes].filter(Number.isFinite).filter(n => n >= 10))].sort((a, b) => a - b);
      if (candidates.length >= 2) {
        const low = candidates[0];
        const high = candidates[candidates.length - 1];
        if (high >= Math.max(1_000, low * 8)) {
          likes = low;
          views = high;
        }
      }
    }

    // Reliability filters: never store unrelated tiny page counters or swap views/likes.
    if (views !== null && likes !== null && likes >= 20 && views < likes) {
      const swappedLooksPlausible = likes >= Math.max(1_000, views * 8);
      if (swappedLooksPlausible) [views, likes] = [likes, views];
      else views = null;
    }
    if (views !== null && views <= 5 && (likes ?? job.currentLikes ?? 0) >= 20) views = null;
    if (likes !== null && views !== null && likes > views) likes = null;

    if (likes === null && views === null) {
      throw new Error('Instagram did not expose reliable public likes/views in this run.');
    }

    console.log(`  target candidates: likes=[${[...new Set(trusted.likes)].join(',')}] views=[${[...new Set(trusted.views)].join(',')}] weakLikes=[${[...new Set(found.likes)].slice(0, 8).join(',')}] weakViews=[${[...new Set(found.views)].slice(0, 8).join(',')}]`);

    return {
      views,
      likes,
      comments,
      metadata: {
        provider: 'github-playwright',
        pageTitle: pageData.title,
        checkedAt: new Date().toISOString(),
        usedSession: Boolean(SESSION_ID),
        viewCandidates: found.views.length + trusted.views.length,
        likeCandidates: found.likes.length + trusted.likes.length,
        trustedViews: [...new Set(trusted.views)].slice(0, 12),
        trustedLikes: [...new Set(trusted.likes)].slice(0, 12),
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

const queue = await api(`/automation/instagram-jobs?limit=${LIMIT}&force=${FORCE_SYNC ? 1 : 0}`);
if (!queue || queue.success !== true || !Array.isArray(queue.jobs)) {
  throw new Error(`Unexpected Beitna API response. Make sure the v19/v20 API folder is uploaded to the live site. Response: ${JSON.stringify(queue).slice(0, 800)}`);
}
console.log(`Received ${queue.count || 0} Instagram job(s). API server time: ${queue.serverTime || '-'}; candidates: ${queue.candidateCount ?? '-'}; force: ${queue.force ? 'yes' : 'no'}.`);
if (!queue.jobs.length) {
  console.log('No Instagram records are due right now. Scheduled run completed without changes.');
  await browser.close();
  process.exit(0);
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
