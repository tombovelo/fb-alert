#!/usr/bin/env node
'use strict';

/**
 * FB-Alert Tracker — lancement de la surveillance Facebook en ligne de commande.
 *
 *   node scripts/watch.js <url...> [options]
 *   npm run watch -- <url...> [options]
 *
 * Crée l'utilisateur, la source (PAGE / GROUP / MARKETPLACE détectés
 * automatiquement) et le monitor, puis lance l'application (cron + file +
 * scraping + IA) sauf --no-start.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Mot de passe du compte démo créé par ce script (stocké haché bcrypt).
const DEFAULT_PASSWORD = '12345678';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const HELP = `${C.bold}FB-Alert Tracker — veille Facebook (page, groupe, marketplace)${C.reset}

${C.bold}Usage :${C.reset}
  node scripts/watch.js <url...> [options]
  npm run watch -- <url...> [options]

${C.bold}Exemples :${C.reset}
  node scripts/watch.js https://www.facebook.com/groups/225328517492542
  node scripts/watch.js https://www.facebook.com/NASA --keywords=science,actualité
  node scripts/watch.js https://www.facebook.com/marketplace/1084000000000000 \\
      --keywords=location,problème --interval=10
  node scripts/watch.js <url1> <url2> <url3> --no-start   # créer sans lancer

${C.bold}Options :${C.reset}
  --keywords=a,b,c    mots-clés de veille (défaut : problème,location,bonsoir)
  --negative=a,b      mots-clés exclus (défaut : aucun)
  --interval=N        minutes entre 2 vérifications (défaut : 5)
  --min-price=N       prix minimum extrait (optionnel)
  --max-price=N       prix maximum extrait (optionnel)
  --email=<email>     utilisateur propriétaire (défaut : fb-alert@demo.local)
  --no-start          créer la veille sans lancer l'application
  -h, --help          afficher cette aide

${C.dim}Le type (PAGE / GROUP / MARKETPLACE) est déduit de l'URL.
Contrôles : Ctrl+C arrête proprement l'application.${C.reset}`;

function fail(msg) {
  console.error(`${C.red}Erreur :${C.reset} ${msg}`);
  process.exit(1);
}

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

function parseArgs(argv) {
  const opts = { urls: [], start: true };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    } else if (arg === '--no-start') {
      opts.start = false;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) fail(`option incomplète : ${arg}`);
      const key = arg.slice(2, eq);
      const value = arg.slice(eq + 1);
      if (['keywords', 'negative', 'interval', 'min-price', 'max-price', 'email'].includes(key)) {
        opts[key] = value;
      } else {
        fail(`option inconnue : --${key} (voir --help)`);
      }
    } else {
      opts.urls.push(arg);
    }
  }
  return opts;
}

function guessType(url) {
  if (url.includes('/marketplace/')) return 'MARKETPLACE';
  if (url.includes('/groups/')) return 'GROUP';
  try {
    const parsed = new URL(url);
    const isFacebook = /(^|\.)facebook\.com$/i.test(parsed.hostname);
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    if (isFacebook && (path === '' || path === '/home.php' || path === '/index.html')) {
      return 'FEED';
    }
  } catch {
    /* URL non parsable -> PAGE */
  }
  return 'PAGE';
}

function toList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    // Bind identique à Nest (::, dual-stack) : tester 127.0.0.1 donnerait
    // un faux « libre » quand une instance écoute déjà sur toutes adresses.
    srv.listen(port);
  });
}

