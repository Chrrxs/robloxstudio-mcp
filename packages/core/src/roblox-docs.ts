/**
 * Fetches official Roblox engine reference documentation as markdown from
 * create.roblox.com. Every reference page has a markdown mirror at
 * https://create.roblox.com/docs/reference/engine/<category>/<Name>.md,
 * which is what agents consume via the get_roblox_docs tool and the
 * robloxdocs:// resource template.
 */

export const DOC_CATEGORIES = ['classes', 'enums', 'datatypes', 'libraries', 'globals'] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

const DOCS_BASE_URL = 'https://create.roblox.com/docs/reference/engine';
const DOCS_INDEX_URL = DOCS_BASE_URL;
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
// Beyond this the doc dominates the agent's context window; return the head
// plus the section index so the agent can re-request one section.
const MAX_DOC_CHARS = 50_000;

interface CacheEntry {
  fetchedAt: number;
  content?: string;
  notFound?: boolean;
}

const cache = new Map<string, CacheEntry>();
let catalogCache: { fetchedAt: number; pages: DocRecommendation[] } | undefined;

export function isDocCategory(value: string): value is DocCategory {
  return (DOC_CATEGORIES as readonly string[]).includes(value);
}

function cacheGet(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  const ttl = entry.notFound ? NEGATIVE_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - entry.fetchedAt > ttl) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

export function docUrl(category: DocCategory, name: string): string {
  return `${DOCS_BASE_URL}/${category}/${encodeURIComponent(name)}.md`;
}

export class DocNotFoundError extends Error {
  constructor(category: DocCategory, name: string) {
    super(
      `No Roblox documentation found for ${category}/${name}. ` +
      `Names are case-sensitive PascalCase (e.g. "ProximityPrompt", "TweenService"). ` +
      `Valid categories: ${DOC_CATEGORIES.join(', ')}.`
    );
    this.name = 'DocNotFoundError';
  }
}

export interface DocRecommendation {
  category: DocCategory;
  name: string;
  url: string;
}

