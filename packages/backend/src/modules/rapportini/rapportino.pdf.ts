// pdfkit e non un browser headless (Puppeteer/Playwright + Chromium): il backend gira
// su Render con `plan: free` (vedi render.yaml), cioè 512MB di RAM e spegnimento per
// inattività. Un Chromium avviato per stampare una pagina supera da solo quel budget e
// farebbe terminare il processo dal sistema (OOM) proprio mentre un cliente sta
// firmando. pdfkit genera il PDF in-process, in memoria, senza binari esterni: è la
// motivazione esplicita richiesta da coding-standards per aggiungere una dipendenza.
import PDFDocument from 'pdfkit';
import type { RapportinoSnapshot, SnapshotMateriale, SnapshotRiga } from './rapportini.types';

// Dati della firma: NON stanno nello snapshot e non possono starci, perché lo snapshot
// è congelato alla creazione, cioè prima che il cliente firmi. Chi genera il PDF di un
// rapportino non ancora firmato passa semplicemente dei null.
export interface FirmaPdf {
  firmatarioNome: string | null;
  firmatarioEmail: string | null;
  /** PNG in base64 SENZA il prefisso "data:", come salvato in rapportini.signature_png. */
  firmaPngBase64: string | null;
  firmatoIl: Date | null;
}

// Dati che stanno in COLONNA e non nello snapshot, passati a parte per la stessa ragione
// della firma: il numero progressivo viene assegnato all'INSERT, mentre lo snapshot è
// costruito prima (l'anteprima ne costruisce uno per un rapportino che ancora non esiste).
// `null` è ammesso perché il generatore non deve poter fallire su un dato mancante: si
// stampa un trattino, non si interrompe la produzione del documento.
export interface DatiDocumento {
  numero: number | null;
}

const PAGINA = { margine: 40, larghezza: 595.28, altezza: 841.89 } as const;
const CONTENUTO_X = PAGINA.margine;
const CONTENUTO_DESTRA = PAGINA.larghezza - PAGINA.margine;
const CONTENUTO_LARGHEZZA = CONTENUTO_DESTRA - CONTENUTO_X;
// Più alto del margine inferiore: sotto ci sta il piè di pagina, scritto su OGNI pagina.
const FONDO_CONTENUTO = 782;
const Y_PIE_LINEA = 792;
const Y_PIE_TESTO = 798;
// Le pagine dalla seconda in poi hanno una testata compatta: il contenuto riparte da qui.
const Y_CONTENUTO_SEGUE = 70;

// Grigio scuro neutro e non il blu dell'applicazione: il documento appartiene all'azienda
// che lo emette, non al gestionale che lo produce. Nessun colore aziendale, perché il
// sistema è multi-tenant e `companies` non ha né logo né colore.
const COLORE = {
  scuro: '#262626',
  testo: '#171717',
  testoSecondario: '#525252',
  etichetta: '#737373',
  lineaRiga: '#d4d4d4',
  bordoCasella: '#a3a3a3',
  chiusura: '#737373',
  zebra: '#fafafa',
  fondoTotale: '#f5f5f5',
  chip: '#e5e5e5',
  chipTesto: '#404040',
  separatore: '#e5e5e5',
  avvisoTesto: '#b45309',
  avvisoFondo: '#fffbeb',
  avvisoBordo: '#fde68a',
  // Rosso "da timbro", usato SOLO per il numero del documento: è il numero pre-stampato
  // del blocco cartaceo, ed è l'unico elemento della pagina che lo porta.
  numero: '#b91c1c',
  tenue: '#a3a3a3',
} as const;

interface Colonna {
  titolo: string;
  larghezza: number;
  allineamento?: 'left' | 'right';
}

const COLONNE_LAVORO: Colonna[] = [
  { titolo: 'LAVORO ESEGUITO', larghezza: 300 },
  { titolo: 'ORARIO', larghezza: 78 },
  { titolo: 'ORE', larghezza: 44, allineamento: 'right' },
  { titolo: 'OPERATORE', larghezza: 93.28 },
];

// La colonna CODICE compare o sparisce UNA VOLTA per documento, non riga per riga: una
// colonna che appare solo in alcune righe darebbe l'impressione di un dato perso nelle
// altre. Le due ripartizioni sommano entrambe a CONTENUTO_LARGHEZZA.
function colonneMateriali(conCodice: boolean): Colonna[] {
  if (conCodice) {
    return [
      { titolo: 'UM', larghezza: 55 },
      { titolo: 'Q.TÀ', larghezza: 65, allineamento: 'right' },
      { titolo: 'CODICE', larghezza: 95 },
      { titolo: 'DESCRIZIONE', larghezza: 300.28 },
    ];
  }
  return [
    { titolo: 'UM', larghezza: 55 },
    { titolo: 'Q.TÀ', larghezza: 70, allineamento: 'right' },
    { titolo: 'DESCRIZIONE', larghezza: 390.28 },
  ];
}

const ALTEZZA_RIGA_LAVORO_MINIMA = 22;
const ALTEZZA_RIGA_MATERIALE_MINIMA = 18;
const ALTEZZA_RIGA_TOTALE = 26;
const ALTEZZA_BLOCCO_FIRMA = 150;
// Righe a rigatura stampate sotto la chiusura di ogni tabella, come sul blocco cartaceo.
// Non sono spazio in cui aggiungere una voce dopo la firma: la linea di chiusura e il
// TOTALE ORE stanno SOPRA di esse, quindi qualunque riga scritta a penna dopo si vede
// perché cade fuori dal totale sottoscritto.
const RIGHE_VUOTE_LAVORO = 8;
const RIGHE_VUOTE_MATERIALI = 6;
// Quota di rigatura riservata ai materiali quando lo spazio scarseggia: senza, il
// riempitivo della tabella delle ore si prende tutto il residuo e il blocco materiali
// resta senza righe vuote — cioè la deroga applicata a metà.
const RIGHE_VUOTE_MATERIALI_MINIME = 3;
// Riga "formato snapshot vN" sotto il blocco firma: fa parte della coda del documento e
// va riservata insieme alla firma, altrimenti non ci sta mai e sparisce in silenzio.
const ALTEZZA_RIGA_FORMATO = 12;
// Spazio fra un blocco e il successivo. Costante e non un numero ripetuto: entra sia nel
// disegno sia nel CALCOLO della riserva, e le due cose devono dire la stessa cifra —
// dimenticarlo nella riserva è già bastato a spingere la firma su una seconda pagina.
const GAP_TRA_BLOCCHI = 12;
// Spazio dopo il riquadro legale, prima del blocco firma. Costante per la stessa ragione
// del gap qui sopra, e per un caso già capitato: la riserva chiesta ad assicuraSpazio e
// l'avanzamento di doc.y erano due numeri DIVERSI (6 chiesto, 14 consumato). Gli 8pt di
// differenza mancavano al conto, quindi il riquadro poteva entrare "per un pelo" e poi
// spingere di 8pt tutto ciò che segue — cioè proprio il blocco firma, che non deve mai
// spezzarsi fra due pagine. Lo stesso valore serve anche ad altezzaBloccoLegale, che
// misura questo blocco per decidere quante righe vuote stanno sopra.
const SPAZIO_DOPO_RIGA_LEGALE = 14;

