
import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { z } from 'zod';

const ai = new GoogleGenAI({
  apiKey: env.GEMINI_API_KEY
});

const storySchema = z.object({
  role: z.string(),
  action: z.string(),
  benefit: z.string(),
  position: z.number().int().positive()
});

const criterionSchema = z.object({
  description: z.string(),
  isTestable: z.boolean(),
  warning: z.string().nullable()
});

const mockupComponentSchema = z.object({
  id: z.string(),
  type: z.enum([
    'heading',
    'text',
    'button',
    'input',
    'card',
    'list',
    'progress',
    'navigation'
  ]),
  label: z.string(),
  content: z.string(),
  actions: z.array(z.string())
});

const mockupSchema = z.object({
  title: z.string(),
  purpose: z.string(),
  components: z.array(mockupComponentSchema).min(1),
  primaryAction: z.string()
});

const replySchema = z.object({
  stage: z.enum([
    'clarification',
    'roles',
    'stories',
    'priority',
    'criteria_mockup',
    'refinement',
    'grooming'
  ]),
  message: z.string(),
  question: z.string().nullable(),
  options: z.array(
    z.object({
      label: z.string(),
      value: z.string()
    })
  ),
  multiSelect: z.boolean(),
  roles: z.array(
    z.object({
      name: z.string(),
      description: z.string()
    })
  ).optional(),
  stories: z.array(storySchema).optional(),
  priorityStory: storySchema.optional(),
  acceptanceCriteria: z.array(criterionSchema).optional(),
  mockup: mockupSchema.optional(),
  nextActions: z.array(
    z.object({
      label: z.string(),
      action: z.string()
    })
  ).min(1).max(4)
});

export type AIReply = z.infer<typeof replySchema>;

type HistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

// Otsib vestluse ajaloost kinnitatud kasutajalood.
function getConfirmedStories(
  history: HistoryMessage[]
): z.infer<typeof storySchema>[] | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];

    if (item.role !== 'user') {
      continue;
    }

    try {
      const data = JSON.parse(item.content);

      if (
        data?.type === 'stories_confirmed' &&
        Array.isArray(data.stories)
      ) {
        return z.array(storySchema).parse(data.stories);
      }
    } catch {
      // Tavaline tekstsõnum ei ole kinnitamise sündmus.
    }
  }

  return null;
}

// Otsib vestluse ajaloost kinnitatud kasutajarollid.
function getConfirmedRoles(
  history: HistoryMessage[]
): Array<{ name: string; description: string }> | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];

    if (item.role !== 'user') {
      continue;
    }

    try {
      const data = JSON.parse(item.content);

      if (
        data?.type === 'roles_confirmed' &&
        Array.isArray(data.roles)
      ) {
        return z.array(
          z.object({
            name: z.string(),
            description: z.string()
          })
        ).parse(data.roles);
      }
    } catch {
      // Tavaline tekstsõnum ei ole kinnitamise sündmus.
    }
  }

  return null;
}

// Otsib vestluse ajaloost kinnitatud prioriteetse kasutajaloo.
function getConfirmedPriority(
  history: HistoryMessage[]
): z.infer<typeof storySchema> | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];

    if (item.role !== 'user') {
      continue;
    }

    try {
      const data = JSON.parse(item.content);

      if (
        data?.type === 'priority_confirmed' &&
        data.priorityStory
      ) {
        return storySchema.parse(data.priorityStory);
      }
    } catch {
      // Tavaline tekstsõnum ei ole kinnitamise sündmus.
    }
  }

  return null;
}


function getLatestConfirmationType(history: HistoryMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.role !== 'user') continue;
    try {
      const data = JSON.parse(item.content);
      if (typeof data?.type === 'string' && data.type.endsWith('_confirmed')) return data.type;
    } catch { /* regular user message */ }
  }
  return null;
}

