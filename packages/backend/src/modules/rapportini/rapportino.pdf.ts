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

const PAGINA = { margine: 40, larghezza: 595.28, altezza: 841.89 } as const;
const CONTENUTO_LARGHEZZA = PAGINA.larghezza - PAGINA.margine * 2;
const FONDO_PAGINA = PAGINA.altezza - PAGINA.margine;

const COLONNE_ORE = [
  { titolo: 'Operaio', larghezza: 95 },
  { titolo: 'Lavoro', larghezza: 95 },
  { titolo: 'Tipo', larghezza: 60 },
  { titolo: 'Ore', larghezza: 35, allineamento: 'right' as const },
  { titolo: 'Orario', larghezza: 70 },
  { titolo: 'Descrizione', larghezza: 160 },
];

const COLONNE_MATERIALI = [
  { titolo: 'Materiale', larghezza: 315 },
  { titolo: 'Quantità', larghezza: 100, allineamento: 'right' as const },
  { titolo: 'Unità', larghezza: 100 },
];

interface Colonna {
  titolo: string;
  larghezza: number;
  allineamento?: 'left' | 'right';
}

function formatDataIt(isoDate: string): string {
  const [anno, mese, giorno] = isoDate.split('-');
  return giorno && mese && anno ? `${giorno}/${mese}/${anno}` : isoDate;
}

function formatDataOraIt(value: Date): string {
  const due = (n: number) => String(n).padStart(2, '0');
  return `${due(value.getDate())}/${due(value.getMonth() + 1)}/${value.getFullYear()} ${due(value.getHours())}:${due(value.getMinutes())}`;
}

function orario(riga: SnapshotRiga): string {
  if (!riga.oraInizio && !riga.oraFine) return '—';
  return `${riga.oraInizio?.slice(0, 5) ?? '—'} - ${riga.oraFine?.slice(0, 5) ?? '—'}`;
}

function testoMateriali(materiali: SnapshotMateriale[]): string {
  return materiali.map((m) => `${m.nome} ${m.quantita} ${m.unita}`).join('; ');
}

function altezzaRiga(doc: PDFKit.PDFDocument, colonne: Colonna[], celle: string[]): number {
  let massima = 0;
  for (let i = 0; i < colonne.length; i++) {
    const altezza = doc.heightOfString(celle[i] ?? '', { width: colonne[i].larghezza - 6 });
    if (altezza > massima) massima = altezza;
  }
  return massima + 6;
}

function scriviRiga(doc: PDFKit.PDFDocument, colonne: Colonna[], celle: string[], altezza: number): void {
  let x = PAGINA.margine;
  const y = doc.y;
  for (let i = 0; i < colonne.length; i++) {
    doc.text(celle[i] ?? '', x + 3, y + 3, {
      width: colonne[i].larghezza - 6,
      align: colonne[i].allineamento ?? 'left',
    });
    x += colonne[i].larghezza;
  }
  doc.y = y + altezza;
  doc
    .moveTo(PAGINA.margine, doc.y)
    .lineTo(PAGINA.margine + CONTENUTO_LARGHEZZA, doc.y)
    .strokeColor('#dddddd')
    .lineWidth(0.5)
    .stroke();
}

function scriviIntestazioneTabella(doc: PDFKit.PDFDocument, colonne: Colonna[]): void {
  doc.font('Helvetica-Bold').fontSize(9);
  const celle = colonne.map((c) => c.titolo);
  scriviRiga(doc, colonne, celle, altezzaRiga(doc, colonne, celle));
  doc.font('Helvetica').fontSize(9);
}

// Aggiunge una pagina quando la riga successiva non ci sta, ripetendo l'intestazione
// della tabella: una tabella che continua senza intestazione su una seconda pagina
// costringe a tornare indietro per capire cosa sia ogni colonna.
function assicuraSpazio(doc: PDFKit.PDFDocument, altezzaRichiesta: number, colonne?: Colonna[]): void {
  if (doc.y + altezzaRichiesta <= FONDO_PAGINA) return;
  doc.addPage();
  if (colonne) scriviIntestazioneTabella(doc, colonne);
}

function scriviTestata(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot): void {
  const { azienda, cantiere } = snapshot;
  doc.font('Helvetica-Bold').fontSize(16).text(azienda.nome, { align: 'left' });
  doc.font('Helvetica').fontSize(9).fillColor('#444444');
  const righeAzienda = [
    azienda.indirizzo,
    azienda.vat ? `P.IVA / C.F. ${azienda.vat}` : null,
    [azienda.email, azienda.telefono].filter(Boolean).join(' · ') || null,
  ].filter((r): r is string => Boolean(r));
  for (const riga of righeAzienda) doc.text(riga);
  doc.fillColor('#000000').moveDown(1);

  doc.font('Helvetica-Bold').fontSize(14).text('RAPPORTINO GIORNALIERO DI CANTIERE');
  doc.moveDown(0.5);

  doc.font('Helvetica').fontSize(10);
  const etichettaCantiere = cantiere.code ?? `Cantiere #${cantiere.projectNumber}`;
  doc.text(`Cantiere: ${etichettaCantiere} — ${cantiere.nome}`);
  doc.text(`Committente: ${cantiere.clientName ?? '—'}`);
  doc.text(`Data dei lavori: ${formatDataIt(snapshot.date)}`);
  doc.text(`Tipo commessa: ${cantiere.tipoCommessa}`);
  doc.moveDown(1);
}