function normalizeDocName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function queryNameVariants(value: string): string[] {
  const parts = value.split(/[./:#\s]+/).filter(Boolean);
  const variants = new Set<string>([normalizeDocName(value)]);
  for (const part of parts) {
    const normalized = normalizeDocName(part);
    if (normalized && normalized !== 'enum') variants.add(normalized);
  }
  return Array.from(variants).filter(Boolean);
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

async function fetchDocCatalog(): Promise<DocRecommendation[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt <= CACHE_TTL_MS) {
    return catalogCache.pages;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(DOCS_INDEX_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/html' },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch Roblox docs index: HTTP ${response.status}`);
  }

  const html = await response.text();
  const pages = new Map<string, DocRecommendation>();
  const routePattern = /reference\/engine\/(classes|enums|datatypes|libraries|globals)\/([A-Za-z0-9_]+)/g;
  for (const match of html.matchAll(routePattern)) {
    const category = match[1] as DocCategory;
    const name = match[2];
    const key = `${category}/${name}`;
    pages.set(key, { category, name, url: docUrl(category, name) });
  }
  const result = Array.from(pages.values());
  if (result.length === 0) {
    throw new Error('Roblox docs index did not contain any engine reference pages');
  }
  catalogCache = { fetchedAt: Date.now(), pages: result };
  return result;
}

export async function recommendRobloxDocs(
  category: DocCategory,
  name: string,
  limit = 5,
): Promise<DocRecommendation[]> {
  const variants = queryNameVariants(name);
  const catalog = await fetchDocCatalog();
  return catalog
    .map((page) => {
      const candidate = normalizeDocName(page.name);
      const similarity = Math.max(...variants.map((variant) => {
        if (variant === candidate) return 2;
        const distance = editDistance(variant, candidate);
        const ratio = 1 - distance / Math.max(variant.length, candidate.length, 1);
        const prefixBonus = variant.startsWith(candidate) || candidate.startsWith(variant) ? 0.15 : 0;
        const containsBonus = variant.includes(candidate) || candidate.includes(variant) ? 0.05 : 0;
        return ratio + prefixBonus + containsBonus;
      }));
      return { page, score: similarity + (page.category === category ? 0.08 : 0) };
    })
    .sort((a, b) => b.score - a.score || a.page.name.localeCompare(b.page.name))
    .slice(0, Math.max(1, limit))
    .map(({ page }) => page);
}

function recommendationsMarkdown(
  requestedCategory: DocCategory,
  requestedName: string,
  recommendations: DocRecommendation[],
): string {
  const lines = recommendations.map((page) =>
    `- [${page.category}/${page.name}](${page.url}) — ` +
    `retry with \`name="${page.name}", doc_type="${page.category}"\``,
  );
  return [
    `# No exact Roblox documentation page found`,
    '',
    `The lookup \`${requestedCategory}/${requestedName}\` did not resolve. Recommended pages:`,
    '',
    ...lines,
  ].join('\n');
}

export async function fetchRobloxDoc(category: DocCategory, name: string): Promise<string> {
  const key = `${category}/${name}`;
  const cached = cacheGet(key);
  if (cached) {
    if (cached.notFound) throw new DocNotFoundError(category, name);
    return cached.content!;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(docUrl(category, name), {
      signal: controller.signal,
      headers: { Accept: 'text/markdown, text/plain' },
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch Roblox docs for ${key}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    cacheSet(key, { fetchedAt: Date.now(), notFound: true });
    throw new DocNotFoundError(category, name);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch Roblox docs for ${key}: HTTP ${response.status}`);
  }

  const content = await response.text();
  cacheSet(key, { fetchedAt: Date.now(), content });
  return content;
}

/** List the `## `-level section headings of a reference page. */
export function listSections(markdown: string): string[] {
  const sections: string[] = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) sections.push(match[1]);
  }
  return sections;
}

/**
 * Extract one `## `-level section (heading through the line before the next
 * `## ` or `# ` heading), matched case-insensitively. Returns undefined when
 * the section does not exist.
 */
export function extractSection(markdown: string, section: string): string | undefined {
  const lines = markdown.split('\n');
  const wanted = section.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##\s+(.+?)\s*$/);
    if (match && match[1].toLowerCase() === wanted) {
      start = i;
      break;
    }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##?\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

export interface DocResult {
  content: string;
  truncated: boolean;
  sections: string[];
  recommendations?: DocRecommendation[];
}

/**
 * Fetch a doc page, optionally narrowed to one section. Oversized full pages
 * are truncated with the section index appended so the caller can re-request
 * a specific section instead.
 */
export async function getRobloxDoc(category: DocCategory, name: string, section?: string): Promise<DocResult> {
  let markdown: string;
  try {
    markdown = await fetchRobloxDoc(category, name);
  } catch (error) {
    if (!(error instanceof DocNotFoundError)) throw error;
    try {
      const recommendations = await recommendRobloxDocs(category, name);
      return {
        content: recommendationsMarkdown(category, name, recommendations),
        truncated: false,
        sections: [],
        recommendations,
      };
    } catch {
      // Preserve the precise direct-lookup error if the recommendation index
      // is temporarily unavailable.
      throw error;
    }
  }
  const sections = listSections(markdown);

  if (section) {
    const extracted = extractSection(markdown, section);
    if (extracted === undefined) {
      throw new Error(
        `Section "${section}" not found in ${category}/${name}. Available sections: ${sections.join(', ') || '(none)'}`
      );
    }
    return { content: extracted, truncated: false, sections };
  }

  if (markdown.length > MAX_DOC_CHARS) {
    const head = markdown.slice(0, MAX_DOC_CHARS);
    const note =
      `\n\n---\n[Truncated at ${MAX_DOC_CHARS} of ${markdown.length} characters. ` +
      `Re-request with the "section" parameter to read one section in full. ` +
      `Available sections: ${sections.join(', ')}]`;
    return { content: head + note, truncated: true, sections };
  }

  return { content: markdown, truncated: false, sections };
}
