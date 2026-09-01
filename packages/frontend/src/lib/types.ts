// Tipi condivisi del dominio WorkFlow360 (allineati al backend).

// Ridotto da 6 a 3 valori il 20/08 (deciso con l'utente): resource/qa/stakeholder
// avevano pochissime funzioni reali, tolti per semplificare il prodotto. Scritto a
// mano qui (non derivato dal backend): se cambia di nuovo, va aggiornato anche qui.
export type UserRole = 'admin' | 'project_manager' | 'operaio';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  companyId: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface Company {
  id: string;
  name: string;
  vat?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
}

export type ProjectTipoCommessa = 'contratto' | 'consuntivo';
export type ProjectStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

// Rispecchia esattamente PublicProject del backend (packages/backend/src/modules/projects/projects.types.ts).
// "clientName" non esiste nello schema — non aggiungerlo qui senza prima aggiungerlo
// davvero al database, altrimenti torna a essere ignorato in silenzio. "code" invece
// esiste dal 19/08 (migrazione 0007): scritto a mano dall'admin, facoltativo, univoco
// per azienda — vedi etichettaCantiere() in format.ts per come si mostra.
export interface Project {
  id: string;
  // Identificativo leggibile ("Cantiere #12"), progressivo per azienda, assegnato dal
  // server: non esiste finché il cantiere non è stato creato, mai passato dal client.
  projectNumber: number;
  code: string | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  tipoCommessa: ProjectTipoCommessa;
  startDate: string | null;
  endDate: string | null;
  ownerId: string | null;
  createdAt: string;
}

export interface PaginatedProjects {
  projects: Project[];
  total: number;
  page: number;
  limit: number;
}

export interface ListProjectsFilters {
  tipoCommessa?: ProjectTipoCommessa;
  status?: ProjectStatus[];
}

export interface ProjectsSummary {
  total: number;
  byTipo: Record<ProjectTipoCommessa, number>;
  byStatus: Record<ProjectStatus, number>;
}

// Periodo opzionale (estremi inclusi, YYYY-MM-DD) per i report — assente = tutto lo
// storico. Stessa forma su tutti gli endpoint di reports.ts che lo accettano.
export interface DateRange {
  from: string;
  to: string;
}

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  assignedTo: string | null;
  // Risolto dal server: resta valorizzato anche se l'assegnatario non è (più) nella
  // lista assignableUsers (operaio disattivato, o ruolo di chi guarda senza accesso
  // a quella lista) — non incrociare mai assignedTo con assignableUsers per il nome.
  assignedToName: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

// Riga minimale restituita da GET /tasks/assignable-users (solo operai attivi
// dell'azienda) — usata per popolare la dropdown di assegnazione.
export interface AssignableUser {
  id: string;
  name: string;
}

export interface HoursByProjectRow {
  projectId: string;
  projectNumber: number;
  code: string | null;
  tipoCommessa: ProjectTipoCommessa;
  projectName: string;
  totalHours: string;
  ordinary: string;
  straordinario: string;
  notturno: string;
  festivo: string;
  permesso: string;
  ferie: string;
  logCount: number;
}

export interface HoursByUserRow {
  userId: string;
  userName: string;
  userEmail: string;
  totalHours: string;
  ordinary: string;
  straordinario: string;
  notturno: string;
  festivo: string;
  permesso: string;
  ferie: string;
  logCount: number;
}

// Stessa forma di HoursByUserRow (meno userEmail): righe "ore per dipendente" dentro UN
// cantiere, non per tutta l'azienda — permette a TabellaOre di essere riusata identica.
export interface ProjectEmployeeRow {
  userId: string;
  userName: string;
  totalHours: string;
  ordinary: string;
  straordinario: string;
  notturno: string;
  festivo: string;
  permesso: string;
  ferie: string;
  logCount: number;
}

export interface TimeLogMaterial {
  id: string;
  name: string;
  quantity: string;
  unit: string;
}