// Riga obbligatoria, non decorativa: questo sistema non contiene tariffe né importi
// (vedi projects.ts). Senza dirlo esplicitamente, un cliente potrebbe leggere la propria
// firma come approvazione di una somma da pagare, che qui non è mai stata calcolata né
// mostrata. Testo INVARIATO parola per parola: è un vincolo legale, non materiale da
// impaginazione. Costante perché serve in due punti — per stamparla e per MISURARLA
// quando si decide quante righe vuote ci stanno (vedi scriviRigheVuote).
const TESTO_LEGALE =
  'Il presente rapportino attesta esclusivamente QUANTITÀ (ore lavorate e materiali impiegati). ' +
  'Non contiene prezzi, tariffe né importi: la firma non costituisce approvazione di alcuna somma.';

// Ordine dei tipi di ora nel riepilogo. Copia dichiarata di TIPI_ORDER in
// packages/frontend/src/lib/format.ts: i due pacchetti non condividono codice, e un
// ordine diverso fra il PDF e la schermata di firma mostrerebbe al cliente due letture
// dello stesso documento. Chi cambia l'uno cambi anche l'altro.
const TIPI_ORDINE = ['ordinario', 'straordinario', 'notturno', 'festivo', 'permesso', 'ferie'];
// La fascia oraria si stampa solo per i tipi in cui "quando" cambia il significato delle
// ore. Per l'ordinario è rumore: è la norma.
const TIPI_CON_FASCIA = new Set(['straordinario', 'notturno', 'festivo']);

function formatDataIt(isoDate: string): string {
  const [anno, mese, giorno] = isoDate.split('-');
  return giorno && mese && anno ? `${giorno}/${mese}/${anno}` : isoDate;
}

function formatDataOraIt(value: Date): string {
  if (Number.isNaN(value.getTime())) return '—';
  const due = (n: number) => String(n).padStart(2, '0');
  return `${due(value.getDate())}/${due(value.getMonth() + 1)}/${value.getFullYear()} ${due(value.getHours())}:${due(value.getMinutes())}`;
}

/**
 * Numero in formato italiano: virgola decimale e nessuno zero inutile ("5", "7,5", "1,25").
 *
 * Il nome dice "decimale" e non "ore" perché di ore non sa niente: lo snapshot conserva
 * con il punto sia le ore ("5.00") sia le quantità di materiale ("12.5"), perché è la
 * forma in cui Postgres restituisce un `numeric` — quella è la memoria del documento,
 * questa è la sua lettura. Finché si è chiamata `formatOreIt` le quantità sono rimaste
 * indietro, stampate grezze accanto a ore già in italiano: sullo stesso foglio comparivano
 * "12.5" metri e "7,5" ore, che in italiano si leggono come due numeri scritti in due modi
 * diversi (e il punto, per giunta, da noi separa le migliaia).
 */
function formatDecimaleIt(valore: string, decimaliMassimi: number): string {
  const numero = Number(valore);
  if (!Number.isFinite(numero)) return valore;
  return numero.toLocaleString('it-IT', { maximumFractionDigits: decimaliMassimi });
}

// Ore: due decimali, quanti ne tiene `time_logs.hours_worked` (numeric(5,2)).
// Esportata perché serve anche al corpo dell'email del rapportino firmato
// (rapportini.service.ts): il cliente legge "7,5" nel PDF allegato e deve leggere "7,5"
// anche nel messaggio che glielo accompagna, non "7.50".
export function formatOreIt(valore: string): string {
  return formatDecimaleIt(valore, 2);
}

// Quantità dei materiali: tre decimali, quanti ne tiene `time_log_materials.quantity`
// (numeric(12,3)). Uno in più delle ore, perché in cantiere si misura anche il mezzo metro.
function formatQuantitaIt(valore: string): string {
  return formatDecimaleIt(valore, 3);
}

/**
 * N° progressivo del rapportino, come il numero pre-stampato di un blocco a ricalco.
 *
 * Cinque cifre perché è il formato del blocco cartaceo dell'azienda ("08379"): la
 * continuità visiva con ciò che i clienti riconoscono vale più del margine di un sesto
 * zero. Oltre 99999 il numero cresce senza padding, mai troncato.
 *
 * Copia dichiarata di formatNumeroRapportino in packages/frontend/src/lib/format.ts: il
 * frontend non è importabile da qui, e senza le due copie sorvegliate la stessa cifra
 * comparirebbe come "N° 08380" su una schermata e "n. 8380" sull'altra. Prefisso incluso,
 * per la stessa ragione.
 */
export function formatNumeroRapportino(numero: number): string {
  return `N° ${String(numero).padStart(5, '0')}`;
}

function etichettaNumero(documento: DatiDocumento): string {
  return documento.numero == null ? '—' : formatNumeroRapportino(documento.numero);
}

function etichettaCantiere(snapshot: RapportinoSnapshot): string {
  return snapshot.cantiere.code ?? `#${snapshot.cantiere.projectNumber}`;
}

function orarioRiga(riga: SnapshotRiga): string {
  if (!riga.oraInizio && !riga.oraFine) return '—';
  return `${riga.oraInizio?.slice(0, 5) ?? ''}–${riga.oraFine?.slice(0, 5) ?? ''}`;
}

// Fascia oraria del riepilogo, con una regola volutamente restrittiva: si stampa SOLO se
// esiste UNA SOLA riga di quel tipo e ha entrambi gli orari. Con due o più righe dello
// stesso tipo, min(inizio)–max(fine) non è la fascia lavorata — due turni separati
// diventerebbero un blocco continuo, cioè un'informazione falsa su un documento firmato.
function fasciaOraria(righe: SnapshotRiga[], tipo: string): string | null {
  if (!TIPI_CON_FASCIA.has(tipo)) return null;
  const delTipo = righe.filter((riga) => riga.tipo === tipo);
  if (delTipo.length !== 1) return null;
  const riga = delTipo[0];
  if (!riga.oraInizio || !riga.oraFine) return null;
  return `dalle ${riga.oraInizio.slice(0, 5)} alle ${riga.oraFine.slice(0, 5)}`;
}

