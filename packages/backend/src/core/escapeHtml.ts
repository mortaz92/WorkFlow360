// Un solo punto che sa come si neutralizza un valore prima di infilarlo in una stringa
// HTML. Serve a chi COSTRUISCE email a mano (auth.service.ts, rapportini.service.ts):
// lì il corpo del messaggio nasce da concatenazione, non da un motore di template, e
// nessuno protegge i valori interpolati al posto nostro.
//
// Il caso che lo rende necessario non è teorico: `firmatarioNome` arriva dall'endpoint
// PUBBLICO di firma del rapportino, cioè da chiunque abbia il link, e finisce dritto
// nell'email che riceve l'azienda in copia nascosta. Gli altri valori (nomi di cantiere,
// di azienda) sono scritti da utenti autenticati e il rischio è minore, ma passano di
// qui lo stesso: un'escape applicata "solo dove serve" smette di essere applicata il
// giorno in cui cambia da dove arriva il dato.
//
// L'apostrofo diventa &#39; e non &apos;: quest'ultima non è un'entità HTML4 e alcuni
// client di posta datati la mostrano letterale invece di renderla.
const ENTITA_HTML: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (carattere) => ENTITA_HTML[carattere]);
}
