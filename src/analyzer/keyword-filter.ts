export type KeywordGroups = {
  keywords?: string[];
  characteristics?: string[];
  characteristicsMin?: number;
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
 * Supprime les espaces pour comparer : « 67 ha » et « 67ha » deviennent
 * identiques, de même que « bord de route » et « bordderoute ».
 */
export function compactForMatch(value: string): string {
  return value.replace(/ /g, '');
}

/**
 * Une publication correspond si :
 * - au moins un mot de « Cherche » est trouvé (si la catégorie est remplie) ;
 * - au moins un mot de « Lieu » est trouvé (si la catégorie est remplie) ;
 * - au moins `characteristicsMin` mots de « Caractéristiques » sont trouvés
 *   (1 par défaut, jamais plus que le nombre de mots saisis).
 * Une catégorie vide est ignorée. Un mot exclu présent rejette la publication.
 * La comparaison ignore les espaces.
 */
export function matchesKeywords(
  text: string,
  groups: KeywordGroups,
  negativeKeywords: string[],
): boolean {
  const haystack = compactForMatch(normalizeForMatch(text));
  const contains = (word: string) => haystack.includes(compactForMatch(word));

  const blocked = cleanList(negativeKeywords).some(contains);
  if (blocked) return false;

  const keywords = cleanList(groups.keywords);
  const characteristics = cleanList(groups.characteristics);
  const locations = cleanList(groups.locations);

  if (keywords.length === 0 && characteristics.length === 0 && locations.length === 0) {
    return false;
  }

  if (keywords.length > 0 && !keywords.some(contains)) return false;
  if (locations.length > 0 && !locations.some(contains)) return false;

  if (characteristics.length > 0) {
    const requested = Math.floor(groups.characteristicsMin ?? 1);
    const required = Math.min(Math.max(1, requested), characteristics.length);
    const found = characteristics.filter(contains).length;
    if (found < required) return false;
  }

  return true;
}
