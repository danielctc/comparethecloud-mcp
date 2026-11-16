import { z } from 'zod';

const slug = z.string().min(1).max(300).refine(value => value !== '.' && value !== '..', 'Use a listing or content slug.')
  .describe('URL slug of the record, as returned by a search tool, for example "acme-cloud".');
const contentType = z.enum(['article', 'news', 'opinion']).describe('Kind of editorial content: article, news or opinion.');
/** The shape of a company-knowledge id; search emits only ids that fetch will accept. */
export const KNOWLEDGE_ID = /^(provider|article|news|opinion):[^/:?#\s]+$/;
export const definitions = {
  search_providers: { description: 'Search technology providers by name, category and city.', inputSchema: {
    q: z.string().min(1).max(200).describe('Search words, such as a provider name or service, for example "managed kubernetes".'),
    category: z.string().optional().describe('Exact primary category to filter by, as listed by list_categories.'),
    location: z.string().optional().describe('City to filter by, as listed by list_categories with facet location_city.'),
    limit: z.number().optional().describe('Number of results to return. Default 8, maximum 20.'),
  } },
  get_provider: { description: 'Read all supplied fields for one provider. Missing listings do not imply a company does not exist.', inputSchema: { slug } },
  similar_providers: { description: 'Find providers similar to a directory listing.', inputSchema: { slug, limit: z.number().optional().describe('Number of similar providers to return. Default 6, maximum 12.') } },
  list_categories: { description: 'List directory categories, cities or services with counts.', inputSchema: {
    query: z.string().optional().describe('Text to narrow the values by. Leave out for the largest values.'),
    facet: z.enum(['primary_category', 'location_city', 'services']).optional().describe('What to list: primary_category (default), location_city or services.'),
  } },
  directory_stats: { description: 'Read directory totals and the twenty largest categories.', inputSchema: {} },
  search_content: { description: 'Search articles, news and opinion, or return the latest content.', inputSchema: {
    q: z.string().max(200).optional().describe('Search words. Leave out to get the latest content.'),
    type: contentType.optional(),
    limit: z.number().optional().describe('Number of results to return. Default 10, maximum 20.'),
  } },
  get_content: { description: 'Read an article, news story or opinion piece, with its citation.', inputSchema: { type: contentType, slug } },
  search: { description: 'Search providers and editorial content for company knowledge.', inputSchema: { query: z.string().min(1).max(200).describe('Search words to find providers and editorial content.') }, outputSchema: { results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })) } },
  fetch: { description: 'Fetch a provider or editorial result by its search identifier.', inputSchema: { id: z.string().max(310).regex(KNOWLEDGE_ID).refine(value => !['.', '..'].includes(value.split(':')[1]!), 'Use a valid identifier.').describe('Identifier from a search result, such as "provider:acme-cloud" or "article:my-slug".') }, outputSchema: { id: z.string(), title: z.string(), text: z.string(), url: z.string(), metadata: z.record(z.string(), z.unknown()) } },
  site_guide: { description: 'Read the site guide and its guidance on available content.', inputSchema: {} },
};