// Gemini vastuse küsimine ja valideerimine.
async function generateAIReply(prompt: string): Promise<AIReply> {
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      maxOutputTokens: 6000
    }
  });

  const raw = response.text;
  if (!raw) throw new Error('Gemini returned an empty response');
  try {
    return replySchema.parse(JSON.parse(raw));
  } catch (firstError) {
    const retry = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: `${prompt}\n\nEelmine vastus oli vigase JSON-i või skeemiga. Genereeri uuesti kogu vastus rangelt nõutud JSON-skeemi järgi. Ära lisa markdowni.`,
      config: { responseMimeType: 'application/json', maxOutputTokens: 6000 }
    });
    if (!retry.text) throw firstError;
    return replySchema.parse(JSON.parse(retry.text));
  }
}

// Vestluse käivitamine.
export async function startAIConversation(
  projectName: string,
  description: string
): Promise<AIReply> {
  const prompt = `
Sa oled AI projektijuht, kes aitab kliendil muuta
mistahes tarkvaraidee arendatavaks projektiks.

Projekti nimi: ${projectName}

Kliendi idee:
${description}

Sinu ülesanne:
1. Mõista kliendi tegelikku vajadust.
2. Ära eelda, et tegemist on kindla valdkonnaga.
3. Kui kirjeldus on umbmäärane, esita 1-3 täpsustavat küsimust.
4. Esita korraga üks küsimus.
5. Paku küsimusele konkreetsed vastusevariandid.
6. Lisa alati valikud "Muu (kirjutan ise)" ja "Jäta vahele".
7. Ära genereeri kasutajalugusid enne, kui vajalik info on kogutud.

Väljasta korrektne JSON järgmise struktuuriga:
{
  "stage": "clarification",
  "message": "Sinu vestlussõnum",
  "question": "Täpsustav küsimus või null",
  "options": [
    {"label": "Variant 1", "value": "variant1"},
    {"label": "Muu (kirjutan ise)", "value": "other"},
    {"label": "Jäta vahele", "value": "skip"}
  ],
  "multiSelect": false,
  "nextActions": [
    {"label": "Edasi", "action": "continue"}
  ]
}

Vasta ainult korrektse JSON-iga.
`;

  return generateAIReply(prompt);
}

