#!/usr/bin/env node
// Create a Printify product from a design and write it into a brand catalog, or copy mockups onto a listing.
//
//   node tools/merch-factory.js --brand kudoken --image https://.../design.png --title "Kudoken Tank" --type "unisex jersey tank"
//   node tools/merch-factory.js --brand kudoken --from kudoken-tee --title "Kudoken Tee 2"   (copy mockups only, no Printify call)
//
// Flags:
//   --brand <key>         store/brands/<key>/catalog.json (omit for Fruity Puppy: store/catalog.json)
//   --from <product id>   copy description, pairs and mockups from this catalog product
//   --image <url>         design to upload to Printify (creates a Printify product)
//   --title <text>        listing title (also the catalog id stem)
//   --type <words>        blueprint search, matched against Printify catalog titles (default "unisex heavy cotton tee")
//   --blueprint <id>      use this blueprint instead of searching (still checked live)
//   --provider <id>       use this print provider (checked live); default Printify Choice, then a US provider
//   --colors "Black,White" --sizes "S,M,L,XL"   variant filters (default first color, S-XL on apparel)
//   --price <cents>       retail price per variant (default: the --from product's price, else 2499)
//   --dry-run             resolve blueprint/provider/variants live and print them; create and write nothing
//
// Every Printify ID is looked up live. None are typed in here.
import { PrintifyClient } from '../lib/printify.js';
import { resolveProductSpec } from '../lib/printify-resolve.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_TYPE = 'unisex heavy cotton tee';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = name => process.argv.includes(name);
const list = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []);

function catalogPath(brand) {
  return brand ? join('store', 'brands', brand, 'catalog.json') : join('store', 'catalog.json');
}

function loadCatalog(brand) {
  return JSON.parse(readFileSync(catalogPath(brand), 'utf8'));
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const skuPart = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

async function main() {
  const brand = arg('--brand', '');
  const fromId = arg('--from', '');
  const imageUrl = arg('--image', '');
  const title = arg('--title', 'Custom Merch');
  const dryRun = flag('--dry-run');

  const catalog = loadCatalog(brand);
  const original = fromId ? catalog.products.find(p => p.id === fromId) : null;
  if (fromId && !original) throw new Error(`No product "${fromId}" in ${catalogPath(brand)}`);
  let images = original?.images ? [...original.images] : [];
  const price = Number(arg('--price', original?.variants?.[0]?.price_cents || 2499));
  const id = slug(title);
  let catalogVariants = null;

  if (imageUrl) {
    const client = new PrintifyClient();
    const spec = await resolveProductSpec(client, {
      type: arg('--type', DEFAULT_TYPE),
      blueprint: arg('--blueprint', ''),
      provider: arg('--provider', ''),
      colors: list(arg('--colors', '')),
      sizes: list(arg('--sizes', '')),
    });
    console.log(`Blueprint ${spec.blueprint.id} "${spec.blueprint.title}", provider ${spec.provider.id} "${spec.provider.title}", ${spec.variants.length} variants`);
    if (dryRun) {
      for (const v of spec.variants) console.log(`  variant ${v.id}  ${v.title}`);
      return;
    }

    console.log('Uploading design...');
    const uploaded = await client.uploadImage({ file_name: 'design.png', url: imageUrl });
    const variants = spec.variants.map(v => ({ id: v.id, price, is_enabled: true }));
    const position = spec.variants[0].placeholders?.[0]?.position || 'front';
    const product = await client.createProduct({
      title,
      description: original?.description || title,
      blueprint_id: spec.blueprint.id,
      print_provider_id: spec.provider.id,
      variants,
      print_areas: [{
        variant_ids: variants.map(v => v.id),
        placeholders: [{ position, images: [{ id: uploaded.id, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
      }],
    });
    await new Promise(r => setTimeout(r, 5000));
    const full = await client.getProduct(product.id);
    // Printify mockups are a fallback only. The listing photo should be a character wearing the gear (store/OPERATOR.md).
    if (!images.length) images = (full.images || []).map(img => img.src).filter(Boolean);
    const stem = skuPart(id).slice(0, 10);
    const multiColor = new Set(spec.variants.map(v => v.options?.color || '')).size > 1;
    catalogVariants = spec.variants.map(v => ({
      sku: [stem, multiColor && skuPart(v.options?.color), skuPart(v.options?.size) || String(v.id)].filter(Boolean).join('-'),
      title: v.title,
      price_cents: price,
      active: true,
      printify_product_id: product.id,
      printify_variant_id: v.id,
    }));
    console.log('Printify product', product.id, 'images', images.length);
  } else if (dryRun) {
    console.log('Nothing to resolve without --image.');
    return;
  }

  if (!images.length) {
    console.error('No mockups to copy. Pass --from <catalog product id> or --image <design url>.');
    process.exit(1);
  }

  const existing = catalog.products.find(p => p.id === id);
  if (existing) {
    existing.images = images;
    if (catalogVariants) { existing.variants = catalogVariants; existing.fulfiller = 'printify'; }
    console.log('Updated', existing.id, 'with', images.length, 'images');
  } else {
    catalog.products.push({
      id,
      title,
      brand: brand || 'Store',
      description: original?.description || title,
      images,
      tags: [],
      pairs: original ? [original.id] : [],
      fulfiller: 'printify',
      variants: catalogVariants || [{ sku: skuPart(id).slice(0, 12), title: 'Default', price_cents: price, active: true }],
    });
    console.log('Added', id, 'with', images.length, 'images from', fromId || 'Printify');
  }

  writeFileSync(catalogPath(brand), JSON.stringify(catalog, null, 2) + '\n');
  console.log('Wrote', catalogPath(brand));
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
