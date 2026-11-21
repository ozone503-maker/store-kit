import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBlueprint, resolveProvider, resolveVariants, resolveProductSpec } from '../lib/printify-resolve.js';

function fakeClient() {
  const blueprints = [
    { id: 11, title: 'Kids Heavy Cotton Tee', brand: 'Gildan', model: '5000B' },
    { id: 22, title: 'Unisex Heavy Cotton Tee', brand: 'Gildan', model: '5000' },
    { id: 33, title: 'Velveteen Plush Blanket', brand: 'Generic', model: 'VP' },
  ];
  const providers = { 22: [{ id: 1, title: 'Overseas Print' }, { id: 2, title: 'Stateside Ink' }], 33: [{ id: 3, title: 'Far Away' }, { id: 99, title: 'Printify Choice' }] };
  const locations = { 1: 'GB', 2: 'US', 3: 'CN', 99: 'US' };
  const variants = {
    '22/2': ['Black', 'White'].flatMap(color => ['XS', 'S', 'M', 'L', 'XL', '2XL'].map((size, i) => ({ id: (color === 'Black' ? 100 : 200) + i, title: `${color} / ${size}`, options: { color, size }, placeholders: [{ position: 'front' }] }))),
    '33/99': [{ id: 300, title: '50x60', options: { size: '50x60' } }, { id: 301, title: '60x80', options: { size: '60x80' } }],
  };
  return {
    listBlueprints: async () => blueprints,
    getBlueprint: async id => blueprints.find(b => b.id === id),
    listPrintProviders: async bp => providers[bp] || [],
    getPrintProvider: async id => ({ id, location: { country: locations[id] } }),
    listVariants: async (bp, pp) => ({ variants: variants[`${bp}/${pp}`] || [] }),
  };
}

test('blueprint is found by words, shortest exact-ish title first', async () => {
  assert.equal((await resolveBlueprint(fakeClient(), { query: 'unisex heavy cotton tee' })).id, 22);
  assert.equal((await resolveBlueprint(fakeClient(), { query: 'blanket' })).id, 33);
  assert.equal((await resolveBlueprint(fakeClient(), { id: '11' })).id, 11);
  await assert.rejects(resolveBlueprint(fakeClient(), { query: 'duffel bag' }));
  await assert.rejects(resolveBlueprint(fakeClient(), {}));
});

test('provider prefers Printify Choice, then US, and validates an explicit id', async () => {
  assert.equal((await resolveProvider(fakeClient(), 33)).id, 99);
  assert.equal((await resolveProvider(fakeClient(), 22)).id, 2);
  assert.equal((await resolveProvider(fakeClient(), 22, { id: 1 })).id, 1);
  await assert.rejects(resolveProvider(fakeClient(), 22, { id: 99 }));
});

test('variants default to first color and S-XL; blankets keep every size', async () => {
  const tee = await resolveVariants(fakeClient(), 22, 2);
  assert.deepEqual(tee.map(v => v.id), [101, 102, 103, 104]);
  const white = await resolveVariants(fakeClient(), 22, 2, { colors: ['white'], sizes: ['M', '2XL'] });
  assert.deepEqual(white.map(v => v.id), [202, 205]);
  const blanket = await resolveVariants(fakeClient(), 33, 99);
  assert.deepEqual(blanket.map(v => v.id), [300, 301]);
});

test('full spec resolves live with no hand-typed ids', async () => {
  const spec = await resolveProductSpec(fakeClient(), { type: 'heavy cotton tee unisex' });
  assert.equal(spec.blueprint.id, 22);
  assert.equal(spec.provider.id, 2);
  assert.equal(spec.variants.length, 4);
});

test('merch factory has no hardcoded Printify ids', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../tools/merch-factory.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /17390|Number\(arg\('--blueprint', '\d+'\)\)|Number\(arg\('--provider', '\d+'\)\)/);
});
