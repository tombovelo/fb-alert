import { Page } from 'playwright';
import { SourceType } from '@prisma/client';
import { ScrapedCandidate } from './scraper.types';
import {
  normalizeFacebookUrl,
  parsePriceFromText,
  postIdFromUrl,
  stablePostId,
} from './facebook-json';

const POST_LINK_SELECTOR =
  'a[href*="/posts/"], a[href*="story_fbid="], a[href*="/photos/"], a[href*="/videos/"], a[href*="/permalink/"]';

const MARKETPLACE_LINK_SELECTOR = 'a[href*="/marketplace/item/"]';

interface DomArticle {
  text: string;
  href: string | null;
  timeText: string;
  author: string;
  imageUrl: string | null;
  hasMessage: boolean;
  linkCount: number;
}

/**
 * Repli sur le DOM lorsque le flux GraphQL n'a pas été intercepté.
 * Cible les conteneurs ARIA div[role="article"] et les liens d'horodatage.
 */
export async function extractPostsFromDom(
  page: Page,
  type: SourceType,
  limit = 20,
): Promise<ScrapedCandidate[]> {
  if (type === 'MARKETPLACE') {
    return extractMarketplace(page, limit);
  }
  return extractFeedPosts(page, limit);
}

async function extractFeedPosts(
  page: Page,
  limit: number,
): Promise<ScrapedCandidate[]> {
  const articles = page.locator('div[role="article"]');
  const count = Math.min(await articles.count().catch(() => 0), limit * 2);
  const candidates: ScrapedCandidate[] = [];

  for (let index = 0; index < count && candidates.length < limit; index += 1) {
    const handle = await articles.nth(index).elementHandle().catch(() => null);
    if (!handle) continue;

    const dom = await page
      .evaluate((element) => {
        const root = element as HTMLElement;
        const message = root.querySelector<HTMLElement>(
          '[data-testid="post_message"], [data-ad-comet-preview="message"]',
        );
        const links = Array.from(
          root.querySelectorAll<HTMLAnchorElement>(
            'a[href*="/posts/"], a[href*="story_fbid="], a[href*="/photos/"], a[href*="/videos/"], a[href*="/permalink/"]',
          ),
        );
        const timePattern =
          /(\d+\s*(min|mins|h|j|d|hr|hrs|sem|mois|an)|hier|yesterday|il y a)/i;
        const timeLink = links.find((link) =>
          timePattern.test((link.innerText ?? '').trim()),
        );
        const link = timeLink ?? links[0] ?? null;
        const author = root.querySelector<HTMLAnchorElement>(
          'h3 a, h4 a, h3 span a, [data-testid="post_author"] a',
        );
        const image = root.querySelector<HTMLImageElement>(
          'a[href*="/photos/"] img, a[href*="/videos/"] img, img[srcset]',
        );
        const isAvatar = (value: string | null | undefined): boolean =>
          !!value &&
          /\/t39\.30808-1\/|profile_pic|emoji|rsrc\.php|static\.xx\.fbcdn|s(?:32|40|50|60|80|100|120|160)x(?:32|40|50|60|80|100|120|160)/i.test(
            value,
          );
        let imageUrl = image?.currentSrc || image?.src || null;
        if (!imageUrl || isAvatar(imageUrl)) {
          const better = Array.from(root.querySelectorAll<HTMLImageElement>('img'))
            .map((img) => img.currentSrc || img.src)
            .find((value) => !!value && !isAvatar(value));
          imageUrl = better ?? null;
        }
        return {
          text: (message?.innerText ?? root.innerText ?? '').trim(),
          href: link?.href ?? null,
          timeText: timeLink ? (timeLink.innerText ?? '').trim() : '',
          author: (author?.innerText ?? '').trim(),
          imageUrl,
          hasMessage: Boolean(message),
          linkCount: links.length,
        };
      }, handle)
      .catch(() => null);
    if (!dom) continue;
    await handle.dispose().catch(() => undefined);

    const candidate = toFeedCandidate(dom);
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

const REPLY_LINE_RE = /^(?:répondre|reply)\s*$/i;

function toFeedCandidate(dom: DomArticle): ScrapedCandidate | null {
  const text = dom.text.trim();
  if (text.length < 10) return null;

  if (!dom.hasMessage) {
    if (dom.linkCount === 0) return null;
    if (text.length < 40) return null;
    const lastLine = text.split('\n').pop() ?? '';
    if (REPLY_LINE_RE.test(lastLine.trim())) return null;
  }

  const url = dom.href ? normalizeFacebookUrl(dom.href) : undefined;
  const facebookPostId =
    (url ? postIdFromUrl(url) : undefined) ??
    (url ? stablePostId(url) : stablePostId(`${dom.author}|${text.slice(0, 120)}`));

  return {
    facebookPostId,
    url,
    author: dom.author || undefined,
    text,
    price: parsePriceFromText(text),
    imageUrl: dom.imageUrl ?? undefined,
    publishedAt: parseRelativeTime(dom.timeText),
    origin: 'dom',
  };
}

async function extractMarketplace(
  page: Page,
  limit: number,
): Promise<ScrapedCandidate[]> {
  const items = page.locator(MARKETPLACE_LINK_SELECTOR);
  const count = Math.min(await items.count().catch(() => 0), limit * 3);
  const candidates: ScrapedCandidate[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < count && candidates.length < limit; index += 1) {
    const handle = await items.nth(index).elementHandle().catch(() => null);
    if (!handle) continue;

    const dom = await page
      .evaluate((element) => {
        const link = element as HTMLAnchorElement;
        const image = link.querySelector<HTMLImageElement>('img');
        return {
          href: link.href,
          text: (link.innerText ?? '').trim(),
          ariaLabel: link.getAttribute('aria-label') ?? '',
          imageUrl: image?.currentSrc || image?.src || null,
        };
      }, handle)
      .catch(() => null);
    await handle.dispose().catch(() => undefined);
    if (!dom?.href) continue;

    const url = normalizeFacebookUrl(dom.href);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const { title, price } = resolveMarketplaceFields(
      dom.text,
      dom.ariaLabel,
    );
    if (!title) continue;

    const facebookPostId = postIdFromUrl(url) ?? stablePostId(url);
    candidates.push({
      facebookPostId,
      url,
      text: dom.text || title,
      title,
      price,
      imageUrl: dom.imageUrl ?? undefined,
      origin: 'dom',
    });
  }

  return candidates;
}

const FREE_TEXT_RE =
  /^(?:gratuit(?:e)?|free|none)\b|^0\s*(?:\$|€|usd|fcfa|f\s?cfa|xof|xaf)/i;

export function isFreeText(raw: string): boolean {
  const text = raw.trim();
  return text.length <= 12 && FREE_TEXT_RE.test(text);
}

export function parseMarketplaceAriaLabel(
  raw: string,
): { title: string; price?: number } | null {
  const label = raw.replace(/\u00A0/g, ' ').trim();
  if (!label) return null;

  const withoutId = label.replace(/,\s*annonce\s*\d+\s*$/i, '');
  const parts = withoutId
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  for (let index = 1; index < parts.length; index += 1) {
    if (isFreeText(parts[index])) {
      return { title: parts.slice(0, index).join(', '), price: 0 };
    }
    // Prix strict : sans devise ni nombre groupé, c'est un index ou un modèle
    // ("Peugeot 309"), pas un prix.
    const price = parsePriceFromText(parts[index]);
    if (price !== undefined) {
      return { title: parts.slice(0, index).join(', '), price };
    }
  }

  return { title: parts[0] };
}

export function resolveMarketplaceFields(
  text: string,
  ariaLabel?: string,
): { title: string; price?: number } {
  const fromText = splitMarketplaceText(text);
  const fromAria = ariaLabel ? parseMarketplaceAriaLabel(ariaLabel) : null;

  const ariaTitle = fromAria?.title ?? '';
  const ariaTitleUsable =
    ariaTitle.length > 0 &&
    parsePriceFromText(ariaTitle) === undefined &&
    !/^\d/.test(ariaTitle);
  const textTitleUsable =
    fromText.title.length > 0 && parsePriceFromText(fromText.title) === undefined;

  const title = ariaTitleUsable
    ? ariaTitle
    : textTitleUsable
      ? fromText.title
      : ariaTitle || fromText.title;

  let price = fromText.price !== undefined ? fromText.price : fromAria?.price;
  // "Gratuit" peut être en deuxième ligne après le badge "Annonce récente".
  if (text.split('\n').some((line) => isFreeText(line))) price = 0;

  return { title, price };
}

const BADGE_RE = /^annonce récente$/i;

/**
 * Texte d'une annonce Marketplace : lignes séparées par des retours à la
 * ligne (badge, prix, titre, localisation). Le prix doit contenir une devise
 * ou un nombre groupé, sinon un modèle ("Peugeot 309") serait pris pour un
 * prix.
 */
export function splitMarketplaceText(raw: string): {
  title: string;
  price?: number;
} {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { title: '' };

  const content = lines.filter((line) => !BADGE_RE.test(line));
  if (content.length === 0) return { title: lines[0] };

  const freeIndex = content.findIndex((line) => isFreeText(line));
  if (freeIndex >= 0) {
    const others = content.filter((_, index) => index !== freeIndex);
    return { title: others[0] ?? content[0], price: 0 };
  }

  const priceIndex = content.findIndex(
    (line) => parsePriceFromText(line) !== undefined,
  );
  if (priceIndex === 0) {
    return {
      title: content[1] ?? content[0],
      price: parsePriceFromText(content[0]),
    };
  }
  if (priceIndex > 0) {
    return {
      title: content[0],
      price: parsePriceFromText(content[priceIndex]),
    };
  }

  return { title: content[0] };
}

const RELATIVE_TIME_RE =
  /^(?:il y a\s*)?(\d+|un|une|a|one)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours|heure|heures|j|jr|jrs|day|days|jour|jours|sem|week|weeks|semaine|semaines|mois|month|months|an|yr|year|years)\b/i;

export function parseRelativeTime(raw: string): Date | undefined {
  const text = raw.trim().toLowerCase();
  if (!text) return undefined;
  if (/^(hier|yesterday)$/.test(text)) {
    return new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  const match = text.match(RELATIVE_TIME_RE);
  if (!match) return undefined;

  const amount =
    /^\d+$/.test(match[1]) ? Number(match[1]) : match[1] === 'a' ? 1 : 1;
  const unit = match[2];
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  let ms: number;
  if (/^(min|minute)/.test(unit)) ms = amount * minute;
  else if (/^(h|hr|heure)/.test(unit)) ms = amount * hour;
  else if (/^(j|jr|day|jour)/.test(unit)) ms = amount * day;
  else if (/^(sem|week|semaine)/.test(unit)) ms = amount * week;
  else if (/^(mois|month)/.test(unit)) ms = amount * month;
  else ms = amount * year;

  return new Date(Date.now() - ms);
}

const DETAIL_PUBLISHED_RE =
  /publié\s+(il y a\b[^,.\n]*|hier\b|aujourd[’']hui\b)/i;

export function parseDetailPublishedAt(raw: string): Date | undefined {
  const match = raw.match(DETAIL_PUBLISHED_RE);
  if (match) {
    if (/^aujourd/i.test(match[1])) return new Date();
    return parseRelativeTime(match[1].trim());
  }
  // Sans durée (« Publié dans <lieu> »), Facebook omet l'horodatage quand
  // l'annonce est récente : on date à maintenant.
  if (/publié\s+(?:dans|à)\b/i.test(raw)) return new Date();
  return undefined;
}

const DETAIL_SELLER_NAME_RE =
  /^\s*\n?\s*([^\n]{1,80}?)(?:\s+a rejoint|\s{2,}|\n|$)/i;

export function parseDetailSeller(raw: string): string | undefined {
  const labelRe = /informations vendeur\(se\)/gi;
  let label: RegExpExecArray | null;
  while ((label = labelRe.exec(raw)) !== null) {
    const tail = raw.slice(label.index + label[0].length);
    const nameMatch = tail.match(DETAIL_SELLER_NAME_RE);
    if (!nameMatch) continue;
    const name = nameMatch[1].replace(/\s+/g, ' ').trim();
    if (name && !/^informations\b/i.test(name)) return name;
  }
  return undefined;
}
