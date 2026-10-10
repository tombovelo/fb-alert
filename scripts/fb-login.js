const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const backendRoot = path.resolve(__dirname, '..');
const envPath = path.join(backendRoot, '.env');

function resolveStatePath() {
  const envFile = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const fromEnv =
    process.env.FB_STORAGE_STATE ||
    (envFile.match(/^FB_STORAGE_STATE="?([^"\n]+)"?/m) || [])[1];
  return fromEnv
    ? path.resolve(backendRoot, fromEnv)
    : path.join(backendRoot, 'fb-storage-state.json');
}

const statePath = resolveStatePath();

async function isLoggedIn(context) {
  try {
    const cookies = await context.cookies('https://www.facebook.com');
    return cookies.some((cookie) => cookie.name === 'c_user');
  } catch {
    return false;
  }
}

async function checkExistingSession() {
  if (!fs.existsSync(statePath)) return false;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: statePath });
    const valid = await isLoggedIn(context);
    await context.close();
    return valid;
  } catch {
    return false;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function main() {
  const existing = await checkExistingSession();
  if (existing) {
    console.log(`Session déjà valide : ${statePath}`);
    console.log(
      'Pour vous reconnecter (session expirée), supprimez ce fichier puis relancez la commande.',
    );
    return;
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'fr-FR',
  });
  const page = await context.newPage();
  await page.goto('https://www.facebook.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });

  console.log('Connectez-vous à Facebook dans la fenêtre qui vient de s\'ouvrir.');
  console.log('Ne fermez pas la fenêtre : la session sera enregistrée automatiquement.');

  let saved = false;
  const save = async () => {
    if (saved) return;
    saved = true;
    await context.storageState({ path: statePath });
    const cookies = await context.cookies();
    console.log(`Session enregistrée : ${statePath}`);
    console.log(`${cookies.length} cookies enregistrés (dont c_user / xs).`);
  };

  const interval = setInterval(() => {
    void (async () => {
      try {
        if (!(await isLoggedIn(context))) return;
        clearInterval(interval);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await save();
        console.log('Vous pouvez fermer cette fenêtre, puis relancer vos tests de scraping.');
        await browser.close();
        process.exit(0);
      } catch (error) {
        console.error(`Erreur : ${error.message}`);
      }
    })();
  }, 2_000);

  browser.on('disconnected', () => {
    if (saved) return;
    clearInterval(interval);
    console.error(
      'Fenêtre fermée avant la connexion : aucun cookie enregistré. Relancez la commande.',
    );
    process.exit(1);
  });

  process.on('SIGINT', () => {
    void (async () => {
      clearInterval(interval);
      await save().catch(() => undefined);
      await browser.close().catch(() => undefined);
      process.exit(0);
    })();
  });
}

main().catch((error) => {
  console.error(`Échec : ${error.message}`);
  process.exit(1);
});
