import { z } from 'zod';

const slug = z.string().min(1).max(300).refine(value => value !== '.' && value !== '..', 'Use a listing or content slug.');
const contentType = z.enum(['article', 'news', 'opinion']);
export const definitions = {
  search_providers: { description: 'Search technology providers by name, category and city.', inputSchema: {
    q: z.string().min(1).max(200), category: z.string().optional(), location: z.string().optional(), limit: z.number().optional(),
  } },
  get_provider: { description: 'Read all supplied fields for one provider. Missing listings do not imply a company does not exist.', inputSchema: { slug } },
  similar_providers: { description: 'Find providers similar to a directory listing.', inputSchema: { slug, limit: z.number().optional() } },
  list_categories: { description: 'List directory categories, cities or services with counts.', inputSchema: {
    query: z.string().optional(), facet: z.enum(['primary_category', 'location_city', 'services']).optional(),
  } },
  directory_stats: { description: 'Read directory totals and the twenty largest categories.', inputSchema: {} },
  search_content: { description: 'Search articles, news and opinion, or return the latest content.', inputSchema: {
    q: z.string().max(200).optional(), type: contentType.optional(), limit: z.number().optional(),
  } },
  get_content: { description: 'Read an article, news story or opinion piece, with its citation.', inputSchema: { type: contentType, slug } },
  search: { description: 'Search providers and editorial content for company knowledge.', inputSchema: { query: z.string().min(1).max(200) }, outputSchema: { results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })) } },
  fetch: { description: 'Fetch a provider or editorial result by its search identifier.', inputSchema: { id: z.string().max(310).regex(/^(provider|article|news|opinion):[^/:?#\s]+$/).refine(value => !['.', '..'].includes(value.split(':')[1]!), 'Use a valid identifier.') }, outputSchema: { id: z.string(), title: z.string(), text: z.string(), url: z.string(), metadata: z.record(z.string(), z.unknown()) } },
  site_guide: { description: 'Read the site guide and its guidance on available content.', inputSchema: {} },
};
