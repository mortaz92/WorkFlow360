import { z } from 'zod';
import type { RapportinoStatus } from '../../core/db/schema';

// Versione della FORMA dello snapshot, non del rapportino. Un documento firmato mesi fa
// va riletto e ristampato con la struttura che aveva allora: chi legge uno snapshot
// deve poter capire quale forma sta guardando senza indovinarlo dai campi presenti.
//
// v2 (indirizzo del cantiere e codice dei materiali): il bump NON invalida gli hash già
// registrati, perché verificaIntegritaSnapshot ricalcola dal JSON SALVATO e leggiSnapshot
// restituisce l'oggetto originale, non l'output di Zod. Uno snapshot v1 resta leggibile
// così com'è — vedi i `.nullish()` più sotto, che è ciò che lo rende possibile.
export const SNAPSHOT_VERSIONE = 2;

// Tutto lo snapshot è per COPIA, non per riferimento: nomi ed email sono duplicati qui
// dentro invece di essere risolti con una join al momento della lettura. DELETE
// /users/:id anonimizza l'utente in modo irreversibile (name -> "Utente rimosso"), e un
// documento che il cliente ha firmato non deve cambiare contenuto dopo la firma.
//
// Nessun prezzo, nessun importo, in nessun campo: lo schema di questo progetto non ha
// tariffe (vedi projects.ts, "NESSUN prezzo/importo nel DB"). Il cliente sottoscrive
// QUANTITÀ — ore e materiali — non una cifra.

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
  /** "Destinazione" sul documento. OPZIONALE e non solo nullable: uno snapshot v1 non ha
   * proprio la chiave, e chi lo rilegge deve trattare anche `undefined`. */
  indirizzo?: string | null;
}

export interface SnapshotMateriale {
  nome: string;
  quantita: string;
  unita: string;
  /** Codice articolo. Opzionale per la stessa ragione di `indirizzo`: assente negli
   * snapshot v1, che restano leggibili e ristampabili. */
  codice?: string | null;
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

// Forma minima che uno snapshot riletto dal database deve avere per essere usabile.
// `snapshot_json` è una colonna jsonb: Postgres garantisce che sia JSON valido, non che
// contenga QUESTA struttura — una riga scritta da una versione futura, da una migrazione
// sbagliata o a mano resterebbe altrimenti un `as RapportinoSnapshot` mai verificato, che
// esplode molto più in là (nel generatore PDF) con un errore che non nomina la causa.
//
// Deliberatamente permissivo su ciò che non è strutturale: `tipo` è z.string() e non un
// enum, `date` è z.string() e non un formato — un documento firmato anni fa deve poter
// essere ristampato anche se nel frattempo i tipi di ora ammessi sono cambiati. Qui si
// controlla la FORMA, non le regole di dominio del momento.
//
// I campi aggiunti in v2 usano `.nullish()` e MAI `.nullable()`, ed è la differenza fra
// un documento riletto e un 500: `.nullable()` accetta `null` ma RIFIUTA la chiave
// assente, e uno snapshot v1 la chiave non ce l'ha proprio. Con `.nullable()` il parse
// fallirebbe, leggiSnapshot lancerebbe, e ogni GET, ogni PDF e ogni rinvio email di un
// rapportino GIÀ FIRMATO prima di questa versione risponderebbe 500 per sempre.
const snapshotMaterialeSchema = z.object({
  nome: z.string(),
  quantita: z.string(),
  unita: z.string(),
  codice: z.string().nullish(),
});

const snapshotRigaSchema = z.object({
  timeLogId: z.string(),
  operaio: z.object({ id: z.string(), nome: z.string() }),
  lavoro: z.object({ taskId: z.string(), titolo: z.string() }),
  tipo: z.string(),
  ore: z.string(),
  oraInizio: z.string().nullable(),
  oraFine: z.string().nullable(),
  descrizioneLavoro: z.string().nullable(),
  note: z.string().nullable(),
  materiali: z.array(snapshotMaterialeSchema),
});

export const rapportinoSnapshotSchema = z.object({
  versione: z.number(),
  azienda: z.object({
    nome: z.string(),
    vat: z.string().nullable(),
    indirizzo: z.string().nullable(),
    email: z.string().nullable(),
    telefono: z.string().nullable(),
  }),
  cantiere: z.object({
    id: z.string(),
    projectNumber: z.number(),
    code: z.string().nullable(),
    nome: z.string(),
    clientName: z.string().nullable(),
    tipoCommessa: z.string(),
    indirizzo: z.string().nullish(),
  }),
  date: z.string(),
  righe: z.array(snapshotRigaSchema),
  totali: z.object({
    oreTotali: z.string(),
    perTipo: z.record(z.string()),
    materiali: z.array(snapshotMaterialeSchema),
  }),
  preparatoIl: z.string(),
  preparatoDa: z.object({ userId: z.string(), nome: z.string() }),
});

// Riga di elenco: deliberatamente SENZA snapshot né firma (vedi listRapportini).
export interface RapportinoListItem {
  id: string;
  projectId: string;
  date: string;
  /** Progressivo per azienda, assegnato alla creazione. Vive in colonna e NON nello
   * snapshot: l'anteprima costruisce lo snapshot prima che il numero esista. */
  numero: number;
  revision: number;
  status: RapportinoStatus;
  totalHours: string;
  createdBy: string;
  createdAt: Date;
  signerName: string | null;
  signedAt: Date | null;
  expiresAt: Date;
  emailSentAt: Date | null;
  unlockedAt: Date | null;
}

export interface PaginatedRapportini {
  rapportini: RapportinoListItem[];
  total: number;
  page: number;
  limit: number;
}

// Dettaglio: include lo snapshot (è il documento) ma MAI il token di firma, nemmeno
// nella sua forma hashata — chi legge il dettaglio non deve poter risalire al link.
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
  /** Restituito UNA SOLA VOLTA, alla creazione: in database esiste solo il suo hash. */
  signingToken: string;
  expiresAt: Date;
}

export interface FirmaInput {
  firmatarioNome: string;
  firmatarioEmail: string;
  firmaPng: string;
  /** Facoltativo per compatibilità con client vecchi: se presente, deve combaciare con
   * l'id risolto dal token (vedi signRapportino) — chiude lo scarto fra il rapportino
   * mostrato in anteprima (letto dall'id nell'URL) e quello che il token firma davvero. */
  rapportinoId?: string;
}

export interface FirmaContesto {
  ip: string | null;
  userAgent: string | null;
}

export interface FirmaEsito {
  firmato: true;
  /** Mai dedotto: dice se l'email è DAVVERO partita, non se abbiamo provato a mandarla. */
  emailInviata: boolean;
}
