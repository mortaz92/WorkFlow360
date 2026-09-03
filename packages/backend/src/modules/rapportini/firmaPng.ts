import zlib from 'node:zlib';
import { ValidationError } from '../../core/errors';

// Validazione del PNG della firma del cliente: sta in un modulo suo e non dentro
// rapportini.service.ts perché serve in DUE punti che non si somigliano — l'endpoint
// pubblico di firma (dove il PNG arriva da fuori) e la rigenerazione del PDF (dove il PNG
// arriva dal database, ma è comunque un dato entrato da fuori tempo prima).
//
// Il punto di questo file è uno solo: **niente arriva a pdfkit senza essere stato
// decodificato qui prima, in modo SINCRONO**. Non è una precauzione di stile.
// pdfkit disegna i PNG con png-js, che per un'immagine con canale alfa (colorType 4 o 6 —
// cioè esattamente quello che produce il canvas della firma) chiama
// `zlib.inflate(imgData, callback)` e dentro quella callback fa `throw err`
// (node_modules/png-js/lib/png-js.js). È un throw ASINCRONO: nessun try/catch attorno a
// `doc.image()` può intercettarlo, la callback non gira sullo stack di chi ha chiamato.
// Il risultato, riprodotto dal vivo, è che un PNG con intestazione IHDR perfetta e 4 byte
// di spazzatura al posto dei dati compressi supera ogni controllo di forma, arriva a
// pdfkit e TERMINA IL PROCESSO con "incorrect header check" — un `uncaughtException` che
// in produzione non ha nessun gestore. Chiunque possieda un link di firma (o, per la
// rigenerazione del PDF, qualunque utente autenticato) potrebbe far cadere il backend
// per tutti, in un ciclo che il rate limiter non ferma perché il suo contatore vive in
// memoria e riparte da zero a ogni riavvio.
//
// La decompressione fatta QUI, con inflateSync, ha due proprietà che quella di png-js non
// ha: è sincrona (quindi catturabile e traducibile in un 400 con il token ancora valido,
// il cliente rifirma) e ha un TETTO sull'output.

const PREFISSO_DATA_PNG = 'data:image/png;base64,';
const FIRMA_MAX_BYTES = 500 * 1024;
// Il base64 usa 4 caratteri per ogni 3 byte: la stringa in arrivo è circa 4/3 dei byte
// che rappresenta. Serve a rifiutare un payload sovradimensionato PRIMA di decodificarlo,
// non a misurarlo con precisione — il controllo esatto sui byte decodificati resta
// comunque, subito dopo.
const FIRMA_MAX_BASE64_CHARS = Math.ceil((FIRMA_MAX_BYTES * 4) / 3) + 4;
// Gli 8 byte iniziali obbligatori di ogni file PNG (RFC 2083).
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Struttura dell'header PNG: dopo i magic byte, il primo chunk DEVE essere IHDR
// (RFC 2083 §11.2.2). Offset assoluti dall'inizio del file:
//   8..11  lunghezza del chunk    12..15 tipo del chunk ("IHDR")
//   16..19 larghezza (big-endian) 20..23 altezza (big-endian)
//   24 profondità di bit  25 tipo di colore  26 compressione  27 filtro  28 interlacciamento
const PNG_OFFSET_TIPO_CHUNK = 12;
const PNG_OFFSET_LARGHEZZA = 16;
const PNG_OFFSET_ALTEZZA = 20;
const PNG_OFFSET_PROFONDITA_BIT = 24;
const PNG_OFFSET_TIPO_COLORE = 25;
const PNG_OFFSET_INTERLACCIAMENTO = 28;
const PNG_HEADER_MIN_BYTES = 29;
// Ogni chunk PNG è: 4 byte di lunghezza + 4 di tipo + i dati + 4 di CRC.
const CHUNK_INTESTAZIONE_BYTES = 8;
const CHUNK_CRC_BYTES = 4;
// Tetto sulle dimensioni DICHIARATE nell'IHDR. La firma di un cliente è un tratto su un
// canvas da tablet: poche centinaia di pixel per lato. Questi limiti sono già larghissimi
// per quell'uso, e servono a tutt'altro — un PNG può dichiarare dimensioni enormi restando
// minuscolo da compresso (una "bomba di decompressione"), e chi lo decodifica alloca
// larghezza × altezza × 4 byte PRIMA di accorgersi che è assurdo. Su Render il backend gira
// con 512MB (plan free, vedi render.yaml): un'allocazione simile non lancia un'eccezione
// che si possa intercettare con un try/catch, fa terminare il processo dal sistema mentre
// un cliente sta firmando. Per questo il controllo sta PRIMA di qualunque decodifica.
const FIRMA_MAX_LARGHEZZA_PX = 2000;
const FIRMA_MAX_ALTEZZA_PX = 1000;
// Campioni per pixel di ciascun tipo di colore PNG (RFC 2083 §4.1.1). Le chiavi sono anche
// l'elenco dei tipi ammessi: un tipo fuori da questa tabella non ha un numero di byte per
// pixel calcolabile, quindi non avrebbe nemmeno un tetto calcolabile per l'inflate.
const CAMPIONI_PER_TIPO_COLORE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PROFONDITA_BIT_AMMESSE = new Set([1, 2, 4, 8, 16]);

