# AI-tool – juhitud tooteavastuse ja backlog'i rakendus

AI-tool aitab projektijuhil muuta kliendi vabas vormis idee juhitud AI-vestluse abil arendatavaks backlog'iks. AI juhib töövoogu ja teeb ettepanekuid; inimene valib, muudab, kinnitab või lükkab need tagasi. Kinnitamata AI-ettepanekud ei muuda backlog'i.

## Tehnoloogiad

- Node.js 24 (sisseehitatud `node:sqlite`)
- TypeScript ja Express 5
- Google Gemini (`@google/genai`)
- SQLite püsivaks salvestuseks
- Brauseri kasutajaliides HTML-i, CSS-i ja JavaScriptiga
- AI loodud maketid kuvatakse lubatud struktureeritud komponentidest; AI genereeritud suvalist HTML-i, CSS-i ega JavaScripti brauseris ei käivitata.

## Käivitamine

1. Paigalda Node.js 24.
2. Kopeeri `.env.example` failiks `.env`.
3. Lisa `.env` faili Gemini API võti: `GEMINI_API_KEY=...`.
4. Paigalda sõltuvused: `npm install`.
5. Kompileeri TypeScript: `npm run build`.
6. Käivita arendusserver: `npm run dev`.
7. Ava brauseris `http://localhost:3000`.

Tootmisrežiim:

```bash
npm run build
npm start
```

Andmebaas luuakse kausta `data/ai-tool.db`. Olemasoleva andmebaasi skeemi täiendused tehakse serveri käivitamisel migratsioonidega. Ära lisa `.env` faili ega selle sisu Git-repositooriumisse.

## Olemasoleva projekti uuendamine

Uuenduse ZIP ei sisalda kohalikku `.env` faili, `data` kausta ega `node_modules` kausta. Säilita need oma arvutis. Ära asenda andmebaasi, kui soovid olemasolevaid projektiandmeid alles hoida.

## Funktsioonid

### Projektid ja juhitud vestlus

- Projektide loomine ja projektide loendi kuvamine.
- Vestluse alustamine ühe vabas vormis idee kirjeldusega.
- AI täpsustavad küsimused koos vastusevariantide ja vabateksti võimalusega.
- Kasutajarollide pakkumine, valimine, lisamine ja eemaldamine.
- Vähemalt viie Connextra vormis kasutajaloo genereerimine happy path'i järjekorras.
- Kasutaja valib, millised lood backlog'i lisatakse.
- AI prioriteedisoovitus koos põhjendusega; kasutaja saab valida teise loo.
- AI pakub igas etapis järgmisi tegevusi.
- Vestluse ajalugu ja projekti etapp salvestatakse.

### Backlog

- Kasutajalugude käsitsi lisamine, muutmine, kustutamine ja järjestamine.
- Suuruse, staatuse, märkuste ja avatud küsimuste haldamine.
- MVP piiri määramine.
- Vastuvõtukriteeriumide lisamine, muutmine, kinnitamine ja tagasilükkamine.
- Definition of Ready kontroll: Connextra osad, vähemalt kolm sobivat kriteeriumi, testitavus, vaatega seotud loo makett ning avatud küsimuste puudumine.
- Viimase muudatuse tagasivõtmine.
- Arhiveeritud lugude taastamine ning lugude ühendamise ettepanekud.

### Maketid ja kliendi täpsustused

- AI loob valitud loole vastuvõtukriteeriumid ja struktureeritud maketi.
- Uue vaate kirjeldus võib luua ettepaneku kasutajaloo, kriteeriumide ja maketiga.
- Makett kuvatakse ainult rakenduse lubatud komponentidest.
- Maketi versiooniajalugu ja varasema versiooni taastamine uue versioonina.
- Kliendi täpsustus loob enne/pärast muudatusettepaneku.
- Muudatus rakendub alles pärast kasutaja kinnitust ning on seotud valitud looga.

### Groomimine

- AI analüüsib andmebaasis olevat tegelikku backlog'i.
- Ülevaatus otsib puuduvaid või testimatuid kriteeriume, puuduvaid makette, liiga suuri lugusid, võimalikke duplikaate ja vigast Connextra vormi.
- Jagamise ja ühendamise ettepanekud kuvatakse eelvaatena.
- Ettepanekut saab muuta, kinnitada või ignoreerida.
- AI ülevaatus ei muuda backlog'i enne inimese kinnitust.

## API põhilõiked

