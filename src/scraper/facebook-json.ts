import { createHash } from 'crypto';
import { ScrapedCandidate } from './scraper.types';

const ID_KEYS = ['post_id', 'story_id', 'postID', 'post_id_str'];
const URL_KEYS = [
  'url',
  'permalink_url',
  'permalink',
  'href',
  'canonical_url',
  'target_url',
  'share_url',
];
const TIME_KEYS = [
  'creation_time',
  'publish_time',
  'creation_timestamp',
  'timestamp',
  'publish_timestamp',
];
const TEXT_KEYS = ['message', 'text', 'body', 'description'];
const TITLE_KEYS = [
  'marketplace_listing_title',
  'listing_title',
  'listing_title_text',
  'title',
];
const PRICE_NUMBER_KEYS = [
  'price',
  'listing_price',
  'price_amount',
  'amount',
  'formatted_price',
];
const PRICE_STRING_KEYS = [
  'price_string',
  'formatted_price',
  'price_display',
  'price',
];
const AUTHOR_KEYS = [
  'author',
  'actor',
  'user',
  'page',
  'profile',
  'share_actor',
  'actors',
  'authors',
];
const AUTHOR_NAME_KEYS = ['author_name', 'username', 'short_name'];
const IMAGE_KEYS = [
  'image_uri',
  'cover_photo_uri',
  'listing_photos',
  'image',
  'thumbnailUrl',
  'thumbnail_uri',
];

// Devise explicite requise (avec \b pour ne pas avaler "300 articles").
const CURRENCY_WORDS =
  '(?:fcfa|f\\s?cfa|cfa|xof|xaf|gnf|mga|fmg|ar|eur|usd|dinars?|francs?|qar|sar|ngn|dh|mad|da)\\b';
const CURRENCY_SYMBOLS = '(?:€|\\$)';
const CURRENCY_RE = new RegExp(
  '(\\d{1,3}(?:[ .\\u00A0]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)\\s*(?:' +
    CURRENCY_WORDS +
    '|' +
    CURRENCY_SYMBOLS +
    ')',
  'i',
);
const PLAIN_NUMBER_RE =
  /(\b\d{1,3}(?:[ .\u00A0,]\d{3})+(?:[.,]\d{1,2})?\b|\b\d+(?:[.,]\d{1,2})?\b)/;
const GROUPED_NUMBER_RE = /(\b\d{1,3}(?:[ .\u00A0,]\d{3})+(?:[.,]\d{1,2})?\b)/;

const ANTI_XSS_PREFIX = 'for (;;);';

/**
 * Liens jamais retenus comme publication : notifications, messages, profils.
 * `profile.php` n'exclut que les liens de profil purs — les permaliens d'une
 * page à identifiant numérique (`profile.php?id=X&story_fbid=Y`) sont gardés.
 */
const EXCLUDED_URL_RE =
  /\/notifications\/|\/login|\/checkpoint|\/messages\/|\/events\/birthdays|\/friends\/|\/account_status|[?&]notif_id=|[?&]notif_t=|[?&]ref=notif|l\.facebook\.com\/l\.php/i;

const PROFILE_LINK_RE = /profile\.php/i;
const POST_PERMALINK_RE = /story_fbid=|\/posts\//i;

function isExcludedUrl(url: string): boolean {
  if (EXCLUDED_URL_RE.test(url)) return true;
  return PROFILE_LINK_RE.test(url) && !POST_PERMALINK_RE.test(url);
}

const NOTIFICATION_TEXT_RE =
  /a mentionné votre nom|a également commenté|a commenté (?:votre|ce)|c’est l’anniversaire|c'est l'anniversaire|nouveau j’aime|nouveau j'aime|a aimé votre commentaire|a répondu à votre/i;

/** Message système Facebook, jamais du contenu d'auteur. */
const NOISE_TEXT_RE =
  /les commentaires ont été désactivés|les commentaires sont désactivés|commentaires (?:ont été|sont) désactivés/i;

const MIN_TEXT_LENGTH = 15;

export function parseFacebookPayload(raw: string): unknown | null {
  const payloads = parseFacebookStream(raw);
  return payloads[0] ?? null;
}

