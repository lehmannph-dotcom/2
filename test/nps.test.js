'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nps = require('../src/nps');

test('NPS-Kategorien', () => {
  assert.deepEqual([0, 6, 7, 8, 9, 10].map(nps.category), ['detractor', 'detractor', 'passive', 'passive', 'promoter', 'promoter']);
  assert.equal(nps.parseScore('7'), 7);
  assert.equal(nps.parseScore(11), null);
  assert.equal(nps.parseScore(7.5), null);
  assert.equal(nps.parseScore(undefined), null);
});

test('NPS = % Promotoren − % Kritiker', () => {
  const u = {};
  assert.equal(nps.npsOf(u), null);
  [10, 9, 9, 8, 7, 3, 9, 10, 0, 9].forEach((s) => nps.addScore(u, s));
  // 6 Promotoren, 2 Passive, 2 Kritiker → (6 − 2) / 10 = 40
  assert.equal(nps.npsOf(u), 40);
  assert.deepEqual(nps.summary(u), { score: 40, count: 10, promoters: 6, passives: 2, detractors: 2 });
});

test('Geglätteter NPS für das Matching', () => {
  const neu = {};
  const einer = {};
  nps.addScore(einer, 0);
  assert.equal(nps.smoothedNps(neu), 0);
  assert.equal(nps.smoothedNps(einer), -25, 'ein Kritiker allein ergibt nicht gleich −100');
  const viele = {};
  for (let i = 0; i < 50; i++) nps.addScore(viele, 10);
  assert.ok(nps.smoothedNps(viele) > 90);
});
