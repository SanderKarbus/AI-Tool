# Parandus: AI ettepaneku rakendamine

Parandatud `ai_proposals.status` väärtused. Rakendatud ettepanek salvestatakse nüüd väärtusega `approved` (andmebaasi lubatud väärtus), mitte `applied`.

Muudatused:
- Kõik ettepanekute kinnitamise harud kasutavad nüüd `approved`.
- Värske andmebaasi skeem piirab staatuse väärtustele `pending`, `approved`, `rejected`.
- Olemasolevat andmebaasi ega kasutaja `.env` faili ei ole vaja kustutada ega uuesti luua.

## Paigaldamine
1. Peata arendusserver terminalis `Ctrl+C`.
2. Paki ZIP lahti projekti juurkausta `D:\Projects\AI-tool` ja luba olemasolevad failid asendada.
3. Käivita `npm run build`.
4. Käivita `npm run dev`.
5. Ava AI ettepanekud ja vajuta uuesti `Kinnita ja rakenda`.

Andmebaasi (`data`), `.env` ja `node_modules` kaustu see ZIP ei sisalda ega asenda.