export type TimeLogTipo =
  | 'ordinario'
  | 'straordinario'
  | 'notturno'
  | 'festivo'
  | 'permesso'
  | 'ferie';

export interface TimeLog {
  id: string;
  taskId: string;
  userId: string;
  tipo: TimeLogTipo;
  hoursWorked: string;
  date: string;
  startTime: string | null;
  // Sempre facoltativa: puramente informativa, non entra nel calcolo delle ore.
  endTime: string | null;
  workDescription: string | null;
  notes: string | null;
  materials: TimeLogMaterial[];
  createdAt: string;
}

export interface ProjectMaterialSummary {
  name: string;
  unit: string;
  totalQuantity: string;
}

// Rispecchia ProjectDetail del backend (reports.service.ts): dettaglio di UN cantiere.
export interface ProjectDetail {
  id: string;
  projectNumber: number;
  code: string | null;
  name: string;
  status: ProjectStatus;
  tipoCommessa: ProjectTipoCommessa;
  createdAt: string;
  // Derivato da employees.length lato server — tenuto per compatibilità, ma è sempre
  // ridondante con employees.length.
  employeeCount: number;
  employees: ProjectEmployeeRow[];
  totalHours: string;
  materials: ProjectMaterialSummary[];
}

export interface ProjectTimelineEntry {
  id: string;
  date: string;
  tipo: TimeLogTipo;
  hoursWorked: string;
  workDescription: string | null;
  notes: string | null;
  userId: string;
  userName: string;
  taskId: string;
  taskTitle: string;
  materials: { name: string; quantity: string; unit: string }[];
}

export interface ProjectTimeline {
  entries: ProjectTimelineEntry[];
  total: number;
  page: number;
  limit: number;
}

export interface UserTimeLogRow {
  id: string;
  date: string;
  tipo: TimeLogTipo;
  hoursWorked: string;
  workDescription: string | null;
  projectId: string;
  projectNumber: number;
  code: string | null;
  tipoCommessa: ProjectTipoCommessa;
  projectName: string;
  taskId: string;
  taskTitle: string;
}

// Rispecchia UserTimeLogDetail del backend: dettaglio di UN dipendente.
export interface UserTimeLogDetail {
  userId: string;
  userName: string;
  userEmail: string;
  totalHours: string;
  ordinary: string;
  straordinario: string;
  notturno: string;
  festivo: string;
  permesso: string;
  ferie: string;
  logCount: number;
  timeLogs: UserTimeLogRow[];
}

export type CorrectionStatus = 'open' | 'in_review' | 'approved' | 'rejected' | 'applied';
export type CorrectionSeverity = 'low' | 'medium' | 'high' | 'critical';

// Rispecchia PublicCorrection del backend. taskId/reportedBy sono solo UUID: risolvere
// il nome del cantiere/segnalatore richiede incrociarli con dati già caricati altrove
// (es. la lista utenti), non c'è un endpoint che li unisce già.
export interface Correction {
  id: string;
  taskId: string;
  reportedBy: string;
  description: string;
  status: CorrectionStatus;
  severity: CorrectionSeverity;
  createdAt: string;
}

// Rapportino firmato dal cliente (cantieri "a consuntivo"). Rispecchia esattamente
// rapportini.types.ts del backend — i campi Date lato server (createdAt/signedAt/
// expiresAt/emailSentAt/unlockedAt) arrivano come stringhe ISO su HTTP, stesso
// trattamento già riservato a TimeLog.createdAt sopra.
export type RapportinoStatus = 'in_firma' | 'firmato' | 'annullato' | 'scaduto';

export interface SnapshotAzienda {
  nome: string;
  vat: string | null;
  indirizzo: string | null;
  email: string | null;
  telefono: string | null;
}

export interface SnapshotCantiere {
  id: string;
  projectNumber: number;
  code: string | null;
  nome: string;
  clientName: string | null;
  tipoCommessa: string;
}

export interface SnapshotMateriale {
  nome: string;
  quantita: string;
  unita: string;
}

