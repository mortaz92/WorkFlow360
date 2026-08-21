import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { CONFIG } from '../config';
import * as schema from './schema';

const queryClient = postgres(CONFIG.DATABASE_URL);

export const db = drizzle(queryClient, { schema });
