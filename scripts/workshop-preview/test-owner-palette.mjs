#!/usr/bin/env node
// Tests for the owner identity palette. Pure, no external network, no deps.
//
// Run: node scripts/workshop-preview/test-owner-palette.mjs
// Exit 0 = all pass; exit 1 = at least one failure.
//
// Checks: 128 unique valid RGB, index bounds, frozen, determinism (stable
// across fresh module loads), and the non-text contrast criterion vs #203a30.
import { OWNER_PALETTE, OWNER_PALETTE_SIZE, ownerIdentity } from './owner-palette.mjs';

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HEX = /^#[0-9a-f]{6}$/i;
const BACKPLATE = { r: 0x20, g: 0x3a, b: 0x30 }; // #203a30
function hexToRgb(hex) {
  const m = hex.slice(1);
  return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16) };
}
function channelLin(v8) {
  const v = v8 / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function relLum({ r, g, b }) {
  return 0.2126 * channelLin(r) + 0.7152 * channelLin(g) + 0.0722 * channelLin(b);
}
function contrast(a, b) {
  const la = relLum(a); const lb = relLum(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
function hslLightness({ r, g, b }) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  return (Math.max(rn, gn, bn) + Math.min(rn, gn, bn)) / 2;
}

console.log('owner palette test\n');

console.log('[shape] 128 entries, exact fields, stable index');
check('exactly 128 entries (OWNER_PALETTE_SIZE 128)', OWNER_PALETTE.length === 128 && OWNER_PALETTE_SIZE === 128);
check('every entry has exactly {index,color,mark}', OWNER_PALETTE.every((e) =>
  Array.isArray(e) === false && Object.keys(e).length === 3
  && typeof e.index === 'number' && typeof e.color === 'string' && typeof e.mark === 'string'));
check('index equals its position (stable prefix)', OWNER_PALETTE.every((e, i) => e.index === i));

console.log('\n[colour] valid + unique RGB, marks unique');
check('every colour is valid #rrggbb hex', OWNER_PALETTE.every((e) => HEX.test(e.color)));
check('all 128 colours are unique', new Set(OWNER_PALETTE.map((e) => e.color.toLowerCase())).size === 128);
check('all 128 marks are unique', new Set(OWNER_PALETTE.map((e) => e.mark)).size === 128);
check('mark is padded index+1 (01..128)', OWNER_PALETTE.every((e) => e.mark === String(e.index + 1).padStart(2, '0')));

console.log('\n[frozen] palette and entries are immutable');
check('OWNER_PALETTE is frozen', Object.isFrozen(OWNER_PALETTE));
check('every entry is frozen', OWNER_PALETTE.every((e) => Object.isFrozen(e)));

console.log('\n[bounds] ownerIdentity valid only for integers 0..127');
check('ownerIdentity(0) -> entry 0', ownerIdentity(0) === OWNER_PALETTE[0]);
check('ownerIdentity(127) -> entry 127', ownerIdentity(127) === OWNER_PALETTE[127]);
check('ownerIdentity(-1) -> null', ownerIdentity(-1) === null);
check('ownerIdentity(128) -> null', ownerIdentity(128) === null);
check('ownerIdentity(129) -> null', ownerIdentity(129) === null);
check('ownerIdentity(1.5) -> null', ownerIdentity(1.5) === null);
check('ownerIdentity("5") -> null', ownerIdentity('5') === null);
check('ownerIdentity(NaN) -> null', ownerIdentity(NaN) === null);
check('ownerIdentity(undefined) -> null', ownerIdentity(undefined) === null);
check('ownerIdentity(null) -> null', ownerIdentity(null) === null);

console.log('\n[determinism] stable entry, identical across fresh loads');
check('ownerIdentity(i) is the same frozen entry every call', OWNER_PALETTE.every((e, i) => ownerIdentity(i) === e));
check('ownerIdentity(7) referentially stable', ownerIdentity(7) === ownerIdentity(7) && ownerIdentity(7) === OWNER_PALETTE[7]);
{
  const fresh = await import('./owner-palette.mjs?determinism=1');
  check('fresh module load reproduces the identical palette (no random)',
    JSON.stringify(fresh.OWNER_PALETTE) === JSON.stringify(OWNER_PALETTE));
}

console.log('\n[contrast] non-text accent vs #203a30 backplate');
const contrasts = OWNER_PALETTE.map((e) => contrast(hexToRgb(e.color), BACKPLATE));
const minContrast = Math.min(...contrasts);
const maxContrast = Math.max(...contrasts);
check(`every colour contrast vs #203a30 >= 3 (min ${minContrast.toFixed(2)}, max ${maxContrast.toFixed(2)})`,
  contrasts.every((c) => c >= 3));

console.log('\n[balance] medium light/saturation, no near-black/white accents');
const lights = OWNER_PALETTE.map((e) => hslLightness(hexToRgb(e.color)));
check('lightness stays in a medium band (0.45..0.85)', lights.every((l) => l >= 0.45 && l <= 0.85),
  `min ${Math.min(...lights).toFixed(2)} max ${Math.max(...lights).toFixed(2)}`);
check('no near-black or near-white accents', lights.every((l) => l > 0.4 && l < 0.9));

console.log('\n----------------------------------------');
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} of ${passed + failures.length} checks`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`PASSED: all ${passed} checks`);
process.exit(0);