// Vestluse jätkamine.
export async function continueAIConversation(
  projectName: string,
  history: HistoryMessage[],
  backlogContext: unknown = []
): Promise<AIReply> {
  const confirmedStories = getConfirmedStories(history);
  const confirmedRoles = getConfirmedRoles(history);
  const confirmedPriority = getConfirmedPriority(history);
  const latestConfirmation = getLatestConfirmationType(history);
  const criteriaMockupConfirmed = latestConfirmation === 'criteria_mockup_confirmed';

  if (criteriaMockupConfirmed) {
    const prompt = `
Sa oled AI projektijuht. Kasutaja on valitud kasutajaloole juba kinnitanud vastuvõtukriteeriumid ja maketi.
Ära genereeri neid uuesti ega muuda backlog'i ise.
Projekti nimi: ${projectName}
Tegelik backlog: ${JSON.stringify(backlogContext)}
Vestluse ajalugu: ${JSON.stringify(history)}
Vasta stage="refinement" või "grooming" vastavalt kasutaja viimasele sõnumile.
Kui kasutaja annab kliendi täpsustuse, selgita, et lood eelvaate ainult valitud loole ning paku tegevuseks "open_refinement".
Kui kasutaja soovib backlog'i üle vaadata, paku tegevuseks "review_backlog".
Paku alati 1-4 konkreetset nextActions valikut.
Vasta ainult replySchema JSON struktuuris.
`;
    return generateAIReply(prompt);
  }

  // Kui prioriteet on kinnitatud, genereerime kriteeriumid ja maketi.
  if (confirmedPriority) {
    const prompt = `
Sa oled AI projektijuht ja prototüüpimise ekspert.

Projekti nimi:
${projectName}

Projekti tegelik backlog (andmebaasist; käsitle seda tõeallikana):
${JSON.stringify(backlogContext, null, 2)}

Kasutaja on kinnitanud järgmise prioriteetse kasutajaloo:

${JSON.stringify(confirmedPriority, null, 2)}

Sinu ülesanne:

OSA 1. VASTUVÕTUKRITEERIUMID

1. Genereeri sellele kasutajaloole vähemalt viis vastuvõtukriteeriumi.
2. Iga kriteerium peab sisaldama ainult ühte lihtsat tingimust.
3. Iga tingimust peab saama kontrollida vastusega jah või ei.
4. Kriteerium peab olema konkreetne ja mõõdetav.
5. Väldi hinnangulisi sõnu nagu:
   kasutajasõbralik, kiire, lihtne, mugav, intuitiivne ja selge.
6. Ära ühenda ühte kriteeriumi mitut tingimust.
7. Kontrolli iga kriteerium ise üle.
8. Kui kriteerium ei ole kontrollitav, määra isTestable väärtuseks false
   ja lisa warning väljale põhjendus.
9. Kontrollitava kriteeriumi korral määra isTestable väärtuseks true
   ja warning väärtuseks null.

OSA 2. MOCKUP

1. Loo sama kasutajaloo jaoks lihtne wireframe-makett.
2. Makett peab näitama vaate sisu, paigutust ja kasutaja tegevusi.
3. Kasuta ainult struktureeritud komponente.
4. Ära väljasta HTML-i, JavaScripti, CSS-i ega käivitatavat koodi.
5. Kasuta komponentide tüüpe:
   heading, text, button, input, card, list, progress, navigation.
6. Igal komponendil peab olema id, type, label, content ja actions.
7. Makett peab vastama valitud kasutajaloole.
8. Iga vaadet puudutav vastuvõtukriteerium peab olema maketis nähtav.
9. Ära lisa funktsioone, mis ei ole kasutajalooga seotud.

Väljasta stage väärtusega "criteria_mockup".

Väljundi struktuur:
{
  "stage": "criteria_mockup",
  "message": "Tutvusta kasutajale loodud vastuvõtukriteeriume ja maketti.",
  "question": null,
  "options": [],
  "multiSelect": false,
  "priorityStory": {
    "role": "Kinnitatud roll",
    "action": "Kinnitatud tegevus",
    "benefit": "Kinnitatud kasu",
    "position": 1
  },
  "acceptanceCriteria": [
    {
      "description": "Üks kontrollitav tingimus.",
      "isTestable": true,
      "warning": null
    }
  ],
  "mockup": {
    "title": "Vaate pealkiri",
    "purpose": "Vaate eesmärk",
    "components": [
      {
        "id": "component-1",
        "type": "heading",
        "label": "Pealkiri",
        "content": "Vaate pealkiri",
        "actions": []
      },
      {
        "id": "component-2",
        "type": "button",
        "label": "Loo projekt",
        "content": "Loo projekt",
        "actions": ["Projekti loomine"]
      }
    ],
    "primaryAction": "Peamine kasutaja tegevus"
  },
  "nextActions": [
    {
      "label": "Kinnita kriteeriumid ja makett",
      "action": "confirm_criteria_mockup"
    },
    {
      "label": "Muuda ettepanekut",
      "action": "edit_criteria_mockup"
    }
  ]
}

priorityStory peab vastama täpselt kasutaja kinnitatud loole.
Väljasta vähemalt viis vastuvõtukriteeriumi.
Vasta ainult korrektse JSON-iga.
`;

    return generateAIReply(prompt);
  }

  // Kui kasutajalood on kinnitatud, soovitame prioriteeti.
  if (confirmedStories && confirmedStories.length > 0) {
    const prompt = `
Sa oled AI projektijuht.

Projekti nimi:
${projectName}

Projekti tegelik backlog (andmebaasist; käsitle seda tõeallikana):
${JSON.stringify(backlogContext, null, 2)}

Kinnitatud kasutajalood:
${JSON.stringify(confirmedStories, null, 2)}

Sinu ülesanne:
1. Analüüsi ainult neid kasutajalugusid.
2. Vali nende hulgast kõige olulisem kasutajalugu.
3. Lähtu valikul projekti põhifunktsionaalsusest ja kasutaja peamisest eesmärgist.
4. Ära mõtle välja uut kasutajalugu.
5. Ära muuda valitud kasutajaloo välju.
6. Põhjenda selgelt, miks see kasutajalugu on kõige olulisem.
7. Väljasta stage väärtusega "priority".
8. Väljasta valitud kasutajalugu eraldi priorityStory väljal.
9. Ära esita täpsustavaid küsimusi.
10. Paku kasutajale võimalust prioriteet kinnitada.

Väljundi struktuur:
{
  "stage": "priority",
  "message": "Valitud kasutajaloo põhjendus.",
  "question": null,
  "options": [],
  "multiSelect": false,
  "priorityStory": {
    "role": "Täpselt backlog'is oleva loo roll",
    "action": "Täpselt backlog'is oleva loo tegevus",
    "benefit": "Täpselt backlog'is oleva loo kasu",
    "position": 1
  },
  "nextActions": [
    {
      "label": "Kinnita prioriteet",
      "action": "confirm_priority"
    }
  ]
}

priorityStory peab olema üks täpsetest kinnitatud kasutajaluguest.
Vasta ainult korrektse JSON-iga.
`;

    return generateAIReply(prompt);
  }

  // Kui rollid on kinnitatud, genereerime kasutajalood.
  if (confirmedRoles && confirmedRoles.length > 0) {
    const prompt = `
Sa oled AI projektijuht.

Projekti nimi:
${projectName}

Projekti tegelik backlog (andmebaasist; käsitle seda tõeallikana):
${JSON.stringify(backlogContext, null, 2)}

Vestluse ajalugu:
${JSON.stringify(history, null, 2)}

Kinnitatud kasutajarollid:
${JSON.stringify(confirmedRoles, null, 2)}

Sinu ülesanne:
1. Kasuta ainult kasutaja kinnitatud rolle.
2. Genereeri vähemalt viis projekti eesmärgiga seotud kasutajalugu.
3. Kasuta Connextra vormingut:
   "As a [role], I want [action], so that [benefit]."
4. Hoia role, action ja benefit eraldi väljadel.
5. Järjesta lood happy path'i järgi.
6. Alusta kasutaja peamisest eesmärgist ja liigu selle saavutamiseks vajalike tegevuste kaudu.
7. Määra position väärtused alates ühest.
8. Ära küsi täiendavaid küsimusi.
9. Kasutajalugude etapis kasuta stage väärtust "stories".
10. Paku kasutajale võimalust lood kinnitada.

Väljundi struktuur:
{
  "stage": "stories",
  "message": "Kasutajalugude tutvustus",
  "question": null,
  "options": [],
  "multiSelect": false,
  "roles": ${JSON.stringify(confirmedRoles)},
  "stories": [
    {
      "role": "Kinnitatud kasutajaroll",
      "action": "soovin teha midagi",
      "benefit": "saaksin sellest kasu",
      "position": 1
    }
  ],
  "nextActions": [
    {
      "label": "Kinnita kasutajalood",
      "action": "confirm_stories"
    }
  ]
}

Väljasta vähemalt viis kasutajalugu.
Vasta ainult korrektse JSON-iga.
`;

    return generateAIReply(prompt);
  }

  // Kui kinnitamise sündmusi pole, jätkame tavapärast analüüsi.
  const prompt = `
Sa oled AI projektijuht, kes aitab kliendil muuta tarkvaraidee arendatavaks projektiks.

Projekti nimi:
${projectName}

Projekti tegelik backlog (andmebaasist; käsitle seda tõeallikana):
${JSON.stringify(backlogContext, null, 2)}

Senine vestlus:
${JSON.stringify(history, null, 2)}

Sinu ülesanne:
1. Arvesta kogu senise vestlusega.
2. Ära küsi uuesti küsimusi, millele klient on juba vastanud.
3. Kui vajalik info pole kogutud, esita järgmine täpsustav küsimus.
4. Esita korraga ainult üks küsimus.
5. Paku küsimusele konkreetsed vastusevariandid.
6. Lisa alati valikud "Muu (kirjutan ise)" ja "Jäta vahele".
7. Kui vajalik info on kogutud, paku sobivad kasutajarollid.
8. Kasutajarollide etapis kasuta stage väärtust "roles".
9. Iga roll peab sisaldama name ja description välju.
10. Ära genereeri kasutajalugusid enne, kui kasutajarollid on kinnitatud.

Kui kasutad etappi clarification, lisa küsimus ja vastusevariandid.
Kui kasutad etappi roles, väljasta rollid ning paku nende kinnitamist.

Vasta ainult korrektse JSON-iga.
`;

  return generateAIReply(prompt);
}

