#!/usr/bin/env node
'use strict';

/**
 * Script de démonstration des modules FB-Alert Tracker.
 *
 * Usage :
 *   node scripts/test-modules.js 1              Module 1 : Scraper Engine (scraping direct)
 *   node scripts/test-modules.js 2              Module 2 : Queue Manager (cron + worker Redis)
 *   node scripts/test-modules.js 3              Module 3 : Filtering & AI (Redis + regex + Gemini)
 *   node scripts/test-modules.js all            Les 3 étapes d'affilée
 *
 * Options :
 *   --url=<url>      URL Facebook ciblée (défaut : groupe FIMTAMA)
 *   --keywords=a,b   Mots-clés du monitor (étape 3, défaut : problème,location,bonsoir)
 *   --mock           IA simulée au lieu de l'appel réel Gemini
 *   --keep           conserver les données créées après le test
 *   -h, --help       afficher cette aide
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const DIST = path.join(BACKEND, 'dist');
const PORT = process.env.TEST_PORT || '3100';
const DEFAULT_URL = 'https://www.facebook.com/groups/225328517492542';
const DEMO_EMAIL = 'demo@test.local';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function usage() {
  const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
  console.log(header.slice(header.indexOf('/**') + 3).trim());
}

function parseArgs(argv) {
  const opts = { step: null, url: DEFAULT_URL, keywords: ['problème', 'location', 'bonsoir'], mock: false, keep: false };
  for (const arg of argv) {
    if (/^(1|2|3|all)$/.test(arg)) opts.step = arg;
    else if (arg.startsWith('--url=')) opts.url = arg.slice(6);
    else if (arg.startsWith('--keywords=')) opts.keywords = arg.slice(11).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--mock') opts.mock = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '-h' || arg === '--help') { usage(); process.exit(0); }
    else { console.error(`${c.red}Argument inconnu : ${arg}${c.reset}`); usage(); process.exit(1); }
  }
  if (!opts.step) { usage(); process.exit(1); }
  return opts;
}

function loadEnv() {
  const envPath = path.join(BACKEND, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .forEach((l) => {
      const i = l.indexOf('=');
      const k = l.slice(0, i).trim();
      const v = l.slice(i + 1).trim().replace(/^"|"$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    });
}

function checkDist() {
  if (!fs.existsSync(path.join(DIST, 'main.js'))) {
    console.error(`${c.red}dist/ introuvable. Lancez d'abord :  npm run build${c.reset}`);
    process.exit(1);
  }
}

function guessType(url) {
  if (url.includes('/groups/')) return 'GROUP';
  if (url.includes('/marketplace')) return 'MARKETPLACE';
  return 'PAGE';
}

function banner(title) {
  console.log(`\n${c.bold}${c.cyan}=== ${title} ===${c.reset}`);
}

function ok(label, extra) {
  console.log(`${c.green}OK  ${c.reset} ${label}${extra ? ` ${c.dim}${extra}${c.reset}` : ''}`);
}

function fail(label, extra) {
  console.log(`${c.red}FAIL${c.reset} ${label}${extra ? ` ${c.dim}${extra}${c.reset}` : ''}`);
}

function check(condition, label, extra) {
  condition ? ok(label, extra) : fail(label, extra);
  return condition;
}

async function waitFor(fn, timeoutMs, intervalMs = 2000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

async function portLibre() {
  try {
    await fetch(`http://localhost:${PORT}/api/monitors`);
    return false;
  } catch {
    return true;
  }
}

function startApp(extraEnv) {
  const child = spawn(process.execPath, [path.join(DIST, 'main.js')], {
    cwd: BACKEND,
    env: { ...process.env, PORT, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const buffer = [];
  const collect = (d) => {
    const text = String(d);
    buffer.push(text);
    process.stdout.write(text);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const logs = () => buffer.join('');
  const stop = async () => {
    child.kill();
    await sleep(1500);
  };
  return { child, logs, stop };
}

async function waitAppReady(app, timeoutMs = 60000) {
  const ready = await waitFor(async () => {
    if (!app.logs().includes('successfully started')) return false;
    try {
      await fetch(`http://localhost:${PORT}/api/monitors`);
      return true;
    } catch {
      return false;
    }
  }, timeoutMs, 1000);
  if (!ready) {
    console.log(`\n${c.red}L'app n'a pas démarré à temps. Derniers logs :${c.reset}`);
    console.log(app.logs().split('\n').slice(-25).join('\n'));
  }
  return !!ready;
}

function prisma() {
  const { PrismaClient } = require('@prisma/client');
  return new PrismaClient();
}

function redis() {
  const IORedis = require('ioredis');
  return new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
}

function truncate(text, n = 90) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

async function cleanup(db, rd) {
  await db.userMonitor.deleteMany({ where: { user: { email: DEMO_EMAIL } } });
  await db.notification.deleteMany({ where: { user: { email: DEMO_EMAIL } } });
  await db.matchedPost.deleteMany({});
  await db.processedPost.deleteMany({});
  await db.source.deleteMany({});
  await db.user.deleteMany({ where: { email: DEMO_EMAIL } });
  const keys = await rd.keys('fb:seen:*');
  if (keys.length) await rd.del(...keys);
}

/* ------------------------------------------------------------------ */
/* ÉTAPE 1 — Module 1 : Scraper Engine                                 */
/* ------------------------------------------------------------------ */
async function step1(opts) {
  banner('ÉTAPE 1 — Module 1 : Scraper Engine (Playwright + GraphQL)');
  console.log(`${c.dim}source : ${opts.url}${c.reset}\n`);

  const { ScraperService } = require(path.join(DIST, 'scraper', 'scraper.service.js'));
  const service = new ScraperService({ get: (key) => process.env[key] });

  const started = Date.now();
  const result = await service.scrapeSource({ url: opts.url, type: guessType(opts.url) });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n${c.bold}Résultat${c.reset} : ${result.posts.length} post(s) — origine ${result.origin} — ${result.durationMs} ms (temps total ${elapsed}s)\n`);

  let withAuthor = 0;
  let withDate = 0;
  for (const [i, post] of result.posts.entries()) {
    if (post.author) withAuthor += 1;
    if (post.publishedAt) withDate += 1;
    console.log(
      `  ${String(i + 1).padStart(2)}. [${post.origin}] ${c.bold}${post.author ?? '(auteur inconnu)'}${c.reset}` +
        `${post.publishedAt ? ` — ${c.cyan}${post.publishedAt.toISOString()}${c.reset}` : ''}` +
        `${post.price != null ? ` — ${c.yellow}${post.price}${c.reset}` : ''}`,
    );
    console.log(`      ${c.dim}${truncate(post.text, 110)}${c.reset}`);
    console.log(`      ${c.dim}${post.url ?? ''}${c.reset}`);
  }

  console.log(`\n${c.dim}ids : ${result.posts.map((p) => p.facebookPostId).join(', ')}${c.reset}`);

  const passed =
    check(result.posts.length > 0, 'au moins 1 post extrait', `(${result.posts.length})`) &&
    check(withAuthor > 0, 'auteurs récupérés', `(${withAuthor}/${result.posts.length})`) &&
    check(withDate > 0, 'dates de publication récupérées', `(${withDate}/${result.posts.length})`);

  console.log(`\n${passed ? c.green + 'ÉTAPE 1 RÉUSSIE' : c.red + 'ÉTAPE 1 ÉCHEC'}${c.reset}`);
  return passed;
}

/* ------------------------------------------------------------------ */
/* ÉTAPE 2 — Module 2 : Queue Manager                                  */
/* ------------------------------------------------------------------ */
async function step2(opts) {
  banner('ÉTAPE 2 — Module 2 : Queue Manager (cron 1 min + BullMQ + worker)');
  console.log(`${c.dim}source : ${opts.url} — l'app va démarrer sur le port ${PORT}${c.reset}`);

  if (!(await portLibre())) {
    console.error(`${c.red}Port ${PORT} occupé. Terminez l'autre instance (Ctrl+C) puis relancez.${c.reset}`);
    return false;
  }

  const db = prisma();
  const rd = redis();
  const app = startApp({ QUEUE_SCHEDULER_ENABLED: 'true' });
  let passed = false;

  try {
    if (!(await waitAppReady(app))) return false;

    const source = await db.source.create({
      data: { url: opts.url, type: guessType(opts.url), checkIntervalMinutes: 5 },
    });
    console.log(`\n${c.dim}source injectée en base (lastScrapedAt=null → due immédiatement) — attente du cron (max 60s)…${c.reset}\n`);

    const scraped = await waitFor(
      async () => {
        const s = await db.source.findUnique({ where: { id: source.id } });
        return s && s.lastScrapedAt ? s : null;
      },
      180000,
    );

    if (!scraped) {
      console.log(`\n${c.red}Aucun scraping en 180s. Logs :${c.reset}`);
      console.log(app.logs().split('\n').slice(-20).join('\n'));
      fail('scraping exécuté par le worker');
      return false;
    }

    const posts = await db.processedPost.findMany({ where: { sourceId: source.id } });
    console.log(`\n${c.bold}Résultat${c.reset} : lastScrapedAt = ${scraped.lastScrapedAt.toISOString()} — ${posts.length} post(s) en base PostgreSQL\n`);

    for (const post of posts.slice(0, 5)) {
      console.log(`  - [${post.facebookPostId}] ${post.author ?? '?'} : ${truncate(post.rawContent, 80)}`);
    }
    if (posts.length > 5) console.log(`  ${c.dim}… et ${posts.length - 5} autres${c.reset}`);

    const logs = app.logs();
    const scheduled = logs.includes('source(s) due(s) enfilée(s)') || logs.includes('enfilé pour la source');
    const workered = logs.includes('post(s) (');
    const dedup = logs.includes('facebook-scraping-queue');

    console.log('');
    passed =
      check(scheduled, 'cron a enfilé le job (SourceSchedulerService)') &&
      check(workered, 'worker a exécuté le scraping (ScrapingWorkerService)') &&
      check(dedup, 'file Redis « facebook-scraping-queue » utilisée') &&
      check(posts.length > 0, 'posts persistés en PostgreSQL', `(${posts.length})`);
  } finally {
    await app.stop();
    if (!opts.keep) {
      await db.processedPost.deleteMany({});
      await db.source.deleteMany({});
      const keys = await rd.keys('fb:seen:*');
      if (keys.length) await rd.del(...keys);
    }
    await db.$disconnect();
    await rd.quit();
  }

  console.log(`\n${passed ? c.green + 'ÉTAPE 2 RÉUSSIE' : c.red + 'ÉTAPE 2 ÉCHEC'}${c.reset}`);
  return passed;
}

