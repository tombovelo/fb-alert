export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
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

  return keywords.some(
    (keyword) => keyword.trim() !== '' && haystack.includes(normalizeForMatch(keyword)),
  );
}