// Backlog'i terviklik ülevaatus. Tagastab ainult ettepanekud; andmeid ei muuda.
const backlogFindingSchema = z.object({
  storyId: z.string().uuid(),
  category: z.enum([
    'too_large',
    'duplicate',
    'missing_criteria',
    'untestable_criteria',
    'missing_mockup',
    'invalid_connextra'
  ]),
  severity: z.enum(['low', 'medium', 'high']),
  problem: z.string().min(1).max(1000),
  rationale: z.string().min(1).max(1500),
  suggestion: z.string().min(1).max(1500),
  changes: z.object({
    role: z.string().min(1).max(150).optional(),
    action: z.string().min(1).max(1000).optional(),
    benefit: z.string().min(1).max(1000).optional(),
    size: z.enum(['S', 'M', 'L']).nullable().optional(),
    acceptanceCriteria: z.array(z.object({
      description: z.string().min(1).max(1000),
      isTestable: z.boolean(),
      warning: z.string().max(500).nullable()
    })).max(20).optional(),
    newStories: z.array(z.object({
      role: z.string().min(1).max(150),
      action: z.string().min(1).max(1000),
      benefit: z.string().min(1).max(1000),
      criteria: z.array(z.string().max(1000)).max(20).optional()
    })).min(2).max(5).optional(),
    mergeStoryIds: z.array(z.string().uuid()).min(2).max(5).optional(),
    newStory: z.object({
      role: z.string().min(1).max(150),
      action: z.string().min(1).max(1000),
      benefit: z.string().min(1).max(1000)
    }).optional(),
    mockup: z.object({
      title: z.string().min(1).max(200),
      purpose: z.string().min(1).max(1000),
      components: z.array(z.object({
        id: z.string().min(1).max(100),
        type: z.enum(['heading', 'text', 'button', 'input', 'card', 'list', 'progress', 'navigation']),
        label: z.string().max(200),
        content: z.string().max(1000),
        actions: z.array(z.string().max(200)).max(20)
      })).min(1).max(50),
      primaryAction: z.string().max(200).nullable().optional()
    }).optional()
  }).optional()
});

