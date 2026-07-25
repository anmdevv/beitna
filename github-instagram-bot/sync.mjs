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

async function api(path, options = {}) {
  const response = await fetch(`${SITE}/api${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Beitna API ${response.status}: ${data.error || text}`);
  return data;
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
  if (depth > 18 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectKnownNumbers(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [rawKey, child] of Object.entries(value)) {
    const key = rawKey.toLowerCase();
    const n = typeof child === 'number' || typeof child === 'string' ? toNumber(String(child)) : null;
    if (n !== null) {
      if (['like_count', 'likes_count', 'likecount'].includes(key)) out.likes.push(n);
      if (['play_count', 'view_count', 'video_view_count', 'video_play_count', 'ig_play_count', 'clips_play_count'].includes(key)) out.views.push(n);
      if (['comment_count', 'comments_count'].includes(key)) out.comments.push(n);
    }
    if (key === 'edge_media_preview_like' && child && typeof child === 'object') {
      const count = toNumber(String(child.count ?? ''));
      if (count !== null) out.likes.push(count);
    }
    collectKnownNumbers(child, out, depth + 1);
  }
}

function collectFromText(text, out) {
  if (!text) return;
  const patterns = [
    ['likes', /(?:"like_count"|"likes_count"|"likeCount")\s*:\s*"?(\d+)"?/gi],
    ['views', /(?:"play_count"|"view_count"|"video_view_count"|"video_play_count"|"ig_play_count"|"clips_play_count")\s*:\s*"?(\d+)"?/gi],
    ['comments', /(?:"comment_count"|"comments_count")\s*:\s*"?(\d+)"?/gi],
    ['likes', /([\d,.]+\s*[KkMm]?)\s+(?:likes?|إعجاب(?:ات)?)/gi],
    ['views', /([\d,.]+\s*[KkMm]?)\s+(?:views?|plays?|مشاهد(?:ة|ات)?)/gi],
    ['comments', /([\d,.]+\s*[KkMm]?)\s+(?:comments?|تعليقات?)/gi],
  ];
  for (const [bucket, regex] of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const n = toNumber(match[1]);
      if (n !== null) out[bucket].push(n);
    }
  }
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
  const found = { likes: [], views: [], comments: [] };
  const jsonResponses = [];

  page.on('response', async response => {
    const url = response.url();
    if (!/instagram\.com\/(?:api\/v1\/media|graphql\/query|graphql\/web)/i.test(url)) return;
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
      title: document.title || '',
    }));
    collectFromText(pageData.text, found);
    collectFromText(pageData.meta, found);
    collectFromText(pageData.scripts, found);

    for (const payload of jsonResponses) collectKnownNumbers(payload, found);

    // A logged-in browser session can sometimes access the media info JSON for public posts.
    const shortcode = job.externalId || (job.url.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i)?.[1] ?? '');
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
              'Referer': job.url,
            },
          });
          if (response.ok()) collectKnownNumbers(await response.json(), found);
        } catch { /* keep the public-page result */ }
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
      },
    };
  } finally {
    await page.close();
  }
}

const queue = await api(`/automation/instagram-jobs?limit=${LIMIT}`);
if (!queue || queue.success !== true || !Array.isArray(queue.jobs)) {
  throw new Error(`Unexpected Beitna API response. Make sure the v19 api folder is uploaded to the live site. Response: ${JSON.stringify(queue).slice(0, 800)}`);
}
console.log(`Received ${queue.count || 0} Instagram job(s). API server time: ${queue.serverTime || '-'}; candidates: ${queue.candidateCount ?? '-'}.`);
if (!queue.jobs.length) {
  throw new Error('No Instagram jobs were returned. Make sure Instagram links are enabled and saved in video_platform_records, then upload the v19 API patch.');
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'UTC',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

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

await browser.close();
console.log(`Finished: ${succeeded}/${queue.jobs.length} updated.`);
