import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicCatalog } from '../lib/commerce.js';

const cat = JSON.parse(readFileSync(new URL('../store/catalog.json', import.meta.url)));

test('Original cream is a $59.99 preorder that ships Dec 1', () => {
  const p = cat.products.find((x) => x.id === 'fruity-puppy-original');
  assert.equal(p.title, 'Fruity Puppy Original');
  assert.equal(p.preorder, 'Preorder, ships Dec 1');
  assert.equal(p.variants[0].price_cents, 5999);
  assert.equal(p.variants[0].active, true);
});

test('catalog API and listing markup expose the preorder note', () => {
  const pub = publicCatalog().products.find((x) => x.id === 'fruity-puppy-original');
  assert.equal(pub.preorder, 'Preorder, ships Dec 1');
  assert.equal(pub.variants[0].price_cents, 5999);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /p\.preorder/);
  assert.match(html, /jar-note/);
  const productPage = readFileSync(new URL('../api/product.js', import.meta.url), 'utf8');
  assert.match(productPage, /preorder-note/);
});
