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
    assert.match(csp[1], /default-src 'self'/);
    assert.match(csp[1], /base-uri 'none'/);
    assert.match(csp[1], /form-action 'none'/);
  });

  test('no innerHTML, eval or Function constructor in shipped files', () => {
    const banned = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/;
    for (const file of shipped) assert.doesNotMatch(read(file), banned, file);
  });

  test('no http or https URL in index.html, src or styles.css', () => {
    for (const file of shipped) assert.doesNotMatch(read(file), /https?:\/\//i, file);
  });

  test('scripts load validation before solver and approval before app', () => {
    const scripts = [...read('index.html').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const order = (name) => scripts.indexOf(name);
    assert.ok(order('src/validation.js') >= 0 && order('src/validation.js') < order('src/solver.js'));
    assert.ok(order('src/approval.js') >= 0 && order('src/approval.js') < order('src/app.js'));
  });

  test('the README does not claim a stubbed-DOM smoke run', () => {
    assert.doesNotMatch(read('README.md'), /stubbed-DOM/i);
  });
});
