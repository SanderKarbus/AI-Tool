# AI-tool arendustöö backlog ja järjestuse põhjendus

Järjekord lähtub ülesande kohustuslikust põhimõttest: esmalt peab töötama terviklik põhivoog algusest lõpuni. Seetõttu kuuluvad MVP-sse ka kliendi täpsustus ja uuendatud makett. Groomimise lisafunktsioonid tulevad pärast seda.

| Jrk | Kasutajalugu (Connextra lühivorm) | Põhikriteeriumid | MVP |
|---:|---|---|:---:|
| 1 | Projektijuhina soovin luua projekti, et kliendi idee oleks salvestatud | Projekt salvestatakse; projekt ilmub loendisse; andmed säilivad taaskäivitamisel | Jah |
| 2 | Projektijuhina soovin kirjeldada idee vabatekstina, et AI saaks protsessi käivitada | Vaba tekst võetakse vastu; vestlus salvestatakse; AI vastus valideeritakse | Jah |
| 3 | Projektijuhina soovin vastata valikvastustega täpsustustele, et nõuded muutuksid konkreetseks | AI esitab täpsustava küsimuse; kuvab valikud; lubatud on vabatekst ja vahelejätmine | Jah |
| 4 | Projektijuhina soovin valida kasutajarollid, et lood lähtuksid tegelikest kasutajatest | Rolle saab valida; lisada; eemaldada | Jah |
| 5 | Projektijuhina soovin saada vähemalt viis happy path'i lugu, et töövoog oleks terviklik | Lood on Connextra osadeks jagatud; järjestatud; vähemalt viis | Jah |
| 6 | Projektijuhina soovin valida backlog'i lisatavad lood, et otsus jääks inimesele | Saab valida lood; kinnitamata lood ei salvestu | Jah |
| 7 | Projektijuhina soovin näha AI prioriteedisoovitust, et alustada olulisest loost | AI põhjendab soovitust; kasutaja saab selle kinnitada või valida teise loo | Jah |
| 8 | Projektijuhina soovin kinnitada kriteeriumid ja maketi, et lugu oleks visuaalselt kontrollitav | Vähemalt kolm kriteeriumi; testitavuse kontroll; turvaline makett; kinnitamine inimese poolt | Jah |
| 9 | Projektijuhina soovin muuta backlog'i käsitsi, et saaksin kliendiga sisu täpsustada | Lisa/muuda/kustuta/järjesta; suurus ja staatus | Jah |
| 10 | Projektijuhina soovin määrata MVP piiri, et esimene kasutatav versioon oleks piiritletud | MVP märgistus; MVP piir kuvatakse järjekorras | Jah |
| 11 | Projektijuhina soovin kontrollida Definition of Ready tingimusi, et poolik lugu ei läheks arendusse | Connextra; vähemalt kolm testitavat kriteeriumi; vajadusel makett; avatud küsimusteta | Jah |
| 12 | Projektijuhina soovin sisestada kliendi täpsustuse ja näha muudatuse eelvaadet, et muudatused oleksid kontrollitud | Enne/pärast; muudatus puudutab ainult valitud lugu; kasutaja saab rakendada, muuta või tagasi lükata | Jah |
| 13 | Projektijuhina soovin säilitada maketi versiooniajaloo, et varasem kavand oleks taastatav | Versioonid säilivad; taastamine loob uue versiooni; varasemad versioonid jäävad alles | Jah |
| 14 | Projektijuhina soovin AI backlog'i ülevaatust, et leida kvaliteediprobleemid | Leiab puuduva kriteeriumi, maketi, suured/duplikaatsed/valesti vormistatud lood | Ei |
| 15 | Projektijuhina soovin jagamise ja ühendamise eelvaadet, et groomida backlog'i ohutult | Näitab uusi lugusid ja kriteeriumide jaotust; ühendamisel eemaldatakse kordused; algsed lood säilivad kuni kinnitamiseni | Ei |
| 16 | Projektijuhina soovin viimast muudatust tagasi võtta, et eksimusi parandada | Enne muudatust salvestatakse taastatav hetkeseis; viimane muudatus taastatakse | Ei |

## MVP piir

MVP hõlmab lugusid 1–13. See sisaldab terviklikku töövoogu: projekti loomine, juhitud vestlus, rollid, kasutajalood, prioriteet, kriteeriumid ja makett, backlog'i haldus, Definition of Ready, kliendi täpsustus ning maketi versiooniajalugu.

Groomimise laiendused (AI backlog'i ülevaatus, jagamise ja ühendamise ettepanekud ning tagasivõtmine) on järgmine etapp. Need on olulised funktsioonid, kuid ei tohi tulla enne ülesandes nõutud terviklikku põhivoogu.

## Järjestuse põhjendus

1. Lood 1–8 loovad idee põhjal valitud ja kontrollitava kasutajaloo.
2. Lood 9–11 võimaldavad backlog'i hallata ning kontrollida, kas lugu on arenduseks valmis.
3. Lood 12–13 lõpetavad ülesandes nõutud põhivoo: kliendi täpsustus muudab valitud lugu ja maketti kontrollitud viisil ning varasemad maketiversioonid säilivad.
4. Lood 14–16 lisavad groomimise ja töökindluse täiustused pärast põhivoo olemasolu.

MVP märgistus kirjeldab ülesandes nõutud esimese tervikliku kasutatava versiooni piiri, mitte üksnes tehnilist miinimumi.