/**
 * Les réponses GraphQL de Facebook peuvent contenir plusieurs documents JSON
 * concaténés dans une même réponse (flux). On découpe en scannant les accolades
 * équilibrées en respectant les chaînes de caractères.
 */
export function parseFacebookStream(raw: string): unknown[] {
  let text = raw.trim();
  if (text.startsWith(ANTI_XSS_PREFIX)) {
    text = text.slice(ANTI_XSS_PREFIX.length);
  }

  const payloads: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          payloads.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          /* fragment illisible : ignoré, on continue le scan */
        }
        start = -1;
      }
    }
  }

  return payloads;
}

export function normalizeFacebookUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw, 'https://www.facebook.com');
    url.hash = '';
    if (url.pathname.includes('/marketplace/item/')) {
      url.search = '';
      return url.toString();
    }
    // Un même post de groupe est exposé en /permalink/ et en /posts/ :
    // on canonnise pour que le dédoublonnage les reconnaisse.
    const groupPost = url.pathname.match(/^(\/groups\/[^/]+)\/permalink\/(\d+)\/?$/);
    if (groupPost) {
      url.pathname = `${groupPost[1]}/posts/${groupPost[2]}/`;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (
        /^(__cft__|__tn__|__hstc|__hsfp|mibextid|rdid|share_plid|comment_id|reply_comment_id|reply|notif_id|notif_t|notification_id|ref|referral_code|__mref|hc_ref)$/i.test(
          key,
        )
      ) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function postIdFromUrl(url: string): string | undefined {
  const pfbid = url.match(/pfbid[0-9A-Za-z]+/);
  if (pfbid) return pfbid[0];
  const story = url.match(/story_fbid=(\d+)/);
  if (story) return `fb_${story[1]}`;
  const postPath = url.match(/\/posts\/(\d+)/);
  if (postPath) return `fb_${postPath[1]}`;
  const reel = url.match(/\/reel\/(\d+)/);
  if (reel) return `fb_${reel[1]}`;
  const photo = url.match(/\/photos\/(?:[^/]+\.)?(\d+)/);
  if (photo) return `fb_${photo[1]}`;
  const marketplace = url.match(/\/marketplace\/item\/(\d+)/);
  if (marketplace) return `mkt_${marketplace[1]}`;
  const video = url.match(/\/videos\/(?:[^/]+\.)?(\d+)/);
  if (video) return `fb_${video[1]}`;
  return undefined;
}

export function stablePostId(seed: string): string {
  return `hash_${createHash('sha1').update(seed).digest('hex').slice(0, 24)}`;
}

/**
 * Les identifiants numériques (post_id brut) et ceux déduits d'une URL
 * (/posts/123 -> fb_123) doivent converger vers la même clé, sinon un même
 * post est collecté deux fois.
 */
export function normalizePostId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return /^\d+$/.test(raw) ? `fb_${raw}` : raw;
}

export function parsePrice(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    return input;
  }
  if (typeof input !== 'string') return undefined;
  const text = input.replace(/\u00A0/g, ' ');
  const match = text.match(CURRENCY_RE) ?? text.match(PLAIN_NUMBER_RE);
  if (!match?.[1]) return undefined;
  const numeric = normalizeNumber(match[1]);
  return numeric > 0 ? numeric : undefined;
}

/**
 * Prix détecté dans un texte libre (post / titre) : uniquement lorsqu'une
 * devise est explicite ou que le nombre est groupé (1 200 000), afin de ne pas
 * confondre les dates, numéros de version ou identifiants avec un prix.
 */
export function parsePriceFromText(raw: string): number | undefined {
  const text = raw.replace(/\u00A0/g, ' ');
  const currency = text.match(CURRENCY_RE);
  if (currency?.[1]) return normalizeNumber(currency[1]);

  const grouped = text.match(GROUPED_NUMBER_RE);
  if (grouped?.[1]) {
    const numeric = normalizeNumber(grouped[1]);
    return numeric > 0 ? numeric : undefined;
  }
  return undefined;
}

