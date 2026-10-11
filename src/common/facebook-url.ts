import { SourceType } from '@prisma/client';

/**
 * Détection du type de source à partir de l'URL Facebook :
 *  - /marketplace/...  -> MARKETPLACE
 *  - /groups/...       -> GROUP
 *  - racine du site (facebook.com/, web.facebook.com/, home.php) -> FEED
 *  - tout le reste (page officielle, profil...) -> PAGE
 */
export function guessSourceType(url: string): SourceType {
  if (url.includes('/marketplace/')) return 'MARKETPLACE';
  if (url.includes('/groups/')) return 'GROUP';
  if (isFeedUrl(url)) return 'FEED';
  return 'PAGE';
}

/** Fil d'actualité : racine d'un hôte facebook.com (avec query éventuelle). */
export function isFeedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)facebook\.com$/i.test(parsed.hostname)) return false;
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return path === '' || path === '/home.php' || path === '/index.html';
  } catch {
    return false;
  }
}

/** Segments de chemin qui désignent une fonctionnalité, pas une entité. */
const RESERVED_SLUGS = new Set([
  'marketplace',
  'watch',
  'gaming',
  'groups',
  'people',
  'pages',
  'reel',
  'photo',
  'photos',
  'videos',
  'posts',
  'permalink.php',
  'profile.php',
  'home.php',
  'index.html',
]);

/**
 * URL canonique du groupe, de la page ou du profil propriétaire d'une
 * publication : /groups/facedev.mg/posts/... -> .../groups/facedev.mg,
 * /permalink.php?id=6157... -> .../profile.php?id=6157..., /reel/... -> undefined.
 */
export function entityUrlFromPost(postUrl: string | null | undefined): string | undefined {
  if (!postUrl) return undefined;
  try {
    const parsed = new URL(postUrl);
    if (!/(^|\.)facebook\.com$/i.test(parsed.hostname)) return undefined;
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (segments[0] === 'groups' && segments[1]) {
      return `https://www.facebook.com/groups/${segments[1]}`;
    }
    if (segments[0] === 'permalink.php') {
      const id = parsed.searchParams.get('id');
      return id ? `https://www.facebook.com/profile.php?id=${id}` : undefined;
    }
    // Page ou profil à identifiant numérique : les permaliens de publication
    // sont en profile.php?id=X&story_fbid=Y — l'entité est profile.php?id=X.
    if (segments[0] === 'profile.php') {
      const id = parsed.searchParams.get('id');
      return id ? `https://www.facebook.com/profile.php?id=${id}` : undefined;
    }

    const first = segments[0];
    if (!first || RESERVED_SLUGS.has(first.toLowerCase())) return undefined;
    if (!/^[A-Za-z0-9._-]+$/.test(first)) return undefined;
    return `https://www.facebook.com/${first}`;
  } catch {
    return undefined;
  }
}

