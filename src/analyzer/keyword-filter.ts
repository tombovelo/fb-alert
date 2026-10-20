export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Nombre minimal de mots-clés à trouver selon le nombre saisi :
 * 1-3 -> 1, 4-6 -> 2, 7 et plus -> 3.
 */
export function minimumKeywordMatches(keywordCount: number): number {
  if (keywordCount <= 3) return 1;
  if (keywordCount <= 6) return 2;
  return 3;
}

export function matchesKeywords(
  text: string,
  keywords: string[],
  negativeKeywords: string[],
): boolean {
  const haystack = normalizeForMatch(text);

  const blocked = negativeKeywords.some(
    (keyword) => keyword.trim() !== '' && haystack.includes(normalizeForMatch(keyword)),
  );
  if (blocked) return false;

  // Doublons (insensibles à la casse/accents) comptés une seule fois.
  const unique = [...new Set(
    keywords.map((keyword) => normalizeForMatch(keyword.trim())).filter((keyword) => keyword !== ''),
  )];
  if (unique.length === 0) return false;

  const found = unique.filter((keyword) => haystack.includes(keyword)).length;
  return found >= minimumKeywordMatches(unique.length);
}
