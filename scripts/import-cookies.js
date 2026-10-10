const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');
const envPath = path.join(backendRoot, '.env');

const SAME_SITE = {
  no_restriction: 'None',
  unrestricted: 'None',
  lax: 'Lax',
  strict: 'Strict',
  unspecified: 'Lax',
  none: 'None',
};

function resolveOutputPath() {
  const envFile = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const fromEnv =
    process.env.FB_STORAGE_STATE ||
    (envFile.match(/^FB_STORAGE_STATE="?([^"\n]+)"?/m) || [])[1];
  return fromEnv
    ? path.resolve(backendRoot, fromEnv)
    : path.join(backendRoot, 'fb-storage-state.json');
}

function newestMatch(directory, pattern) {
  if (!fs.existsSync(directory)) return undefined;
  const files = fs
    .readdirSync(directory)
    .filter((name) => pattern.test(name))
    .map((name) => {
      const full = path.join(directory, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.full;
}

function resolveInputPath() {
  const fromArgs = process.argv[2];
  if (fromArgs) {
    const full = path.resolve(fromArgs);
    if (!fs.existsSync(full)) {
      throw new Error(`Fichier introuvable : ${full}`);
    }
    return full;
  }
  const inBackend = newestMatch(backendRoot, /^cookies.*\.json$/i);
  if (inBackend) return inBackend;
  const inDownloads = newestMatch(
    path.join(process.env.USERPROFILE || '', 'Downloads'),
    /^cookies.*\.json$/i,
  );
  if (inDownloads) return inDownloads;
  throw new Error(
    'Aucun fichier cookies*.json trouvé. Passez le chemin : npm run fb:import -- "chemin/vers/cookies.json"',
  );
}

function toSeconds(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return -1;
  if (value > 1e12) return Math.floor(value / 1000);
  return Math.floor(value);
}

function convertCookie(cookie) {
  const isSession =
    cookie.session === true ||
    cookie.expires === undefined ||
    cookie.expires === null;
  const sameSite =
    SAME_SITE[String(cookie.sameSite ?? '').toLowerCase()] || 'Lax';

  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    expires: isSession ? -1 : toSeconds(cookie.expires),
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    sameSite,
  };
}

function main() {
  const inputPath = resolveInputPath();
  const outputPath = resolveOutputPath();

  const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed.cookies;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`Export invalide (aucun cookie) : ${inputPath}`);
  }

  const cookies = list
    .filter((cookie) => cookie && cookie.name && cookie.value && cookie.domain)
    .map(convertCookie);

  const missing = ['c_user', 'xs'].filter(
    (name) => !cookies.some((cookie) => cookie.name === name),
  );
  if (missing.length > 0) {
    throw new Error(
      `Cookies essentiels absents : ${missing.join(', ')}. La session Facebook ne fonctionnera pas (ré-exportez depuis facebook.com).`,
    );
  }

  if (fs.existsSync(outputPath)) {
    const backup = `${outputPath}.bak`;
    fs.copyFileSync(outputPath, backup);
    console.log(`Ancien état sauvegardé : ${backup}`);
  }

  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({ cookies, origins: [] }, null, 2)}\n`,
    'utf8',
  );

  const dated = cookies
    .map((cookie) => cookie.expires)
    .filter((expires) => expires > 0)
    .sort((a, b) => a - b);
  const nextExpiry = dated.length > 0 ? new Date(dated[0] * 1000) : undefined;
  const sessionCookie = cookies.find((cookie) => cookie.name === 'xs');
  const sessionExpiry =
    sessionCookie && sessionCookie.expires > 0
      ? new Date(sessionCookie.expires * 1000)
      : undefined;

  console.log(`Source          : ${inputPath}`);
  console.log(`Cookies écrits  : ${cookies.length}`);
  console.log(
    `Essentiels      : c_user, xs présents${
      sessionExpiry ? ` (session valide jusqu'au ${sessionExpiry.toISOString()})` : ''
    }`,
  );
  if (nextExpiry) {
    console.log(`Expiration la plus proche : ${nextExpiry.toISOString()}`);
  }
  console.log(`Écrit dans      : ${outputPath}`);
  console.log(
    'Utilisable immédiatement : le scraper lit FB_STORAGE_STATE depuis .env',
  );
}

try {
  main();
} catch (error) {
  console.error(`Échec : ${error.message}`);
  process.exit(1);
}