function tipiOrdinati(perTipo: Record<string, string>): string[] {
  const presenti = Object.keys(perTipo);
  const noti = TIPI_ORDINE.filter((tipo) => presenti.includes(tipo));
  // Un tipo che non è nell'elenco noto (snapshot vecchio, enum cambiato nel frattempo)
  // va comunque stampato: il documento firmato non si riscrive per adeguarlo all'oggi.
  const ignoti = presenti.filter((tipo) => !TIPI_ORDINE.includes(tipo)).sort();
  return [...noti, ...ignoti];
}

function noteDelDocumento(snapshot: RapportinoSnapshot): string[] {
  return snapshot.righe
    .filter((riga) => riga.note && riga.note.trim().length > 0)
    .map((riga) => `${riga.operaio.nome} — ${riga.note?.trim() ?? ''}`);
}

function haQualcheCodice(materiali: SnapshotMateriale[]): boolean {
  return materiali.some((m) => (m.codice ?? '').trim().length > 0);
}

// --- Primitive di disegno -------------------------------------------------------------

function etichettaCasella(doc: PDFKit.PDFDocument, testo: string, x: number, y: number, larghezza?: number): void {
  doc
    .font('Helvetica')
    .fontSize(6.5)
    .fillColor(COLORE.etichetta)
    .text(testo.toUpperCase(), x, y, { characterSpacing: 0.5, lineBreak: false, width: larghezza });
}

// Scrive un valore riducendo il corpo finché entra su una riga sola, invece di troncarlo:
// un nome accorciato con i puntini su un documento firmato è un dato mancante travestito
// da dato presente.
function valoreAdattato(
  doc: PDFKit.PDFDocument,
  testo: string,
  x: number,
  y: number,
  larghezza: number,
  font: 'Helvetica' | 'Helvetica-Bold',
  dimensioni: number[],
  altezzaMassima: number,
  colore: string = COLORE.testo,
): void {
  doc.font(font).fillColor(colore);
  for (const dimensione of dimensioni) {
    doc.fontSize(dimensione);
    if (doc.widthOfString(testo) <= larghezza) {
      doc.text(testo, x, y, { width: larghezza, lineBreak: false });
      return;
    }
  }
  doc.fontSize(dimensioni[dimensioni.length - 1]).text(testo, x, y, { width: larghezza, height: altezzaMassima });
}

function linea(doc: PDFKit.PDFDocument, x1: number, y: number, x2: number, spessore: number, colore: string): void {
  doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(spessore).strokeColor(colore).stroke().restore();
}

// --- Testata --------------------------------------------------------------------------

function scriviTestata(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot): void {
  const { azienda } = snapshot;

  // Barra d'accento al posto del logo: lo slot per un marchio vero (150 × 48 pt) resta
  // libero alla sua destra, ma `companies` non ha ancora un logo da stampare e disegnarne
  // uno somigliante sarebbe un marchio inventato.
  doc.save().rect(CONTENUTO_X, 40, 4, 34).fillColor(COLORE.scuro).fill().restore();

  doc.font('Helvetica-Bold').fillColor(COLORE.testo);
  const nome = azienda.nome;
  let scritto = false;
  for (const dimensione of [20, 16]) {
    doc.fontSize(dimensione);
    if (doc.widthOfString(nome) <= 240) {
      doc.text(nome, 52, 42, { width: 240, lineBreak: false });
      scritto = true;
      break;
    }
  }
  if (!scritto) {
    // Corpo minore e a capo: il nome dell'azienda non si tronca mai.
    doc.fontSize(13).text(nome, 52, 42, { width: 240, height: 58 });
  }

  // Ogni riga è OMESSA se il dato manca: "Tel. —" dichiarerebbe che l'azienda non ha
  // telefono, che è diverso dal non averlo registrato.
  const righeAzienda = [
    azienda.indirizzo,
    azienda.telefono ? `Tel. ${azienda.telefono}` : null,
    azienda.email ? `E-mail: ${azienda.email}` : null,
    azienda.vat ? `P. IVA e C.F. ${azienda.vat}` : null,
  ].filter((riga): riga is string => Boolean(riga));

  doc.font('Helvetica').fontSize(7.5).fillColor(COLORE.testoSecondario);
  let y = 42;
  for (const riga of righeAzienda) {
    doc.text(riga, 335.28, y, { width: 220, align: 'right' });
    y += 9.5;
  }

  linea(doc, CONTENUTO_X, 112, CONTENUTO_DESTRA, 1.5, COLORE.scuro);
}

function scriviTitoloEStato(doc: PDFKit.PDFDocument, firma: FirmaPdf): void {
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor(COLORE.testo)
    .text('RAPPORTINO DI LAVORO', CONTENUTO_X, 122, { characterSpacing: 1.2, lineBreak: false });

  // GET /rapportini/:id/pdf genera il documento in QUALUNQUE stato: senza questo segno,
  // la stampa di un rapportino mai firmato sarebbe indistinguibile da una firmata a chi
  // guarda solo la prima pagina.
  if (firma.firmaPngBase64) return;
  const testo = 'NON FIRMATO';
  doc.font('Helvetica-Bold').fontSize(7.5);
  const larghezza = doc.widthOfString(testo) + 16;
  const x = CONTENUTO_DESTRA - larghezza;
  doc.save().lineWidth(0.5).roundedRect(x, 120, larghezza, 16, 3).fillAndStroke(COLORE.avvisoFondo, COLORE.avvisoBordo).restore();
  doc.fillColor(COLORE.avvisoTesto).text(testo, x + 8, 125, { lineBreak: false });
}

function scriviCaselleDati(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot, documento: DatiDocumento): void {
  const y = 144;
  const altezza = 36;
  const caselle: { etichetta: string; x: number; larghezza: number }[] = [
    { etichetta: 'Data', x: 40, larghezza: 120 },
    { etichetta: 'Commessa', x: 168, larghezza: 219.28 },
    { etichetta: 'N°', x: 395.28, larghezza: 160 },
  ];
  for (const casella of caselle) {
    doc
      .save()
      .lineWidth(0.75)
      .roundedRect(casella.x, y, casella.larghezza, altezza, 3)
      .fillAndStroke('#ffffff', COLORE.bordoCasella)
      .restore();
    etichettaCasella(doc, casella.etichetta, casella.x + 8, y + 6);
  }

  valoreAdattato(doc, formatDataIt(snapshot.date), 48, y + 17, 104, 'Helvetica-Bold', [11], 13);
  valoreAdattato(doc, etichettaCantiere(snapshot), 176, y + 17, 203.28, 'Helvetica-Bold', [11, 9.5, 8], 13);

  // Il numero è l'unico elemento in rosso del documento, ed è deliberato: è il numero
  // pre-stampato del blocco a ricalco, quello con cui il cliente ritrova il rapportino.
  const numero = etichettaNumero(documento);
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(COLORE.numero)
    .text(numero, 403.28, y + 16, { width: 144, align: 'right', lineBreak: false });
}

