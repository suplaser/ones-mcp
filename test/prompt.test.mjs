import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { confirm, password } from '@inquirer/prompts';
import { render } from '@inquirer/testing';
import { apiKeyPromptOptions, overwriteApiKeyPromptOptions } from '../dist/prompt.js';

test('overwrite confirmation defaults to keeping the existing key', { timeout: 5000 }, async () => {
  const control = new AbortController();
  const prompt = await render(confirm, overwriteApiKeyPromptOptions, { signal: control.signal });
  try {
    prompt.events.keypress('enter');
    assert.equal(await prompt.answer, false);
  } finally { control.abort(); }
});

test('typed characters each render exactly one star and never reveal via Ctrl+T', { timeout: 5000 }, async () => {
  const control = new AbortController();
  const prompt = await render(password, apiKeyPromptOptions, { signal: control.signal });
  const key = 'aB3-xY9_';
  try {
    for (let i = 0; i < key.length; i++) {
      prompt.events.type(key[i]);
      await setImmediate();
      assert.ok(prompt.getScreen().endsWith('*'.repeat(i + 1)));
      assert.equal((prompt.getScreen().match(/\*+$/)?.[0] ?? '').length, i + 1);
    }
    prompt.events.keypress({ name: 't', ctrl: true });
    await setImmediate();
    assert.ok(!prompt.getScreen().includes(key));
    assert.ok(prompt.getScreen().endsWith('*'.repeat(key.length)));
    prompt.events.keypress('enter');
    assert.equal(await prompt.answer, key);
    assert.ok(prompt.getScreen().endsWith('*'.repeat(key.length)));
    assert.ok(!(await prompt.getFullOutput({ raw: true })).includes(key));
  } finally { control.abort(); }
});

test('a pasted string renders equal-length stars, with no plaintext before or after submit', { timeout: 5000 }, async () => {
  const control = new AbortController();
  const prompt = await render(password, apiKeyPromptOptions, { signal: control.signal });
  const key = 'pasted-key-0123456789';
  try {
    // One input chunk, as emitted by terminal clipboard paste.
    prompt.events.type(key);
    await setImmediate();
    assert.equal((prompt.getScreen().match(/\*+$/)?.[0] ?? '').length, key.length);
    assert.ok(!prompt.getScreen().includes(key));
    prompt.events.keypress('backspace');
    await setImmediate();
    assert.equal((prompt.getScreen().match(/\*+$/)?.[0] ?? '').length, key.length - 1);
    prompt.events.keypress('enter');
    assert.equal(await prompt.answer, key.slice(0, -1));
    assert.ok(!(await prompt.getFullOutput({ raw: true })).includes(key));
  } finally { control.abort(); }
});

test('bracketed clipboard paste stays masked', { timeout: 5000 }, async () => {
  const control = new AbortController();
  const prompt = await render(password, apiKeyPromptOptions, { signal: control.signal });
  const key = 'bracketed-paste-0123';
  try {
    prompt.input.write(`\u001b[200~${key}\u001b[201~`);
    await setImmediate();
    assert.equal((prompt.getScreen().match(/\*+$/)?.[0] ?? '').length, key.length);
    prompt.events.keypress('enter');
    assert.equal(await prompt.answer, key);
    assert.ok(!(await prompt.getFullOutput({ raw: true })).includes(key));
  } finally { control.abort(); }
});
