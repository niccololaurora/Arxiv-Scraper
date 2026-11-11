# quant-ph topic scanner

Interfaccia web per vedere quali paper `quant-ph` sono apparsi su arXiv
**nell'ultimo giorno, settimana o mese**, filtrati per argomento.

Uno scraper Python gira ogni giorno su GitHub Actions, scarica le submission
recenti dall'[API arXiv](https://info.arxiv.org/help/api/index.html) e pubblica
un sito statico su GitHub Pages. Nessun server, nessun database: il filtraggio
avviene interamente nel browser, quindi è istantaneo.

## Come funziona

```
scraper/fetch_arxiv.py   →  docs/data/papers.json   →  docs/ (sito statico)
   API arXiv, stdlib             ~2200 paper              vanilla JS
```

- **`scraper/fetch_arxiv.py`** — pagina l'API arXiv su una finestra di
  `submittedDate`, deduplica, e scrive un JSON compatto. Solo standard library,
  rispetta la pausa di 3 s richiesta da arXiv.
- **`docs/data/topics.json`** — la tassonomia degli argomenti: ~37 topic in 5
  gruppi, ognuno con le sue keyword. **È fatto per essere modificato a mano**
  (vedi sotto).
- **`docs/app.js`** — al caricamento calcola una volta i topic di ogni paper,
  poi ogni filtro è una lookup su insiemi.

Dettagli che vale la pena conoscere:

- La finestra temporale è calcolata **dall'ultima submission presente nei dati**,
  non dall'ora corrente: arXiv pubblica a blocchi giornalieri, quindi un "ultimo
  giorno" letterale sarebbe vuoto per gran parte della giornata.
- Il matching delle keyword tollera singolare/plurale (`surface code` trova anche
  `surface codes`) e tratta trattini e spazi come equivalenti (`non-Markovian` =
  `non Markovian`).
- La ricerca libera guarda **titolo, abstract e nomi degli autori** (quindi
  `Tomamichel` funziona come ricerca per autore). I termini sono ancorati
  all'inizio di parola ma aperti alla fine: `ion` trova `ions` e `trapped-ion`
  ma non `dimensions`, mentre digitando `entangl` i risultati si restringono
  già. Più termini si combinano in AND; le virgolette tengono insieme una frase,
  quindi `spin squeezing` (due termini) e `"spin squeezing"` (frase) danno
  risultati diversi.
- Lo stato dei filtri finisce nell'URL, quindi una vista filtrata è condivisibile:
  `?days=7&topics=qec,qml&mode=all`.

## Uso in locale

```bash
python3 scraper/fetch_arxiv.py --days 35   # genera docs/data/papers.json
python3 -m http.server 8000 --directory docs
# apri http://localhost:8000
```

Serve un server HTTP: aprendo `docs/index.html` come `file://` il browser
blocca il `fetch` dei dati.

## Deploy su GitHub Pages

Il workflow [`update-and-deploy.yml`](.github/workflows/update-and-deploy.yml)
rigenera i dati e ridistribuisce il sito ogni giorno alle 07:00 UTC (e a ogni
push su `main`).

Va abilitato una volta sola: **Settings → Pages → Source: GitHub Actions**.

> `docs/data/papers.json` è in `.gitignore` di proposito. Viene generato in CI a
> ogni deploy: committarlo significherebbe aggiungere ~4 MB alla history del
> repo ogni giorno.

## Personalizzare gli argomenti

Tutto sta in `docs/data/topics.json`:

```json
{
  "id": "qec",
  "label": "Quantum error correction",
  "keywords": ["quantum error correction", "QEC", "surface code", "decoder"]
}
```

Il sito legge questo file a ogni caricamento, quindi per aggiungere o correggere
un topic **non serve rilanciare lo scraper**: modifica, ricarica, fatto.

Due accortezze:

- evita acronimi troppo corti o ambigui (`QEC` va bene, `QC` genera falsi
  positivi a raffica);
- le keyword sono cercate su titolo + abstract, non sulle categorie arXiv.

Sull'ultima settimana di dati questa tassonomia classifica circa il 93% dei
paper; il resto sono tipicamente cross-list di matematica o hep-th.

---

Dati forniti dall'API di arXiv. Grazie ad arXiv per l'uso della sua
interoperabilità open access.