function scriviTabellaOre(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot): void {
  doc.font('Helvetica-Bold').fontSize(11).text('Ore lavorate');
  doc.moveDown(0.3);
  scriviIntestazioneTabella(doc, COLONNE_ORE);

  for (const riga of snapshot.righe) {
    const descrizione = [riga.descrizioneLavoro, riga.note].filter(Boolean).join(' — ');
    const celle = [
      riga.operaio.nome,
      riga.lavoro.titolo,
      riga.tipo,
      riga.ore,
      orario(riga),
      descrizione || '—',
    ];
    const altezza = altezzaRiga(doc, COLONNE_ORE, celle);
    assicuraSpazio(doc, altezza, COLONNE_ORE);
    scriviRiga(doc, COLONNE_ORE, celle, altezza);
  }
  doc.moveDown(0.8);
}

function scriviTabellaMateriali(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot): void {
  doc.font('Helvetica-Bold').fontSize(11).text('Materiali impiegati');
  doc.moveDown(0.3);

  if (snapshot.totali.materiali.length === 0) {
    doc.font('Helvetica').fontSize(9).text('Nessun materiale registrato.');
    doc.moveDown(0.8);
    return;
  }

  scriviIntestazioneTabella(doc, COLONNE_MATERIALI);
  for (const materiale of snapshot.totali.materiali) {
    const celle = [materiale.nome, materiale.quantita, materiale.unita];
    const altezza = altezzaRiga(doc, COLONNE_MATERIALI, celle);
    assicuraSpazio(doc, altezza, COLONNE_MATERIALI);
    scriviRiga(doc, COLONNE_MATERIALI, celle, altezza);
  }
  doc.moveDown(0.8);
}

function scriviTotali(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot): void {
  assicuraSpazio(doc, 70);
  doc.font('Helvetica-Bold').fontSize(11).text(`Totale ore: ${snapshot.totali.oreTotali}`);
  doc.font('Helvetica').fontSize(9);
  const perTipo = Object.entries(snapshot.totali.perTipo)
    .map(([tipo, ore]) => `${tipo}: ${ore}`)
    .join('   ');
  if (perTipo) doc.text(perTipo);
  const materiali = testoMateriali(snapshot.totali.materiali);
  if (materiali) doc.text(`Materiali: ${materiali}`);
  doc.moveDown(0.8);

  // Riga obbligatoria, non decorativa: questo sistema non contiene tariffe né importi
  // (vedi projects.ts). Senza dirlo esplicitamente, un cliente potrebbe leggere la
  // propria firma come approvazione di una somma da pagare, che qui non è mai stata
  // calcolata né mostrata.
  doc.font('Helvetica-Oblique').fontSize(8).fillColor('#444444');
  doc.text(
    'Il presente rapportino attesta esclusivamente QUANTITÀ (ore lavorate e materiali impiegati). ' +
      'Non contiene prezzi, tariffe né importi: la firma non costituisce approvazione di alcuna somma.',
    { width: CONTENUTO_LARGHEZZA },
  );
  doc.fillColor('#000000').font('Helvetica').moveDown(1);
}

function scriviFirma(doc: PDFKit.PDFDocument, snapshot: RapportinoSnapshot, firma: FirmaPdf): void {
  assicuraSpazio(doc, 170);
  doc.font('Helvetica-Bold').fontSize(11).text('Firma del cliente');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9);

  if (!firma.firmaPngBase64) {
    doc.text('NON ANCORA FIRMATO — documento in attesa di sottoscrizione da parte del cliente.');
    doc.moveDown(1);
  } else {
    // Nessun try/catch attorno a doc.image: se l'immagine non è decodificabile, il PDF
    // deve fallire rumorosamente. Un rapportino "firmato" stampato senza la firma
    // sembrerebbe valido pur non provando più nulla — un errore visibile è preferibile
    // a un documento silenziosamente svuotato del suo unico elemento probatorio.
    doc.image(Buffer.from(firma.firmaPngBase64, 'base64'), PAGINA.margine, doc.y, { fit: [220, 90] });
    doc.y += 95;
    doc
      .moveTo(PAGINA.margine, doc.y)
      .lineTo(PAGINA.margine + 240, doc.y)
      .strokeColor('#000000')
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.4);
    doc.text(`Firmatario: ${firma.firmatarioNome ?? '—'}`);
    if (firma.firmatarioEmail) doc.text(`Email: ${firma.firmatarioEmail}`);
    if (firma.firmatoIl) doc.text(`Firmato il: ${formatDataOraIt(firma.firmatoIl)}`);
    doc.moveDown(0.8);
  }

  doc.fontSize(8).fillColor('#666666');
  doc.text(
    `Documento preparato il ${formatDataOraIt(new Date(snapshot.preparatoIl))} da ${snapshot.preparatoDa.nome} ` +
      `(WorkFlow360, formato snapshot v${snapshot.versione}).`,
    { width: CONTENUTO_LARGHEZZA },
  );
  doc.fillColor('#000000');
}

/**
 * Costruisce il PDF del rapportino a partire dallo snapshot congelato e dalla firma.
 * Funzione PURA rispetto al database: non legge nulla, riceve tutto come argomento —
 * così è testabile da sola e il PDF non può mai divergere da ciò che è stato firmato,
 * perché non ha modo di andare a rileggere i dati "aggiornati".
 */
export function buildRapportinoPdf(snapshot: RapportinoSnapshot, firma: FirmaPdf): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGINA.margine });
    const parti: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => parti.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(parti)));
    doc.on('error', reject);

    try {
      scriviTestata(doc, snapshot);
      scriviTabellaOre(doc, snapshot);
      scriviTabellaMateriali(doc, snapshot);
      scriviTotali(doc, snapshot);
      scriviFirma(doc, snapshot, firma);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
