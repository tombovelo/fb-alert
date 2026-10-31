export type KeywordGroups = {
  keywords?: string[];
  characteristics?: string[];
  locations?: string[];
};

/**
 * Prépare un texte pour la comparaison : minuscules, sans accents, et tous les
 * espaces, retours à la ligne et signes de ponctuation réduits à un espace.
 * « Trano,   à\nVENDRE ! » devient « trano a vendre ».
 */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanList(list: string[] | undefined): string[] {
  return [
    ...new Set(
      (list ?? [])
        .map((value) => normalizeForMatch(value))
        .filter((value) => value !== ''),
    ),
  ];
}

/**
 * Une publication correspond si, pour chaque catégorie remplie (mots-clés,
 * caractéristiques, lieux), au moins un mot est trouvé. Une catégorie vide est
 * ignorée. Un mot exclu présent rejette la publication.
 */
export function matchesKeywords(
  text: string,
  groups: KeywordGroups,
  negativeKeywords: string[],
): boolean {
  const haystack = normalizeForMatch(text);

  const blocked = cleanList(negativeKeywords).some((keyword) =>
    haystack.includes(keyword),
  );
  if (blocked) return false;

  const categories = [
    cleanList(groups.keywords),
    cleanList(groups.characteristics),
    cleanList(groups.locations),
  ].filter((words) => words.length > 0);

  if (categories.length === 0) return false;

  return categories.every((words) =>
    words.some((word) => haystack.includes(word)),
  );
}