export interface SnapshotRiga {
  timeLogId: string;
  operaio: { id: string; nome: string };
  lavoro: { taskId: string; titolo: string };
  tipo: string;
  ore: string;
  oraInizio: string | null;
  oraFine: string | null;
  descrizioneLavoro: string | null;
  note: string | null;
  materiali: SnapshotMateriale[];
}

export interface SnapshotTotali {
  oreTotali: string;
  /** Ore per tipo (ordinario/straordinario/...), solo i tipi effettivamente presenti. */
  perTipo: Record<string, string>;
  materiali: SnapshotMateriale[];
}

export interface RapportinoSnapshot {
  versione: number;
  azienda: SnapshotAzienda;
  cantiere: SnapshotCantiere;
  date: string;
  righe: SnapshotRiga[];
  totali: SnapshotTotali;
  preparatoIl: string;
  preparatoDa: { userId: string; nome: string };
}

// Riga di elenco: deliberatamente SENZA snapshot né firma (vedi listRapportini nel
// backend) — usata per l'elenco admin/PM in CantiereDetailPage.
export interface RapportinoListItem {
  id: string;
  projectId: string;
  date: string;
  revision: number;
  status: RapportinoStatus;
  totalHours: string;
  createdBy: string;
  createdAt: string;
  signerName: string | null;
  signedAt: string | null;
  expiresAt: string;
  emailSentAt: string | null;
  unlockedAt: string | null;
}

export interface PaginatedRapportini {
  rapportini: RapportinoListItem[];
  total: number;
  page: number;
  limit: number;
}

// Dettaglio: include lo snapshot (è il documento) ma MAI il token di firma — quello
// esiste solo nella risposta di POST /rapportini (vedi CreatedRapportino sotto).
export interface PublicRapportino extends RapportinoListItem {
  companyId: string;
  snapshot: RapportinoSnapshot;
  snapshotHash: string;
  signerEmail: string | null;
  emailLastError: string | null;
  cancelReason: string | null;
  unlockedBy: string | null;
  unlockReason: string | null;
}

export interface CreatedRapportino {
  rapportino: PublicRapportino;
  /** Restituito UNA SOLA VOLTA, alla creazione: in database esiste solo il suo hash —
   * va passato in memoria (navigate state) alla pagina di firma, mai salvato altrove. */
  signingToken: string;
  expiresAt: string;
}

export interface CreateTimeLogInput {
  taskId: string;
  hoursWorked: string;
  date: string;
  tipo?: TimeLogTipo;
  // Facoltativa anche con tipo 'ordinario' (dal 19/08): se assente, il backend non
  // calcola né la fascia notturna né il tetto 8h/giorno — le ore restano integralmente
  // sotto il tipo scelto.
  startTime?: string;
  // Sempre facoltativa, anche con tipo 'ordinario' — solo informativa.
  endTime?: string;
  workDescription?: string;
  notes?: string;
  materials?: { name: string; quantity: string; unit?: string }[];
}

// Diverso da Partial<CreateTimeLogInput> apposta: nell'update il form di modifica
// rimanda SEMPRE il valore corrente di ogni campo, quindi "l'operaio ha svuotato
// questo campo" deve poter dire "cancellalo" (null) e non "non l'ho toccato"
// (undefined, che il backend ignora). Il backend accetta già null su tutti e
// quattro (TIME_HHMM.nullable().optional() ecc. in timeLogs.routes.ts) — mancava
// solo un tipo frontend capace di esprimerlo. Con CreateTimeLogInput (solo
// `| undefined`) uno svuotamento non arrivava mai al server: il valore vecchio
// restava per sempre, senza errore.
export interface UpdateTimeLogInput {
  taskId?: string;
  // Riassegnazione a un altro dipendente: applicata dal backend solo per admin/PM.
  userId?: string;
  hoursWorked?: string;
  date?: string;
  tipo?: TimeLogTipo;
  startTime?: string | null;
  endTime?: string | null;
  workDescription?: string | null;
  notes?: string | null;
  materials?: { name: string; quantity: string; unit?: string }[];
}