function ensureBuild() {
  const mainJs = path.join(ROOT, 'dist', 'main.js');
  if (fs.existsSync(mainJs)) return;
  console.log(`${C.dim}dist/ absent → npm run build…${C.reset}`);
  const res = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (res.status !== 0) fail('échec du build (npm run build)');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.urls.length === 0) {
    console.log(HELP);
    process.exit(1);
  }

  for (const url of opts.urls) {
    if (!/^https?:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(url)) {
      fail(`URL invalide (facebook.com attendu, sous-domaines acceptés) : ${url}`);
    }
  }

  loadEnv();

  const keywords = toList(opts.keywords || 'problème,location,bonsoir');
  const negative = toList(opts.negative);
  const interval = Math.max(1, Number(opts.interval) || 5);
  const email = opts.email || 'fb-alert@demo.local';
  const minPrice = opts['min-price'] !== undefined ? Number(opts['min-price']) : null;
  const maxPrice = opts['max-price'] !== undefined ? Number(opts['max-price']) : null;

  ensureBuild();

  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient();
  const bcrypt = require('bcryptjs');

  console.log(`\n${C.bold}=== Veille Facebook — création des sources ===${C.reset}`);

  const passwordHash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
  const user = await db.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash },
  });

  // Migration de l'ancien mot de passe en clair ('watch-cli') vers bcrypt.
  const migrated = await db.user.updateMany({
    where: { email, passwordHash: 'watch-cli' },
    data: { passwordHash },
  });
  if (migrated.count > 0) {
    console.log(
      `  ${C.green}✔${C.reset} mot de passe migré vers le hash bcrypt (${email})`,
    );
  }

  const created = [];
  for (const url of opts.urls) {
    const type = guessType(url);
    const source = await db.source.upsert({
      where: { url },
      update: { type, status: 'ACTIVE', checkIntervalMinutes: interval },
      create: { url, type, checkIntervalMinutes: interval },
    });
    const monitor = await db.userMonitor.upsert({
      where: { userId_sourceId: { userId: user.id, sourceId: source.id } },
      update: {
        keywords,
        negativeKeywords: negative,
        minPrice,
        maxPrice,
        isActive: true,
      },
      create: {
        userId: user.id,
        sourceId: source.id,
        keywords,
        negativeKeywords: negative,
        minPrice,
        maxPrice,
      },
    });
    created.push({ url, type, source, monitor });
    console.log(
      `  ${C.green}✔${C.reset} ${type.padEnd(11)} ${url}` +
        `${C.dim}  (intervalle ${interval} min, mots-clés : ${keywords.join(', ')})${C.reset}`,
    );
  }

  const total = await db.source.count();
  await db.$disconnect();

  console.log(
    `\n${C.dim}${created.length} source(s) prête(s) — ${total} source(s) au total dans la base.${C.reset}`,
  );

  if (!opts.start) {
    console.log(`${C.yellow}Mode --no-start :${C.reset} l'application n'est pas lancée.`);
    console.log(`${C.dim}Lancez-la avec : npm run start:dev   (ou relancez sans --no-start)${C.reset}\n`);
    return;
  }

  const port = Number(process.env.PORT) || 3000;
  if (!(await portFree(port))) {
    console.log(
      `${C.yellow}Le port ${port} est déjà utilisé :${C.reset} une instance de l'application tourne probablement.`,
    );
    console.log(
      `${C.dim}Elle détectera les nouvelles sources au prochain tick du cron (ou immédiatement si elles sont en retard).${C.reset}\n`,
    );
    return;
  }

  console.log(
    `${C.cyan}▶ Démarrage de l'application${C.reset} ${C.dim}(port ${port}, Ctrl+C pour arrêter)${C.reset}\n`,
  );

  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'main.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  const shutdown = () => {
    if (!child.killed) child.kill('SIGINT');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  child.on('exit', (code) => {
    if (code === 1) {
      console.log(
        `${C.yellow}L'application s'est arrêtée (code 1).${C.reset} ${C.dim}Si le port était repris, une autre instance tourne déjà : vos veilles restent enregistrées et seront traitées par elle.${C.reset}`,
      );
    } else {
      console.log(`\n${C.dim}Application arrêtée (code ${code ?? 0}).${C.reset}`);
    }
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(`${C.red}Erreur :${C.reset} ${err.message}`);
  process.exit(1);
});
