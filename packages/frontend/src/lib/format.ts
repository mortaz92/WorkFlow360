// Formattazione condivisa numeri/date: prima di questo file la stessa logica era
// duplicata in 6 pagine, con una versione (DashboardPage) che arrotondava le ore a 1
// decimale fisso mentre tutte le altre ne mostravano fino a 2 — stesso dato, resa
// diversa a seconda della pagina. Un solo punto vale per tutta l'app.
import type { ProjectStatus, ProjectTipoCommessa, RapportinoStatus, TimeLogTipo, UserRole } from './types';
import type { BadgeVariant } from '../components/ui/Badge';

// Ordine dei 6 tipi di ora, usato per popolare selettori e scomposizioni: era duplicato
// (con lo stesso ordine) in OperaioPage, DashboardPage e ReportPage — terzo uso reale,
// soglia per estrarlo (stessa regola già applicata sopra a PROJECT_STATUS_LABELS).
export const TIPI_ORDER: TimeLogTipo[] = ['ordinario', 'straordinario', 'notturno', 'festivo', 'permesso', 'ferie'];

// ID leggibile del cantiere, per tipo: stesso project_number progressivo di sempre,
// solo il formato di visualizzazione cambia — nessun dato nuovo, nessuna doppia
// numerazione (confermato con l'utente 18/08). Firma sui due campi primitivi, non
// sull'oggetto Project: i chiamanti hanno forme diverse (Project, ProjectDetail,
// righe dei report).
export function formatProjectId(projectNumber: number, tipoCommessa: ProjectTipoCommessa): string {
  return tipoCommessa === 'consuntivo' ? `${projectNumber}CO` : `ID.${projectNumber}`;
}

// Etichetta da mostrare per un cantiere: il codice scritto a mano dall'admin se c'è,
// altrimenti il formato automatico di sempre. UNICO punto che decide questo fallback —
// ogni pagina deve chiamare questa funzione (mai formatProjectId direttamente), altrimenti
// due schermate potrebbero mostrare due etichette diverse per LO STESSO cantiere.
export function etichettaCantiere(code: string | null, projectNumber: number, tipoCommessa: ProjectTipoCommessa): string {
  return code ?? formatProjectId(projectNumber, tipoCommessa);
}

// "YYYY-MM" (valore nativo di <input type="month">) -> primo/ultimo giorno del mese,
// in locale. MAI toISOString(): tra mezzanotte e le 1-2 di notte in Italia restituisce
// il giorno prima (stesso bug già trovato e corretto una volta in OperaioPage.isoDate).
// new Date(anno, mese, 0) è l'ultimo giorno del mese precedente al parametro "mese" —
// passando il mese 1-based richiesto (non mese-1) si ottiene quindi l'ultimo giorno
// del mese richiesto stesso.
export function monthToRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(y, m, 0).getDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` };
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatHours(n: string | number): string {
  return Number(n).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

// Un colore DISTINTO per ciascuno dei 6 tipi (non più 3 gruppi che condividevano lo
// stesso colore, es. straordinario/notturno/festivo erano tutti "badge-warning"):
// richiesto esplicitamente dall'utente il 20/08 per riconoscere il tipo a colpo d'occhio
// in ogni tabella dell'app (Registro cronologico, Cronologia dipendente, Operaio...).
// Le 6 classi (badge-ordinario ecc.) sono definite in index.css.
export function badgeClassForTipo(tipo: TimeLogTipo): string {
  return `badge badge-${tipo}`;
}

// Etichetta italiana per lo stato del cantiere: era duplicata identica in CantieriPage
// e CantiereDetailPage, ora c'è anche in DashboardPage — terzo uso, soglia per estrarla
// (vedi coding-standards.md, DRY: un'astrazione nasce da 3+ casi reali).
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  pending: 'In attesa',
  in_progress: 'In corso',
  completed: 'Completato',
  blocked: 'Bloccato',
};

// Etichetta italiana per ogni ruolo: prima si mostrava il valore grezzo dell'enum
// (es. "project_manager", "qa") preso pari pari dal database — corretto su richiesta
// esplicita dell'utente il 20/08. "operaio" è già in italiano nel database stesso,
// nessuna traduzione da fare per quello.
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Amministratore',
  project_manager: 'Responsabile progetti',
  operaio: 'Operaio',
};

// Etichetta italiana e colore badge per lo stato del rapportino: prima duplicati identici
// in RapportiniCantiere.tsx (elenco per admin/PM) e assenti in FirmaPage.tsx, che mostrava
// l'enum grezzo (es. "scaduto") al CLIENTE finale — unico punto ora per entrambi i file.
export const RAPPORTINO_STATUS_LABELS: Record<RapportinoStatus, string> = {
  in_firma: 'In attesa di firma',
  firmato: 'Firmato',
  annullato: 'Annullato',
  scaduto: 'Scaduto',
};

export const RAPPORTINO_STATUS_BADGE_VARIANT: Record<RapportinoStatus, BadgeVariant> = {
  in_firma: 'warning',
  firmato: 'success',
  annullato: 'default',
  scaduto: 'danger',
};
