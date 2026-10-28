import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AiCriteria {
  keywords: string[];
  negativeKeywords: string[];
  minPrice?: number | null;
  maxPrice?: number | null;
}

export interface AiAnalysis {
  isMatch: boolean;
  extractedPrice: number | null;
  summary: string | null;
  confidence: number | null;
}

const LLM_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const DEFAULT_NVIDIA_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

const NO_RETRY_RE =
  /(exceeded your current quota|exceeded your available credits|insufficient credit)/i;

export function parseAiAnalysis(payload: string): AiAnalysis {
  const cleaned = payload
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Réponse IA non-JSON: ${cleaned.slice(0, 120)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Réponse IA: JSON non-object');
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.isMatch !== 'boolean') {
    throw new Error('Réponse IA invalide: isMatch doit être un boolean');
  }

  const confidenceRaw =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0;

  return {
    isMatch: obj.isMatch,
    extractedPrice:
      typeof obj.extractedPrice === 'number' && Number.isFinite(obj.extractedPrice)
        ? obj.extractedPrice
        : null,
    summary: typeof obj.summary === 'string' ? obj.summary.slice(0, 500) : '',
    confidence: Math.min(1, Math.max(0, confidenceRaw)),
  };
}

/** Préfixes mobiles malgaches valides (036 exclu). */
const MG_PREFIX = '3(?:[2-5]|[7-9])';
/** Séparateur optionnel entre les groupes de chiffres d'un numéro. */
const MG_SEP = '[\\s.\\-]?';

/**
 * Téléphone malgache : « 0 » (ou « +261 » / « 261 ») suivi de 9 chiffres,
 * préfixe 32-35 ou 37-39. Les séparateurs (espace, point, tiret) sont tolérés.
 */
const MG_PHONE_SOURCE =
  `(?<!\\d)(?:\\+?261|0)${MG_SEP}(${MG_PREFIX})${MG_SEP}(\\d{2})${MG_SEP}(\\d{3})${MG_SEP}(\\d{2})(?!\\d)`;

const LOCAL_PHONE_DIGITS_RE = new RegExp(`^0${MG_PREFIX}`);
const INTL_PHONE_DIGITS_RE = new RegExp(`^${MG_PREFIX}`);

/** Un nombre ressemble-t-il à un numéro de téléphone (ex. 034 12 345 67) ? */
export function looksLikePhone(value: number): boolean {
  const digits = String(Math.trunc(Math.abs(value)));
  if (digits.length === 10) return LOCAL_PHONE_DIGITS_RE.test(digits);
  if (digits.length === 9) return INTL_PHONE_DIGITS_RE.test(digits);
  return false;
}

/** Masque les numéros de téléphone du texte avant l'extraction des prix. */
function maskPhones(text: string): string {
  return text.replace(new RegExp(MG_PHONE_SOURCE, 'g'), ' ');
}

/** Numéro de téléphone malgache trouvé dans le texte, normalisé « 034 12 345 67 ». */
export function detectPhone(text: string): string | null {
  const match = new RegExp(MG_PHONE_SOURCE).exec(text);
  if (!match) return null;
  const [, prefix, a, b, c] = match;
  return `0${prefix} ${a} ${b} ${c}`;
}

/**
 * Convertit un montant écrit à la main en nombre : « 100,000 » et
 * « 1 200 000 » sont des milliers, « 1,5 » reste une décimale.
 */
function parsePriceNumber(raw: string): number | null {
  let value = raw.replace(/[\s\u00A0]/g, '');
  if (/^\d{1,3}(?:,\d{3})+$/.test(value)) {
    value = value.replace(/,/g, '');
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(value)) {
    value = value.replace(/\./g, '');
  } else {
    value = value.replace(',', '.');
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Prix candidats : montants avec devise ou nombres groupés (100,000 / 1 200 000). */
function priceCandidates(text: string): number[] {
  const clean = maskPhones(text);
  const patterns = [
    /(\d[\d\s.,]{0,14})\s*(ariary|ar|€|euros?|\$|usd|mga)(?![a-z])/gi,
    /(€|usd|\$|euros?|mga|ariary)\s*(\d[\d\s.,]{0,14})/gi,
    /(?:^|[^a-z])ar\.?\s*(\d[\d\s.,]{0,14})/gi,
    /(\d{1,3}(?:[\s.,\u00A0]\d{3})+)/g,
  ];
  const values: number[] = [];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const raw = /^\d/.test(match[1] ?? '') ? match[1] : match[2];
      if (!raw) continue;
      const value = parsePriceNumber(raw);
      if (value === null) continue;
      if (looksLikePhone(value)) continue;
      values.push(value);
    }
  }
  return values;
}

