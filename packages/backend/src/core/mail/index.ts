import { CONFIG } from '../config';

const RESEND_API_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 5000;

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

// Chiamata REST diretta a Resend (fetch nativo, Node 18+), non la libreria npm
// 'resend': una dipendenza in più per una singola POST non si giustifica (vedi
// coding-standards: nessuna nuova dipendenza senza motivazione esplicita).
//
// Non lancia MAI: un errore di invio (chiave assente, Resend giù, timeout) va
// loggato e basta, mai propagato al chiamante — requestPasswordReset in
// auth.service.ts deve rispondere identico sia che l'email parta sia che fallisca,
// altrimenti la differenza di comportamento diventerebbe un modo per indovinare
// quali indirizzi sono registrati (la stessa anti-enumerazione già applicata al
// login con l'hash fittizio in verifyCredentials).
export async function sendEmail(input: SendEmailInput): Promise<void> {
  if (!CONFIG.RESEND_API_KEY) {
    console.warn(
      `[MAIL] RESEND_API_KEY non configurata: email a ${input.to} NON inviata (solo loggata). Oggetto: "${input.subject}"`,
    );
    return;
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
        subject: input.subject,
        html: input.html,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[MAIL] Resend ha rifiutato l'invio a ${input.to} (HTTP ${res.status}): ${body}`);
    }
  } catch (err) {
    console.error(`[MAIL] Errore di rete nell'invio a ${input.to}:`, err);
  } finally {
    clearTimeout(timeout);
  }
}
