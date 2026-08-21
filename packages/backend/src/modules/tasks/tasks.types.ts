export interface PublicTask {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  assignedTo: string | null;
  // Risolto lato server (leftJoin su users in tasks.service.ts) invece di lasciare
  // che il frontend lo incroci con la lista di operai assegnabili — quella lista è
  // vuota per ruoli non-manager e non include operai disattivati/promossi, quindi un
  // task rimasto assegnato a qualcuno "sparirebbe" dalla vista come "Non assegnato".
  assignedToName: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  dueDate: string | null;
  hoursEstimated: string | null;
  createdAt: Date;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  assignedTo?: string | null;
  status?: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  dueDate?: string | null;
  hoursEstimated?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  assignedTo?: string | null;
  status?: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  dueDate?: string | null;
  hoursEstimated?: string | null;
}

export interface PaginatedTasks {
  tasks: PublicTask[];
  total: number;
  page: number;
  limit: number;
}

// Riga minimale restituita da GET /tasks/assignable-users — solo ciò che serve a
// popolare una dropdown di assegnazione, non l'utente completo (vedi PublicUser).
export interface AssignableUser {
  id: string;
  name: string;
}
