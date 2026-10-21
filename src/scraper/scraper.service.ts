import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SourceType } from '@prisma/client';
import { Browser, chromium, Page } from 'playwright';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { attachGraphQlCapture, GraphQlCapture } from './graphql-interceptor';
import {
  extractPostsFromDom,
  parseDetailPublishedAt,
  parseDetailSeller,
} from './dom-fallback';
import { stablePostId } from './facebook-json';
import { readPageName } from './page-name';
import { guessSourceType } from '../common/facebook-url';
import {
  ScrapeError,
  ScrapedCandidate,
  ScrapedPost,
  ScrapeResult,
} from './scraper.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pause aléatoire « humaine » entre deux actions (500–2000 ms). */
const humanDelay = () => sleep(500 + Math.floor(Math.random() * 1_500));

@Injectable()
export class ScraperService implements OnModuleDestroy {
  private readonly logger = new Logger(ScraperService.name);
  private browser?: Browser;
  private launching?: Promise<Browser>;

  constructor(private readonly config: ConfigService) {}

  async scrapeSource(
    source: { url: string; type: SourceType },
    options?: { limit?: number; keywords?: string[] },
  ): Promise<ScrapeResult> {
    const startedAt = Date.now();
    const limit = options?.limit ?? this.int('FB_POSTS_LIMIT', 10);
    const keywords = (options?.keywords ?? [])
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword !== '');
    const browser = await this.getBrowser();

