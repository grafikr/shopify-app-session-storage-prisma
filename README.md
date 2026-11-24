# @grafikr/shopify-app-session-storage-prisma

`SessionStorage` for `@grafikr/shopify-app-remix` on Prisma (works with Prisma 7 generated clients and driver adapters).
Your `schema.prisma` needs a `Session` model with the columns from
`@shopify/shopify-app-session-storage-prisma`:

```prisma
model Session {
  id                  String    @id
  shop                String
  state               String
  isOnline            Boolean   @default(false)
  scope               String?
  expires             DateTime?
  accessToken         String
  userId              BigInt?
  firstName           String?
  lastName            String?
  email               String?
  accountOwner        Boolean?
  locale              String?
  collaborator        Boolean?
  emailVerified       Boolean?
  refreshToken        String?
  refreshTokenExpires DateTime?
}
```

```ts
import { PrismaSessionStorage } from '@grafikr/shopify-app-session-storage-prisma';

const sessionStorage = new PrismaSessionStorage(prisma);
```