/* ------------------------------------------------------------------ */
/* ÉTAPE 3 — Module 3 : Filtering & AI Engine                          */
/* ------------------------------------------------------------------ */
async function step3(opts) {
  banner('ÉTAPE 3 — Module 3 : Filtering & AI (Redis TTL 30 j → regex → Gemini → MatchedPost)');
  const ia = opts.mock ? 'MOCK (simulée)' : `RÉELLE (gemini)`;
  console.log(`${c.dim}source : ${opts.url}`);
  console.log(`mots-clés : ${opts.keywords.join(', ')} — IA : ${ia}${c.reset}`);

  if (!(await portLibre())) {
    console.error(`${c.red}Port ${PORT} occupé. Terminez l'autre instance (Ctrl+C) puis relancez.${c.reset}`);
    return false;
  }

  const db = prisma();
  const rd = redis();

  // État propre : on repart de zéro pour bien observer le pipeline complet.
  const staleKeys = await rd.keys('fb:seen:*');
  if (staleKeys.length) await rd.del(...staleKeys);

  const app = startApp({
    QUEUE_SCHEDULER_ENABLED: 'true',
    GEMINI_MOCK: opts.mock ? 'true' : 'false',
  });
  let passed = false;

  try {
    if (!(await waitAppReady(app))) return false;

    const user = await db.user.upsert({
      where: { email: DEMO_EMAIL },
      update: {},
      create: { email: DEMO_EMAIL, passwordHash: 'demo' },
    });
    const source = await db.source.upsert({
      where: { url: opts.url },
      update: { checkIntervalMinutes: 1, lastScrapedAt: null, status: 'ACTIVE', consecutiveErrors: 0 },
      create: { url: opts.url, type: guessType(opts.url), checkIntervalMinutes: 1 },
    });
    const monitor = await db.userMonitor.upsert({
      where: { userId_sourceId: { userId: user.id, sourceId: source.id } },
      update: { keywords: opts.keywords, negativeKeywords: ['xyzaucunmotcle'], isActive: true },
      create: {
        userId: user.id,
        sourceId: source.id,
        keywords: opts.keywords,
        negativeKeywords: ['xyzaucunmotcle'],
      },
    });

    console.log(`\n${c.dim}monitor créé — attente du scraping + de l'analyse IA (max 3 min)…${c.reset}\n`);

    const analysisLines = () => app.logs().split('\n').filter((l) => l.includes('appel(s) IA'));
    const callsOf = (line) => Number((line.match(/(\d+) appel\(s\) IA/) || [])[1] || 0);

    const analyzed = await waitFor(async () => {
      if (app.logs().includes('exceeded your current quota')) return 'QUOTA';
      const s = await db.source.findUnique({ where: { id: source.id } });
      if (!s || !s.lastScrapedAt) return null;
      return analysisLines().some((l) => callsOf(l) >= 1) ? s : null;
    }, 200000);

    if (analyzed === 'QUOTA') {
      console.log(`\n${c.yellow}Quota Gemini épuisé sur cette clé API (429 "exceeded your current quota").${c.reset}`);
      console.log(`${c.dim}Vérifiez votre plan/billing dans la console Google AI Studio, puis relancez sans --mock.`);
      console.log(`Ou relancez avec --mock pour observer le pipeline avec une IA simulée.${c.reset}`);
      fail('pipeline Module 3 (quota IA)');
      return false;
    }

    if (!analyzed) {
      console.log(`\n${c.red}Analyse non observée. Derniers logs :${c.reset}`);
      console.log(app.logs().split('\n').slice(-25).join('\n'));
      fail('pipeline Module 3 exécuté');
      return false;
    }

    // --- A. Redis ---
    const seenKeys = await rd.keys('fb:seen:*');
    const ttl = seenKeys.length ? await rd.ttl(seenKeys[0]) : 0;
    console.log(`\n${c.bold}A. Dédoublonnage Redis${c.reset} : ${seenKeys.length} clé(s) fb:seen:* — TTL ${ttl} s (~${(ttl / 86400).toFixed(1)} jours)`);

    // --- B/C/D. Filtre + IA + MatchedPost ---
    const processed = await db.processedPost.findMany({ where: { sourceId: source.id } });
    const matched = await db.matchedPost.findMany({
      where: { userMonitorId: monitor.id },
      include: { processedPost: true },
      orderBy: { createdAt: 'asc' },
    });

    console.log(`\n${c.bold}B/C/D. Filtre → IA → enregistrement${c.reset} :`);
    console.log(`  posts scrapés        : ${processed.length}`);
    console.log(`  analysés par l'IA    : ${processed.filter((p) => p.aiSummary).length}`);
    console.log(`  MatchedPost (isMatch): ${matched.length}\n`);

    for (const m of matched) {
      console.log(`  ${c.green}✔${c.reset} confidence ${m.confidence}` +
        `${m.processedPost.extractedPrice != null ? ` — prix ${m.processedPost.extractedPrice}` : ''}`);
      console.log(`    ${c.dim}${truncate(m.processedPost.aiSummary, 110)}${c.reset}`);
    }

    const logLine = analysisLines().find((l) => callsOf(l) >= 1) || '';
    if (logLine) console.log(`\n  ${c.dim}log : ${truncate(logLine.replace(/.*AnalyzerService\]\s*/, ''), 130)}${c.reset}`);

    // --- 2e passage : preuve du dédoublonnage ---
    console.log(`\n${c.dim}attente du 2e passage du cron (intervalle 1 min) pour prouver le dédoublonnage…${c.reset}`);
    const secondLog = await waitFor(async () => {
      const lines = app.logs().split('\n').filter((l) => l.includes('appel(s) IA'));
      return lines.length >= 2 ? lines[1] : null;
    }, 150000);

    let seenSecond = 0;
    if (secondLog) {
      seenSecond = Number((secondLog.match(/(\d+) déjà vu\(s\)/) || [])[1] || 0);
      console.log(`  ${c.dim}${truncate(secondLog.replace(/.*AnalyzerService\]\s*/, ''), 130)}${c.reset}`);
    }

    const matchedAfter = await db.matchedPost.count();

    console.log('');
    passed =
      check(seenKeys.length > 0, 'A. clés fb:seen créées en Redis', `(${seenKeys.length})`) &&
      check(ttl > 2591000, 'A. TTL ~30 jours', `(${ttl}s)`) &&
      check(processed.filter((p) => p.aiSummary).length > 0, 'B/C. posts envoyés à l\'IA (résumé persisté)', `(${processed.filter((p) => p.aiSummary).length})`) &&
      check(matched.length > 0, 'D. MatchedPost enregistrés', `(${matched.length})`) &&
      check(!!secondLog && seenSecond > 0, '2e passage : posts déjà vus abandonnés', secondLog ? `(${seenSecond} déjà vu(s))` : '(2e log introuvable)') &&
      check(matchedAfter === matched.length, 'pas de doublon après le 2e passage', `(${matchedAfter})`);
  } finally {
    await app.stop();
    if (!opts.keep) await cleanup(db, rd);
    await db.$disconnect();
    await rd.quit();
  }

  console.log(`\n${passed ? c.green + 'ÉTAPE 3 RÉUSSIE' : c.red + 'ÉTAPE 3 ÉCHEC'}${c.reset}`);
  return passed;
}

/* ------------------------------------------------------------------ */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  loadEnv();
  checkDist();

  const results = {};
  if (opts.step === '1' || opts.step === 'all') results[1] = await step1(opts);
  if (opts.step === '2' || opts.step === 'all') results[2] = await step2(opts);
  if (opts.step === '3' || opts.step === 'all') results[3] = await step3(opts);

  banner('RÉSUMÉ');
  for (const [step, passed] of Object.entries(results)) {
    console.log(`  Module ${step} : ${passed ? c.green + 'RÉUSSIE' : c.red + 'ÉCHEC'}${c.reset}`);
  }
  if (!opts.keep) console.log(`${c.dim}  (données de test nettoyées — utilisez --keep pour les conserver)${c.reset}`);
  console.log('');

  const allPassed = Object.values(results).every(Boolean);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${c.red}Erreur fatale : ${err.stack || err.message}${c.reset}`);
  process.exit(1);
});
