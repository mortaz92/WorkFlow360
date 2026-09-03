export type ProjectTipoCommessa = 'contratto' | 'consuntivo';
export type ProjectStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface PublicProject {
  id: string;
  // Identificativo leggibile mostrato all'utente ("Cantiere #12"), progressivo per
  // azienda. Assegnato dal server in createProject, mai passato dal client.
  projectNumber: number;
  // Codice scritto a mano dall'admin alla creazione (es. "CANT-04"), facoltativo,
  // univoco per azienda. NULL se non impostato: in quel caso il frontend mostra il
  // formato automatico basato su projectNumber (vedi etichettaCantiere in format.ts).
  code: string | null;
  name: string;
  // Committente del cantiere. Esiste in tabella dalla migrazione 0011 e viene già
  // restituito a runtime (toPublicProject fa spread dell'intera riga): non era dichiarato
  // qui, quindi il tipo mentiva su cosa contiene davvero la risposta.
  clientName: string | null;
  // Indirizzo del cantiere, la "Destinazione" del rapportino cartaceo: dove si è
  // lavorato, che non coincide con la sede del committente. NULL per i cantieri creati
  // prima di questo campo o senza indirizzo scritto.
  address: string | null;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  tipoCommessa: ProjectTipoCommessa;
  startDate: string | null;
  endDate: string | null;
  ownerId: string | null;
  createdAt: Date;
}

export interface CreateProjectInput {
  name: string;
  code?: string | null;
  address?: string | null;
  description?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'blocked';
  tipoCommessa?: ProjectTipoCommessa;
  startDate?: string | null;
  endDate?: string | null;
  ownerId?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  code?: string | null;
  address?: string | null;
  description?: string | null;
  status?: 'pending' | 'in_progress' | 'completed' | 'blocked';
  tipoCommessa?: ProjectTipoCommessa;
  startDate?: string | null;
  endDate?: string | null;
  ownerId?: string | null;
}

export interface PaginatedProjects {
  projects: PublicProject[];
  total: number;
  page: number;
  limit: number;
}
