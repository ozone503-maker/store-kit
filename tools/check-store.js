#!/usr/bin/env node
// Sanity-check every brand's config.json + catalog.json before you commit.  npm run check
// Errors (exit 1): missing files, bad JSON, duplicate ids/SKUs, bad prices, printify items without IDs,
// unknown fulfillers, pairs pointing at nothing. Warnings: listings without images, no allowed_origins.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.STORE_DIR || 'store';
const brands = [['default', base], ...(existsSync(join(base, 'brands'))
  ? readdirSync(join(base, 'brands'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => [d.name, join(base, 'brands', d.name)])
  : [])];

let errors = 0, warnings = 0;
const err = (b, m) => { errors++; console.log(`ERROR ${b}: ${m}`); };
const warn = (b, m) => { warnings++; console.log(`warn  ${b}: ${m}`); };
const allSkus = new Map();

for (const [brand, dir] of brands) {
  let config, catalog;
  try { config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')); } catch (e) { err(brand, `config.json: ${e.message}`); continue; }
  try { catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')); } catch (e) { err(brand, `catalog.json: ${e.message}`); continue; }
  if (!config.name) err(brand, 'config.name missing');
  if (!config.currency) err(brand, 'config.currency missing');
  if (!(config.allowed_origins || []).length) warn(brand, 'config.allowed_origins is empty (/buy will fall back to the default site)');
  const fulfillers = config.fulfillers || {};
  if (config.default_fulfiller && !fulfillers[config.default_fulfiller]) err(brand, `default_fulfiller "${config.default_fulfiller}" not in fulfillers`);
  const products = catalog.products || [];
  const ids = new Set();
  for (const p of products) {
    if (!p.id) { err(brand, 'product without id'); continue; }
    if (ids.has(p.id)) err(brand, `duplicate product id ${p.id}`);
    ids.add(p.id);
    const f = p.fulfiller || config.default_fulfiller;
    if (f && !fulfillers[f]) err(brand, `${p.id}: fulfiller "${f}" not in config.fulfillers`);
    const isPrintify = fulfillers[f]?.adapter === 'printify';
    if (!(p.images || []).length) warn(brand, `${p.id}: no images (listings need a character photo)`);
    for (const v of p.variants || []) {
      if (!v.sku) { err(brand, `${p.id}: variant without sku`); continue; }
      if (allSkus.has(v.sku)) err(brand, `${p.id}: SKU ${v.sku} also used in ${allSkus.get(v.sku)}`);
      allSkus.set(v.sku, `${brand}/${p.id}`);
      if (!Number.isInteger(v.price_cents) || v.price_cents < 0) err(brand, `${v.sku}: price_cents must be a whole number of cents`);
      if (isPrintify && v.active !== false && (!v.printify_product_id || !v.printify_variant_id)) {
        err(brand, `${v.sku}: active printify variant without printify_product_id/printify_variant_id (it cannot be fulfilled)`);
      }
    }
  }
  for (const p of products) for (const id of p.pairs || []) if (!ids.has(id)) warn(brand, `${p.id}: pairs -> unknown product ${id}`);
  console.log(`ok    ${brand}: ${products.length} products`);
}
console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
