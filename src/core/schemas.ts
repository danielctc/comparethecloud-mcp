import { Schema } from 'effect';

const optionalText = Schema.optional(Schema.NullOr(Schema.String));
const optionalFlag = Schema.optional(Schema.NullOr(Schema.Boolean));
const optionalNumber = Schema.optional(Schema.NullOr(Schema.Number));

export const ProviderHit = Schema.Struct({
  name: Schema.String, slug: Schema.String, description: optionalText,
  location: optionalText, location_city: optionalText, primary_category: optionalText,
  categories: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  url: optionalText, pricing_tier: optionalText, is_verified: optionalFlag,
  is_claimed: optionalFlag, founded_year: optionalNumber, ranking_score: optionalNumber,
});
export const ProviderSearch = Schema.Struct({
  hits: Schema.Array(ProviderHit), estimatedTotalHits: Schema.Number,
});
export const Provider = Schema.Struct({ listing: Schema.StructWithRest(
  Schema.Struct({ name: Schema.String, slug: Schema.String }), [Schema.JsonObject],
) });
export const Similar = Schema.Struct({ similar: Schema.Array(Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]), name: Schema.String, slug: Schema.String,
  description: optionalText, location: optionalText,
  services: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  is_verified: optionalFlag, is_promoted: optionalFlag, similarity_score: optionalNumber,
})) });
export const Facets = Schema.Struct({ facetHits: Schema.Array(Schema.Struct({
  value: Schema.String, count: Schema.Number,
})) });
export const Stats = Schema.StructWithRest(Schema.Struct({ categories: Schema.Array(Schema.Struct({
  count: Schema.Number, name: Schema.String, slug: Schema.String,
})) }), [Schema.JsonObject]);
const ContentFields = {
  type: Schema.Literals(['article', 'news', 'opinion']), slug: Schema.String,
  title: Schema.String, summary: optionalText, author: optionalText,
  publishedAt: optionalText, url: Schema.String,
};
export const ContentSearch = Schema.Struct({ items: Schema.Array(Schema.Struct(ContentFields)) });
export const Content = Schema.Struct({ item: Schema.Struct({
  ...ContentFields, updatedAt: optionalText, text: Schema.String,
}) });

// Company knowledge result shapes.
export const KnowledgeSearch = Schema.Struct({ results: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, url: Schema.String })) });
export const KnowledgeFetch = Schema.Struct({ id: Schema.String, title: Schema.String, text: Schema.String, url: Schema.String, metadata: Schema.Record(Schema.String, Schema.Unknown) });
