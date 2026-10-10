import { Page, Response } from 'playwright';
import { ScrapedCandidate } from './scraper.types';
import {
  CandidateRegistry,
  collectCandidates,
  parseFacebookStream,
} from './facebook-json';

const GRAPHQL_HINT = '/api/graphql/';
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const REGISTRY_LIMIT = 300;

export interface GraphQlCapture {
  posts: ScrapedCandidate[];
  responsesSeen: number;
  waitForPosts: (timeoutMs: number) => Promise<void>;
  detach: () => void;
}

/**
 * Écoute passive des réponses JSON de l'API GraphQL Facebook.
 * Aucune requête n'est émise : on lit uniquement les réponses déjà déclenchées
 * par la navigation (page.on('response')).
 */
export function attachGraphQlCapture(page: Page): GraphQlCapture {
  let notify: (() => void) | undefined;
  const registry = new CandidateRegistry(REGISTRY_LIMIT);

  const capture: GraphQlCapture = {
    posts: registry.posts,
    responsesSeen: 0,
    waitForPosts: (timeoutMs: number) =>
      new Promise<void>((resolve) => {
        if (capture.posts.length > 0) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          notify = undefined;
          resolve();
        }, timeoutMs);
        notify = () => {
          clearTimeout(timer);
          notify = undefined;
          resolve();
        };
      }),
    detach: () => undefined,
  };

  const handler = (response: Response) => {
    void (async () => {
      try {
        if (!response.url().includes(GRAPHQL_HINT)) return;
        const size = Number(response.headers()['content-length'] ?? 0);
        if (size > MAX_PAYLOAD_BYTES) return;

        const raw = await response.text();
        const payloads = parseFacebookStream(raw);
        if (payloads.length === 0) return;

        capture.responsesSeen += 1;

        // La fusion entre réponses se fait dans le registre : un post dont la
        // première apparition n'avait pas de permalien est complété par la
        // suivante, au lieu d'être ignoré comme doublon.
        for (const payload of payloads) {
          registry.addAll(collectCandidates(payload));
        }

        if (capture.posts.length > 0) notify?.();
      } catch {
        /* une réponse illisible n'interrompt pas le scraping */
      }
    })();
  };

  page.on('response', handler);
  capture.detach = () => page.off('response', handler);
  return capture;
}