// Parola per parola lo stesso messaggio che signRapportino restituisce quando è pdfkit a
// non farcela: per chi sta firmando i due casi sono lo stesso fatto ("questa firma non si
// riesce a usare, rifai il tratto"), e dargli due testi diversi lo manderebbe a cercare
// una differenza che non lo riguarda. Il dettaglio tecnico resta nei log, non nel corpo
// della risposta di un endpoint pubblico.
const ERRORE_NON_DISEGNABILE = 'Impossibile elaborare la firma: riprova';

interface IntestazionePng {
  larghezza: number;
  altezza: number;
  profonditaBit: number;
  tipoColore: number;
}

/** Legge e convalida l'IHDR. Ogni campo che serve a calcolare il tetto dell'inflate viene
 *  controllato qui: un valore fuori tabella renderebbe il tetto un numero inventato. */
function leggiIntestazione(bytes: Buffer): IntestazionePng {
  if (
    bytes.length < PNG_HEADER_MIN_BYTES ||
    bytes.toString('ascii', PNG_OFFSET_TIPO_CHUNK, PNG_OFFSET_LARGHEZZA) !== 'IHDR'
  ) {
    throw new ValidationError("Il contenuto della firma non è un file PNG valido (intestazione IHDR assente)");
  }
  const larghezza = bytes.readUInt32BE(PNG_OFFSET_LARGHEZZA);
  const altezza = bytes.readUInt32BE(PNG_OFFSET_ALTEZZA);
  // Zero non è una dimensione ammessa da RFC 2083 e manderebbe in errore il decodificatore.
  if (larghezza === 0 || altezza === 0) {
    throw new ValidationError('Il contenuto della firma non è un file PNG valido (dimensioni nulle)');
  }
  if (larghezza > FIRMA_MAX_LARGHEZZA_PX || altezza > FIRMA_MAX_ALTEZZA_PX) {
    throw new ValidationError(
      `La firma dichiara dimensioni non plausibili (${larghezza}×${altezza} pixel): ` +
        `il massimo consentito è ${FIRMA_MAX_LARGHEZZA_PX}×${FIRMA_MAX_ALTEZZA_PX}`,
    );
  }

  const profonditaBit = bytes[PNG_OFFSET_PROFONDITA_BIT];
  const tipoColore = bytes[PNG_OFFSET_TIPO_COLORE];
  if (!PROFONDITA_BIT_AMMESSE.has(profonditaBit) || CAMPIONI_PER_TIPO_COLORE[tipoColore] === undefined) {
    throw new ValidationError(ERRORE_NON_DISEGNABILE);
  }
  // Interlacciamento Adam7 rifiutato, e non per pigrizia: un'immagine interlacciata si
  // decomprime in SETTE sotto-immagini, ognuna con i propri byte di filtro, quindi il
  // tetto calcolato sotto (una riga di filtro per riga di pixel) non varrebbe più — e un
  // tetto sbagliato è come non averlo. Nessun canvas di browser produce PNG interlacciati:
  // rifiutarli non toglie niente a nessuna firma vera.
  if (bytes[PNG_OFFSET_INTERLACCIAMENTO] !== 0) {
    throw new ValidationError(ERRORE_NON_DISEGNABILE);
  }

  return { larghezza, altezza, profonditaBit, tipoColore };
}

/** Concatena i dati di tutti i chunk IDAT, come fa png-js prima di decomprimerli. */
function estraiDatiCompressi(bytes: Buffer): Buffer {
  const pezzi: Buffer[] = [];
  let posizione = PNG_MAGIC.length;

  while (posizione + CHUNK_INTESTAZIONE_BYTES <= bytes.length) {
    const lunghezza = bytes.readUInt32BE(posizione);
    const tipo = bytes.toString('ascii', posizione + 4, posizione + CHUNK_INTESTAZIONE_BYTES);
    const inizioDati = posizione + CHUNK_INTESTAZIONE_BYTES;
    const fineDati = inizioDati + lunghezza;
    // Un chunk che dichiara più byte di quanti il file ne contenga è un file troncato: va
    // fermato qui, altrimenti la lettura proseguirebbe su byte che non esistono (è la
    // stessa mancanza di controllo che in png-js produce un errore molto più a valle).
    if (fineDati + CHUNK_CRC_BYTES > bytes.length) {
      throw new ValidationError(ERRORE_NON_DISEGNABILE);
    }
    if (tipo === 'IDAT') pezzi.push(bytes.subarray(inizioDati, fineDati));
    if (tipo === 'IEND') break;
    posizione = fineDati + CHUNK_CRC_BYTES;
  }

  if (pezzi.length === 0) {
    throw new ValidationError(ERRORE_NON_DISEGNABILE);
  }
  return Buffer.concat(pezzi);
}

