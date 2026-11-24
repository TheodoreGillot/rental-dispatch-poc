'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const shipped = ['index.html', 'styles.css', ...fs.readdirSync(path.join(root, 'src')).map((f) => `src/${f}`)];

describe('static checks on shipped files', () => {
  test('the CSP keeps default-src self and adds base-uri and form-action none', () => {
    const html = read('index.html');
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html);
    assert.ok(csp, 'CSP meta tag present');
    assert.equal(csp[1], "default-src 'self'; base-uri 'none'; form-action 'none'");
  });

  test('the five tab labels are present and the current one uses aria-current', () => {
    const html = read('index.html');
    for (const label of ['Dispatch', 'Calendar', 'Equipment', 'Reservations', 'Assistant']) {
      assert.match(html, new RegExp(`>${label}<`), label);
    }
    assert.equal((html.match(/class="nav-tab"/g) || []).length, 5);
    assert.match(html, /class="nav-tab" data-tab="dispatch" aria-current="page"/);
  });

  test('the scope card sentence is present verbatim', () => {
    const sentence = "Real: constraint check and re-plan search (deterministic code). Assistant: rule-based intent parsing and templated replies; 0 LLM calls. Faked: login, data, client messages, vendor integrations. Cut: billing, dashboards (except the summary cards on Dispatch), settings.";
    assert.ok(read('index.html').includes(sentence), 'scope card sentence must match exactly');
  });

  test('LLM calls appear as 0 and the fictional labels stay visible', () => {
    const html = read('index.html');
    assert.match(html, /LLM calls: 0/);
    assert.match(html, /0 LLM calls/);
    assert.ok(html.includes('Atelier Lumière (fictional)'));
    assert.ok(html.includes('All data is fictional'));
  });

  test('no innerHTML, eval or Function constructor in shipped files', () => {
    const banned = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/;
    for (const file of shipped) assert.doesNotMatch(read(file), banned, file);
  });

  test('no http or https URL in index.html, src or styles.css', () => {
    for (const file of shipped) assert.doesNotMatch(read(file), /https?:\/\//i, file);
  });

  test('scripts load validation before solver and the pure layers before app', () => {
    const scripts = [...read('index.html').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const order = (name) => scripts.indexOf(name);
    assert.ok(order('src/validation.js') >= 0 && order('src/validation.js') < order('src/solver.js'));
    assert.ok(order('src/approval.js') >= 0 && order('src/approval.js') < order('src/app.js'));
    assert.ok(order('src/solver.js') < order('src/tools.js'));
    assert.ok(order('src/tools.js') < order('src/assistant.js'));
    assert.ok(order('src/summary.js') >= 0 && order('src/summary.js') < order('src/app.js'));
    assert.ok(order('src/assistant.js') < order('src/app.js'));
  });

  test('the README does not claim a stubbed-DOM smoke run', () => {
    assert.doesNotMatch(read('README.md'), /stubbed-DOM/i);
  });
});
