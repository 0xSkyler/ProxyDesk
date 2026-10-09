export interface SeoKeywordAssignment {
  workspaceId: number;
  keyword: string;
}

/** A line is one complete search phrase, including any commas in that phrase. */
export function parseSeoKeywords(input: string | string[]): string[] {
  const lines = typeof input === 'string' ? input.split(/\r?\n/) : input;
  const seen = new Set<string>();
  return lines.flatMap((line) => {
    if (typeof line !== 'string') throw new Error('Each keyword must be text.');
    const keyword = line.trim().replace(/\s+/g, ' ');
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) return [];
    seen.add(key);
    return [keyword];
  });
}

/** Each selected workspace owns exactly one keyword for the whole run. */
export function allocateSeoKeywords(keywords: string[], workspaceIds: number[]): SeoKeywordAssignment[] {
  if (!keywords.length) throw new Error('Enter at least one keyword to track.');
  if (!workspaceIds.length) throw new Error('Select at least one browser.');
  if (keywords.length > workspaceIds.length) {
    throw new Error(`Select at least ${keywords.length} browsers to run all ${keywords.length} keywords simultaneously.`);
  }
  return workspaceIds.map((workspaceId, index) => ({ workspaceId, keyword: keywords[index % keywords.length]! }));
}
