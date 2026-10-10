import { Page } from 'playwright';

/**
 * Nom réel d'une page/groupe Facebook : og:title sinon <title>, nettoyé des
 * suffixes (« FaceDev | Facebook », « - Accueil ») et des compteurs « (3) ».
 * Retourne null pour le fil d'accueil ou si la page n'expose pas de nom.
 */
export function cleanPageName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw
    .replace(/^\(\d+\)\s*/, '')
    .split('|')[0]
    .replace(/\s+[-–]\s+Accueil\s*$/i, '')
    .replace(/\s+[-–]\s+Facebook\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return null;
  if (/^facebook$/i.test(name)) return null;
  return name.slice(0, 80);
}

export async function readPageName(page: Page): Promise<string | null> {
  try {
    const raw = await page.evaluate(() => {
      const og = document
        .querySelector('meta[property="og:title"]')
        ?.getAttribute('content');
      return (og || document.title || '').trim();
    });
    return cleanPageName(raw);
  } catch {
    return null;
  }
}
