import { Session } from '@shopify/shopify-api';
import type { SessionStorage } from '@shopify/shopify-app-session-storage';

export interface SessionRow {
  id: string;
  shop: string;
  state: string;
  isOnline: boolean;
  scope: string | null;
  expires: Date | null;
  accessToken: string;
  userId: bigint | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  accountOwner: boolean | null;
  locale: string | null;
  collaborator: boolean | null;
  emailVerified: boolean | null;
  refreshToken: string | null;
  refreshTokenExpires: Date | null;
}

/** The subset of a Prisma `session` model delegate this storage uses. */
export interface SessionDelegate {
  count(): Promise<number>;
  upsert(args: { where: { id: string }; update: SessionRow; create: SessionRow }): Promise<unknown>;
  findUnique(args: { where: { id: string } }): Promise<SessionRow | null>;
  deleteMany(args: { where: { id: string } | { id: { in: string[] } } }): Promise<unknown>;
  findMany(args: { where: { shop: string }; take: number; orderBy: { expires: 'desc' }[] }): Promise<SessionRow[]>;
}

export interface PrismaSessionStorageOptions {
  /** Key of the session model on the Prisma client. Defaults to `session`. */
  tableName?: string;
  /** How many times to check that the table exists on startup. Defaults to 2. */
  connectionRetries?: number;
  /** Wait between those checks, in ms. Defaults to 5000. */
  connectionRetryIntervalMs?: number;
}

const UNIQUE_CONSTRAINT_ERROR_CODE = 'P2002';

export class MissingSessionTableError extends Error {}
export class MissingSessionStorageError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sessionToRow(session: Session): SessionRow {
  const user = session.toObject().onlineAccessInfo?.associated_user;
  return {
    id: session.id,
    shop: session.shop,
    state: session.state,
    isOnline: session.isOnline,
    scope: session.scope || null,
    expires: session.expires || null,
    accessToken: session.accessToken || '',
    userId: user?.id != null ? BigInt(user.id) : null,
    firstName: user?.first_name || null,
    lastName: user?.last_name || null,
    email: user?.email || null,
    accountOwner: user?.account_owner ?? false,
    locale: user?.locale || null,
    collaborator: user?.collaborator ?? false,
    emailVerified: user?.email_verified ?? false,
    refreshToken: session.refreshToken || null,
    refreshTokenExpires: session.refreshTokenExpires || null,
  };
}

function rowToSession(row: SessionRow): Session {
  const params: Record<string, string | number | boolean> = {
    id: row.id,
    shop: row.shop,
    state: row.state,
    isOnline: row.isOnline,
  };
  if (row.userId != null) params.userId = String(row.userId);
  if (row.firstName) params.firstName = row.firstName;
  if (row.lastName) params.lastName = row.lastName;
  if (row.email) params.email = row.email;
  if (row.locale) params.locale = row.locale;
  if (row.accountOwner !== null) params.accountOwner = row.accountOwner;
  if (row.collaborator !== null) params.collaborator = row.collaborator;
  if (row.emailVerified !== null) params.emailVerified = row.emailVerified;
  if (row.expires) params.expires = row.expires.getTime();
  if (row.scope) params.scope = row.scope;
  if (row.accessToken) params.accessToken = row.accessToken;
  if (row.refreshToken) params.refreshToken = row.refreshToken;
  if (row.refreshTokenExpires) params.refreshTokenExpires = row.refreshTokenExpires.getTime();
  return Session.fromPropertyArray(Object.entries(params), true);
}

export class PrismaSessionStorage implements SessionStorage {
  #table: SessionDelegate;
  #tableName: string;
  #retries: number;
  #retryIntervalMs: number;
  #ready: Promise<boolean>;

  constructor(
    prisma: object,
    {
      tableName = 'session',
      connectionRetries = 2,
      connectionRetryIntervalMs = 5000,
    }: PrismaSessionStorageOptions = {},
  ) {
    const table = (prisma as Record<string, SessionDelegate | undefined>)[tableName];
    if (!table) throw new Error(`PrismaClient does not have a ${tableName} table`);
    this.#table = table;
    this.#tableName = tableName;
    this.#retries = connectionRetries;
    this.#retryIntervalMs = connectionRetryIntervalMs;

    this.#ready = this.#pollForTable().then(
      () => true,
      (cause) => {
        throw new MissingSessionTableError(
          `Prisma ${tableName} table does not exist. Run the database migration (e.g. \`prisma db push\`).`,
          { cause },
        );
      },
    );
    // Avoid an unhandled rejection if nothing awaits it; ensureReady() still surfaces the error.
    this.#ready.catch(() => {});
  }

  /** Polls the table again and resolves whether it is available. */
  async isReady() {
    try {
      await this.#pollForTable();
      this.#ready = Promise.resolve(true);
    } catch {
      this.#ready = Promise.resolve(false);
    }
    return this.#ready;
  }

  async storeSession(session: Session) {
    await this.#ensureReady();
    const data = sessionToRow(session);
    const upsert = () => this.#table.upsert({ where: { id: session.id }, update: data, create: data });
    try {
      await upsert();
    } catch (error) {
      // Two concurrent requests can race to create the same session; the second upsert then updates it.
      if ((error as { code?: string } | null)?.code !== UNIQUE_CONSTRAINT_ERROR_CODE) throw error;
      await upsert();
    }
    return true;
  }

  async loadSession(id: string) {
    await this.#ensureReady();
    const row = await this.#table.findUnique({ where: { id } });
    return row ? rowToSession(row) : undefined;
  }

  async deleteSession(id: string) {
    await this.#ensureReady();
    await this.#table.deleteMany({ where: { id } });
    return true;
  }

  async deleteSessions(ids: string[]) {
    await this.#ensureReady();
    await this.#table.deleteMany({ where: { id: { in: ids } } });
    return true;
  }

  async findSessionsByShop(shop: string) {
    await this.#ensureReady();
    const rows = await this.#table.findMany({ where: { shop }, take: 25, orderBy: [{ expires: 'desc' }] });
    return rows.map(rowToSession);
  }

  async #ensureReady() {
    if (!(await this.#ready)) {
      throw new MissingSessionStorageError(
        'Prisma session storage is not ready. Use the `isReady` method to poll for the table.',
      );
    }
  }

  async #pollForTable() {
    for (let i = 0; i < this.#retries; i++) {
      try {
        await this.#table.count();
        return;
      } catch (error) {
        console.log(`Error obtaining session table: ${error}`);
      }
      await sleep(this.#retryIntervalMs);
    }
    throw new Error(`The table \`${this.#tableName}\` does not exist in the current database.`);
  }
}
