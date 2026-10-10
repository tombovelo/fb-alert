const { chromium } = require('playwright');

const urls = process.argv.slice(2);
if (urls.length === 0) {
  urls.push('https://facebook.com/groups/472539645069324'); // en erreur
  urls.push('https://web.facebook.com/groups/facedev.mg'); // controle (OK)
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'fr-FR',
    storageState: 'fb-storage-state.json',
  });
  const page = await context.newPage();

  for (const url of urls) {
    let status = 0;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      status = resp ? resp.status() : 0;
    } catch (e) {
      console.log(`${url}\n  ERREUR NAV: ${e.message.split('\n')[0]}`);
      continue;
    }
    await page.waitForTimeout(3000);
    const info = await page.evaluate(() => {
      const pwd = document.querySelector('input[type="password"]');
      const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
      return {
        title: document.title,
        og,
        loginWall: Boolean(pwd) || /\/(login|checkpoint)/.test(location.pathname),
        unavailable: /ce contenu n[’']est pas disponible|n[’']est plus disponible|content isn[’]t available/i.test(
          document.body.innerText.slice(0, 600),
        ),
        bodyStart: document.body.innerText.slice(0, 220).replace(/\s+/g, ' '),
      };
    });
    console.log(`\n${url}`);
    console.log(`  HTTP ${status} | title="${info.title}" | og="${info.og ?? '-'}"`);
    console.log(`  loginWall=${info.loginWall} | indisponible=${info.unavailable}`);
    console.log(`  page: ${info.bodyStart}`);
  }

  await browser.close();
})().catch((e) => console.error('FATAL', e.message));