/** Prix d'une annonce : le plus grand montant (avec devise ou groupé) du texte. */
export function detectPrice(text: string): number | null {
  const values = priceCandidates(text);
  if (values.length === 0) return null;
  return Math.max(...values);
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly config: ConfigService) { }

  get mockEnabled(): boolean {
    return (
      this.config.get<string>('GEMINI_MOCK') === 'true' ||
      this.config.get<string>('AI_MOCK') === 'true'
    );
  }

  /**
   * Priorité : NVIDIA (NVIDIA_MODEL, Nemotron) puis Gemini en secours.
   * Le mock (GEMINI_MOCK/AI_MOCK) court-circuite les deux.
   */
  async analyze(text: string, criteria: AiCriteria): Promise<AiAnalysis> {
    if (this.mockEnabled) return AiService.mockAnalyze(text);

    const failures: string[] = [];

    const nvidiaKey = this.config.get<string>('NVIDIA_API_KEY');
    if (nvidiaKey) {
      const model =
        this.config.get<string>('NVIDIA_MODEL') || DEFAULT_NVIDIA_MODEL;
      try {
        const startedAt = Date.now();
        const result = await this.withRetry(
          'NVIDIA',
          () => this.callNvidia(nvidiaKey, model, text, criteria),
          model,
        );
        this.logger.debug(
          `NVIDIA ${model} OK en ${Date.now() - startedAt} ms (isMatch=${result.isMatch})`,
        );
        return result;
      } catch (err) {
        failures.push(`NVIDIA(${model}): ${(err as Error).message}`);
        this.logger.warn(
          `NVIDIA ${model} en échec — ${(err as Error).message.slice(0, 120)}`,
        );
        this.logger.warn('Repli sur Gemini après échec de NVIDIA');
      }
    }

    const geminiKey = this.config.get<string>('GEMINI_API_KEY');
    if (geminiKey) {
      const model =
        this.config.get<string>('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
      try {
        const startedAt = Date.now();
        const result = await this.withRetry(
          'Gemini',
          () => this.callGemini(geminiKey, model, text, criteria),
          model,
        );
        this.logger.debug(
          `Gemini ${model} OK en ${Date.now() - startedAt} ms (isMatch=${result.isMatch})`,
        );
        return result;
      } catch (err) {
        failures.push(`Gemini: ${(err as Error).message}`);
      }
    }

    if (failures.length === 0) {
      throw new Error(
        'Aucune clé IA configurée (NVIDIA_API_KEY ou GEMINI_API_KEY manquante dans .env)',
      );
    }
    throw new Error(failures.join(' | '));
  }

  private async withRetry(
    provider: string,
    call: () => Promise<AiAnalysis>,
    model: string,
  ): Promise<AiAnalysis> {
    let lastError: Error = new Error(`Appel ${provider} non exécuté`);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await call();
      } catch (err) {
        lastError = err as Error;
        const permanent = NO_RETRY_RE.test(lastError.message);
        const retriable =
          !permanent && /HTTP (429|500|502|503|504)/.test(lastError.message);
        if (!retriable || attempt === MAX_ATTEMPTS) break;
        this.logger.warn(
          `${provider} tentative ${attempt}/${MAX_ATTEMPTS} échouée (${lastError.message.slice(0, 80)}), nouvelle tentative...`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    throw new Error(`${provider} (${model}): ${lastError.message}`);
  }

  private async callNvidia(
    apiKey: string,
    model: string,
    text: string,
    criteria: AiCriteria,
  ): Promise<AiAnalysis> {
    const response = await fetch(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          top_p: 0.95,
          max_tokens: 2048,
          seed: 42,
          stream: false,
          messages: [{ role: 'user', content: this.buildPrompt(text, criteria) }],
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`NVIDIA HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('NVIDIA: réponse vide (sans choices)');

    return parseAiAnalysis(content);
  }

  private async callGemini(
    apiKey: string,
    model: string,
    text: string,
    criteria: AiCriteria,
  ): Promise<AiAnalysis> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: this.buildPrompt(text, criteria) }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const part = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!part) throw new Error('Gemini: réponse vide (sans candidates)');

    return parseAiAnalysis(part);
  }

  private buildPrompt(text: string, criteria: AiCriteria): string {
    const priceRange =
      criteria.minPrice != null || criteria.maxPrice != null
        ? `Prix accepté : entre ${criteria.minPrice ?? 0} et ${criteria.maxPrice ?? 'illimité'}.`
        : 'Aucune contrainte de prix.';

    return [
      'Tu analyses une publication Facebook extraite automatiquement et tu dois dire si elle correspond aux critères de surveillance d\'un utilisateur.',
      '',
      `Mots-clés pertinents : ${criteria.keywords.join(', ')}`,
      `Mots-clés excluants : ${criteria.negativeKeywords.join(', ') || '(aucun)'}`,
      priceRange,
      '',
      'Publication :',
      '"""',
      text.slice(0, 4000),
      '"""',
      '',
      'Réponds STRICTEMENT avec un objet JSON, sans aucun texte avant ou après :',
      '{"isMatch": boolean, "extractedPrice": number|null, "summary": string, "confidence": number}',
      '',
      'Règles :',
      '- isMatch : true uniquement si la publication correspond aux critères (pertinente et non exclue).',
      '- extractedPrice : prix trouvé dans le texte, nombre brut sans devise ; null si absent.',
      '- summary : résumé factuel en une phrase, 300 caractères maximum. Si la publication contient un contact de la personne (téléphone, email, WhatsApp), termine le résumé par ce contact.',
      '- confidence : valeur comprise entre 0 et 1.',
    ].join('\n');
  }

  static mockAnalyze(text: string): AiAnalysis {
    return {
      isMatch: true,
      extractedPrice: detectPrice(text),
      summary: `[MOCK] ${text.slice(0, 150)}`,
      confidence: 0.9,
    };
  }
}