const backlogReviewSchema = z.object({
  summary: z.string().min(1).max(2000),
  findings: z.array(backlogFindingSchema).max(100)
});

export type BacklogReview = z.infer<typeof backlogReviewSchema>;

export async function reviewProjectBacklog(
  projectName: string,
  backlog: unknown
): Promise<BacklogReview> {
  const prompt = `
Sa oled kogenud ärianalüütik ja agiilse arenduse backlog'i ülevaataja.
Analüüsi allpool olevat projekti tegelikku backlog'i. Ära muuda andmeid.
Leia ainult põhjendatud probleemid järgmistest kategooriatest:
- too_large: kasutajalugu sisaldab mitut eraldiseisvat tegevust või rolli;
- duplicate: kaks lugu kirjeldavad sisuliselt sama tulemust;
- missing_criteria: puuduvad või alla kolme vastuvõtukriteeriumi;
- untestable_criteria: kriteeriumid on subjektiivsed, mitme tingimusega või jah/ei kontrollita;
- missing_mockup: vaate/ekraani/vormi/kuvamisega seotud lool puudub makett;
- invalid_connextra: roll, tegevus või kasu on puudu või halvasti sõnastatud.

Iga leid peab viitama olemasoleva loo täpsele storyId-le. Ära mõtle ID-sid välja.
Paku changes ainult siis, kui saad teha konkreetse ja ohutu paranduse.
Kui too_large, paku changes.newStories: jaga lugu 2-4 eraldi Connextra looks ja jaga olemasolevad kriteeriumid sobivate lugude vahel.
Kui duplicate, paku changes.mergeStoryIds ainult siis, kui leiad backlog'ist teise päriselt kattuva loo; lisa changes.newStory ühendatud loo Connextra väljadega.
Kriteerium peab sisaldama ühte lihtsat jah/ei tingimust.
Kui kategooria on missing_mockup, lisa changes.mockup: loo selle kasutajaloo jaoks konkreetne
struktureeritud wireframe. Kasuta ainult komponente heading, text, button, input, card,
list, progress, navigation. Ära lisa HTML-i, JavaScripti ega CSS-i.
Makett peab vastama ainult selle kasutajaloo tegevusele ja kasule.
Muude kategooriate puhul ära lisa mockup'i.
Ära loo dubleerivaid ega spekulatiivseid leide. Kui probleemi pole, tagasta tühi findings.

Projekti nimi: ${projectName}
Backlog JSON:
${JSON.stringify(backlog)}

Tagasta ainult JSON kujul:
{
  "summary": "Lühike kokkuvõte",
  "findings": [{
    "storyId": "olemasolev UUID",
    "category": "too_large|duplicate|missing_criteria|untestable_criteria|missing_mockup|invalid_connextra",
    "severity": "low|medium|high",
    "problem": "Probleem",
    "rationale": "Põhjendus",
    "suggestion": "Konkreetne soovitus",
    "changes": {
      "role": "valikuline",
      "action": "valikuline",
      "benefit": "valikuline",
      "size": "S|M|L|null",
      "acceptanceCriteria": [{"description":"...","isTestable":true,"warning":null}],
      "newStories": [{"role":"...","action":"...","benefit":"...","criteria":["..."]}],
      "mergeStoryIds": ["olemasolev-uuid-1","olemasolev-uuid-2"],
      "newStory": {"role":"...","action":"...","benefit":"..."},
      "mockup": {
        "title": "Vaate nimi",
        "purpose": "Vaate eesmärk",
        "components": [{"id":"component-1","type":"heading","label":"Pealkiri","content":"...","actions":[]}],
        "primaryAction": "Põhitegevus"
      }
    }
  }]
}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt,
    config: { responseMimeType: 'application/json', maxOutputTokens: 8000 }
  });
  if (!response.text) throw new Error('Gemini returned an empty backlog review');
  let parsed: BacklogReview;
  try {
    parsed = backlogReviewSchema.parse(JSON.parse(response.text));
  } catch (firstError) {
    const retry = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: `${prompt}\n\nEelmine vastus ei vastanud skeemile. Genereeri kogu backlog'i analüüs uuesti korrektse JSON-ina, kasuta ainult olemasolevaid storyId väärtusi.`,
      config: { responseMimeType: 'application/json', maxOutputTokens: 8000 }
    });
    if (!retry.text) throw firstError;
    parsed = backlogReviewSchema.parse(JSON.parse(retry.text));
  }
  const allowedIds = new Set(
    (backlog as Array<{ id: string }>).map(story => story.id)
  );

  if (parsed.findings.some(finding =>
    !allowedIds.has(finding.storyId) ||
    (finding.changes?.mergeStoryIds ?? []).some(id => !allowedIds.has(id))
  )) {
    throw new Error('AI backlog review referenced an unknown story ID');
  }

  return parsed;
}


