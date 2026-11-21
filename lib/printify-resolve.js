// Live Printify catalog lookups for the merch factory. Nothing here is a hand-typed ID:
// blueprint, print provider and variant IDs all come from the Printify catalog API at run time.

const APPAREL_SIZES = ['S', 'M', 'L', 'XL'];
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Pick a blueprint. `id` wins when given (back-compat with --blueprint); otherwise match `query` against titles. */
export async function resolveBlueprint(client, { id, query } = {}) {
  if (id) return client.getBlueprint(Number(id));
  if (!query) throw new Error('Need --type <words> (e.g. "unisex softstyle t-shirt") or --blueprint <id>');
  const list = await client.listBlueprints();
  const words = norm(query).split(' ').filter(Boolean);
  const scored = list
    .map(b => {
      const hay = norm(`${b.title} ${b.brand} ${b.model}`);
      const hits = words.filter(w => hay.includes(w)).length;
      return { b, hits, exact: norm(b.title) === norm(query) };
    })
    .filter(x => x.hits === words.length)
    .sort((a, b) => (b.exact - a.exact) || (a.b.title.length - b.b.title.length));
  if (!scored.length) throw new Error(`No Printify blueprint matches "${query}"`);
  return scored[0].b;
}

/** Pick a print provider for a blueprint. Prefer Printify Choice, then a US location, then the first listed. */
export async function resolveProvider(client, blueprintId, { id } = {}) {
  const providers = await client.listPrintProviders(blueprintId);
  if (!providers.length) throw new Error(`Blueprint ${blueprintId} has no print providers`);
  if (id) {
    const hit = providers.find(p => Number(p.id) === Number(id));
    if (!hit) throw new Error(`Print provider ${id} does not offer blueprint ${blueprintId}`);
    return hit;
  }
  const choice = providers.find(p => /printify choice/i.test(p.title));
  if (choice) return choice;
  for (const p of providers) {
    const detail = p.location ? p : await client.getPrintProvider(p.id).catch(() => null);
    if (detail?.location?.country === 'US') return p;
  }
  return providers[0];
}

/**
 * Pick variants. Filters by colors and sizes. Default: the first color offered, and S-XL on apparel
 * (every size when the product does not use S-XL, e.g. blankets).
 */
export async function resolveVariants(client, blueprintId, providerId, { colors = [], sizes = [] } = {}) {
  const res = await client.listVariants(blueprintId, providerId);
  const all = res.variants || [];
  if (!all.length) throw new Error(`No variants for blueprint ${blueprintId} / provider ${providerId}`);
  const color = v => v.options?.color || '';
  const size = v => v.options?.size || '';
  let wantColors = colors.map(norm);
  if (!wantColors.length && all.some(color)) wantColors = [norm(color(all[0]))];
  let pool = wantColors.length ? all.filter(v => wantColors.includes(norm(color(v)))) : all;
  let wantSizes = sizes.map(s => s.toUpperCase());
  if (!wantSizes.length && pool.some(v => APPAREL_SIZES.includes(size(v).toUpperCase()))) wantSizes = APPAREL_SIZES;
  if (wantSizes.length) pool = pool.filter(v => wantSizes.includes(size(v).toUpperCase()));
  if (!pool.length) throw new Error('No variants match the requested colors/sizes');
  return pool;
}

/** Everything the factory needs to create a product, resolved live. */
export async function resolveProductSpec(client, opts = {}) {
  const blueprint = await resolveBlueprint(client, { id: opts.blueprint, query: opts.type });
  const provider = await resolveProvider(client, blueprint.id, { id: opts.provider });
  const variants = await resolveVariants(client, blueprint.id, provider.id, opts);
  return { blueprint, provider, variants };
}
