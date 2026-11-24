import { Session } from '@grafikr/shopify-app-remix';
import * as assert from 'remix/assert';
import { describe, it } from 'remix/test';
import { MissingSessionTableError, PrismaSessionStorage, type SessionDelegate, type SessionRow } from './index.ts';

function fakeTable(overrides: Partial<SessionDelegate> = {}) {
  const rows = new Map<string, SessionRow>();
  const table: SessionDelegate = {
    async count() {
      return rows.size;
    },
    async upsert({ where, create }) {
      rows.set(where.id, create);
    },
    async findUnique({ where }) {
      return rows.get(where.id) ?? null;
    },
    async deleteMany() {},
    async findMany() {
      return [...rows.values()];
    },
    ...overrides,
  };
  return table;
}

const session = new Session({
  id: 'offline_a.myshopify.com',
  shop: 'a.myshopify.com',
  state: 's',
  isOnline: false,
  accessToken: 't',
});

describe('PrismaSessionStorage', () => {
  it('retries the upsert once on a P2002 unique constraint error', async () => {
    let calls = 0;
    const table = fakeTable({
      async upsert() {
        if (++calls === 1) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      },
    });
    const storage = new PrismaSessionStorage({ session: table });

    assert.equal(await storage.storeSession(session), true);
    assert.equal(calls, 2);
  });

  it('does not swallow other upsert errors', async () => {
    let calls = 0;
    const table = fakeTable({
      async upsert() {
        calls++;
        throw Object.assign(new Error('boom'), { code: 'P1001' });
      },
    });
    const storage = new PrismaSessionStorage({ session: table });

    await assert.rejects(() => storage.storeSession(session), /boom/);
    assert.equal(calls, 1);
  });

  it('rejects with MissingSessionTableError when the table is missing', async () => {
    const table = fakeTable({
      async count() {
        throw new Error('no such table');
      },
    });
    const storage = new PrismaSessionStorage(
      { session: table },
      { connectionRetries: 1, connectionRetryIntervalMs: 1 },
    );

    await assert.rejects(() => storage.loadSession('x'), MissingSessionTableError);
    assert.equal(await storage.isReady(), false);
  });
});
