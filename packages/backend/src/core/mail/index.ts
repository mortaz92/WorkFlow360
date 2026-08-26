import { CONFIG } from '../config';

const RESEND_API_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 5000;

// ATTENZIONE — forma NON verificata contro un invio reale. Resend documenta gli
// allegati come `attachments: [{ filename, content }]` con `content` in base64, ed è
// quello che scriviamo qui sotto, ma questo progetto non ha una RESEND_API_KEY con cui
// provarlo: prima di farci affidamento in produzione va confrontato con la
// documentazione Resend aggiornata e verificato con un invio vero (l'allegato arriva?
// si apre? il nome è quello giusto?). Stesso genere di avvertenza già usata altrove
// per le integrazioni di terzi non verificate dal vivo — un formato "plausibile" non è
// un formato verificato, e un allegato rifiutato in silenzio si scopre solo quando il
// cliente dice che non ha ricevuto il rapportino.
export interface SendEmailAttachment {
  filename: string;
  /** Contenuto del file codificato in base64 (senza prefisso "data:"). */
  content: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  bcc?: string;
  attachments?: SendEmailAttachment[];
}

export interface SendEmailResult {
  sent: boolean;
  error?: string;
}

// Chiamata REST diretta a Resend (fetch nativo, Node 18+), non la libreria npm
// 'resend': una dipendenza in più per una singola POST non si giustifica (vedi
// coding-standards: nessuna nuova dipendenza senza motivazione esplicita).
//
// Non lancia MAI: un errore di invio (chiave assente, Resend giù, timeout) viene
// loggato e RESTITUITO, mai propagato come eccezione. Il valore di ritorno esiste per
// chi deve dire la verità all'utente ("firma registrata, email non inviata" invece di
// un "inviata" falso). Chi NON deve distinguere i due casi lo ignora di proposito:
// requestPasswordReset in auth.service.ts deve rispondere identico che l'email parta o
// no, altrimenti la differenza diventa un modo per indovinare quali indirizzi sono
// registrati — vedi il commento a quel punto di chiamata.
// L'indirizzo del destinatario NON compare MAI nei log, in nessun ramo. Non è
// scrupolo generico: il destinatario del rapportino firmato è il CLIENTE dell'azienda,
// una persona che non è utente del sistema e che non ha mai acconsentito a comparire
// nei log di un servizio di terzi (Render li conserva e li rende leggibili a chiunque
// abbia accesso alla dashboard). Per diagnosticare un invio fallito servono l'oggetto e
// la causa, che restano; a chi fosse indirizzato si ricava dalla riga del rapportino,
// dove il dato ha una ragione di esistere.
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!CONFIG.RESEND_API_KEY) {
    const reason = 'RESEND_API_KEY non configurata';
    console.warn(`[MAIL] ${reason}: email NON inviata (solo loggata). Oggetto: "${input.subject}"`);
    return { sent: false, error: reason };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: CONFIG.MAIL_FROM,
        to: [input.to],
        ...(input.bcc ? { bcc: [input.bcc] } : {}),
        subject: input.subject,
        html: input.html,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const reason = `Resend ha rifiutato l'invio (HTTP ${res.status}): ${body}`;
      console.error(`[MAIL] ${reason} — oggetto: "${input.subject}"`);
      return { sent: false, error: reason };
    }
    return { sent: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[MAIL] Errore di rete nell'invio — oggetto: "${input.subject}":`, err);
    return { sent: false, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}