- `GET /api/health` – serveri tervisekontroll.
- `GET /api/projects`, `POST /api/projects`, `GET /api/projects/:projectId` – projektide loend, loomine ja avamine.
- `GET /api/projects/:projectId/conversation`, `PATCH /api/projects/:projectId/stage` – vestluse ja etapi laadimine/uuendamine.
- `POST /api/projects/:projectId/chat/start`, `POST /api/conversations/:conversationId/chat` – juhitud AI-vestlus.
- `POST /api/conversations/:conversationId/roles/confirm`, `POST /api/conversations/:conversationId/stories/confirm`, `POST /api/conversations/:conversationId/priority/confirm`, `POST /api/conversations/:conversationId/criteria-mockup/confirm` – vestluse ettepanekute kinnitamine.
- `GET /api/projects/:projectId/backlog`, `POST /api/projects/:projectId/stories`, `PATCH /api/projects/:projectId/stories/:storyId`, `DELETE /api/projects/:projectId/stories/:storyId` – backlog'i lugude pärimine ja haldus.
- `PATCH /api/projects/:projectId/backlog/reorder`, `PATCH /api/projects/:projectId/stories/:storyId/mvp` – järjestamine ja MVP piir.
- `GET /api/projects/:projectId/stories/:storyId/ready-check`, `PATCH /api/projects/:projectId/stories/:storyId/status` – Definition of Ready ja staatuse muutmine.
- `GET /api/projects/:projectId/archived-stories`, `POST /api/projects/:projectId/stories/:storyId/restore` – arhiveeritud lugude vaatamine ja taastamine.
- `POST /api/projects/:projectId/backlog/review`, `GET /api/projects/:projectId/proposals`, `PATCH /api/projects/:projectId/proposals/:proposalId` – AI ülevaatus ja ettepanekute haldus.
- `POST /api/projects/:projectId/stories/:storyId/refinement`, `POST /api/projects/:projectId/prototype`, `POST /api/projects/:projectId/stories/:storyId/split-proposal`, `POST /api/projects/:projectId/merge-proposal` – täpsustuse, prototüübi, jagamise ja ühendamise ettepanekud.
- `PATCH /api/stories/:storyId/criteria/:criterionId`, `POST /api/projects/:projectId/stories/:storyId/criteria` – vastuvõtukriteeriumide haldus.
- `GET /api/stories/:storyId/mockup-versions`, `POST /api/projects/:projectId/stories/:storyId/mockup-restore` – maketi versiooniajalugu ja taastamine.
- `GET /api/projects/:projectId/undo/latest`, `POST /api/projects/:projectId/stories/:storyId/undo` – viimase muudatuse tagasivõtmine.

## Testimise seis

- **Andmete püsivus:** kasutaja on kontrollinud, et projektiandmed säilivad serveri korduvate taaskäivitamiste järel.
- **Rakenduse kasutusvoog:** juhitud vestlust, backlog'i, makette, kriteeriume ja AI ettepanekuid on käsitsi läbi proovitud.
- **AI teenuse kättesaadavus:** Gemini võib ajutiselt vastata veaga `503 UNAVAILABLE` suure koormuse ajal. Sellisel juhul võib sama toimingu mõne aja pärast uuesti käivitada.
- **Ühendamise ja arhiveerimise voog:** seda on testimise käigus eraldi kontrollitud; AI teenuse ajutist tõrget ei tohi käsitleda rakenduse andmekao või püsivusveana.

Enne esitamist tuleb teha lõplik vastuvõtukatse allpool kirjeldatud demonstratsioonivoo järgi ning kontrollida, et kasutatav lähtekood vastab repositooriumisse lisatavale versioonile.

## Teadaolevad piirangud

- AI ettepanekute kvaliteet sõltub sisendi detailsusest ja Gemini teenuse vastustest.
- Gemini teenus võib ajutiselt olla ülekoormatud (`503 UNAVAILABLE`).
- Kriteeriumide testitavuse kontroll on osaliselt reeglipõhine ega asenda analüütiku otsust.
- Vaatega seotud loo tuvastamine kasutab lihtsustatud loogikat.
- Makett on wireframe-taseme struktuurne prototüüp, mitte lõplik visuaalne disain.
- Rakendusel puudub kasutajakontode ja mitme kasutaja õiguste haldus; see on lokaalse demonstratsiooni tööriist.

## Demonstratsiooni soovituslik käik (5–10 min)

1. Loo uus projekt ja sisesta üks umbmäärane idee.
2. Vasta AI täpsustavale küsimusele, vali rollid ja lisa pakutud lood.
3. Vaata AI prioriteedisoovitust ning kinnita või vali teine lugu.
4. Genereeri valitud loole vastuvõtukriteeriumid ja makett; kinnita osa kriteeriume, lükka üks tagasi ning muuda üht.
5. Sisesta kliendi täpsustus, vaata enne/pärast ettepanekut ja rakenda see ainult valitud loole.
6. Ava backlog, muuda järjekorda ja määra MVP piir.
7. Käivita AI backlog'i ülevaatus ning näita üht jagamise või ühendamise ettepanekut eelvaates.
8. Näita Definition of Ready kontrolli ja maketi versiooniajalugu.
9. Taaskäivita server või ava projekt uuesti ning näita, et andmed on alles.

## Git ja esitamine

Lähtekood tuleb esitada Git-repositooriumis sisulise commit'ide ajalooga. Soovitatav on teha eraldi commit'id vähemalt järgmiste tööetappide kohta:

1. projekti algstruktuur ja serveri/andmebaasi alus;
2. juhitud vestlus, rollid ja kasutajalugude genereerimine;
3. backlog'i haldus ja Definition of Ready;
4. kriteeriumid, maketid ja versiooniajalugu;
5. kliendi täpsustused ja muudatusettepanekud;
6. AI groomimine, lugude jagamine ja ühendamine;
7. dokumentatsioon, testiparandused ja lõplik viimistlus.

Ära tee tagantjärele väljamõeldud commit'e ega lisa `.env` faili, API võtit, `node_modules` või lokaalset andmebaasi repositooriumisse.