function scriviCommittenteERiepilogo(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot): void {
  const y = 188;
  const altezza = 84;

  // --- Committente / cantiere / destinazione ---
  doc.save().lineWidth(0.75).roundedRect(40, y, 320, altezza, 3).fillAndStroke('#ffffff', COLORE.bordoCasella).restore();
  linea(doc, 46, y + 27, 354, 0.5, COLORE.separatore);
  linea(doc, 46, y + 51, 354, 0.5, COLORE.separatore);

  etichettaCasella(doc, 'Spett.le', 48, y + 6);
  valoreAdattato(doc, snapshot.cantiere.clientName ?? '—', 48, y + 16, 304, 'Helvetica-Bold', [11, 9.5, 8], 11);

  etichettaCasella(doc, 'Cantiere', 48, y + 30);
  valoreAdattato(doc, snapshot.cantiere.nome, 48, y + 40, 304, 'Helvetica', [9.5, 8.5, 7.5], 11);

  // Quando l'indirizzo manca si stampa il trattino e NON il nome del cantiere: sono due
  // informazioni diverse, e riempire il buco con l'altra le renderebbe indistinguibili.
  // `?? '—'` copre anche l'`undefined` di uno snapshot v1, che la chiave non ce l'ha.
  etichettaCasella(doc, 'Destinazione', 48, y + 54);
  valoreAdattato(doc, snapshot.cantiere.indirizzo ?? '—', 48, y + 64, 304, 'Helvetica', [9.5, 8.5, 7.5], 14);

  // --- Riepilogo ore ---
  // Al posto delle caselle da spuntare del cartaceo: le spunte dicono sì/no perché la
  // carta non sa contare, `perTipo` dice QUANTO. Stessa posizione, più informazione — e
  // nessuna casella disegnata che sembra da compilare su un documento già chiuso.
  doc.save().lineWidth(0.5).roundedRect(375.28, y, 180, altezza, 3).fillAndStroke(COLORE.zebra, COLORE.separatore).restore();
  etichettaCasella(doc, 'Riepilogo ore', 383.28, y + 6);

  const tipi = tipiOrdinati(snapshot.totali.perTipo);
  const fasce = new Map(tipi.map((tipo) => [tipo, fasciaOraria(snapshot.righe, tipo)]));
  const spazioDisponibile = altezza - 18;
  const altezzaEstesa = tipi.length * 15 + [...fasce.values()].filter(Boolean).length * 8;
  // Modalità compatta quando i tipi sono tanti: si rinuncia alla fascia oraria, che è
  // un'aggiunta, mai alle ore, che sono il dato.
  const compatto = altezzaEstesa > spazioDisponibile;
  const passo = compatto ? Math.min(15, spazioDisponibile / Math.max(tipi.length, 1)) : 15;

  let rigaY = y + 18;
  for (const tipo of tipi) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(COLORE.testo)
      .text(tipo.toUpperCase(), 383.28, rigaY, { characterSpacing: 0.4, lineBreak: false });
    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .text(formatOreIt(snapshot.totali.perTipo[tipo]), 383.28, rigaY - 1, { width: 164, align: 'right', lineBreak: false });
    rigaY += passo;
    const fascia = compatto ? null : fasce.get(tipo);
    if (fascia) {
      doc.font('Helvetica').fontSize(7).fillColor(COLORE.testoSecondario).text(fascia, 383.28, rigaY - 4, { lineBreak: false });
      rigaY += 8;
    }
  }
  if (tipi.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLORE.testoSecondario).text('Nessuna ora registrata', 383.28, y + 20, { lineBreak: false });
  }
}

// Testata ridotta delle pagine dalla seconda in poi: chi ha in mano un foglio staccato
// deve poter dire di quale documento è, senza ripetere l'intera intestazione.
function scriviTestataSegue(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot, documento: DatiDocumento): void {
  // Stesso trattamento del blocco firma, e per lo stesso motivo: sotto questa riga c'è una
  // linea a y fisso (60) e il contenuto riparte da Y_CONTENUTO_SEGUE, quindi una ragione
  // sociale che va a capo ci finisce sopra — e `lineBreak: false` non lo impedisce, perché
  // pdfkit lo ignora quando riceve anche una `width`. Non è un caso di scuola: misurata con
  // pdfkit, "Costruzioni Generali Fratelli Rossi & Figli S.r.l. Unipersonale" occupa
  // 257,5pt contro i 250 disponibili.
  valoreAdattato(doc, snapshot.azienda.nome, CONTENUTO_X, 40, 250, 'Helvetica-Bold', [9, 8, 7], 11);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(COLORE.testoSecondario)
    .text(
      `Rapportino ${etichettaNumero(documento)} · ${formatDataIt(snapshot.date)} · (segue)`,
      CONTENUTO_DESTRA - 265,
      41,
      { width: 265, align: 'right', lineBreak: false },
    );
  linea(doc, CONTENUTO_X, 60, CONTENUTO_DESTRA, 0.75, COLORE.scuro);
}

// --- Tabelle --------------------------------------------------------------------------

function scriviBanda(doc: PDFKit.PDFDocument, colonne: Colonna[], y: number, segue = false): number {
  doc.save().rect(CONTENUTO_X, y, CONTENUTO_LARGHEZZA, 18).fillColor(COLORE.scuro).fill().restore();
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
  let x = CONTENUTO_X;
  for (const [indice, colonna] of colonne.entries()) {
    const titolo = indice === 0 && segue ? `${colonna.titolo} (SEGUE)` : colonna.titolo;
    doc.text(titolo, x + 6, y + 5.5, {
      width: colonna.larghezza - 12,
      align: colonna.allineamento ?? 'left',
      characterSpacing: 0.6,
      lineBreak: false,
    });
    x += colonna.larghezza;
  }
  return y + 18;
}

