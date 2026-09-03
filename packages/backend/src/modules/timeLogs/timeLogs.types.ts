export interface TimeLogMaterial {
  id: string;
  name: string;
  // Codice articolo scritto dall'operaio (colonna CODICE del blocco cartaceo).
  // Facoltativo: null quando non è stato scritto, mai stringa vuota (vedi il transform
  // in timeLogs.routes.ts).
  code: string | null;
  quantity: string; // numeric restituito come stringa da Postgres
  unit: string;
}

export interface PublicTimeLog {
  id: string;
  taskId: string;
  userId: string;
  tipo: string;
  hoursWorked: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  workDescription: string | null;
  notes: string | null;
  materials: TimeLogMaterial[];
  createdAt: Date;
}

export interface CreateMaterialInput {
  name: string;
  quantity: string; // decimal come stringa, validato nello schema Zod
  unit?: string;
  code?: string | null;
}

export interface CreateTimeLogInput {
  taskId: string;
  // Facoltativo: un operaio non lo invia mai (il service forza il proprio id), un
  // admin/PM che lo omette registra per sé stesso invece di ricevere un errore — il
  // tipo deve rispecchiare questo, il campo era erroneamente obbligatorio (mai
  // allineato allo schema Zod, che lo dichiara .optional() da sempre).
  userId?: string;
  tipo?: 'ordinario' | 'straordinario' | 'notturno' | 'festivo' | 'permesso' | 'ferie';
  hoursWorked: string;
  date: string;
  // Obbligatorio quando tipo è 'ordinario' (o omesso, che equivale a 'ordinario'):
  // senza un orario di inizio il servizio non può calcolare quante ore ricadono
  // nella fascia notturna 22:00-06:00. Facoltativo per gli altri tipi.
  startTime?: string;
  // Sempre facoltativo, anche per tipo 'ordinario': a differenza di startTime non
  // entra in alcun calcolo, è solo un'informazione aggiuntiva sul turno.
  endTime?: string;
  workDescription?: string;
  notes?: string;
  materials?: CreateMaterialInput[];
}

export interface UpdateTimeLogInput {
  // Bug corretto in questa sessione: il campo era già inviato dal frontend
  // (OperaioPage) ma lo schema Zod non lo dichiarava, quindi veniva scartato in
  // silenzio da Zod — "sposta questa registrazione sul cantiere giusto" non faceva
  // nulla, senza errore.
  taskId?: string;
  // Riassegnazione a un altro dipendente: applicata SOLO se chi chiama è admin/PM
  // (stesso anti-tampering di CreateTimeLogInput.userId in createTimeLog) — per un
  // operaio il campo viene ignorato, non rifiutato con errore.
  userId?: string;
  tipo?: 'ordinario' | 'straordinario' | 'notturno' | 'festivo' | 'permesso' | 'ferie';
  hoursWorked?: string;
  date?: string;
  startTime?: string | null;
  endTime?: string | null;
  workDescription?: string | null;
  notes?: string | null;
  // I materiali in update sono gestiti come replace dell'intera lista (semplice e prevedibile).
  materials?: CreateMaterialInput[];
}

export interface PaginatedTimeLogs {
  timeLogs: PublicTimeLog[];
  total: number;
  page: number;
  limit: number;
}
