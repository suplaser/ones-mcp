import assert from 'node:assert/strict';
import test from 'node:test';
import { configureApiKey } from '../dist/login.js';

function fixture(saved = null, answer = false) {
  const state = { saved, confirms: 0, reads: 0, writes: 0, browsers: 0, logs: [] };
  return {
    state,
    store: {
      get: async () => state.saved,
      set: async (key) => { state.saved = key; state.writes++; },
    },
    desktop: { openBrowser: async () => { state.browsers++; } },
    prompts: {
      confirmOverwrite: async () => { state.confirms++; return answer; },
      readApiKey: async () => { state.reads++; return 'synthetic-new-key'; },
    },
    log: (message) => state.logs.push(message),
  };
}

const config = { origin: 'https://ones.cn', environmentApiKey: undefined };

test('declining overwrite preserves the existing key without opening a browser or asking for input', async () => {
  const f = fixture('synthetic-old-key');
  assert.equal(await configureApiKey(config, f.store, f.desktop, f.prompts, true, f.log), 'kept');
  assert.equal(f.state.saved, 'synthetic-old-key');
  assert.equal(f.state.confirms, 1);
  assert.equal(f.state.reads, 0);
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.browsers, 0);
});

test('accepting overwrite replaces the existing key after confirmation', async () => {
  const f = fixture('synthetic-old-key', true);
  assert.equal(await configureApiKey(config, f.store, f.desktop, f.prompts, true, f.log), 'saved');
  assert.equal(f.state.saved, 'synthetic-new-key');
  assert.equal(f.state.confirms, 1);
  assert.equal(f.state.reads, 1);
  assert.equal(f.state.writes, 1);
  assert.equal(f.state.browsers, 1);
  assert.ok(!f.state.logs.join('').includes('synthetic-new-key'));
});

test('first-time setup does not ask to overwrite', async () => {
  const f = fixture();
  assert.equal(await configureApiKey(config, f.store, f.desktop, f.prompts, false, f.log), 'saved');
  assert.equal(f.state.confirms, 0);
  assert.equal(f.state.writes, 1);
  assert.equal(f.state.browsers, 0);
});

test('cancelling the confirmation leaves the original key untouched', async () => {
  const f = fixture('synthetic-old-key');
  f.prompts.confirmOverwrite = async () => { throw new Error('cancelled'); };
  await assert.rejects(configureApiKey(config, f.store, f.desktop, f.prompts, true, f.log));
  assert.equal(f.state.saved, 'synthetic-old-key');
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.browsers, 0);
});

test('environment credentials remain unchanged and their priority is explained', async () => {
  const f = fixture(null, true);
  const envConfig = { ...config, environmentApiKey: 'synthetic-environment-key' };
  await configureApiKey(envConfig, f.store, f.desktop, f.prompts, false, f.log);
  assert.equal(envConfig.environmentApiKey, 'synthetic-environment-key');
  assert.equal(f.state.saved, 'synthetic-new-key');
  assert.ok(f.state.logs.some((message) => message.includes('环境变量仍优先')));
});
