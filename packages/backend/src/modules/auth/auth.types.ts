import type { userRoleEnum } from '../../core/db/schema';

export type UserRole = (typeof userRoleEnum.enumValues)[number];

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  companyId: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  companyId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