/**
 * Decomprime davvero i dati immagine, con un tetto sull'output.
 *
 * Il tetto è larghezza × altezza × byte-per-pixel + altezza: i byte dei pixel più UN byte
 * di filtro per riga (RFC 2083 §9). È il massimo che un PNG non interlacciato di queste
 * dimensioni possa produrre, quindi un'immagine legittima non lo tocca mai. Senza tetto,
 * `zlib` espande quanto gli viene chiesto: ~500KB compressi (il massimo che questo
 * endpoint accetta) possono diventare centinaia di MB, e su Render il processo verrebbe
 * terminato per memoria. Il controllo sulle dimensioni IHDR NON copriva questo caso —
 * limita l'allocazione dei pixel, non l'inflate, che avviene prima e su un buffer che
 * cresce da solo.
 */
function assertPixelDecomprimibili(bytes: Buffer, intestazione: IntestazionePng): void {
  const campioni = CAMPIONI_PER_TIPO_COLORE[intestazione.tipoColore];
  const bytePerPixel = Math.ceil((campioni * intestazione.profonditaBit) / 8);
  const tettoOutput = intestazione.larghezza * intestazione.altezza * bytePerPixel + intestazione.altezza;

  try {
    zlib.inflateSync(estraiDatiCompressi(bytes), { maxOutputLength: tettoOutput });
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    // Qualunque causa (dati non zlib, stream troncato, output oltre il tetto) porta allo
    // stesso esito: la firma non è disegnabile e va rifiutata ADESSO, mentre il cliente è
    // ancora davanti allo schermo e il token è ancora valido.
    throw new ValidationError(ERRORE_NON_DISEGNABILE);
  }
}

/** Controlli comuni ai due punti d'ingresso, su byte già decodificati dal base64. */
function assertContenutoPng(bytes: Buffer): void {
  // Controllo dei byte magici, non solo del prefisso dichiarato: il prefisso lo scrive
  // il client e può dichiarare qualsiasi cosa. Senza questo, l'endpoint pubblico
  // diventerebbe un modo per depositare contenuto arbitrario nel database e farselo
  // restituire da un altro endpoint travestito da immagine.
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new ValidationError('Il contenuto della firma non è un file PNG valido');
  }
  if (bytes.length > FIRMA_MAX_BYTES) {
    throw new ValidationError(
      `La firma supera la dimensione massima consentita (${Math.round(FIRMA_MAX_BYTES / 1024)} KB)`,
    );
  }
  assertPixelDecomprimibili(bytes, leggiIntestazione(bytes));
}

/**
 * Valida il data-URI che arriva dall'endpoint pubblico di firma e restituisce il solo
 * base64, nella forma in cui va salvato in `rapportini.signature_png`.
 */
export function validaFirmaPng(valore: string): string {
  if (!valore.startsWith(PREFISSO_DATA_PNG)) {
    throw new ValidationError(`La firma deve essere un'immagine PNG nel formato "${PREFISSO_DATA_PNG}..."`);
  }
  const base64 = valore.slice(PREFISSO_DATA_PNG.length);
  // Buffer.from(..., 'base64') non fallisce mai su input sporco: scarta i caratteri che
  // non riconosce e restituisce comunque qualcosa. Il controllo dell'alfabeto va fatto
  // prima, altrimenti "non è base64" diventerebbe indistinguibile da "è un PNG strano".
  if (base64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ValidationError('La firma non è codificata correttamente in base64');
  }
  // Tetto misurato sulla STRINGA, prima di decodificarla: Buffer.from alloca l'intero
  // contenuto decodificato, e controllare la dimensione dopo significherebbe pagare
  // l'allocazione per intero proprio per gli input che si vogliono rifiutare, cioè
  // esattamente quelli che un attaccante ha interesse a spedire grandi e in serie.
  if (base64.length > FIRMA_MAX_BASE64_CHARS) {
    throw new ValidationError(
      `La firma supera la dimensione massima consentita (${Math.round(FIRMA_MAX_BYTES / 1024)} KB)`,
    );
  }

  assertContenutoPng(Buffer.from(base64, 'base64'));
  return base64;
}

/**
 * Stessa verifica per una firma GIÀ salvata, prima di rigenerare il PDF di un rapportino
 * firmato in passato.
 *
 * Serve perché la validazione all'ingresso protegge solo ciò che entra da oggi: una riga
 * scritta prima di questa correzione può contenere un PNG che fa terminare il processo
 * quando pdfkit prova a disegnarlo, e per innescarlo basterebbe una GET del PDF. Qui
 * l'errore diventa un fallimento della singola richiesta (vedi generaPdfDifensivo, che lo
 * traduce in un errore che NOMINA il rapportino) invece della caduta del backend.
 */
export function assertFirmaPngDisegnabile(base64: string): void {
  assertContenutoPng(Buffer.from(base64, 'base64'));
}
