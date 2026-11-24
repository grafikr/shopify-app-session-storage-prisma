import { Session } from '@grafikr/shopify-app-remix';
import { describe, expect, it } from 'bun:test';
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

    expect(await storage.storeSession(session)).toBe(true);
    expect(calls).toBe(2);
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

    await expect(storage.storeSession(session)).rejects.toThrow(/boom/);
    expect(calls).toBe(1);
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

    await expect(storage.loadSession('x')).rejects.toBeInstanceOf(MissingSessionTableError);
    expect(await storage.isReady()).toBe(false);
  });

  it('round-trips an offline session', async () => {
    const storage = new PrismaSessionStorage({ session: fakeTable() });
    await storage.storeSession(
      new Session({
        id: 'offline_a.myshopify.com',
        shop: 'a.myshopify.com',
        state: 's',
        isOnline: false,
        accessToken: 'tok',
        scope: 'read_products',
      }),
    );

    const loaded = await storage.loadSession('offline_a.myshopify.com');
    expect(loaded?.shop).toBe('a.myshopify.com');
    expect(loaded?.accessToken).toBe('tok');
    expect(loaded?.scope).toBe('read_products');
    expect(loaded?.isOnline).toBe(false);
  });

  it('returns undefined for an unknown session', async () => {
    const storage = new PrismaSessionStorage({ session: fakeTable() });
    expect(await storage.loadSession('nope')).toBeUndefined();
  });

  it('stores online access info as columns', async () => {
    let stored: SessionRow | undefined;
    const table = fakeTable({
      async upsert({ create }) {
        stored = create;
      },
    });
    const storage = new PrismaSessionStorage({ session: table });
    await storage.storeSession(
      new Session({
        id: 'online_1',
        shop: 'a.myshopify.com',
        state: 's',
        isOnline: true,
        accessToken: 'tok',
        onlineAccessInfo: {
          expires_in: 100,
          associated_user_scope: 'read_products',
          associated_user: {
            id: 123,
            first_name: 'Ada',
            last_name: 'Lovelace',
            email: 'ada@example.com',
            account_owner: true,
            locale: 'en',
            collaborator: false,
            email_verified: true,
          },
        },
      }),
    );

    expect(stored?.userId).toBe(123n);
    expect(stored?.firstName).toBe('Ada');
    expect(stored?.email).toBe('ada@example.com');
    expect(stored?.accountOwner).toBe(true);
    expect(stored?.emailVerified).toBe(true);
  });

  it('deletes one or many sessions by id', async () => {
    const calls: unknown[] = [];
    const table = fakeTable({
      async deleteMany(args) {
        calls.push(args.where);
      },
    });
    const storage = new PrismaSessionStorage({ session: table });

    expect(await storage.deleteSession('a')).toBe(true);
    expect(await storage.deleteSessions(['a', 'b'])).toBe(true);
    expect(calls).toEqual([{ id: 'a' }, { id: { in: ['a', 'b'] } }]);
  });

  it('finds sessions by shop, newest expiry first, capped at 25', async () => {
    let args: unknown;
    const table = fakeTable({
      async findMany(a) {
        args = a;
        return [
          {
            id: 'offline_a',
            shop: 'a.myshopify.com',
            state: 's',
            isOnline: false,
            scope: null,
            expires: null,
            accessToken: 't',
            userId: null,
            firstName: null,
            lastName: null,
            email: null,
            accountOwner: null,
            locale: null,
            collaborator: null,
            emailVerified: null,
            refreshToken: null,
            refreshTokenExpires: null,
          },
        ];
      },
    });
    const storage = new PrismaSessionStorage({ session: table });

    const sessions = await storage.findSessionsByShop('a.myshopify.com');
    expect(sessions.map((s) => s.id)).toEqual(['offline_a']);
    expect(args).toEqual({ where: { shop: 'a.myshopify.com' }, take: 25, orderBy: [{ expires: 'desc' }] });
  });

  it('throws when the Prisma client lacks the table', () => {
    expect(() => new PrismaSessionStorage({})).toThrow(/does not have a session table/);
  });

  it('supports a custom table name', async () => {
    const storage = new PrismaSessionStorage({ shopifySession: fakeTable() }, { tableName: 'shopifySession' });
    expect(await storage.isReady()).toBe(true);
  });
});
