// Client API minimalista: fetch + gestione token JWT in localStorage.
// Il backend gira su :4000; in dev il proxy Vite rimappa /api -> :4000 (v. vite.config.ts).

const TOKEN_KEY = 'wf360_token';

// In produzione frontend e backend stanno su due domini diversi (sito statico + web
// service), quindi l'URL del backend va iniettato al momento della build con
// VITE_API_BASE_URL (es. https://workflow360-api.onrender.com/api/v1).
// Senza la variabile si resta sul percorso relativo, che in sviluppo passa dal proxy
// Vite verso :4000: locale invariato rispetto a prima. Variabile vuota = variabile
// assente, perché è facile crearla su Render e lasciarla senza valore, e un API_BASE
// stringa vuota romperebbe ogni chiamata in modo silenzioso.
// Barra finale tolta: è l'errore più probabile quando si incolla l'URL dal pannello
// Render (il browser la aggiunge quasi sempre) — con la barra, ogni chiamata diventerebbe
// ".../api/v1//auth/login" (doppia barra), che non corrisponde a nessuna rotta: 404 su
// tutto, login compreso, con un sintomo che non fa pensare subito alla causa.
const apiBaseFromEnv = import.meta.env.VITE_API_BASE_URL as string | undefined;
const API_BASE = apiBaseFromEnv?.trim().replace(/\/+$/, '') || '/api/v1';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Il payload del JWT (sub/email/role/companyId) basta per mostrare nome/ruolo nella UI
// (es. sidebar): non serve un'altra chiamata API né salvarlo separatamente in
// localStorage, dato che il token stesso lo contiene già. Nessuna verifica della firma:
// è solo per la visualizzazione, l'autorizzazione vera resta sempre lato backend.
export function getCurrentUser(): import('./types').AuthUser | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!decoded.sub || !decoded.email || !decoded.role) return null;
    return { id: decoded.sub, email: decoded.email, role: decoded.role, companyId: decoded.companyId ?? '' };
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth !== false) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message = data?.error?.message ?? `Errore ${res.status}`;
    const code = data?.error?.code;
    // auth:false è solo firmaRapportino (endpoint pubblico, mai col token di sessione di
    // chi lo chiama): un 401 lì è il cliente che ha usato un link scaduto/non valido, non
    // ha nulla a che fare con la sessione dell'operaio — cancellarla lo disconnetterebbe
    // per un errore che non lo riguarda.
    if (res.status === 401 && opts.auth !== false) clearToken();
    throw new ApiError(message, res.status, code);
  }
  return data as T;
}

// Costruisce una query string da parametri opzionali, omettendo quelli assenti — evita
// di ripetere la stessa concatenazione condizionale in ogni funzione che accetta un
// periodo/filtro facoltativo (getHoursByProject/getHoursByUser/getProjectDetail/
// getUserTimeLogDetail/getProjectTimeline/listProjects, sesto uso reale).
function buildQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined);
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

