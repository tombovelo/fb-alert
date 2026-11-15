export type PriceCurrency = 'ar' | 'eur' | 'usd' | 'unknown';

export interface PriceCandidate {
  raw: string;
  value: number;
  sourceValue: number;
  currency: PriceCurrency;
  originalCurrency: string;
  index: number;
  end: number;
  isCaution: boolean;
  isFee: boolean;
  isPerM2: boolean;
  isArea: boolean;
  isIdentifier: boolean;
  context: string;
  source: string;
}

export type PriceSelectionReason =
  | 'prix au m2'
  | 'prix minimum'
  | 'gratuit'
  | 'aucun prix fiable';

export interface PriceSelection {
  price: number | null;
  candidates: PriceCandidate[];
  reason: PriceSelectionReason;
}

const MAX_AR_PRICE = 100_000_000_000;
const MAX_FOREIGN_PRICE = 1_000_000;

const CURRENCY_SOURCE =
  String.raw`(?:ariary|mga|fmg|francs?|fr|ar|eur(?:os?)?|usd|€|\$)`;
const NUMBER_TOKEN_SOURCE =
  String.raw`(?:\d{1,3}(?:(?:[ \u00A0]+|[.,'’_])\d{3})+(?:[.,]\d{1,2})?|\d{1,4}(?:[ \u00A0]+\d{3})+|\d+(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const GROUPED_TOKEN_SOURCE =
  String.raw`(?:\d{1,3}(?:(?:[ \u00A0]+|[.,'’_])\d{3})+(?:[.,]\d{1,2})?|\d{1,4}(?:[ \u00A0]+\d{3})+|\d+(?:[.,]\d{3})+(?:[.,]\d{1,2})?)`;
const SCALE_UNIT_SOURCE =
  String.raw`(?:milliards?|millions?|mios?|milliers?|milles?|mils?|mille)(?![a-z])`;

const CURRENCY_AFTER_RE = new RegExp(
  String.raw`(?<!\d)(${NUMBER_TOKEN_SOURCE})\s*(${CURRENCY_SOURCE})(?![a-z])`,
  'gi',
);
const CURRENCY_BEFORE_RE = new RegExp(
  String.raw`(?<![a-z])(${CURRENCY_SOURCE})\s*\.?\s*(${NUMBER_TOKEN_SOURCE})(?!\d)`,
  'gi',
);
const GROUPED_RE = new RegExp(
  String.raw`(?<!\d)(?<![a-zA-Z²])(${GROUPED_TOKEN_SOURCE})(?!\d)`,
  'g',
);
const SCALE_RE = new RegExp(
  String.raw`(?<!\d)(\d+(?:[.,]\d+)?)\s*(${SCALE_UNIT_SOURCE})(?:\s*(\d{1,3})(?!\d)\s*(${SCALE_UNIT_SOURCE})?)?`,
  'gi',
);
const M_RE = new RegExp(
  String.raw`(?<!\d)(\d+(?:[.,]\d+)?)\s*[mM](?!\s*[²2](?![0-9]))(?:\s*(\d{1,3})(?!\d))?(?!\s*[²2])(?!\s*(?:mois|m[eè]tres?|metres?|minutes?|mm|cm)\b)(?=\s*(?:${CURRENCY_SOURCE})(?![a-z])|[^a-zA-Z]|$)`,
  'gi',
);

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const IP_OCTET_SOURCE = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|0?\d?\d)`;
const IP_RE = new RegExp(
  String.raw`(?<!\d)(?:${IP_OCTET_SOURCE}\.){3}${IP_OCTET_SOURCE}(?::\d{2,5})?(?!\d)`,
  'g',
);
const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const PHONE_RE =
  /(?<!\d)(?:\+?261|0)\s*3[2-57-9](?:[\s.-]?\d{2})(?:[\s.-]?\d{3})(?:[\s.-]?\d{2})(?!\d)/g;

const CAUTION_RE =
  /\b(?:caution|garantie|avance|acompte|dépôt|depot|arrhes)\b[^.!?\n]{0,30}$/i;
const CAUTION_NEGATED_RE =
  /(?:tsy\s+misy|sans|pas\s+de|aucune?|no)\s+caution\b/i;
const FEE_RE =
  /\b(?:visite|commission|frais|droit|timbre|assurance|dossier|honoraires|pourboire)\b[^.!?\n]{0,30}$/i;
const IDENTIFIER_RE =
  /\b(?:carte|karatra|laharana|numéro|numero|num|matricule|cin|identifiant|id|référence|reference|ref|compte|code|poste)(?![a-zà-ÿ])[^.!?\n]{0,25}$/i;
const IDENTIFIER_AFTER_RE =
  /^\s*(?:de\s+)?(?:carte|karatra|laharana|numéro|numero|num|matricule|cin|identifiant|id|référence|reference|ref|compte|code|poste)(?![a-zà-ÿ])/i;
const FREE_TEXT_RE = /\b(?:gratuit(?:e)?|free|sans frais|tsy misy frais)\b/i;
const PRICE_BEFORE_RE =
  /\b(?:prix|tarif|loyer|louyer|hofany|ofany|hofa)\b[^.!?\n]{0,20}[:=]?\s*$/i;
const IP_CURRENCY_AFTER_RE = new RegExp(
  String.raw`^\s*(?:${CURRENCY_SOURCE})(?![a-z])`,
  'i',
);

function fractionalValue(raw: string, multiplier: number): number {
  return (Number(raw) / 10 ** raw.length) * multiplier;
}

function parseNumberToken(raw: string): number | null {
  let value = raw.replace(/[\s\u00A0'’_]/g, '');
  if (!value) return null;

  if (value.includes(',') && value.includes('.')) {
    const lastComma = value.lastIndexOf(',');
    const lastDot = value.lastIndexOf('.');
    const lastSeparator = Math.max(lastComma, lastDot);
    const lastGroup = value.slice(lastSeparator + 1);
    if (lastGroup.length === 3) {
      value = value.replace(/[.,]/g, '');
    } else if (lastComma > lastDot) {
      value = value.replace(/\./g, '').replace(',', '.');
    } else {
      value = value.replace(/,/g, '');
    }
  } else if (value.includes(',')) {
    const parts = value.split(',');
    value =
      parts.length === 2 && parts[1].length <= 2
        ? value.replace(',', '.')
        : value.replace(/,/g, '');
  } else if (value.includes('.')) {
    const parts = value.split('.');
    value =
      parts.length === 2 && parts[1].length <= 2
        ? value
        : value.replace(/\./g, '');
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCurrency(
  value: number,
  currencyToken: string | null,
): { value: number; currency: PriceCurrency; originalCurrency: string } {
  const token = (currencyToken ?? '').toLowerCase().replace(/\s+/g, '');
  if (['fmg', 'fr', 'franc', 'francs'].includes(token)) {
    return { value: value / 5, currency: 'ar', originalCurrency: token };
  }
  if (['ar', 'ariary', 'mga'].includes(token)) {
    return { value, currency: 'ar', originalCurrency: token };
  }
  if (['€', 'eur', 'euro', 'euros'].includes(token)) {
    return { value, currency: 'eur', originalCurrency: token };
  }
  if (['$', 'usd'].includes(token)) {
    return { value, currency: 'usd', originalCurrency: token };
  }
  return { value, currency: 'unknown', originalCurrency: token };
}

export function isPlausiblePrice(
  value: number,
  currency: PriceCurrency = 'unknown',
): boolean {
  if (!Number.isFinite(value) || value < 1) return false;
  if (currency === 'eur' || currency === 'usd') {
    return value <= MAX_FOREIGN_PRICE;
  }
  return value <= MAX_AR_PRICE;
}

export function parseLoosePriceNumber(raw: string): number | null {
  const text = raw.replace(/\u00A0/g, ' ').trim();
  if (!text || !/^\d[\d\s.,'’_]*$/.test(text)) return null;
  return parseNumberToken(text);
}

export function maskNonPriceText(text: string): string {
  let masked = text.replace(/\u00A0/g, ' ');
  masked = masked.replace(URL_RE, (match) => ' '.repeat(match.length));
  masked = masked.replace(IP_RE, (match, offset: number) => {
    const before = masked.slice(Math.max(0, offset - 35), offset);
    const after = masked.slice(
      offset + match.length,
      offset + match.length + 20,
    );
    if (PRICE_BEFORE_RE.test(before) || IP_CURRENCY_AFTER_RE.test(after)) {
      return match;
    }
    return ' '.repeat(match.length);
  });
  masked = masked.replace(EMAIL_RE, (match) => ' '.repeat(match.length));
  masked = masked.replace(PHONE_RE, (match) => ' '.repeat(match.length));
  return masked;
}

function currencyAt(
  text: string,
  end: number,
): { token: string; length: number } | null {
  const match = text
    .slice(end)
    .match(new RegExp(String.raw`^\s*(${CURRENCY_SOURCE})(?![a-z])`, 'i'));
  if (!match) return null;
  return { token: match[1], length: match[0].length };
}

function scaleMultiplier(unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith('milliard')) return 1_000_000_000;
  if (normalized.startsWith('million') || normalized.startsWith('mio')) {
    return 1_000_000;
  }
  return 1_000;
}

export function extractPriceCandidates(text: string): PriceCandidate[] {
  const sourceText = text.replace(/\u00A0/g, ' ');
  const masked = maskNonPriceText(sourceText);
  const candidates: PriceCandidate[] = [];

  const addCandidate = (
    index: number,
    raw: string,
    sourceValue: number,
    currencyToken: string | null,
    source: string,
  ): void => {
    const normalized = normalizeCurrency(sourceValue, currencyToken);
    if (!isPlausiblePrice(normalized.value, normalized.currency)) return;

    const end = index + raw.length;
    const before = masked
      .slice(Math.max(0, index - 50), index)
      .toLowerCase();
    const after = masked
      .slice(end, Math.min(masked.length, end + 35))
      .toLowerCase();
    const after10 = after.slice(0, 10);

    const isCaution =
      !CAUTION_NEGATED_RE.test(before) && CAUTION_RE.test(before);
    const isFee = FEE_RE.test(before);
    const isPerM2 =
      /^\s*(?:\/|par|au|le)\s*m(?:²|2)(?![a-z0-9])/i.test(after10) ||
      /(?:prix|tarif)[^.!?\n]{0,20}m(?:²|2)\s*[:=]?\s*$/i.test(before);
    const isArea =
      (/^\s*(?:m(?:²|2)|m[eè]tres?(?:\s*carr[eé]s?)?|ares?|ha|hectares?)(?![a-z0-9])/i.test(
        after,
      ) ||
        /\b(?:refy|surface|superficie)\s*[:=]?\s*$/i.test(before)) &&
      !isPerM2;
    const isIdentifier =
      IDENTIFIER_RE.test(before) || IDENTIFIER_AFTER_RE.test(after10);

    candidates.push({
      raw: raw.trim(),
      value: normalized.value,
      sourceValue,
      currency: normalized.currency,
      originalCurrency: normalized.originalCurrency,
      index,
      end,
      isCaution,
      isFee,
      isPerM2,
      isArea,
      isIdentifier,
      context: `${before} ${after}`.replace(/\s+/g, ' ').trim(),
      source,
    });
  };

  for (const match of masked.matchAll(CURRENCY_AFTER_RE)) {
    const value = parseNumberToken(match[1]);
    if (value === null) continue;
    addCandidate(match.index ?? 0, match[0], value, match[2], 'devise-apres');
  }

  for (const match of masked.matchAll(CURRENCY_BEFORE_RE)) {
    const value = parseNumberToken(match[2]);
    if (value === null) continue;
    const index = match.index ?? 0;
    const beforeCurrency = masked.slice(Math.max(0, index - 16), index);
    if (/\d\s*$/.test(beforeCurrency)) continue;
    addCandidate(index, match[0], value, match[1], 'devise-avant');
  }

  for (const match of masked.matchAll(SCALE_RE)) {
    const base = parseNumberToken(match[1]);
    if (base === null) continue;
    const multiplier = scaleMultiplier(match[2]);
    const nextNumber = match[3] ? Number(match[3]) : null;
    const nextUnit = match[4];
    let value = base * multiplier;
    if (nextNumber !== null) {
      value += nextUnit
        ? nextNumber * scaleMultiplier(nextUnit)
        : fractionalValue(match[3], multiplier);
    }
    const index = match.index ?? 0;
    const end = index + match[0].length;
    const currency = currencyAt(masked, end);
    const raw =
      match[0] + (currency ? masked.slice(end, end + currency.length) : '');
    addCandidate(index, raw, value, currency?.token ?? null, 'echelle');
  }

  for (const match of masked.matchAll(M_RE)) {
    const base = parseNumberToken(match[1]);
    if (base === null) continue;
    const value =
      base * 1_000_000 +
      (match[2] ? fractionalValue(match[2], 1_000_000) : 0);
    const index = match.index ?? 0;
    const end = index + match[0].length;
    const currency = currencyAt(masked, end);
    if (!currency) {
      const beforeContext = masked
        .slice(Math.max(0, index - 20), index)
        .toLowerCase();
      const afterContext = masked
        .slice(end, Math.min(masked.length, end + 20))
        .toLowerCase();
      const nearPriceBefore =
        /(?:loyer|louyer|prix|hofany|ofany|hofa|tarif)\b[^.!?\n]{0,15}$/i.test(
          beforeContext,
        );
      const nearPriceAfter =
        /^\s*(?:de\s+)?(?:loyer|louyer|prix|hofany|ofany|hofa|tarif)\b/i.test(
          afterContext,
        );
      if (!nearPriceBefore && !nearPriceAfter) continue;
    }
    const raw =
      match[0] + (currency ? masked.slice(end, end + currency.length) : '');
    addCandidate(index, raw, value, currency?.token ?? null, 'M');
  }

  for (const match of masked.matchAll(GROUPED_RE)) {
    const value = parseNumberToken(match[1]);
    if (value === null) continue;
    addCandidate(match.index ?? 0, match[0], value, null, 'groupe');
  }

  const deduped = new Map<string, PriceCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.index}:${candidate.end}:${candidate.value}`;
    const previous = deduped.get(key);
    if (
      !previous ||
      (previous.currency === 'unknown' && candidate.currency !== 'unknown')
    ) {
      deduped.set(key, candidate);
    }
  }

  const sorted = [...deduped.values()].sort(
    (left, right) => left.index - right.index || right.end - left.end,
  );
  const kept: PriceCandidate[] = [];
  for (const candidate of sorted) {
    const contained = kept.some(
      (outer) =>
        outer.index <= candidate.index &&
        outer.end >= candidate.end &&
        (outer.value > candidate.value ||
          (outer.value === candidate.value &&
            outer.currency !== 'unknown' &&
            candidate.currency === 'unknown')),
    );
    if (contained) continue;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const inner = kept[index];
      if (
        candidate.index <= inner.index &&
        candidate.end >= inner.end &&
        candidate.value >= inner.value
      ) {
        kept.splice(index, 1);
      }
    }
    kept.push(candidate);
  }

  return kept;
}

export function selectPriceDetailed(text: string): PriceSelection {
  const candidates = extractPriceCandidates(text);
  const usable = candidates.filter(
    (candidate) =>
      !candidate.isCaution &&
      !candidate.isFee &&
      !candidate.isArea &&
      !candidate.isIdentifier &&
      candidate.value > 0,
  );
  const localCurrency = usable.filter(
    (candidate) =>
      candidate.currency === 'ar' || candidate.currency === 'unknown',
  );
  const pool = localCurrency.length > 0 ? localCurrency : usable;
  const perM2 = pool.filter((candidate) => candidate.isPerM2);
  const finalPool = perM2.length > 0 ? perM2 : pool;

  if (finalPool.length === 0) {
    if (FREE_TEXT_RE.test(maskNonPriceText(text))) {
      return { price: 0, candidates, reason: 'gratuit' };
    }
    return { price: null, candidates, reason: 'aucun prix fiable' };
  }

  const price = Math.round(
    Math.min(...finalPool.map((candidate) => candidate.value)),
  );
  return {
    price,
    candidates,
    reason: perM2.length > 0 ? 'prix au m2' : 'prix minimum',
  };
}

export function selectPrice(text: string): number | null {
  return selectPriceDetailed(text).price;
}
