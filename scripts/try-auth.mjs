// Manual end-to-end check. This intentionally opens the real onboarding UI.
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'local-onboarding-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('dist/index.js')],
  stderr: 'pipe',
});
// Only fixed application messages appear on stderr, but do not capture the user's prompt.
transport.stderr?.on('data', () => {});
try {
  await client.connect(transport);
  console.log(JSON.stringify({ connected: true, tools: (await client.listTools()).tools.map((tool) => tool.name) }));
  let last;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: 'ones_auth_status', arguments: {} });
    const status = result.structuredContent;
    if (!status) throw new Error('No credential status was returned');
    const current = JSON.stringify({ configured: status.configured, setup: status.setup, source: status.source });
    if (current !== last) { console.log(current); last = current; }
    if (status.configured || status.setup === 'manual-required') break;
    await setTimeout(1000);
  }
  console.log('Read-only status check finished; any open input window remains under user control.');
} finally {
  await client.close();
}