function normalizeNumber(raw: string): number {
  let value = raw.replace(/[\s\u00A0]/g, '');
  if (value.includes(',') && value.includes('.')) {
    value = value.lastIndexOf(',') > value.lastIndexOf('.')
      ? value.replace(/\./g, '').replace(',', '.')
      : value.replace(/,/g, '');
  } else if (value.includes(',')) {
    const parts = value.split(',');
    value = parts.length === 2 && parts[1].length <= 2
      ? value.replace(',', '.')
      : value.replace(/,/g, '');
  } else if (/\.\d{3}$/.test(value)) {
    value = value.replace(/\./g, '');
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Regroupe les doublons d'un même post : Facebook expose le même identifiant
 * dans plusieurs objets du JSON (Story avec permalien, feedback, plugin de
 * commentaire). On fusionne les champs plutôt que d'ignorer les suivants,
 * afin de compléter l'URL, l'auteur ou la date manquants sur le premier.
 */
export class CandidateRegistry {
  readonly posts: ScrapedCandidate[] = [];
  private readonly byId = new Map<string, ScrapedCandidate>();
  private readonly byUrl = new Map<string, ScrapedCandidate>();

  constructor(private readonly limit = 60) {}

  add(candidate: ScrapedCandidate): void {
    const existing = this.lookup(candidate);
    if (existing) {
      mergeCandidate(existing, candidate);
      this.index(existing);
      return;
    }
    if (this.posts.length >= this.limit) return;
    this.posts.push(candidate);
    this.index(candidate);
  }

  addAll(candidates: Iterable<ScrapedCandidate>): void {
    for (const candidate of candidates) this.add(candidate);
  }

  private lookup(candidate: ScrapedCandidate): ScrapedCandidate | undefined {
    if (candidate.facebookPostId) {
      const byId = this.byId.get(candidate.facebookPostId);
      if (byId) return byId;
    }
    if (candidate.url) return this.byUrl.get(candidate.url);
    return undefined;
  }

  private index(candidate: ScrapedCandidate): void {
    if (candidate.facebookPostId && !this.byId.has(candidate.facebookPostId)) {
      this.byId.set(candidate.facebookPostId, candidate);
    }
    if (candidate.url && !this.byUrl.has(candidate.url)) {
      this.byUrl.set(candidate.url, candidate);
    }
  }
}

function mergeCandidate(
  target: ScrapedCandidate,
  source: ScrapedCandidate,
): void {
  if (!target.url && source.url) target.url = source.url;
  if (!target.facebookPostId && source.facebookPostId) {
    target.facebookPostId = source.facebookPostId;
  }
  if (!target.author && source.author) target.author = source.author;
  if (!target.title && source.title) target.title = source.title;
  if (target.price === undefined && source.price !== undefined) {
    target.price = source.price;
  }
  if (!target.imageUrl && source.imageUrl) target.imageUrl = source.imageUrl;
  if (!target.publishedAt && source.publishedAt) {
    target.publishedAt = source.publishedAt;
  }
  if (source.text.length > target.text.length) target.text = source.text;
}

export function collectCandidates(
  payload: unknown,
  limit = 60,
): ScrapedCandidate[] {
  const registry = new CandidateRegistry(limit);
  registry.addAll(walkCandidates(payload, limit * 4));
  return registry.posts;
}

function walkCandidates(
  payload: unknown,
  maxRaw: number,
): ScrapedCandidate[] {
  const raw: ScrapedCandidate[] = [];

  const visit = (node: unknown, depth: number): void => {
    if (raw.length >= maxRaw || depth > 40) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const candidate = buildCandidate(node as Record<string, unknown>);
    if (candidate) raw.push(candidate);
    for (const value of Object.values(node as Record<string, unknown>)) {
      visit(value, depth + 1);
    }
  };

  visit(payload, 0);
  return raw;
}

function buildCandidate(obj: Record<string, unknown>): ScrapedCandidate | null {
  const url = firstUrl(obj);
  if (url && isExcludedUrl(url)) return null;
  if (isCommentNode(obj)) return null;

  const facebookPostId = normalizePostId(
    firstString(obj, ID_KEYS) ?? (url ? postIdFromUrl(url) : undefined),
  );

  if (!facebookPostId && !url) return null;

  const text = extractText(obj);
  const title = firstString(obj, TITLE_KEYS);
  if (!text && !title) return null;
  if (NOTIFICATION_TEXT_RE.test(text)) return null;
  if (NOISE_TEXT_RE.test(text)) return null;
  if (
    text.length < MIN_TEXT_LENGTH &&
    (!title || title.length < MIN_TEXT_LENGTH)
  ) {
    return null;
  }

  const price =
    firstNumber(obj, PRICE_NUMBER_KEYS) ??
    parsePrice(firstString(obj, PRICE_STRING_KEYS)) ??
    (title ? parsePriceFromText(title) : undefined) ??
    (text ? parsePriceFromText(text) : undefined);

  const imageUrl = firstImageUrl(obj);

  return {
    facebookPostId,
    url,
    author: extractAuthor(obj),
    text: text || title || '',
    title,
    price,
    imageUrl,
    publishedAt: extractDate(obj),
    origin: 'graphql',
  };
}

function firstString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const nested = deepFindString(value, ['text', 'name', 'title', 'value'], 4);
      if (nested) return nested;
    }
  }
  return undefined;
}

function firstNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parsePrice(value);
      if (parsed) return parsed;
    }
    if (value && typeof value === 'object') {
      const nested = deepFindNumber(value, 3);
      if (nested) return nested;
    }
  }
  return undefined;
}

function firstUrl(obj: Record<string, unknown>): string | undefined {
  for (const key of URL_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && /facebook\.com|fb\.com/i.test(value)) {
      return normalizeFacebookUrl(value);
    }
  }
  for (const value of Object.values(obj)) {
    if (typeof value === 'string' && /\/posts\/|story_fbid=|\/marketplace\/item\//.test(value)) {
      const url = normalizeFacebookUrl(value);
      if (url) return url;
    }
  }
  return undefined;
}

/** Photos de publication (grand format) plutôt que vignettes de profil. */
const POST_IMAGE_RE =
  /\/t39\.30808-(?:6|9|15)\/|p(?:480|720|960)x|s(?:480|720|960)x/i;
/** Avatars, emojis et ressources de l'interface : jamais l'image du post. */
const AVATAR_IMAGE_RE =
  /\/t39\.30808-1\/|profile_pic|emoji|rsrc\.php|static\.xx\.fbcdn|s(?:32|40|50|60|80|100|120|160)x(?:32|40|50|60|80|100|120|160)|\.fb\.keyframes|m1\/v\/t6\//i;
/** Seules les vraies images (CDN Facebook / aperçu de lien) sont retenues. */
const IMAGE_URL_RE =
  /scontent|fbcdn\.net|safe_image\.php|\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i;
/** Pages Facebook (profil, photo, story…) : ce ne sont pas des images. */
const NON_IMAGE_URL_RE =
  /(?:profile|photo|story|permalink|reel|watch|video)\.php|facebook\.com\/(?:groups|profile|photo)/i;
/** Sous-arbres qui n'appartiennent jamais au contenu du post. */
const SKIP_KEY_RE =
  /comment|feedback|ufi|reaction|author|actor|owner|profile|navigation|seo|metadata|suggestion|related/i;
/** Post partagé imbriqué : utilisé seulement si le post n'a pas sa photo. */
const ATTACHED_STORY_RE = /attached_story/i;

function imageScore(url: string): number {
  if (!IMAGE_URL_RE.test(url) || NON_IMAGE_URL_RE.test(url)) return -1;
  if (AVATAR_IMAGE_RE.test(url)) return -1;
  if (POST_IMAGE_RE.test(url)) return 2;
  return 1;
}