// Cornice della riga: zebratura, separatori verticali e linea di fondo. Sono i tre
// elementi che danno l'aspetto "modulo" e vanno disegnati anche per le righe vuote,
// altrimenti la rigatura del blocco cartaceo sparirebbe proprio dove serve.
function disegnaGrigliaRiga(
  doc: PDFKit.PDFDocument,
  colonne: Colonna[],
  y: number,
  altezza: number,
  zebra: boolean,
): void {
  if (zebra) {
    doc.save().rect(CONTENUTO_X, y, CONTENUTO_LARGHEZZA, altezza).fillColor(COLORE.zebra).fill().restore();
  }
  doc.save().lineWidth(0.5).strokeColor(COLORE.separatore);
  let x = CONTENUTO_X;
  doc.moveTo(x, y).lineTo(x, y + altezza).stroke();
  for (const colonna of colonne) {
    x += colonna.larghezza;
    doc.moveTo(x, y).lineTo(x, y + altezza).stroke();
  }
  doc.restore();
  linea(doc, CONTENUTO_X, y + altezza, CONTENUTO_DESTRA, 0.5, COLORE.lineaRiga);
}

function xColonna(colonne: Colonna[], indice: number): number {
  let x = CONTENUTO_X;
  for (let i = 0; i < indice; i++) x += colonne[i].larghezza;
  return x;
}

// Aggiunge una pagina quando la riga successiva non ci sta, ripetendo l'intestazione
// della tabella: una tabella che continua senza intestazione su una seconda pagina
// costringe a tornare indietro per capire cosa sia ogni colonna.
function assicuraSpazio(doc: PDFKit.PDFDocument, altezzaRichiesta: number, ripetiBanda?: () => void): void {
  if (doc.y + altezzaRichiesta <= FONDO_CONTENUTO) return;
  doc.addPage();
  if (ripetiBanda) ripetiBanda();
}

// Righe a rigatura sotto la chiusura della tabella (richiesta esplicita dell'utente: il
// documento deve avere la forma piena del suo blocco cartaceo).
//
// Sono RIEMPITIVO, e come tale non devono costare una pagina in più: `riserva` è lo
// spazio che il resto del documento occuperà ancora (materiali, note, riga legale, blocco
// firma), e le righe vuote si fermano prima di intaccarlo. Senza questo calcolo, un
// rapportino di due righe finiva su due pagine con la firma da sola sulla seconda —
// esattamente la pagina inutile che le righe vuote non devono generare.
function scriviRigheVuote(
  doc: PDFKit.PDFDocument,
  colonne: Colonna[],
  quante: number,
  altezza: number,
  riserva: number,
): void {
  for (let i = 0; i < quante; i++) {
    if (doc.y + altezza + riserva > FONDO_CONTENUTO) return;
    disegnaGrigliaRiga(doc, colonne, doc.y, altezza, false);
    doc.y += altezza;
  }
}

function altezzaRigaLavoro(doc: PDFKit.PDFDocument, riga: SnapshotRiga): number {
  const larghezzaTitolo = COLONNE_LAVORO[0].larghezza - 12;
  let contenuto = doc.font('Helvetica-Bold').fontSize(9).heightOfString(riga.lavoro.titolo, { width: larghezzaTitolo });
  if (riga.tipo !== 'ordinario') contenuto += 13;
  if (riga.descrizioneLavoro) {
    contenuto += 2 + doc.font('Helvetica').fontSize(8).heightOfString(riga.descrizioneLavoro, { width: larghezzaTitolo });
  }
  const operatore = doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .heightOfString(riga.operaio.nome, { width: COLONNE_LAVORO[3].larghezza - 12 });
  return Math.max(ALTEZZA_RIGA_LAVORO_MINIMA, Math.max(contenuto, operatore) + 10);
}

function scriviRigaLavoro(doc: PDFKit.PDFDocument, riga: SnapshotRiga, altezza: number, zebra: boolean): void {
  const y = doc.y;
  disegnaGrigliaRiga(doc, COLONNE_LAVORO, y, altezza, zebra);

  const xLavoro = xColonna(COLONNE_LAVORO, 0) + 6;
  const larghezzaLavoro = COLONNE_LAVORO[0].larghezza - 12;
  let cursore = y + 5;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORE.testo).text(riga.lavoro.titolo, xLavoro, cursore, { width: larghezzaLavoro });
  cursore = doc.y;

  // Il tipo si segnala solo quando NON è ordinario: l'ordinario è la norma, e marcarlo
  // riempirebbe la colonna di etichette che non distinguono nulla.
  if (riga.tipo !== 'ordinario') {
    const testoTipo = riga.tipo.toUpperCase();
    doc.font('Helvetica-Bold').fontSize(6.5);
    const larghezzaChip = doc.widthOfString(testoTipo) + 8;
    doc.save().roundedRect(xLavoro, cursore + 1, larghezzaChip, 11, 2).fillColor(COLORE.chip).fill().restore();
    doc.fillColor(COLORE.chipTesto).text(testoTipo, xLavoro + 4, cursore + 4, { lineBreak: false });
    cursore += 13;
  }

  // Mai troncata: una descrizione tagliata su un documento firmato è una promessa di
  // contenuto che il cliente non ha visto.
  if (riga.descrizioneLavoro) {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLORE.testoSecondario)
      .text(riga.descrizioneLavoro, xLavoro, cursore + 2, { width: larghezzaLavoro });
  }

  const orario = orarioRiga(riga);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(orario === '—' ? COLORE.tenue : COLORE.testo)
    .text(orario, xColonna(COLONNE_LAVORO, 1) + 6, y + 6, { width: COLONNE_LAVORO[1].larghezza - 12, lineBreak: false });

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(COLORE.testo)
    .text(formatOreIt(riga.ore), xColonna(COLONNE_LAVORO, 2) + 6, y + 5.5, {
      width: COLONNE_LAVORO[2].larghezza - 12,
      align: 'right',
      lineBreak: false,
    });

  // Il nome si ripete su ogni riga anche quando è sempre lo stesso: una cella lasciata
  // vuota "perché uguale a sopra" si legge come dato mancante.
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(COLORE.testo)
    .text(riga.operaio.nome, xColonna(COLONNE_LAVORO, 3) + 6, y + 6, { width: COLONNE_LAVORO[3].larghezza - 12 });

  doc.y = y + altezza;
}