const refinementSchema = z.object({
  summary: z.string().min(1).max(1500),
  changes: z.object({
    role: z.string().min(1).max(150).optional(),
    action: z.string().min(1).max(1000).optional(),
    benefit: z.string().min(1).max(1000).optional(),
    acceptanceCriteria: z.array(criterionSchema).max(20).optional(),
    mockup: mockupSchema.optional(),
    openQuestions: z.array(z.string().max(1000)).max(30).optional()
  })
});

export type StoryRefinement = z.infer<typeof refinementSchema>;

export async function proposeStoryRefinement(
  projectName: string,
  story: { role: string; action: string; benefit: string },
  criteria: Array<{ description: string; status: string }>,
  mockup: unknown,
  clarification: string
): Promise<StoryRefinement> {
  const prompt = `
Sa oled tootejuht ja UX prototüüpimise ekspert.
Projekti nimi: ${projectName}
Valitud kasutajalugu:
${JSON.stringify(story)}
Olemasolevad vastuvõtukriteeriumid:
${JSON.stringify(criteria)}
Praegune mockup:
${JSON.stringify(mockup)}
Kliendi täpsustus:
${clarification}

Koosta ainult selle ühe kasutajaloo muudatusettepanek.
Ära muuda ega maini teiste lugude muutmist.
Tagasta muudatused ainult siis, kui need tulenevad täpsustusest.
Kriteeriumid peavad olema üksikud jah/ei tingimused ja mockup peab neid vaatega seotud osas kajastama.
Mockup kasutab ainult turvalisi struktureeritud komponente: heading, text, button, input, card, list, progress, navigation.
Ära väljasta HTML-i, CSS-i ega JavaScripti.
Tagasta JSON:
{
 "summary":"Muudatuse selgitus",
 "changes":{
   "role":"valikuline uus roll",
   "action":"valikuline uus tegevus",
   "benefit":"valikuline uus kasu",
   "acceptanceCriteria":[{"description":"üks jah/ei tingimus","isTestable":true,"warning":null}],
   "mockup":{"title":"...","purpose":"...","components":[{"id":"c1","type":"heading","label":"...","content":"...","actions":[]}],"primaryAction":"..."},
   "openQuestions":[]
 }
}
Väljasta ainult JSON. Ära väljasta tühje välju.
`;
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt,
    config: { responseMimeType: 'application/json', maxOutputTokens: 7000 }
  });
  if (!response.text) throw new Error('AI ei tagastanud muudatusettepanekut.');
  return refinementSchema.parse(JSON.parse(response.text));
}


