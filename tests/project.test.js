'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const srcFiles = fs.readdirSync(path.join(root, 'src')).map((file) => `src/${file}`);
const shipped = ['index.html', 'styles.css', ...srcFiles];

function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&middot;/g, '·')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const FORBIDDEN = [
  'fictional',
  'demo',
  'proof of concept',
  'poc',
  'llm calls',
  'about this demo',
  'real:',
  'wrapper:',
  'faked:',
  'cut:',
];

function forbiddenPattern(word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
}

assert.equal(forbiddenPattern('poc').test('epoch'), false);
assert.equal(forbiddenPattern('poc').test('a PoC build'), true);

describe('UI framing', () => {
  test('no forbidden framing words appear in the visible page text', () => {
    const text = visibleText(read('index.html'));
    for (const word of FORBIDDEN) {
      assert.equal(forbiddenPattern(word).test(text), false, `visible text contains "${word}"`);
    }
  });

  test('no forbidden framing words appear in the shipped UI strings', () => {
    for (const file of shipped) {
      const source = read(file);
      for (const word of FORBIDDEN) {
        assert.doesNotMatch(source, forbiddenPattern(word), `${file} contains "${word}"`);
      }
    }
  });

  test('the assistant header carries the required AI transparency line', () => {
    const html = read('index.html');
    assert.match(html, /<h1 id="assistant-title"[^>]*>Assistant · AI, answers may need checking<\/h1>/);
    assert.equal((visibleText(html).match(/answers may need checking/g) || []).length, 1);
    const assistant = read('src/assistant.js');
    assert.match(assistant, /OPENING = 'I am an AI assistant, and answers may need checking\./);
  });

  test('the scope card and its copy are gone, replaced by a neutral footer', () => {
    const html = read('index.html');
    assert.doesNotMatch(html, /scope-card|About this|scope-sentence/);
    assert.match(html, /© 2026 Atelier Lumière\. All rights reserved\./);
    assert.match(html, /Version 2\.0\.0/);
  });

  test('the brand is Atelier Lumière without a qualifier', () => {
    assert.match(read('index.html'), /Atelier Lumière/);
    assert.doesNotMatch(read('index.html'), /\(fictional\)/);
  });
});

describe('project notes and README', () => {
  test('PROJECT_NOTES.md exists and carries the required honest notes', () => {
    const notes = read('PROJECT_NOTES.md');
    assert.match(notes, /Real:/);
    assert.match(notes, /Assistant:/);
    assert.match(notes, /Faked:/);
    assert.match(notes, /Cut:/);
    assert.match(notes, /0 LLM calls|0 LLM calls per run|LLM calls per run: 0/i);
    assert.match(notes, /rule-based/i);
    for (const word of ['login', 'data', 'client messages', 'vendor integrations']) {
      assert.match(notes, new RegExp(word, 'i'));
    }
    for (const word of ['billing', 'dashboards', 'settings']) {
      assert.match(notes, new RegExp(word, 'i'));
    }
    assert.match(notes, /data\/seed\.json/);
  });

  test('the notes are linked from README only, not from the app', () => {
    assert.match(read('README.md'), /PROJECT_NOTES\.md/);
    for (const file of ['index.html', ...srcFiles]) {
      assert.doesNotMatch(read(file), /PROJECT_NOTES/, file);
    }
  });

  test('README explains the static-server requirement for file://', () => {
    assert.match(read('README.md'), /file:\/\//);
    assert.match(read('README.md'), /static (HTTP )?server|python3 -m http\.server/i);
  });
});

describe('static guarantees', () => {
  test('the CSP meta carries the required directives', () => {
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(read('index.html'));
    assert.ok(csp);
    assert.equal(csp[1], "default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'");
  });

  test('no innerHTML, outerHTML, insertAdjacentHTML, eval or Function constructor', () => {
    const banned = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/;
    for (const file of shipped) assert.doesNotMatch(read(file), banned, file);
  });

  test('no external runtime URLs', () => {
    for (const file of [...shipped, 'favicon.svg']) {
      const source = read(file)
        .replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')
        .replace(/'http:\/\/www\.w3\.org\/2000\/svg'/g, '');
      assert.doesNotMatch(source, /https?:\/\//i, file);
    }
  });

  test('no external fonts, imports or CSS url() assets', () => {
    const css = read('styles.css');
    assert.doesNotMatch(css, /@import|url\s*\(/i);
    assert.doesNotMatch(read('index.html'), /<link[^>]+href="https?:/i);
  });

  test('scripts load pure layers before the store, tools, assistant and app', () => {
    const scripts = [...read('index.html').matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
    const order = (name) => scripts.indexOf(name);
    assert.ok(order('src/validation.js') >= 0 && order('src/validation.js') < order('src/selectors.js'));
    assert.ok(order('src/selectors.js') < order('src/solver.js'));
    assert.ok(order('src/solver.js') < order('src/proposals.js'));
    assert.ok(order('src/proposals.js') < order('src/store.js'));
    assert.ok(order('src/store.js') < order('src/assistant-tools.js'));
    assert.ok(order('src/assistant-tools.js') < order('src/assistant.js'));
    assert.ok(order('src/assistant.js') < order('src/app.js'));
  });

  test('the six views and navigation labels exist', () => {
    const html = read('index.html');
    for (const [tab, label] of [['home', 'Home'], ['calendar', 'Calendar'], ['equipment', 'Equipment'], ['reservations', 'Reservations'], ['operations', 'Operations'], ['assistant', 'Assistant']]) {
      assert.match(html, new RegExp(`id="view-${tab}"`));
      assert.match(html, new RegExp(`data-tab="${tab}"`));
      assert.match(html, new RegExp(`>\\s*<span>${label}</span>`));
    }
    assert.match(html, /id="new-reservation"/);
    assert.match(html, /id="reservation-panel"/);
    assert.match(html, /id="panel-customer-search"/);
    assert.match(html, /id="panel-start"/);
    assert.match(html, /id="panel-end"/);
    assert.match(html, /id="panel-item-search"/);
    assert.match(html, /id="panel-submit"/);
  });

  test('the app loads the one seed file with a visible error state', () => {
    const app = read('src/app.js');
    assert.match(app, /fetch\('data\/seed\.json'/);
    assert.match(app, /bootError/);
    assert.match(app, /static HTTP server/);
  });

  test('no attribution text in any shipped or documentation file', () => {
    const files = ['README.md', 'PROJECT_NOTES.md', 'index.html', 'styles.css', 'favicon.svg', ...srcFiles];
    const attributionToken = ['Cl', 'aude'].join('');
    const coAuthoredToken = ['Co', 'Authored'].join('-');
    const generatedToken = ['Generated', 'with'].join(' ');
    const pattern = new RegExp(`\\b${attributionToken}\\b|${coAuthoredToken}|${generatedToken}`, 'i');
    for (const file of files) {
      assert.doesNotMatch(read(file), pattern, file);
    }
  });
});