function scriviTabellaLavoro(
  doc: PDFKit.PDFDocument,
  snapshot: RapportinoSnapshot,
  y: number,
  riserva: number,
): void {
  const ripetiBanda = () => {
    doc.y = scriviBanda(doc, COLONNE_LAVORO, doc.y, true);
  };
  doc.y = scriviBanda(doc, COLONNE_LAVORO, y);

  // Ordine dello snapshot, mai riordinato: l'ordine è parte di ciò che è stato firmato.
  for (const [indice, riga] of snapshot.righe.entries()) {
    const altezza = altezzaRigaLavoro(doc, riga);
    assicuraSpazio(doc, altezza, ripetiBanda);
    scriviRigaLavoro(doc, riga, altezza, indice % 2 === 1);
  }

  // L'ordine è: linea di chiusura, TOTALE ORE, e SOLO DOPO le righe vuote. È ciò che
  // rende innocua la rigatura del blocco cartaceo: una voce aggiunta a penna dopo la
  // firma finirebbe sotto un totale che non la comprende, e si smentirebbe da sola.
  assicuraSpazio(doc, ALTEZZA_RIGA_TOTALE + 2, ripetiBanda);
  linea(doc, CONTENUTO_X, doc.y, CONTENUTO_DESTRA, 1, COLORE.chiusura);

  const yTotale = doc.y;
  doc.save().rect(CONTENUTO_X, yTotale, CONTENUTO_LARGHEZZA, ALTEZZA_RIGA_TOTALE).fillColor(COLORE.fondoTotale).fill().restore();
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(COLORE.testo)
    .text('TOTALE ORE', CONTENUTO_X + 6, yTotale + 9, { characterSpacing: 0.6, lineBreak: false });
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(COLORE.testo)
    .text(formatOreIt(snapshot.totali.oreTotali), xColonna(COLONNE_LAVORO, 2) + 6, yTotale + 6, {
      width: COLONNE_LAVORO[2].larghezza - 12,
      align: 'right',
      lineBreak: false,
    });
  doc.y = yTotale + ALTEZZA_RIGA_TOTALE;
  linea(doc, CONTENUTO_X, doc.y, CONTENUTO_DESTRA, 0.5, COLORE.lineaRiga);

  scriviRigheVuote(doc, COLONNE_LAVORO, RIGHE_VUOTE_LAVORO, ALTEZZA_RIGA_LAVORO_MINIMA, riserva);
  doc.y += GAP_TRA_BLOCCHI;
}

function altezzaRigaMateriale(doc: PDFKit.PDFDocument, materiale: SnapshotMateriale, colonne: Colonna[]): number {
  const larghezzaDescrizione = colonne[colonne.length - 1].larghezza - 12;
  return Math.max(
    ALTEZZA_RIGA_MATERIALE_MINIMA,
    doc.font('Helvetica').fontSize(9).heightOfString(materiale.nome, { width: larghezzaDescrizione }) + 8,
  );
}

// Le funzioni "altezza*" misurano un blocco SENZA disegnarlo: servono a sapere quanto
// spazio è ancora impegnato quando si decide quante righe vuote stampare. Misurano il
// blocco al netto del proprio riempitivo, che è appunto ciò che si sta decidendo, e al
// netto del gap che lo segue, sommato a parte da chi compone la riserva.
function altezzaTabellaMateriali(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot): number {
  const materiali = snapshot.totali.materiali;
  const colonne = colonneMateriali(haQualcheCodice(materiali));
  const righe =
    materiali.length === 0
      ? ALTEZZA_RIGA_MATERIALE_MINIMA
      : materiali.reduce((somma, materiale) => somma + altezzaRigaMateriale(doc, materiale, colonne), 0);
  return 18 + righe;
}

function altezzaBloccoNote(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot): number {
  const note = noteDelDocumento(snapshot);
  if (note.length === 0) return 0;
  const larghezza = CONTENUTO_LARGHEZZA - 12;
  doc.font('Helvetica').fontSize(8.5);
  const altezzaTesto = note.reduce((somma, riga) => somma + doc.heightOfString(riga, { width: larghezza }), 0);
  return 18 + Math.max(28, altezzaTesto + 10) + GAP_TRA_BLOCCHI;
}

function altezzaBloccoLegale(doc: PDFKit.PDFDocument): number {
  doc.font('Helvetica-Oblique').fontSize(7.5);
  return doc.heightOfString(TESTO_LEGALE, { width: CONTENUTO_LARGHEZZA - 16 }) + 16 + SPAZIO_DOPO_RIGA_LEGALE;
}

function scriviTabellaMateriali(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot, riserva: number): void {
  const materiali = snapshot.totali.materiali;
  const conCodice = haQualcheCodice(materiali);
  const colonne = colonneMateriali(conCodice);
  const ripetiBanda = () => {
    doc.y = scriviBanda(doc, colonne, doc.y, true);
  };

  // Spazio per la banda PIÙ la prima riga vera, MISURATA. Prima si riservava l'altezza
  // minima di due righe: una stima, e per giunta ottimistica — una prima riga con una
  // descrizione lunga è più alta del minimo, quindi poteva non entrarci, e la banda
  // restava orfana in fondo alla pagina mentre il contenuto ricominciava sotto una banda
  // marcata "(SEGUE)" che non seguiva nulla. Con la riga vera o ci stanno entrambe, o si
  // cambia pagina prima di scrivere qualsiasi cosa.
  const altezzaPrimaRiga =
    materiali.length === 0 ? ALTEZZA_RIGA_MATERIALE_MINIMA : altezzaRigaMateriale(doc, materiali[0], colonne);
  assicuraSpazio(doc, 18 + altezzaPrimaRiga);
  doc.y = scriviBanda(doc, colonne, doc.y);

  // Banda stampata anche senza materiali: dice che la voce è stata verificata, non
  // dimenticata. Il "nessun materiale" è un'informazione, l'assenza della banda no.
  if (materiali.length === 0) {
    const y = doc.y;
    disegnaGrigliaRiga(doc, colonne, y, ALTEZZA_RIGA_MATERIALE_MINIMA, false);
    doc
      .font('Helvetica-Oblique')
      .fontSize(8.5)
      .fillColor(COLORE.testoSecondario)
      .text('Nessun materiale impiegato', CONTENUTO_X + 6, y + 5, { lineBreak: false });
    doc.y = y + ALTEZZA_RIGA_MATERIALE_MINIMA;
  }

  for (const [indice, materiale] of materiali.entries()) {
    const larghezzaDescrizione = colonne[colonne.length - 1].larghezza - 12;
    const altezza = altezzaRigaMateriale(doc, materiale, colonne);
    assicuraSpazio(doc, altezza, ripetiBanda);
    const y = doc.y;
    disegnaGrigliaRiga(doc, colonne, y, altezza, indice % 2 === 1);

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLORE.testo)
      .text(materiale.unita, xColonna(colonne, 0) + 6, y + 5, { width: colonne[0].larghezza - 12, lineBreak: false });
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(formatQuantitaIt(materiale.quantita), xColonna(colonne, 1) + 6, y + 5, {
        width: colonne[1].larghezza - 12,
        align: 'right',
        lineBreak: false,
      });
    if (conCodice) {
      // valoreAdattato e non un `text` con `width`: `lineBreak: false` NON impedisce il
      // ritorno a capo quando si passa anche `width`. In pdfkit quel flag serve solo a non
      // assegnare una larghezza di default (_initOptions), e con una width esplicita il
      // testo viene comunque mandato al LineWrapper. Misurato con pdfkit: un codice di 50
      // caratteri (il massimo che lo schema accetta) occupa 283,5pt in una colonna da 83,
      // cioè QUATTRO righe; uno realistico tipo "ART-2026/XZ-..." ne occupa 224,7, cioè
      // tre. Finivano stampate sopra le righe successive della tabella. Adattando il corpo il
      // codice resta su una riga sola e resta LEGGIBILE PER INTERO, che su un documento
      // firmato conta più dell'uniformità del carattere.
      valoreAdattato(
        doc,
        materiale.codice ?? '—',
        xColonna(colonne, 2) + 6,
        y + 5.5,
        colonne[2].larghezza - 12,
        'Helvetica',
        [8.5, 7.5, 6.5, 5.5],
        altezza - 8,
        COLORE.testoSecondario,
      );
    }
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLORE.testo)
      .text(materiale.nome, xColonna(colonne, colonne.length - 1) + 6, y + 5, { width: larghezzaDescrizione });
    doc.y = y + altezza;
  }

  // Stessa chiusura marcata della tabella delle ore, e per lo stesso motivo: le righe
  // vuote stanno sotto una linea che dichiara dove finisce l'elenco firmato.
  linea(doc, CONTENUTO_X, doc.y, CONTENUTO_DESTRA, 1, COLORE.chiusura);
  scriviRigheVuote(doc, colonne, RIGHE_VUOTE_MATERIALI, ALTEZZA_RIGA_MATERIALE_MINIMA, riserva);
  doc.y += GAP_TRA_BLOCCHI;
}

