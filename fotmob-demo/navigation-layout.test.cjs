'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const appRule = css.match(/\.app\{([^}]*)\}/)?.[1] || '';
const mainRule = css.match(/(?:^|})main\{([^}]*)\}/)?.[1] || '';
const navRule = css.match(/\.bottomnav\{([^}]*)\}/)?.[1] || '';

test('keeps the app shell within short mobile viewports', () => {
  assert.match(appRule, /height:100dvh/);
  assert.match(appRule, /min-height:0/);
});

test('pins the bottom navigation to the app bottom independently of flex sizing', () => {
  assert.match(navRule, /position:absolute/);
  assert.match(navRule, /left:0/);
  assert.match(navRule, /right:0/);
  assert.match(navRule, /bottom:0/);
  assert.match(navRule, /height:calc\(68px \+ var\(--safe-bottom\)\)/);
});

test('leaves enough scroll padding for the fixed bottom navigation', () => {
  assert.match(mainRule, /overflow:auto/);
  assert.match(mainRule, /padding-bottom:calc\(14px \+ 68px \+ var\(--safe-bottom\)\)/);
});

test('renders the bottom navigation before app scripts initialize', () => {
  const navMarkup = html.match(/<nav class="bottomnav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
  for (const page of ['Matches', 'News', 'Leagues', 'Following', 'More']) {
    assert.match(navMarkup, new RegExp(`data-page="${page}"`));
  }
});

test('includes a circular branded startup screen with a football animation and progress track', () => {
  assert.match(html, /id="boot-splash"/);
  assert.match(html, /class="boot-brand-orb"/);
  assert.match(html, /class="boot-player"/);
  assert.match(html, /class="boot-ball"/);
  assert.match(html, /class="boot-progress" role="progressbar"/);
  assert.match(css, /\.boot-brand-orb\{[^}]*border-radius:50%/);
  assert.match(css, /@keyframes boot-kick/);
  assert.match(css, /@keyframes boot-ball-roll/);
});
