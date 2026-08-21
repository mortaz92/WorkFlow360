import type { UserRole } from '../auth/auth.types';

// Non include mai passwordHash: è la forma in cui un utente può lasciare questo modulo
// verso una response HTTP (vedi toPublicUser in users.service.ts).
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  department: string | null;
  active: boolean;
  createdAt: Date;
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: UserRole;
  department?: string;
  password: string;
}

export interface UpdateUserInput {
  email?: string;
  name?: string;
  role?: UserRole;
  department?: string | null;
  active?: boolean;
}

export interface PaginatedUsers {
  users: PublicUser[];
  total: number;
  page: number;
  limit: number;
}