function scriviNote(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot): void {
  const note = noteDelDocumento(snapshot);
  // Nessuna banda vuota: una sezione NOTE senza note fa sembrare il modulo incompleto.
  if (note.length === 0) return;

  const larghezza = CONTENUTO_LARGHEZZA - 12;
  doc.font('Helvetica').fontSize(8.5);
  const altezzaTesto = note.reduce((somma, riga) => somma + doc.heightOfString(riga, { width: larghezza }), 0);
  const altezzaRiquadro = Math.max(28, altezzaTesto + 10);

  assicuraSpazio(doc, 18 + altezzaRiquadro);
  doc.y = scriviBanda(doc, [{ titolo: 'NOTE', larghezza: CONTENUTO_LARGHEZZA }], doc.y);

  const y = doc.y;
  doc.save().lineWidth(0.5).rect(CONTENUTO_X, y, CONTENUTO_LARGHEZZA, altezzaRiquadro).strokeColor(COLORE.lineaRiga).stroke().restore();
  doc.font('Helvetica').fontSize(8.5).fillColor(COLORE.testo).text(note.join('\n'), CONTENUTO_X + 6, y + 5, { width: larghezza });
  doc.y = y + altezzaRiquadro + GAP_TRA_BLOCCHI;
}

function scriviRigaLegale(doc: PDFKit.PDFDocument): void {
  const larghezza = CONTENUTO_LARGHEZZA - 16;
  doc.font('Helvetica-Oblique').fontSize(7.5);
  const altezza = doc.heightOfString(TESTO_LEGALE, { width: larghezza }) + 16;

  assicuraSpazio(doc, altezza + SPAZIO_DOPO_RIGA_LEGALE);
  const y = doc.y;
  doc.save().lineWidth(0.5).rect(CONTENUTO_X, y, CONTENUTO_LARGHEZZA, altezza).fillAndStroke(COLORE.zebra, COLORE.separatore).restore();
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLORE.testoSecondario).text(TESTO_LEGALE, CONTENUTO_X + 8, y + 8, { width: larghezza });
  doc.y = y + altezza + SPAZIO_DOPO_RIGA_LEGALE;
}

function scriviBloccoFirma(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot, firma: FirmaPdf): void {
  // Il blocco non si spezza MAI fra due pagine: una firma separata dal nome di chi l'ha
  // apposta è esattamente il tipo di documento che non prova più niente. Lo spazio
  // richiesto comprende la riga del formato snapshot che lo segue: chiederne meno la
  // faceva cadere fuori pagina e sparire senza che nulla lo segnalasse.
  assicuraSpazio(doc, ALTEZZA_BLOCCO_FIRMA + ALTEZZA_RIGA_FORMATO);
  const y = doc.y;
  const xSinistra = CONTENUTO_X;
  const xDestra = 305.28;

  etichettaCasella(doc, 'Preparato da', xSinistra, y);
  // valoreAdattato e non un `text` con `width`: in questo blocco le righe successive stanno
  // a offset FISSI (y + 26 qui sotto, y + 116/128 per il firmatario), quindi un nome che va
  // a capo non sposta nulla — ci si stampa sopra. E `lineBreak: false` non lo impedirebbe:
  // pdfkit lo ignora quando riceve anche una `width` (vedi il commento nella tabella
  // materiali). Il corpo si riduce finché il nome sta su una riga: un nome lungo si legge
  // più piccolo, invece di sovrapporsi alla data di preparazione.
  valoreAdattato(doc, snapshot.preparatoDa.nome, xSinistra, y + 12, 250, 'Helvetica-Bold', [9.5, 8.5, 7.5], 12);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(COLORE.testoSecondario)
    .text(`il ${formatDataOraIt(new Date(snapshot.preparatoIl))}`, xSinistra, y + 26, { width: 250 });

  etichettaCasella(doc, 'Firma del cliente', xDestra, y);

  if (!firma.firmaPngBase64) {
    doc.save().lineWidth(1).dash(3, { space: 2 });
    doc.rect(xDestra, y + 12, 250, 96).fillAndStroke(COLORE.avvisoFondo, COLORE.avvisoBordo);
    doc.undash().restore();
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLORE.avvisoTesto)
      .text('IN ATTESA DI FIRMA', xDestra, y + 55, { width: 250, align: 'center', lineBreak: false });
    doc.y = y + ALTEZZA_BLOCCO_FIRMA;
    return;
  }

  // Nessun try/catch attorno a doc.image: se l'immagine non è decodificabile, il PDF
  // deve fallire rumorosamente. Un rapportino "firmato" stampato senza la firma
  // sembrerebbe valido pur non provando più nulla — un errore visibile è preferibile
  // a un documento silenziosamente svuotato del suo unico elemento probatorio.
  // Nessun fondo colorato sotto l'immagine: il PNG del canvas ha sfondo BIANCO OPACO
  // (scelta documentata in FirmaPage.tsx) e su un fondo tinto si vedrebbe la toppa.
  doc.image(Buffer.from(firma.firmaPngBase64, 'base64'), xDestra + 5, y + 12, {
    fit: [240, 96],
    align: 'center',
    valign: 'center',
  });
  linea(doc, xDestra, y + 112, xDestra + 250, 0.75, COLORE.testo);
  // Stesso motivo del "Preparato da": sotto ci sono email e data di firma a offset fissi, e
  // il nome del firmatario è per giunta l'unico testo del documento scritto da un NON
  // utente del sistema (l'endpoint pubblico di firma), quindi lungo quanto vuole entro i
  // 255 caratteri dello schema. Ridotto sta su una riga; a capo coprirebbe la sua email.
  valoreAdattato(doc, firma.firmatarioNome ?? '—', xDestra, y + 116, 250, 'Helvetica-Bold', [9.5, 8.5, 7.5], 12);
  let cursore = y + 128;
  if (firma.firmatarioEmail) {
    doc.font('Helvetica').fontSize(8).fillColor(COLORE.testoSecondario).text(firma.firmatarioEmail, xDestra, cursore, { width: 250 });
    cursore += 10;
  }
  if (firma.firmatoIl) {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLORE.testoSecondario)
      .text(`Firmato il ${formatDataOraIt(firma.firmatoIl)}`, xDestra, cursore, { width: 250 });
  }
  doc.y = y + ALTEZZA_BLOCCO_FIRMA;
}