const prototypeSchema = z.object({
  story: storySchema,
  acceptanceCriteria: z.array(criterionSchema).min(3).max(20),
  mockup: mockupSchema,
  explanation: z.string().min(1).max(1500)
});

export async function generatePrototypeFromPrompt(
  projectName: string,
  promptText: string,
  roles: string[]
): Promise<z.infer<typeof prototypeSchema>> {
  const prompt = `
Sa oled tootejuht ja prototüüpimise ekspert. Koosta kasutaja kirjeldatud uue vaate põhjal üks kasutajalugu, vähemalt 3 vastuvõtukriteeriumi ja struktureeritud wireframe.
Projekt: ${projectName}
Olemasolevad rollid: ${JSON.stringify(roles)}
Vaate kirjeldus: ${promptText}
Kasutajalugu peab olema Connextra osadeks role/action/benefit.
Kriteeriumid: üks tingimus igaühes, jah/ei kontrollitavad. Märgi isTestable false ja warning kui subjektiivne või mitu tingimust.
Mockup komponentide tüübid ainult heading,text,button,input,card,list,progress,navigation. Iga vaatega seotud kriteerium peab maketis nähtav olema.
Ära väljasta HTML/CSS/JS-i.
Tagasta JSON kujul:
{"story":{"role":"...","action":"...","benefit":"...","position":1},
"acceptanceCriteria":[{"description":"...","isTestable":true,"warning":null}],
"mockup":{"title":"...","purpose":"...","components":[{"id":"c1","type":"heading","label":"...","content":"...","actions":[]}],"primaryAction":"..."},
"explanation":"..."}
Ainult JSON.
`;
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt,
    config: { responseMimeType: 'application/json', maxOutputTokens: 7000 }
  });
  if (!response.text) throw new Error('AI ei tagastanud prototüüpi.');
  return prototypeSchema.parse(JSON.parse(response.text));
}


const splitStoriesSchema = z.object({
  rationale: z.string().min(1).max(1500),
  stories: z.array(z.object({
    role: z.string().trim().min(1).max(150),
    action: z.string().trim().min(1).max(1000),
    benefit: z.string().trim().min(1).max(1000),
    criteria: z.array(z.string().trim().min(1).max(1000)).min(3).max(12)
  })).min(2).max(5)
});

