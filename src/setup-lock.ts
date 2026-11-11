import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

export interface SetupLease {
  handoff(pid: number): Promise<void>;
  release(): Promise<void>;
}

export interface SetupLock {
  acquire(): Promise<SetupLease | null>;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export class FileSetupLock implements SetupLock {
  private readonly path: string;
  private readonly directory: string;

  constructor(origin: string, directory?: string) {
    this.directory = directory ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.config'), 'ones-mcp');
    this.path = join(this.directory, `setup-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}.lock`);
  }

  async acquire(): Promise<SetupLease | null> {
    await mkdir(this.directory, { recursive: true });
    const releaseGuard = await this.guard();
    let ownerId: string;
    try {
      const current = await this.readOwner();
      if (current && processExists(current.pid)) return null;
      ownerId = randomUUID();
      await writeFile(this.path, JSON.stringify({ id: ownerId, pid: process.pid }), { mode: 0o600 });
    } finally {
      await releaseGuard();
    }
    return {
      handoff: async (pid) => {
        const release = await this.guard();
        try {
          if ((await this.readOwner())?.id !== ownerId) throw new Error('Setup lease ownership changed');
          await writeFile(this.path, JSON.stringify({ id: ownerId, pid }), { mode: 0o600 });
        } finally { await release(); }
      },
      release: async () => {
        const release = await this.guard();
        try {
          if ((await this.readOwner())?.id === ownerId) await unlink(this.path);
        } finally { await release(); }
      },
    };
  }

  private guard(): Promise<() => Promise<void>> {
    return lockfile.lock(this.directory, {
      lockfilePath: `${this.path}.guard`,
      retries: { retries: 20, minTimeout: 10, maxTimeout: 50 },
      stale: 10_000,
    });
  }

  private async readOwner(): Promise<{ id: string; pid: number } | null> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (typeof data === 'object' && data !== null && 'id' in data && typeof data.id === 'string' &&
          'pid' in data && typeof data.pid === 'number' && Number.isInteger(data.pid) && data.pid > 0) {
        return { id: data.id, pid: data.pid };
      }
      throw new Error('Invalid setup lease metadata');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('无法读取 API Key 输入窗口状态，请检查本地配置目录。');
    }
  }
}