function firstImageUrl(obj: Record<string, unknown>): string | undefined {
  for (const key of IMAGE_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && /^https?:\/\//.test(value)) {
      if (imageScore(value) > 0) return value;
    }
    if (Array.isArray(value) && value.length > 0) {
      const nested = firstImageUrl({ image: value[0] });
      if (nested) return nested;
    }
    if (value && typeof value === 'object') {
      const nested = deepFindString(value, ['uri', 'url', 'src'], 3);
      if (nested && /^https?:\/\//.test(nested) && imageScore(nested) > 0) {
        return nested;
      }
    }
  }

  // Parcours en largeur : l'image la plus proche du bloc du post est la
  // sienne ; les images d'un post partagé ou d'un voisin sont plus loin.
  const search = (allowAttachedStory: boolean): string | undefined => {
    const queue: Array<{ node: unknown; depth: number }> = [{ node: obj, depth: 0 }];
    const seen = new Set<unknown>();
    let visited = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth > (allowAttachedStory ? 18 : 14) || visited > 20_000) break;
      const node = current.node;
      if (typeof node === 'string') {
        visited += 1;
        if (/^https?:\/\//.test(node) && imageScore(node) > 0) return node;
        continue;
      }
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      const entries = Array.isArray(node)
        ? node.slice(0, 60).map((item) => ['', item] as const)
        : Object.entries(node as Record<string, unknown>);
      for (const [key, item] of entries) {
        if (key && SKIP_KEY_RE.test(key)) continue;
        if (!allowAttachedStory && key && ATTACHED_STORY_RE.test(key)) continue;
        queue.push({ node: item, depth: current.depth + 1 });
      }
    }
    return undefined;
  };
  // D'abord la photo propre au post ; à défaut, celle du post partagé.
  return search(false) ?? search(true);
}
function extractText(obj: Record<string, unknown>): string {
  for (const key of TEXT_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const nested = deepFindString(value, ['text', 'body', 'content'], 6);
      if (nested) return nested;
    }
  }
  // Les objets "Story" portent le permalien mais stockent le message complet
  // profondément (comet_sections.content.story...message.text). Une copie
  // tronquée existe parfois plus tôt dans l'arbre : on cible "message".
  const message = findContentText(obj, 12);
  if (message) return message;
  // Post sans message : description de pièce jointe, hors commentaires.
  return deepFindString(obj, ['message', 'text'], 8, NON_CONTENT_KEY_RE) ?? '';
}

/** Sous-arbres qui ne contiennent jamais le contenu de la publication. */
const NON_CONTENT_KEY_RE = /comment|feedback|ufi|notice|reaction/i;

/**
 * Recherche le message de la publication en ignorant les commentaires et le
 * bloc de réactions (feedback), qui contiennent eux aussi des champs "text".
 */
function findContentText(node: unknown, depth: number): string | undefined {
  if (depth < 0 || !node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findContentText(item, depth - 1);
      if (found) return found;
    }
    return undefined;
  }

  const obj = node as Record<string, unknown>;
  const message = obj.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  if (message && typeof message === 'object') {
    const nested = deepFindString(message, ['text'], 3);
    if (nested) return nested;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (!value || typeof value !== 'object') continue;
    if (NON_CONTENT_KEY_RE.test(key)) continue;
    const found = findContentText(value, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function isCommentNode(obj: Record<string, unknown>): boolean {
  const typename = obj.__typename;
  if (typeof typename === 'string' && /comment/i.test(typename)) return true;
  return 'legacy_fbid' in obj && 'depth' in obj;
}

function extractAuthor(obj: Record<string, unknown>): string | undefined {
  for (const key of AUTHOR_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const nested = deepFindString(value, ['name', 'short_name', 'username'], 3);
      if (nested) return nested;
    }
  }
  return firstString(obj, AUTHOR_NAME_KEYS);
}

function extractDate(obj: Record<string, unknown>): Date | undefined {
  for (const key of TIME_KEYS) {
    const raw = Number(obj[key]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const ms = raw > 1e12 ? raw : raw * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

function deepFindString(
  node: unknown,
  preferredKeys: string[],
  maxDepth: number,
  skip?: RegExp,
): string | undefined {
  if (maxDepth < 0 || !node || typeof node !== 'object') return undefined;

  if (!Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    for (const key of preferredKeys) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = deepFindString(child, preferredKeys, maxDepth - 1, skip);
      if (found) return found;
    }
    return undefined;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (skip && skip.test(key)) continue;
    const found = deepFindString(value, preferredKeys, maxDepth - 1, skip);
    if (found) return found;
  }
  return undefined;
}

function deepFindNumber(node: unknown, maxDepth: number): number | undefined {
  if (maxDepth < 0 || !node || typeof node !== 'object') return undefined;
  const children = Array.isArray(node)
    ? node
    : Object.values(node as Record<string, unknown>);
  for (const child of children) {
    if (typeof child === 'number' && Number.isFinite(child) && child > 0) {
      return child;
    }
    const found = deepFindNumber(child, maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}
