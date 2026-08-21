#!/usr/bin/env python3
"""Wireframe PDF WorkFlow360: sidebar a sinistra con 4 voci + 4 pagine di dettaglio.
Tutto disegnato su canvas (robusto, niente flowable sizing issues)."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.enums import TA_CENTER

OUT = "C:/Users/morta/OneDrive/Skrivbord/workflow360/wireframe-workflow360.pdf"

TEAL = colors.HexColor("#0f766e")
TEAL_D = colors.HexColor("#115e59")
LIGHT = colors.HexColor("#f1f5f9")
BORDER = colors.HexColor("#cbd5e1")
MUTED = colors.HexColor("#64748b")
WHITE = colors.white
INK = colors.HexColor("#0f172a")

styles = getSampleStyleSheet()
SMALL = ParagraphStyle("SMALL", parent=styles["Normal"], fontSize=8, textColor=MUTED, leading=10)
BODY = ParagraphStyle("BODY", parent=styles["Normal"], fontSize=8.5, textColor=INK, leading=11)
HCELL = ParagraphStyle("HCELL", parent=styles["Normal"], fontSize=8, textColor=WHITE, leading=10)

W, H = A4

def sidebar(c):
    c.setFillColor(TEAL); c.rect(0, 0, 45*mm, H, fill=1, stroke=0)
    c.setFillColor(WHITE); c.setFont("Helvetica-Bold", 13)
    c.drawString(8*mm, H-20*mm, "WorkFlow")
    c.drawString(8*mm, H-27*mm, "360")
    voci = ["1. Dashboard", "2. Cantieri", "3. Dipendenti", "4. Report"]
    y = H - 50*mm
    for v in voci:
        c.setFont("Helvetica", 9); c.setFillColor(WHITE)
        c.drawString(7*mm, y, v); y -= 12*mm
    c.setFont("Helvetica-Oblique", 7); c.setFillColor(colors.HexColor("#a7f3d0"))
    c.drawString(7*mm, 14*mm, "Azienda SRL"); c.drawString(7*mm, 10*mm, "Esci")

def header(c, title, sub):
    c.setFillColor(TEAL_D); c.rect(45*mm, H-30*mm, W-45*mm, 30*mm, fill=1, stroke=0)
    c.setFillColor(WHITE); c.setFont("Helvetica-Bold", 15)
    c.drawString(52*mm, H-19*mm, title)
    c.setFont("Helvetica", 9); c.setFillColor(colors.HexColor("#a7f3d0"))
    c.drawString(52*mm, H-25*mm, sub)

def card(c, x, y, w, h, title, lines, tcol=TEAL):
    c.setFillColor(LIGHT); c.setStrokeColor(BORDER); c.setLineWidth(1)
    c.roundRect(x, y, w, h, 4, fill=1, stroke=1)
    c.setFillColor(tcol); c.roundRect(x, y+h-9*mm, w, 9*mm, 4, fill=1, stroke=0)
    c.setFillColor(WHITE); c.setFont("Helvetica-Bold", 9)
    c.drawString(x+3*mm, y+h-6.2*mm, title)
    c.setFillColor(INK); c.setFont("Helvetica", 8.3)
    yy = y + h - 13*mm
    for ln in lines:
        c.drawString(x+3*mm, yy, ln); yy -= 4.6*mm

def table(c, x, y, colw, header, rows):
    data = [[Paragraph(f"<b>{h}</b>", HCELL) for h in header]]
    for r in rows:
        data.append([Paragraph(str(v), BODY) for v in r])
    t = Table(data, colWidths=colw)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), TEAL),
        ("GRID", (0,0), (-1,-1), 0.5, BORDER),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, LIGHT]),
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("TOPPADDING", (0,0), (-1,-1), 3), ("BOTTOMPADDING", (0,0), (-1,-1), 3),
        ("LEFTPADDING", (0,0), (-1,-1), 4),
    ]))
    tw, th = t.wrapOn(c, 1, 1)
    t.drawOn(c, x, y - th)
    return th

def p_dashboard(c):
    y = H - 40*mm
    card(c, 52*mm, y-55*mm, 62*mm, 50*mm, "Crea nuovo cantiere", [
        "Nome: [ ____________ ]",
        "Tipo: ( ) contratto  ( ) consuntivo",
        "Cliente: [ ____________ ]",
        "[ + Crea cantiere ]",
    ])
    card(c, 122*mm, y-55*mm, 62*mm, 50*mm, "Crea nuovo dipendente", [
        "Nome: [ ____________ ]",
        "Email: [ ____________ ]",
        "Ruolo: [ operaio v ]",
        "Password: [ ****** ]",
        "[ + Crea dipendente ]",
    ])
    card(c, 52*mm, y-112*mm, 132*mm, 50*mm, "Riepilogo azienda", [
        "Cantieri attivi: 4      Dipendenti: 3/3 (limite 3 admin)",
        "Ore registrate oggi: 12.5h",
        "Ultimi cantieri: C-001 Cantiere Centro, C-002 Impianto...",
        "Nota: il 4° admin viene rifiutato (409).",
    ], tcol=TEAL_D)

def p_cantieri(c):
    y = H - 40*mm
    c.setFont("Helvetica-Bold", 10); c.setFillColor(TEAL_D)
    c.drawString(52*mm, y, "Elenco cantieri con n. commessa")
    th = table(c, 52*mm, y-8*mm, [30*mm, 44*mm, 24*mm, 30*mm, 26*mm],
        ["N. Commessa", "Nome cantiere", "Tipo", "Cliente", "Stato"],
        [["C-2026-001", "Cantiere Centro", "consuntivo", "Comune XY", "in corso"],
         ["C-2026-002", "Ristrutturazione Uffici", "contratto", "Rossi Srl", "in corso"],
         ["C-2026-003", "Impianto elettrico", "consuntivo", "Verdi", "bozza"],
         ["C-2026-004", "Manutenzione ascensori", "contratto", "Condominio A", "completato"]])
    c.setFont("Helvetica", 8); c.setFillColor(MUTED)
    c.drawString(52*mm, y-8*mm-th-8*mm, "Clic su una riga -> dettaglio cantiere + lavori + ore.")

def p_dipendenti(c):
    y = H - 40*mm
    c.setFont("Helvetica-Bold", 10); c.setFillColor(TEAL_D)
    c.drawString(52*mm, y, "Elenco dipendenti (clic -> report dettagliato)")
    th = table(c, 52*mm, y-8*mm, [42*mm, 52*mm, 28*mm],
        ["Nome", "Email", "Ruolo"],
        [["Mario Operaio", "mario@azienda.it", "operaio"],
         ["Lucia Operaio", "lucia@azienda.it", "operaio"],
         ["Admin Neotekna", "admin@azienda.it", "admin"]])
    # Pannello report dettagliato a destra: per data x cantiere
    px, py, pw, ph = 138*mm, y-95*mm, 52*mm, 90*mm
    c.setFillColor(LIGHT); c.setStrokeColor(BORDER); c.setLineWidth(1)
    c.roundRect(px, py, pw, ph, 4, fill=1, stroke=1)
    c.setFillColor(TEAL_D); c.roundRect(px, py+ph-9*mm, pw, 9*mm, 4, fill=1, stroke=0)
    c.setFillColor(WHITE); c.setFont("Helvetica-Bold", 8.5)
    c.drawString(px+3*mm, py+ph-6.2*mm, "Report: Mario Operaio")
    c.setFont("Helvetica-Bold", 8); c.setFillColor(INK)
    c.drawString(px+3*mm, py+ph-14*mm, "09/08/2026  (3 cantieri)")
    # intestazione tabella interna
    c.setFont("Helvetica", 7); c.setFillColor(MUTED)
    c.drawString(px+3*mm, py+ph-18*mm, "Comm.  Cantiere        Ore")
    righe = [
        ("C-001", "Cantiere Centro", "3.5"),
        ("C-002", "Impianto elettr.", "2.0"),
        ("C-004", "Manut. ascensori", "1.5"),
    ]
    yy = py+ph-22*mm
    for comm, nom, ore in righe:
        c.setFillColor(INK); c.setFont("Helvetica", 7.5)
        c.drawString(px+3*mm, yy, f"{comm}")
        c.drawString(px+14*mm, yy, nom[:14])
        c.drawString(px+44*mm, yy, f"{ore}h")
        yy -= 4.4*mm
    c.setFont("Helvetica-Bold", 7.5); c.setFillColor(TEAL_D)
    c.drawString(px+3*mm, yy-1*mm, "Totale giornata: 7.0h")
    # seconda data
    yy2 = yy - 7*mm
    c.setFont("Helvetica-Bold", 8); c.setFillColor(INK)
    c.drawString(px+3*mm, yy2, "10/08/2026  (1 cantiere)")
    yy2 -= 4.4*mm
    c.setFillColor(INK); c.setFont("Helvetica", 7.5)
    c.drawString(px+3*mm, yy2, "C-001"); c.drawString(px+14*mm, yy2, "Cantiere Centro"); c.drawString(px+44*mm, yy2, "2.0h")
    yy2 -= 6*mm
    c.setFont("Helvetica-Bold", 7.5); c.setFillColor(TEAL_D)
    c.drawString(px+3*mm, yy2, "Totale dipendente: 9.0h")
    c.setFont("Helvetica", 8); c.setFillColor(MUTED)
    c.drawString(52*mm, y-8*mm-th-8*mm, "Clic su un dipendente -> dove ha lavorato, in quali cantieri e quante ore per ogni data.")

def p_report(c):
    y = H - 40*mm
    c.setFont("Helvetica-Bold", 10); c.setFillColor(TEAL_D)
    c.drawString(52*mm, y, "Ore totali per dipendente")
    table(c, 52*mm, y-8*mm, [34*mm, 22*mm, 16*mm, 18*mm, 16*mm, 34*mm],
        ["Dipendente", "Ore totali", "Ord.", "Straord.", "Ferie", "Commesse"],
        [["Mario Operaio", "38.5h", "30", "6.5", "2", "C-001, C-002"],
         ["Lucia Operaio", "22.0h", "20", "2", "0", "C-001"],
         ["Admin Neotekna", "0h", "-", "-", "-", "-"]])

PAGES = [p_dashboard, p_cantieri, p_dipendenti, p_report]
TITLES = [
    ("1. Dashboard", "L'azienda crea cantieri e nuovi dipendenti"),
    ("2. Cantieri", "Tutti i cantieri con il loro n. commessa"),
    ("3. Dipendenti", "Elenco dipendenti + report per data/commessa"),
    ("4. Report", "Ore totali di tutti i dipendenti"),
]

def on_page(c, doc):
    c.saveState()
    sidebar(c)
    n = doc.page
    if 1 <= n <= len(PAGES):
        header(c, *TITLES[n-1])
        PAGES[n-1](c)
    c.restoreState()

doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=45*mm, rightMargin=10*mm,
                      topMargin=30*mm, bottomMargin=10*mm,
                      title="WorkFlow360 - Wireframe", author="Hermes")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
doc.addPageTemplates([PageTemplate(id="all", frames=[frame], onPage=on_page)])
# Un flowable placeholder per pagina (spacer che riempie il frame)
from reportlab.pdfgen import canvas as canvas_mod

c = canvas_mod.Canvas(OUT, pagesize=A4)
for i, fn in enumerate(PAGES):
    if i > 0:
        c.showPage()
    sidebar(c)
    header(c, *TITLES[i])
    fn(c)
c.save()
print("PDF generato:", OUT)