    const storageState = this.storageStatePath();
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      screen: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      locale: 'fr-FR',
      timezoneId: 'Indian/Antananarivo',
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      userAgent: this.buildUserAgent(browser.version()),
      ...(storageState && existsSync(storageState) ? { storageState } : {}),
    });
    await context.addInitScript(this.antiDetectionScript());
    const page = await context.newPage();
    const capture = attachGraphQlCapture(page);

    try {
      // Marketplace + mots-clés : une recherche Facebook « Plus récent »
      // par mot-clé, plutôt que la page d'accueil classée par pertinence.
      if (source.type === 'MARKETPLACE' && keywords.length > 0) {
        const candidates = await this.collectMarketplaceSearches(
          page,
          source.url,
          keywords,
          limit,
        );
        const posts = this.toPosts(candidates, limit * keywords.length);

        return {
          sourceUrl: source.url,
          type: source.type,
          posts,
          origin: posts.length > 0 ? 'dom' : 'none',
          durationMs: Date.now() - startedAt,
          pageName: null,
        };
      }

      await this.navigate(page, source.url);
      const pageName = await readPageName(page);

      const candidates = await this.collect(
        page,
        capture,
        limit,
        source.type,
      );
      const posts = this.toPosts(candidates, limit);

      return {
        sourceUrl: source.url,
        type: source.type,
        posts,
        origin: posts.find((post) => post.origin === 'graphql')
          ? 'graphql'
          : posts.length > 0
            ? 'dom'
            : 'none',
        durationMs: Date.now() - startedAt,
        pageName,
      };
    } finally {
      capture.detach();
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }

  async onModuleDestroy() {
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
  }

  private async navigate(page: Page, url: string): Promise<void> {
    const timeout = this.int('FB_NAV_TIMEOUT_MS', 45_000);

    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
    } catch (error) {
      throw new ScrapeError(
        'timeout',
        `Navigation impossible vers ${url}`,
        error,
      );
    }

    const status = response?.status() ?? 0;
    if (status === 404) {
      throw new ScrapeError('not_found', `Source introuvable (404) : ${url}`);
    }
    if (status === 401 || status === 403 || status === 429) {
      throw new ScrapeError(
        'blocked',
        `Facebook a bloqué l'accès (HTTP ${status}) à ${url}`,
      );
    }

    await humanDelay();
    await this.autoScroll(page);

    if (await this.isUnavailable(page)) {
      throw new ScrapeError(
        'not_found',
        `Contenu Facebook indisponible ou supprimé : ${url}`,
      );
    }
  }

  /**
   * Nom réel d'une entité (groupe, page ou profil) : navigation légère sur
   * son URL puis lecture de l'og:title. Retourne null si indisponible.
   */
  async fetchEntityName(url: string): Promise<string | null> {
    const browser = await this.getBrowser();
    const storageState = this.storageStatePath();
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      screen: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      locale: 'fr-FR',
      timezoneId: 'Indian/Antananarivo',
      colorScheme: 'light',
      userAgent: this.buildUserAgent(browser.version()),
      ...(storageState && existsSync(storageState) ? { storageState } : {}),
    });
    await context.addInitScript(this.antiDetectionScript());
    const page = await context.newPage();

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.int('FB_NAV_TIMEOUT_MS', 45_000),
      });
      await humanDelay();
      return await readPageName(page);
    } catch {
      return null;
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }

  /**
   * Facebook affiche « Ce contenu n'est pas disponible » sur la page de
   * remplacement, MAIS une publication du fil peut contenir la même phrase :
   * on ne conclut que si elle est en tête d'une page courte.
   */
  private async isUnavailable(page: Page): Promise<boolean> {
    try {
      const body = await page.innerText('body', { timeout: 3_000 });
      const phrase =
        /ce contenu n[’']est pas disponible|this content isn[’]t available|n[’']est plus disponible|content not available|page introuvable/i;
      if (!phrase.test(body)) return false;
      return phrase.test(body.slice(0, 400)) && body.length < 2_500;
    } catch {
      return false;
    }
  }

  private async autoScroll(page: Page): Promise<void> {
    const steps = Math.max(0, this.int('FB_AUTO_SCROLL_STEPS', 2));
    for (let step = 0; step < steps; step += 1) {
      await page
        .evaluate(() =>
          window.scrollBy(0, Math.round(window.innerHeight * 0.85)),
        )
        .catch(() => undefined);
      await humanDelay();
    }
  }

  private async isLoginWall(page: Page): Promise<boolean> {
    if (/\/(login|checkpoint|recover)\b/.test(page.url())) return true;
    return page
      .locator('input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
  }

  private async collect(
    page: Page,
    capture: GraphQlCapture,
    limit: number,
    type: SourceType,
  ): Promise<ScrapedCandidate[]> {
    // Marketplace n'est pas exposé par le fil GraphQL (seuls des liens
    // sortants le sont) : on lit directement le DOM, qui est la voie validée.
    if (type === 'MARKETPLACE') {
      const domPosts = await extractPostsFromDom(page, type, limit);
      if (domPosts.length > 0) {
        await this.enrichMarketplaceDetails(page, domPosts);
        return domPosts;
      }
    }

    if (capture.posts.length < limit) {
      await this.collectGraphQl(page, capture, limit, type);
    }

    // 2e chance : rechargement complet de la page. Le boot initial peut
    // échouer à déclencher le fil GraphQL (tokens non prêts, JS retardé) ;
    // un reload repart avec un état plus propre et intercepte souvent le flux.
    if (capture.posts.length === 0 && type !== 'MARKETPLACE') {
      this.logger.debug(`GraphQL muet au 1er passage — 2e essai avec reload sur ${page.url()}`);
      await page
        .reload({ waitUntil: 'domcontentloaded', timeout: this.int('FB_NAV_TIMEOUT_MS', 45_000) })
        .catch(() => undefined);
      await humanDelay();
      await this.autoScroll(page);
      await this.collectGraphQl(page, capture, limit, type);
    }

    if (capture.posts.length > 0) return capture.posts;

    this.logger.debug(`Flux GraphQL non intercepté sur ${page.url()} -> repli DOM`);

    let domPosts = await extractPostsFromDom(page, type, limit);
    if (domPosts.length === 0) {
      await sleep(1_500);
      if (capture.posts.length > 0) return capture.posts;
      domPosts = await extractPostsFromDom(page, type, limit);
    }

    if (domPosts.length === 0 && capture.posts.length === 0) {
      if (await this.isLoginWall(page)) {
        throw new ScrapeError(
          'login_required',
          `Session Facebook requise pour ${page.url()} (storageState.json manquant ou expiré)`,
        );
      }
    }

    return domPosts.length > 0 ? domPosts : capture.posts;
  }

  /**
   * Marketplace : une recherche Facebook par mot-clé avec tri « Plus récent »
   * (sortBy=DATE_DESCENDING) → Facebook filtre lui-même sur le mot-clé et
   * remonte les nouvelles annonces en tête, indépendamment de l'accueil.
   */
  private async collectMarketplaceSearches(
    page: Page,
    baseUrl: string,
    keywords: string[],
    limit: number,
  ): Promise<ScrapedCandidate[]> {
    const merged: ScrapedCandidate[] = [];
    const seen = new Set<string>();

    for (const keyword of keywords) {
      try {
        await this.navigate(page, this.marketplaceSearchUrl(baseUrl, keyword));
      } catch (err) {
        this.logger.warn(
          `Recherche Marketplace "${keyword}" impossible : ${(err as Error).message}`,
        );
        continue;
      }

      // Les résultats de recherche mettent parfois ~6 s à se rendre.
      await page
        .locator('a[href*="/marketplace/item/"]')
        .first()
        .waitFor({ timeout: 8_000 })
        .catch(() => undefined);

      const found = await extractPostsFromDom(page, 'MARKETPLACE', limit);
      let added = 0;
      for (const candidate of found) {
        const key =
          candidate.facebookPostId ??
          candidate.url ??
          candidate.text.slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(candidate);
        added += 1;
      }
      this.logger.log(
        `query="${keyword}": ${found.length} annonce(s), ${added} nouvelle(s)`,
      );
      await humanDelay();
    }

    if (merged.length > 0) {
      await this.enrichMarketplaceDetails(page, merged);
    }
    return merged;
  }

  private marketplaceSearchUrl(baseUrl: string, keyword: string): string {
    const parsed = new URL(baseUrl);
    const path = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = path.endsWith('/search') ? path : `${path}/search`;
    parsed.search = '';
    parsed.hash = '';
    parsed.searchParams.set('query', keyword);
    parsed.searchParams.set('sortBy', 'DATE_DESCENDING');
    return parsed.toString();
  }

  /**
   * La grille Marketplace n'expose ni date ni vendeur : on ouvre la page
   * détail de chaque annonce (limité par FB_MKT_DETAIL_MAX, 0 = désactivé)
   * pour lire « Publié il y a … » et « Informations vendeur(se) ».
   */
  private async enrichMarketplaceDetails(
    page: Page,
    posts: ScrapedCandidate[],
  ): Promise<void> {
    const max = this.int('FB_MKT_DETAIL_MAX', posts.length);
    if (max <= 0) return;
    const navTimeout = Math.min(this.int('FB_NAV_TIMEOUT_MS', 45_000), 15_000);

    let visited = 0;
    for (const post of posts) {
      if (visited >= max) break;
      if (!post.url) continue;
      if (post.publishedAt && post.author) continue;

      try {
        await page.goto(post.url, {
          waitUntil: 'domcontentloaded',
          timeout: navTimeout,
        });
        await humanDelay();
        await page
          .getByText(/publié\s+(?:il y a|le|hier|aujourd|dans)/i)
          .first()
          .waitFor({ timeout: 8_000 })
          .catch(() => undefined);
        // La section vendeur arrive au même rendu mais parfois après le reste.
        await page
          .getByText(/informations vendeur\(se\)/i)
          .first()
          .waitFor({ timeout: 4_000 })
          .catch(() => undefined);
        await sleep(400);
        const body = await page
          .innerText('body', { timeout: 3_000 })
          .catch(() => '');

        if (!post.publishedAt) {
          post.publishedAt = parseDetailPublishedAt(body);
        }
        if (!post.author) post.author = parseDetailSeller(body);
        visited += 1;
      } catch {
        this.logger.debug(`Page détail Marketplace inaccessible : ${post.url}`);
      }
    }
  }

  private toPosts(
    candidates: ScrapedCandidate[],
    limit: number,
  ): ScrapedPost[] {
    const posts: ScrapedPost[] = [];
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    const seenTexts = new Set<string>();

    for (const candidate of candidates) {
      const text = candidate.text.trim();
      if (!text) continue;

      const facebookPostId =
        candidate.facebookPostId ??
        (candidate.url ? stablePostId(candidate.url) : undefined) ??
        stablePostId(`${candidate.author ?? ''}|${text.slice(0, 120)}`);

      const fingerprint = text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .slice(0, 120);
      const url = candidate.url;

      if (seenIds.has(facebookPostId)) continue;
      if (url && seenUrls.has(url)) continue;
      if (seenTexts.has(fingerprint)) continue;

      seenIds.add(facebookPostId);
      if (url) seenUrls.add(url);
      seenTexts.add(fingerprint);

      posts.push({
        facebookPostId,
        text,
        origin: candidate.origin,
        url,
        author: candidate.author,
        title: candidate.title,
        price: candidate.price,
        imageUrl: candidate.imageUrl,
        publishedAt: candidate.publishedAt,
      });

      if (posts.length >= limit) break;
    }

    return posts;
  }

  private async collectGraphQl(
    page: Page,
    capture: GraphQlCapture,
    limit: number,
    type: SourceType,
  ): Promise<void> {
    const start = Date.now();
    // Facebook publie les payloads du fil avec du retard : avec la session
    // connectée, la réponse news_feed n'arrive souvent qu'après ~25-45 s
    // (le boot de l'application est lent). On patiente longtemps pour
    // GROUP/PAGE/FEED, mais pas pour Marketplace qui ne passe presque
    // jamais par GraphQL.
    const emptyWait =
      type === 'MARKETPLACE'
        ? 4_000
        : this.int('FB_GRAPHQL_WAIT_MS', 45_000);
    const emptyDeadline = start + emptyWait;
    const deadline = start + this.int('FB_COLLECT_MS', 70_000);
    let lastCount = capture.posts.length;
    let stagnant = 0;
    let ticks = 0;

    while (capture.posts.length < limit) {
      const now = Date.now();
      const hasPosts = capture.posts.length > 0;
      if (now >= deadline) break;
      if (!hasPosts && now >= emptyDeadline) break;
      // Facebook éparpille les réponses utiles sur ~15 s : on patiente plus
      // longtemps avant de conclure qu'il n'y aura rien de plus.
      if (hasPosts && stagnant >= 8) break;

      if (hasPosts) await sleep(1_500);
      else await capture.waitForPosts(1_500);

      ticks += 1;
      if (ticks % 3 === 0) {
        await page
          .evaluate(() =>
            window.scrollBy(0, Math.round(window.innerHeight * 0.85)),
          )
          .catch(() => undefined);
        await humanDelay();
      }

      if (capture.posts.length > lastCount) {
        lastCount = capture.posts.length;
        stagnant = 0;
      } else if (lastCount > 0) {
        stagnant += 1;
      }
    }
  }

  private guessType(url: string): SourceType {
    return guessSourceType(url);
  }

  private storageStatePath(): string | undefined {
    const raw = this.config.get<string>('FB_STORAGE_STATE');
    if (!raw) return undefined;
    return resolve(raw);
  }

  private int(key: string, fallback: number): number {
    const raw = Number(this.config.get(key));
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  }

  /**
   * UA cohérent avec la version RÉELLE du Chromium embarqué. Le nouveau
   * headless ajoute « HeadlessChrome » à l'UA natif : on le remplace par
   * « Chrome » en conservant les mêmes version et plateforme, pour rester
   * aligné avec les Client Hints (sec-ch-ua) émis par le navigateur.
   */
  private buildUserAgent(browserVersion: string): string {
    const major = browserVersion.split('.')[0] ?? '131';
    const platform = process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }

  /**
   * Script injecté avant chaque page. On garde un strict minimum d'overrides,
   * cohérents avec l'OS réel : le nouveau headless fournit déjà des valeurs
   * natives correctes (UA/Client Hints, window.chrome, plugins, permissions).
   * Les fonctions remplacées sont masquées derrière Function.prototype.toString
   * pour rester indiscernables de fonctions natives.
   */
  private antiDetectionScript(): string {
    const vendor = 'Google Inc. (Intel)';
    const renderer =
      process.platform === 'darwin'
        ? 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics OpenGL Engine, OpenGL 4.1)'
        : process.platform === 'win32'
          ? 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)'
          : 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)';

    return `
      (() => {
        const patched = new WeakSet();
        const originalToString = Function.prototype.toString;
        Function.prototype.toString = function toString() {
          if (this === Function.prototype.toString || patched.has(this)) {
            return 'function ' + (this.name || '') + '() { [native code] }';
          }
          return originalToString.call(this);
        };
        patched.add(Function.prototype.toString);

        const hide = (fn, name) => {
          try {
            Object.defineProperty(fn, 'name', { value: name, configurable: true });
          } catch (err) { /* nom non modifiable */ }
          patched.add(fn);
          return fn;
        };

        const VENDOR = ${JSON.stringify(vendor)};
        const RENDERER = ${JSON.stringify(renderer)};
        const patchWebGl = (proto) => {
          if (!proto || typeof proto.getParameter !== 'function') return;
          const original = proto.getParameter;
          proto.getParameter = hide(function getParameter(parameter) {
            if (parameter === 0x9245) return VENDOR;
            if (parameter === 0x9246) return RENDERER;
            return original.call(this, parameter);
          }, 'getParameter');
        };
        patchWebGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
        patchWebGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

        // Headless renvoie « denied » pour les notifications. On réutilise un
        // vrai PermissionStatus (prototype natif) en remplaçant seulement son
        // état par « prompt », comme un profil Chrome neuf.
        if (navigator.permissions && typeof navigator.permissions.query === 'function') {
          const permissions = navigator.permissions;
          const originalQuery = permissions.query.bind(permissions);
          permissions.query = hide(function query(parameters) {
            if (!parameters || parameters.name !== 'notifications') {
              return originalQuery(parameters);
            }
            try {
              return originalQuery({ name: 'geolocation' })
                .then((status) => {
                  try {
                    Object.defineProperty(status, 'state', { value: 'prompt', configurable: true });
                  } catch (err) { /* état non modifiable */ }
                  return status;
                })
                .catch(() => originalQuery(parameters));
            } catch (err) {
              return originalQuery(parameters);
            }
          }, 'query');
        }

        const defineGetter = (target, property, value) => {
          Object.defineProperty(target, property, {
            get: hide(function () { return value; }, 'get ' + property),
            configurable: true,
          });
        };
        defineGetter(window, 'outerWidth', 1366);
        defineGetter(window, 'outerHeight', 985);
        const screenProto = Object.getPrototypeOf(window.screen) || window.screen;
        defineGetter(screenProto, 'availWidth', 1920);
        defineGetter(screenProto, 'availHeight', 1040);
      })();
    `;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = chromium
        .launch({
          headless: this.config.get<string>('FB_HEADLESS') !== 'false',
          // L'ancien headless est détecté par Facebook : l'application reste
          // figée sur l'écran de chargement. Le nouveau mode headless
          // (binaire chromium complet) rend le fil normalement.
          channel: 'chromium',
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--enable-features=NetworkService,NetworkServiceInProcess',
            '--enable-webgl',
            '--use-gl=angle',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--lang=fr-FR',
          ],
        })
        .then((browser) => {
          browser.on('disconnected', () => {
            this.browser = undefined;
          });
          return browser;
        })
        .finally(() => {
          this.launching = undefined;
        });
    }

    this.browser = await this.launching;
    return this.browser;
  }
}