export const api = {
  login: (email: string, password: string) =>
    request<{ accessToken: string; user: import('./types').AuthUser }>('/auth/login', {
      method: 'POST',
      auth: false,
      body: { email, password },
    }),
  // Risponde sempre con lo stesso messaggio, esista o no l'email registrata: il
  // frontend NON deve interpretare la risposta per dedurre nulla, solo mostrarla.
  forgotPassword: (email: string) =>
    request<{ message: string }>('/auth/forgot-password', { method: 'POST', auth: false, body: { email } }),
  resetPassword: (token: string, password: string) =>
    request<undefined>('/auth/reset-password', { method: 'POST', auth: false, body: { token, password } }),

  listCompanies: () => request<{ companies: import('./types').Company[] }>('/companies'),
  createCompany: (body: Partial<import('./types').Company>) =>
    request<{ company: import('./types').Company }>('/companies', { method: 'POST', body }),

  listProjects: (page = 1, limit = 20, filters?: import('./types').ListProjectsFilters) =>
    request<import('./types').PaginatedProjects>(
      `/projects${buildQuery({ page, limit, tipoCommessa: filters?.tipoCommessa, status: filters?.status?.join(',') })}`,
    ),
  // Stesso livello di fiducia di listProjects (lettura aperta a chiunque autenticato).
  getProjectsSummary: () => request<import('./types').ProjectsSummary>('/projects/summary'),
  // Lettura aperta a qualunque ruolo autenticato (stesso principio di trasparenza di
  // listProjects) — a differenza di getProjectDetail, che vive sotto /reports ed è
  // riservato ad admin/PM: CantiereDetailPage usa questo per l'intestazione (nome,
  // numero, stato) indipendentemente da chi può vedere anche le statistiche.
  getProjectById: (id: string) =>
    request<{ project: import('./types').Project }>(`/projects/${id}`),
  createProject: (body: { name: string; code?: string | null; tipoCommessa?: import('./types').ProjectTipoCommessa }) =>
    request<{ project: import('./types').Project }>('/projects', { method: 'POST', body }),
  updateProject: (
    id: string,
    body: {
      name?: string;
      code?: string | null;
      tipoCommessa?: import('./types').ProjectTipoCommessa;
      status?: import('./types').ProjectStatus;
    },
  ) => request<{ project: import('./types').Project }>(`/projects/${id}`, { method: 'PATCH', body }),

  listUsers: () => request<{ users: import('./types').UserSummary[] }>('/users'),
  // Riservato ad admin (usersRouter è admin-only, a differenza di /dipendenti nel
  // frontend che PM può vedere): usata solo dal form di modifica, mai chiamata se
  // getCurrentUser().role !== 'admin'.
  getUserById: (id: string) => request<{ user: import('./types').UserSummary }>(`/users/${id}`),
  createUser: (body: { email: string; name: string; role: string; password: string }) =>
    request<{ user: import('./types').UserSummary }>('/users', { method: 'POST', body }),
  updateUser: (id: string, body: { email?: string; name?: string; role?: string; active?: boolean }) =>
    request<{ user: import('./types').UserSummary }>(`/users/${id}`, { method: 'PATCH', body }),
  // Non è una semplice disattivazione: il backend anonimizza nome ed email (diritto
  // alla cancellazione GDPR), operazione irreversibile — a differenza di updateUser
  // con active:false, che resta reversibile e usata per le sospensioni temporanee.
  deleteUser: (id: string) =>
    request<{ user: import('./types').UserSummary }>(`/users/${id}`, { method: 'DELETE' }),

  // Default 20 lato server: l'operaio deve poter vedere abbastanza storia per il
  // riepilogo "ultimi 7 giorni" (OperaioPage), non solo le ultimissime righe.
  listTimeLogs: (limit = 20) => request<{ timeLogs: import('./types').TimeLog[]; total: number }>(`/time-logs?limit=${limit}`),
  // Restituisce sempre un array: una registrazione "ordinario" può diventare 2-3 righe
  // reali (ordinario/notturno/straordinario) per lo split automatico lato server.
  createTimeLog: (body: import('./types').CreateTimeLogInput) =>
    request<{ timeLogs: import('./types').TimeLog[] }>('/time-logs', { method: 'POST', body }),
  updateTimeLog: (id: string, body: import('./types').UpdateTimeLogInput) =>
    request<{ timeLog: import('./types').TimeLog }>(`/time-logs/${id}`, { method: 'PATCH', body }),
  deleteTimeLog: (id: string) =>
    request<undefined>(`/time-logs/${id}`, { method: 'DELETE' }),

  // Task (lavori) di un cantiere: l'operaio registra le ore su un task, non sul cantiere.
  // limit=100 (max consentito dal backend, tasks.routes.ts) e non il default 20: senza,
  // un cantiere con più di 20 lavori nascondeva i più vecchi dalla lista — non
  // assegnabili né modificabili da CantiereDetailPage, non selezionabili da
  // OperaioPage. Stesso principio già applicato ai cantieri (PROJECTS_FETCH_LIMIT).
  listTasks: (projectId: string) =>
    request<{ tasks: import('./types').Task[] }>(`/tasks?projectId=${projectId}&limit=100`),
  // Registrata prima di requireRole nel router backend: accessibile anche all'operaio.
  // PublicTask porta già projectId — usata per risalire al cantiere di un task senza
  // dover cercare tra tutti i cantieri (vedi repeatLast in OperaioPage.tsx).
  getTaskById: (id: string) => request<{ task: import('./types').Task }>(`/tasks/${id}`),
  createTask: (body: { projectId: string; title: string; status?: string; assignedTo?: string | null }) =>
    request<{ task: import('./types').Task }>('/tasks', { method: 'POST', body }),
  updateTask: (id: string, body: { title?: string; assignedTo?: string | null; status?: string }) =>
    request<{ task: import('./types').Task }>(`/tasks/${id}`, { method: 'PATCH', body }),
  // Solo operai attivi dell'azienda, per popolare la dropdown "Assegna a" — endpoint
  // dedicato (non /users, riservato ad admin) perché lo usano anche i project_manager.
  listAssignableUsers: () =>
    request<{ users: import('./types').AssignableUser[] }>('/tasks/assignable-users'),

  // Report (solo admin/PM). Periodo opzionale su tutti e cinque: assente = tutto lo
  // storico (comportamento invariato per chi non lo passa).
  // archived=true: ore ARCHIVIATE (mese chiuso da 15+ giorni o cantiere completato)
  // invece di quelle attive — stesso endpoint, stesso shape, vedi ArchivioPage.
  getHoursByProject: (range?: import('./types').DateRange, archived?: boolean) =>
    request<{ reports: import('./types').HoursByProjectRow[] }>(
      `/reports/hours-by-project${buildQuery({ from: range?.from, to: range?.to, archived: archived ? 'true' : undefined })}`,
    ),
  getHoursByUser: (range?: import('./types').DateRange, archived?: boolean) =>
    request<{ reports: import('./types').HoursByUserRow[] }>(
      `/reports/hours-by-user${buildQuery({ from: range?.from, to: range?.to, archived: archived ? 'true' : undefined })}`,
    ),
  getProjectDetail: (id: string, range?: import('./types').DateRange) =>
    request<{ project: import('./types').ProjectDetail }>(
      `/reports/projects/${id}${buildQuery({ from: range?.from, to: range?.to })}`,
    ),
  getUserTimeLogDetail: (id: string, range?: import('./types').DateRange) =>
    request<{ user: import('./types').UserTimeLogDetail }>(
      `/reports/users/${id}/time-logs${buildQuery({ from: range?.from, to: range?.to })}`,
    ),
  // Registro cronologico (Archivio): paginato, stesso periodo opzionale.
  getProjectTimeline: (id: string, opts?: { page?: number; limit?: number; range?: import('./types').DateRange }) =>
    request<import('./types').ProjectTimeline>(
      `/reports/projects/${id}/timeline${buildQuery({ page: opts?.page, limit: opts?.limit, from: opts?.range?.from, to: opts?.range?.to })}`,
    ),

  // Lettura aperta a chiunque autenticato (stesso principio di listProjects). Nessun
  // filtro per status lato server: chi chiama filtra/etichetta lato client (vedi uso in
  // DashboardPage) invece di aggiungere un parametro nuovo all'API per questo soltanto.
  listCorrections: (limit = 100) =>
    request<{ corrections: import('./types').Correction[]; total: number }>(`/corrections?limit=${limit}`),

  // Rapportini firmati dal cliente (cantieri a consuntivo, rapportini.routes.ts). Lettura
  // aperta a qualunque ruolo autenticato per anteprima/creazione/dettaglio (è l'operaio
  // stesso a preparare il rapportino sul proprio dispositivo); elenco riservato ad
  // admin/project_manager, sblocco solo admin — annotato punto per punto sotto.
  previewRapportino: (projectId: string, date: string) =>
    request<{ anteprima: import('./types').RapportinoSnapshot }>(
      `/rapportini/anteprima${buildQuery({ projectId, date })}`,
    ),
  createRapportino: (body: { projectId: string; date: string }) =>
    request<import('./types').CreatedRapportino>('/rapportini', { method: 'POST', body }),
  getRapportino: (id: string) =>
    request<{ rapportino: import('./types').PublicRapportino }>(`/rapportini/${id}`),
  // Risposta binaria (PDF): non passa da request<T>, che assume sempre JSON. Stesso
  // header Authorization delle altre chiamate autenticate, aggiunto a mano perché fetch
  // non lo mette da solo su un download.
  downloadRapportinoPdf: async (id: string): Promise<Blob> => {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/rapportini/${id}/pdf`, { headers });
    if (!res.ok) {
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      const message = data?.error?.message ?? `Errore ${res.status}`;
      if (res.status === 401) clearToken();
      throw new ApiError(message, res.status, data?.error?.code);
    }
    return res.blob();
  },
  // Solo admin/project_manager (righe leggere, senza snapshot/firma — vedi RapportinoListItem).
  listRapportini: (
    page = 1,
    limit = 20,
    filters?: { projectId?: string; date?: string; status?: import('./types').RapportinoStatus },
  ) =>
    request<import('./types').PaginatedRapportini>(
      `/rapportini${buildQuery({
        page,
        limit,
        projectId: filters?.projectId,
        date: filters?.date,
        status: filters?.status,
      })}`,
    ),
  // Chi ha creato il rapportino o un admin (verificato lato server, non qui).
  annullaRapportino: (id: string, reason?: string) =>
    request<{ rapportino: import('./types').PublicRapportino }>(`/rapportini/${id}/annulla`, {
      method: 'POST',
      body: { reason },
    }),
  reinviaEmailRapportino: (id: string, email?: string) =>
    request<{ emailInviata: boolean; destinatario: string }>(`/rapportini/${id}/reinvia-email`, {
      method: 'POST',
      body: { email },
    }),
  // Solo admin, motivo obbligatorio: il backend rifiuta un reason vuoto (sbloccaSchema).
  sbloccaRapportino: (id: string, reason: string) =>
    request<{ rapportino: import('./types').PublicRapportino }>(`/rapportini/${id}/sblocca`, {
      method: 'POST',
      body: { reason },
    }),
  // Unico endpoint pubblico del modulo (auth:false, stesso pattern di login/
  // resetPassword sopra): usa il signingToken restituito una sola volta da
  // createRapportino, mai il token di sessione di chi chiama. rapportinoId è facoltativo
  // (retrocompatibile con client vecchi): quando presente il backend verifica che
  // combaci con l'id risolto dal token, chiudendo lo scarto tra l'anteprima mostrata
  // (letta dall'id nell'URL) e il rapportino che il token firma davvero.
  firmaRapportino: (
    token: string,
    firmatarioNome: string,
    firmatarioEmail: string,
    firmaPng: string,
    rapportinoId?: string,
  ) =>
    request<{ firmato: true; emailInviata: boolean }>('/rapportini/firma', {
      method: 'POST',
      auth: false,
      body: { token, firmatarioNome, firmatarioEmail, firmaPng, rapportinoId },
    }),
};