function scriviRigaFormato(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot): void {
  if (doc.y + 12 > FONDO_CONTENUTO) return;
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor(COLORE.tenue)
    .text(`Generato con WorkFlow360 — formato snapshot v${snapshot.versione}`, CONTENUTO_X, doc.y, {
      width: CONTENUTO_LARGHEZZA,
      lineBreak: false,
    });
}

// Piè scritto alla FINE su tutte le pagine bufferizzate: "Pag. X di Y" richiede di
// conoscere il totale, che si sa solo quando il contenuto è finito (da qui bufferPages).
function scriviPiediDiPagina(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot, documento: DatiDocumento): void {
  const intervallo = doc.bufferedPageRange();
  const sinistra = `${snapshot.azienda.nome} · Rapportino ${etichettaNumero(documento)} · ${formatDataIt(snapshot.date)}`;
  for (let i = 0; i < intervallo.count; i++) {
    doc.switchToPage(intervallo.start + i);
    // Il piè sta SOTTO il margine inferiore, e pdfkit aggiunge una pagina da solo quando
    // una riga di testo supererebbe `page.maxY()` (altezza meno margine). Senza azzerare
    // qui il margine, ogni piè scritto genererebbe una pagina nuova, che a sua volta ne
    // chiederebbe uno: verificato: il documento usciva con quattro pagine vuote in coda e
    // nessun piè stampato. Il margine viene rimesso subito dopo, per non alterare altro.
    const margineOriginale = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    linea(doc, CONTENUTO_X, Y_PIE_LINEA, CONTENUTO_DESTRA, 0.5, COLORE.separatore);
    doc.font('Helvetica').fontSize(7).fillColor(COLORE.etichetta);
    doc.text(sinistra, CONTENUTO_X, Y_PIE_TESTO, { width: 380, lineBreak: false });
    doc.text(`Pag. ${i + 1} di ${intervallo.count}`, CONTENUTO_DESTRA - 120, Y_PIE_TESTO, {
      width: 120,
      align: 'right',
      lineBreak: false,
    });
    doc.page.margins.bottom = margineOriginale;
  }
}

/**
 * Costruisce il PDF del rapportino a partire dallo snapshot congelato, dalla firma e dai
 * dati che vivono in colonna (il numero progressivo).
 *
 * Funzione PURA rispetto al database: non legge nulla, riceve tutto come argomento — così
 * è testabile da sola e il PDF non può mai divergere da ciò che è stato firmato, perché
 * non ha modo di andare a rileggere i dati "aggiornati".
 *
 * Ogni campo aggiunto dopo la v1 dello snapshot viene letto con un fallback esplicito
 * (`?? '—'`): questa funzione viene invocata PRIMA che la firma sia scritta a database,
 * apposta perché un fallimento non consumi il token (vedi signRapportino), e un campo
 * assente che facesse eccezione trasformerebbe quella protezione in un rifiuto sistematico
 * di ogni firma.
 */
export function buildRapportinoPdf(
  snapshot: RapportinoSnapshot,
  firma: FirmaPdf,
  documento: DatiDocumento,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGINA.margine, bufferPages: true });
    const parti: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => parti.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(parti)));
    doc.on('error', reject);

    // La prima pagina è creata dal costruttore, prima che questo gestore esista: quindi
    // scatta solo dalla seconda in poi, che è esattamente ciò che serve. addPage riazzera
    // doc.y al margine, perciò va RIMESSO sotto la testata compatta — senza, la prima
    // riga della pagina nuova finirebbe stampata sopra di essa.
    doc.on('pageAdded', () => {
      scriviTestataSegue(doc, snapshot, documento);
      doc.y = Y_CONTENUTO_SEGUE;
    });

    try {
      // Spazio che il documento occuperà ancora dopo ciascuna tabella: è la quota che le
      // righe vuote (riempitivo) non devono mangiarsi, altrimenti spingono il blocco
      // firma su una pagina in più. Misurato, non stimato a occhio, e comprensivo dei gap
      // fra i blocchi — è proprio dimenticandone uno che la firma finiva fuori pagina.
      const codaFinale = altezzaBloccoLegale(doc) + ALTEZZA_BLOCCO_FIRMA + ALTEZZA_RIGA_FORMATO;
      const riservaMateriali = GAP_TRA_BLOCCHI + altezzaBloccoNote(doc, snapshot) + codaFinale;
      const riservaLavoro =
        GAP_TRA_BLOCCHI +
        altezzaTabellaMateriali(doc, snapshot) +
        RIGHE_VUOTE_MATERIALI_MINIME * ALTEZZA_RIGA_MATERIALE_MINIMA +
        riservaMateriali;

      scriviTestata(doc, snapshot);
      scriviTitoloEStato(doc, firma);
      scriviCaselleDati(doc, snapshot, documento);
      scriviCommittenteERiepilogo(doc, snapshot);
      scriviTabellaLavoro(doc, snapshot, 274, riservaLavoro);
      scriviTabellaMateriali(doc, snapshot, riservaMateriali);
      scriviNote(doc, snapshot);
      scriviRigaLegale(doc);
      scriviBloccoFirma(doc, snapshot, firma);
      scriviRigaFormato(doc, snapshot);
      scriviPiediDiPagina(doc, snapshot, documento);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