export async function proposeStorySplit(
  projectName: string,
  story: { role: string; action: string; benefit: string },
  criteria: Array<{ description: string; status: string }>,
  notes: string | null
): Promise<z.infer<typeof splitStoriesSchema>> {
  const prompt = `
Sa oled kogenud ärianalüütik ja agiilse tarkvaraarenduse tootejuht.
Projekti nimi: ${projectName}
Algne kasutajalugu (Connextra): ${JSON.stringify(story)}
Olemasolevad vastuvõtukriteeriumid: ${JSON.stringify(criteria)}
Lisamärkused: ${notes ?? ''}

Jaga kasutajalugu 2–5 väiksemaks, iseseisvaks ja väärtust loovaks kasutajalooks.
Ära jaga lihtsalt tehnilisteks alamülesanneteks. Iga uus lugu peab andma kasutajale eraldi kasutatava tulemuse ning olema võimalikult väike.
Säilita algse loo eesmärk ja ära lisa nõudeid, mida lähteandmed ei toeta.
Kasuta sama rolli, kui eraldi rolli pole põhjust muuta.
Iga loo kohta esita Connextra väljad role, action, benefit ning vähemalt 3 konkreetset, ühe tingimusega ja jah/ei kontrollitavat vastuvõtukriteeriumi.
Ära kasuta hinnangulisi sõnu nagu kiire, lihtne, mugav, intuitiivne või kasutajasõbralik.
Tagasta JSON kujul:
{"rationale":"lühike selgitus jagamise põhjenduse kohta","stories":[{"role":"...","action":"...","benefit":"...","criteria":["...","...","..."]}]}
Väljasta ainult JSON, ilma markdowni koodiplokita.
`;
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt,
    config: { responseMimeType: 'application/json', maxOutputTokens: 7000 }
  });
  if (!response.text) throw new Error('AI ei tagastanud jagamise ettepanekut.');
  return splitStoriesSchema.parse(JSON.parse(response.text));
}


const mergeStoriesSchema = z.object({
  rationale: z.string().trim().min(1).max(1500),
  story: z.object({
    role: z.string().trim().min(1).max(150),
    action: z.string().trim().min(1).max(1000),
    benefit: z.string().trim().min(1).max(1000)
  }),
  criteria: z.array(z.string().trim().min(1).max(1000)).min(3).max(12)
});

export async function proposeStoryMerge(
  projectName: string,
  stories: Array<{
    id: string;
    role: string;
    action: string;
    benefit: string;
    criteria: Array<{ description: string; status: string }>;
  }>
): Promise<z.infer<typeof mergeStoriesSchema>> {
  const prompt = `
Sa oled kogenud ärianalüütik ja agiilse tarkvaraarenduse tootejuht.
Projekti nimi: ${projectName}
Ühendamiseks valitud kasutajalood koos vastuvõtukriteeriumidega:
${JSON.stringify(stories)}

Koosta nende põhjal üks sidus Connextra kasutajalugu, mis säilitab kõigi valitud lugude olulise kasutajaväärtuse.
Ära jäta olulist funktsionaalsust välja ega lisa lähteandmetes toetamata nõudeid.
Kui lood kirjeldavad tegelikult eri kasutajaväärtusi, selgita seda rationale väljal ja paku siiski ettevaatlikult ühine tervik, mitte ära mõtle välja uut funktsionaalsust.
Lisa vähemalt 3 konkreetset, ühe tingimusega ja jah/ei kontrollitavat vastuvõtukriteeriumi.
Väldi subjektiivseid sõnu nagu kiire, lihtne, mugav, intuitiivne ja kasutajasõbralik.
Väljasta ainult JSON kujul:
{"rationale":"...","story":{"role":"...","action":"...","benefit":"..."},"criteria":["...","...","..."]}
`;
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt,
    config: { responseMimeType: 'application/json', maxOutputTokens: 4000 }
  });
  if (!response.text) throw new Error('AI ei tagastanud ühendamise ettepanekut.');
  return mergeStoriesSchema.parse(JSON.parse(response.text));
}
