
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from './database/connection.js';
import { schema } from './database/schema.js';
import {
  startAIConversation,
  continueAIConversation,
  reviewProjectBacklog,
  proposeStoryRefinement,
  generatePrototypeFromPrompt,
  proposeStorySplit,
  proposeStoryMerge
} from './services/ai.service.js';

const app = express();

// Loome tabelid automaatselt serveri käivitamisel
db.exec(schema);

// Olemasoleva andmebaasi täiendamine: lisame puuduvad vastuvõtukriteeriumide väljad.
const criteriaColumns = db.prepare(
  'PRAGMA table_info(acceptance_criteria)'
).all() as Array<{ name: string }>;

if (!criteriaColumns.some(column => column.name === 'is_testable')) {
  db.exec(
    'ALTER TABLE acceptance_criteria ADD COLUMN is_testable INTEGER NOT NULL DEFAULT 1'
  );
}

if (!criteriaColumns.some(column => column.name === 'warning')) {
  db.exec(
    'ALTER TABLE acceptance_criteria ADD COLUMN warning TEXT'
  );
}

if (!criteriaColumns.some(column => column.name === 'status')) {
  db.exec(
    "ALTER TABLE acceptance_criteria ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'"
  );
}


// Lisame kasutajalugudele avatud küsimuste välja, säilitades olemasolevad andmed.
const storyColumns = db.prepare(
  'PRAGMA table_info(stories)'
).all() as Array<{ name: string }>;

if (!storyColumns.some(column => column.name === 'open_questions')) {
  db.exec(
    "ALTER TABLE stories ADD COLUMN open_questions TEXT NOT NULL DEFAULT '[]'"
  );
}

if (!storyColumns.some(column => column.name === 'is_archived')) {
  db.exec('ALTER TABLE stories ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0');
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.resolve(__dirname, '../public')));

// Muudatuste tagasivõtmise ajalugu.
db.exec(`
  CREATE TABLE IF NOT EXISTS undo_snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    story_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
  );
`);

function saveStorySnapshot(projectId: string, storyId: string): void {
  const story = db.prepare('SELECT * FROM stories WHERE id = ? AND project_id = ?')
    .get(storyId, projectId);
  if (!story) return;
  const criteria = db.prepare('SELECT * FROM acceptance_criteria WHERE story_id = ? ORDER BY position')
    .all(storyId);
  const mockups = db.prepare('SELECT * FROM mockups WHERE story_id = ?').all(storyId) as Array<any>;
  const versions = mockups.map(mockup => ({
    mockup,
    versions: db.prepare('SELECT * FROM mockup_versions WHERE mockup_id = ? ORDER BY version')
      .all(mockup.id)
  }));
  db.prepare('INSERT INTO undo_snapshots (id, project_id, story_id, snapshot) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), projectId, storyId, JSON.stringify({ story, criteria, versions }));
}

function checkCriterion(description: string): { testable: boolean; warning: string | null } {
  const subjective = /kasutajasõbralik|kiire|lihtne|mugav|intuitiivne|selge|sujuv|hea kasutajakogemus/i;
  const conjunctions = /\b(ja|ning|samuti)\b/i;
  const reasons: string[] = [];
  if (subjective.test(description)) reasons.push('Sisaldab hinnangulist sõna.');
  if (conjunctions.test(description)) reasons.push('Võib sisaldada mitut tingimust.');
  return { testable: reasons.length === 0, warning: reasons.length ? reasons.join(' ') : null };
}

// Kontrollime serveri tööd
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'AI-tool API is running'
  });
});

// Projekti viimase vestluse ja ajaloo taastamine.
app.get('/api/projects/:projectId/conversation', (req, res) => {
  const { projectId } = req.params;
  const conversation = db.prepare(`
    SELECT id FROM conversations WHERE project_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(projectId) as { id: string } | undefined;
  if (!conversation) return res.json({ conversationId: null, messages: [] });
  const messages = db.prepare(`
    SELECT role, content, created_at FROM messages
    WHERE conversation_id = ? ORDER BY rowid
  `).all(conversation.id);
  return res.json({ conversationId: conversation.id, messages });
});

// Projektide loend
app.get('/api/projects', (_req, res) => {
  const projects = db.prepare(`
    SELECT * FROM projects
    ORDER BY created_at DESC
  `).all();

  res.json(projects);
});

app.patch('/api/projects/:projectId/stage', (req,res) => {
  const input=z.object({stage:z.enum(['idea','clarification','roles','stories','priority','criteria_mockup','refinement','grooming'])}).safeParse(req.body);
  if(!input.success) return res.status(400).json({error:'Vigane etapp.'});
  const result=db.prepare('UPDATE projects SET current_stage=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.data.stage,req.params.projectId);
  if(!result.changes) return res.status(404).json({error:'Projekti ei leitud.'});
  return res.json({current_stage:input.data.stage});
});

app.get('/api/projects/:projectId', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Projekti ei leitud.' });
  return res.json(project);
});

// Uue projekti loomine
const projectSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().max(2000).default('')
});

app.post('/api/projects', (req, res) => {
  const result = projectSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: 'Vigased projekti andmed',
      details: result.error.issues
    });
  }

  const { name, description } = result.data;
  const id = randomUUID();

  db.prepare(`
    INSERT INTO projects (id, name, description)
    VALUES (?, ?, ?)
  `).run(id, name, description);

  const project = db.prepare(`
    SELECT * FROM projects WHERE id = ?
  `).get(id);

  return res.status(201).json(project);
});

// Gemini vestluse käivitamine
app.post('/api/projects/:projectId/chat/start', async (req, res) => {
  try {
    const { projectId } = req.params;

    const inputSchema = z.object({
      description: z.string().trim().min(1).max(5000)
    });

    const input = inputSchema.safeParse(req.body);

    if (!input.success) {
      return res.status(400).json({
        error: 'Projekti kirjeldus puudub või on vigane.',
        details: input.error.issues
      });
    }

    const project = db.prepare(`
      SELECT id, name FROM projects WHERE id = ?
    `).get(projectId) as
      { id: string; name: string } | undefined;

    if (!project) {
      return res.status(404).json({
        error: 'Projekti ei leitud.'
      });
    }

    const reply = await startAIConversation(
      project.name,
      input.data.description
    );
    db.prepare('UPDATE projects SET current_stage = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(reply.stage, input.data.description, projectId);

    const conversationId = randomUUID();

    db.prepare(`
      INSERT INTO conversations (id, project_id)
      VALUES (?, ?)
    `).run(conversationId, projectId);

    db.prepare(`
      INSERT INTO messages
      (id, conversation_id, role, content)
      VALUES (?, ?, ?, ?)
    `).run(
      randomUUID(),
      conversationId,
      'user',
      input.data.description
    );

    db.prepare(`
      INSERT INTO messages
      (id, conversation_id, role, content)
      VALUES (?, ?, ?, ?)
    `).run(
      randomUUID(),
      conversationId,
      'assistant',
      JSON.stringify(reply)
    );

    return res.status(201).json({
      conversationId,
      reply
    });

  } catch (error) {
    console.error('Gemini conversation error:', error);

    return res.status(500).json({
      error: 'Vestluse käivitamine ebaõnnestus.'
    });
  }
});

// Gemini vestluse jätkamine
app.post('/api/conversations/:conversationId/chat', async (req, res) => {
  try {
    const { conversationId } = req.params;

    const inputSchema = z.object({
      message: z.string().trim().min(1).max(5000)
    });

    const input = inputSchema.safeParse(req.body);

    if (!input.success) {
      return res.status(400).json({
        error: 'Sõnum puudub või on vigane.',
        details: input.error.issues
      });
    }

    const conversation = db.prepare(`
      SELECT p.name AS projectName
      FROM conversations c
      JOIN projects p ON p.id = c.project_id
      WHERE c.id = ?
    `).get(conversationId) as
      { projectName: string } | undefined;

    if (!conversation) {
      return res.status(404).json({
        error: 'Vestlust ei leitud.'
      });
    }

    db.prepare(`
      INSERT INTO messages
      (id, conversation_id, role, content)
      VALUES (?, ?, ?, ?)
    `).run(
      randomUUID(),
      conversationId,
      'user',
      input.data.message
    );

    const history = db.prepare(`
      SELECT role, content
      FROM messages
      WHERE conversation_id = ?
      ORDER BY rowid ASC
    `).all(conversationId) as Array<{
      role: 'user' | 'assistant';
      content: string;
    }>;

    const projectIdForContext = (db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(conversationId) as {project_id:string}).project_id;
    const actualBacklog = db.prepare(`
      SELECT s.id, s.role, s.action, s.benefit, s.status, s.position, s.size, s.notes, s.open_questions,
        (SELECT COUNT(*) FROM acceptance_criteria ac WHERE ac.story_id=s.id AND ac.status != 'rejected') AS criteria_count,
        EXISTS(SELECT 1 FROM mockups m WHERE m.story_id=s.id) AS has_mockup
      FROM stories s WHERE s.project_id=? ORDER BY s.position
    `).all(projectIdForContext);
    const reply = await continueAIConversation(
      conversation.projectName,
      history,
      actualBacklog
    );
    db.prepare('UPDATE projects SET current_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(reply.stage, projectIdForContext);

    db.prepare(`
      INSERT INTO messages
      (id, conversation_id, role, content)
      VALUES (?, ?, ?, ?)
    `).run(
      randomUUID(),
      conversationId,
      'assistant',
      JSON.stringify(reply)
    );

    return res.json({ reply });

  } catch (error) {
    console.error('Gemini conversation continuation error:', error);

    return res.status(500).json({
      error: 'Vestluse jätkamine ebaõnnestus.'
    });
  }
});

// Kasutajarollide kinnitamine ja salvestamine
app.post('/api/conversations/:conversationId/roles/confirm', (req, res) => {
  try {
    const { conversationId } = req.params;

    const rolesSchema = z.object({
      roles: z.array(
        z.object({
          name: z.string().trim().min(1).max(150),
          description: z.string().trim().min(1).max(1000)
        })
      ).max(20)
    });

    const input = rolesSchema.safeParse(req.body);

    if (!input.success) {
      return res.status(400).json({
        error: 'Kasutajarollide andmed on vigased.',
        details: input.error.issues
      });
    }

    const conversation = db.prepare(`
      SELECT project_id
      FROM conversations
      WHERE id = ?
    `).get(conversationId) as
      { project_id: string } | undefined;

    if (!conversation) {
      return res.status(404).json({
        error: 'Vestlust ei leitud.'
      });
    }

    const projectId = conversation.project_id;

    db.prepare(`
      DELETE FROM project_roles
      WHERE project_id = ?
    `).run(projectId);

    const insertRole = db.prepare(`
      INSERT INTO project_roles
      (id, project_id, name, description)
      VALUES (?, ?, ?, ?)
    `);

    for (const role of input.data.roles) {
      insertRole.run(
        randomUUID(),
        projectId,
        role.name,
        role.description
      );
    }

    const savedRoles = db.prepare(`
      SELECT id, name, description
      FROM project_roles
      WHERE project_id = ?
      ORDER BY created_at ASC
    `).all(projectId);

    const confirmationMessage = {
      type: 'roles_confirmed',
      message: 'Kasutaja on kasutajarollid kinnitanud.',
      roles: savedRoles
    };

    db.prepare(`
      INSERT INTO messages
      (id, conversation_id, role, content)
      VALUES (?, ?, ?, ?)
    `).run(
      randomUUID(),
      conversationId,
      'user',
      JSON.stringify(confirmationMessage)
    );

    return res.json({
      message: 'Kasutajarollid on kinnitatud ja salvestatud.',
      roles: savedRoles
    });

  } catch (error) {
    console.error('Role confirmation error:', error);

    return res.status(500).json({
      error: 'Kasutajarollide salvestamine ebaõnnestus.'
    });
  }
});

// Kasutajalugude kinnitamine ja backlog'i salvestamine
app.post('/api/conversations/:conversationId/stories/confirm', (req, res) => {
  try {
    const { conversationId } = req.params;

    const storiesSchema = z.object({
      stories: z.array(
        z.object({
          role: z.string().trim().min(1).max(150),
          action: z.string().trim().min(1).max(1000),
          benefit: z.string().trim().min(1).max(1000),
          position: z.number().int().positive()
        })
      ).min(1).max(100)
    });

    const input = storiesSchema.safeParse(req.body);

    if (!input.success) {
      return res.status(400).json({
        error: 'Vali vähemalt üks kasutajalugu.',
        details: input.error.issues
      });
    }

    // Kontrollime vestlust ja leiame projekti
    const conversation = db.prepare(`
      SELECT project_id
      FROM conversations
      WHERE id = ?
    `).get(conversationId) as
      { project_id: string } | undefined;

    if (!conversation) {
      return res.status(404).json({
        error: 'Vestlust ei leitud.'
      });
    }

    const projectId = conversation.project_id;

    // Kontrollime, et kasutajalugude järjekorranumbrid ei korduks
    const positions = input.data.stories.map(story => story.position);

    if (new Set(positions).size !== positions.length) {
      return res.status(400).json({
        error: 'Kasutajalugude järjekorranumbrid peavad olema unikaalsed.'
      });
    }

    db.exec('BEGIN');

    try {
      const insertStory = db.prepare(`
        INSERT INTO stories (
          id,
          project_id,
          role,
          action,
          benefit,
          position,
          origin
        )
        SELECT ?, ?, ?, ?, ?, ?, 'ai'
        WHERE NOT EXISTS (
          SELECT 1 FROM stories
          WHERE project_id = ?
            AND role = ?
            AND action = ?
            AND benefit = ?
        )
      `);

      for (const story of input.data.stories) {
        insertStory.run(
          randomUUID(),
          projectId,
          story.role,
          story.action,
          story.benefit,
          story.position,
          projectId,
          story.role,
          story.action,
          story.benefit
        );
      }

      const savedStories = db.prepare(`
        SELECT id, role, action, benefit, position, status
        FROM stories
        WHERE project_id = ?
        ORDER BY position ASC
      `).all(projectId);

      // Salvestame kinnituse vestlusajalukku
      const confirmationMessage = {
        type: 'stories_confirmed',
        message: 'Kasutaja on kasutajalood kinnitanud ja backlog’i salvestanud.',
        stories: input.data.stories
      };

      db.prepare(`
        INSERT INTO messages
        (id, conversation_id, role, content)
        VALUES (?, ?, ?, ?)
      `).run(
        randomUUID(),
        conversationId,
        'user',
        JSON.stringify(confirmationMessage)
      );

      db.exec('COMMIT');

      return res.json({
        message: 'Kasutajalood on kinnitatud ja backlog’i salvestatud.',
        stories: savedStories
      });

    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

  } catch (error) {
    console.error('Story confirmation error:', error);

    return res.status(500).json({
      error: 'Kasutajalugude salvestamine ebaõnnestus.'
    });
  }
});

// Prioriteetse kasutajaloo kinnitamine
app.post('/api/conversations/:conversationId/priority/confirm', (req, res) => {
  try {
    const { conversationId } = req.params;

    const prioritySchema = z.object({
      role: z.string().trim().min(1).max(150),
      action: z.string().trim().min(1).max(1000),
      benefit: z.string().trim().min(1).max(1000),
      position: z.number().int().positive()
    });

    const input = prioritySchema.safeParse(req.body);

    if (!input.success) {
      return res.status(400).json({
        error: 'Prioriteedi andmed on vigased.',
        details: input.error.issues
      });
    }

    const conversation = db.prepare(`
      SELECT project_id
      FROM conversations
      WHERE id = ?
    `).get(conversationId) as
      { project_id: string } | undefined;

    if (!conversation) {
      return res.status(404).json({
        error: 'Vestlust ei leitud.'
      });
    }

    const projectId = conversation.project_id;

    // Kontrollime, et valitud kasutajalugu on projekti backlog'is olemas.
    const story = db.prepare(`
      SELECT id, role, action, benefit, position
      FROM stories
      WHERE project_id = ?
        AND role = ?
        AND action = ?
        AND benefit = ?
        AND position = ?
    `).get(
      projectId,
      input.data.role,
      input.data.action,
      input.data.benefit,
      input.data.position
    ) as {
      id: string;
      role: string;
      action: string;
      benefit: string;
      position: number;
    } | undefined;

    if (!story) {
      return res.status(400).json({
        error: 'Valitud kasutajalugu ei leidu selle projekti backlog’is.'
      });
    }

    const confirmationMessage = {
      type: 'priority_confirmed',
      message: 'Kasutaja kinnitas prioriteetse kasutajaloo.',
      priorityStory: story
    };

    db.prepare(`
      INSERT INTO messages
      (id, conversation_id, role, content)
      VALUES (?, ?, ?, ?)
    `).run(
      randomUUID(),
      conversationId,
      'user',
      JSON.stringify(confirmationMessage)
    );

    return res.json({
      message: 'Prioriteetne kasutajalugu on kinnitatud.',
      priorityStory: story
    });

  } catch (error) {
    console.error('Priority confirmation error:', error);

    return res.status(500).json({
      error: 'Prioriteedi kinnitamine ebaõnnestus.'
    });
  }
});


// Vastuvõtukriteeriumide ja maketi kinnitamine ning salvestamine
app.post(
  '/api/conversations/:conversationId/criteria-mockup/confirm',
  (req, res) => {
    try {
      const { conversationId } = req.params;

      const componentSchema = z.object({
        id: z.string().trim().min(1).max(100),
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
        label: z.string().max(300).optional(),
        content: z.string().max(5000).optional(),
        actions: z.array(z.string().max(300)).optional()
      });

      const confirmationSchema = z.object({
        storyId: z.string().uuid(),
        acceptanceCriteria: z.array(
          z.object({
            description: z.string().trim().min(1).max(1000),
            isTestable: z.boolean(),
            warning: z.string().max(500).nullable().optional(),
            status: z.enum(['accepted', 'rejected'])
          })
        ).min(3).max(50),
        mockup: z.object({
          title: z.string().trim().min(1).max(200),
          purpose: z.string().trim().min(1).max(1000),
          components: z.array(componentSchema).min(1).max(100),
          primaryAction: z.string().max(300).nullable().optional()
        })
      });

      const input = confirmationSchema.safeParse(req.body);

      if (!input.success) {
        return res.status(400).json({
          error: 'Vastuvõtukriteeriumide või maketi andmed on vigased.',
          details: input.error.issues
        });
      }

      const conversation = db.prepare(`
        SELECT project_id
        FROM conversations
        WHERE id = ?
      `).get(conversationId) as
        { project_id: string } | undefined;

      if (!conversation) {
        return res.status(404).json({
          error: 'Vestlust ei leitud.'
        });
      }

      const story = db.prepare(`
        SELECT id, role, action, benefit
        FROM stories
        WHERE id = ? AND project_id = ?
      `).get(
        input.data.storyId,
        conversation.project_id
      ) as {
        id: string;
        role: string;
        action: string;
        benefit: string;
      } | undefined;

      if (!story) {
        return res.status(404).json({
          error: 'Kasutajalugu ei leidu selle projekti backlog’is.'
        });
      }

      const criteria = input.data.acceptanceCriteria;
      const mockup = input.data.mockup;
      saveStorySnapshot(conversation.project_id, story.id);

      db.exec('BEGIN');

      try {
        // Asendame selle kasutajaloo varasemad kriteeriumid kinnitatud versiooniga.
        db.prepare(`
          DELETE FROM acceptance_criteria
          WHERE story_id = ?
        `).run(story.id);

        const insertCriterion = db.prepare(`
          INSERT INTO acceptance_criteria (
            id,
            story_id,
            description,
            position,
            is_testable,
            warning,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        criteria.forEach((criterion, index) => {
          const check = checkCriterion(criterion.description);
          insertCriterion.run(
            randomUUID(),
            story.id,
            criterion.description,
            index + 1,
            (criterion.isTestable && check.testable) ? 1 : 0,
            check.warning ?? criterion.warning ?? null,
            criterion.status
          );
        });

        const existingMockup = db.prepare(`
          SELECT id, current_version
          FROM mockups
          WHERE story_id = ?
        `).get(story.id) as {
          id: string;
          current_version: number;
        } | undefined;

        const mockupContent = JSON.stringify({
          title: mockup.title,
          purpose: mockup.purpose,
          components: mockup.components,
          primaryAction: mockup.primaryAction ?? null
        });

        let mockupId: string;
        let mockupVersion: number;

        if (existingMockup) {
          mockupId = existingMockup.id;
          mockupVersion = existingMockup.current_version + 1;

          db.prepare(`
            UPDATE mockups
            SET name = ?, current_version = ?
            WHERE id = ?
          `).run(mockup.title, mockupVersion, mockupId);
        } else {
          mockupId = randomUUID();
          mockupVersion = 1;

          db.prepare(`
            INSERT INTO mockups (id, story_id, name, current_version)
            VALUES (?, ?, ?, ?)
          `).run(mockupId, story.id, mockup.title, mockupVersion);
        }

        db.prepare(`
          INSERT INTO mockup_versions (
            id,
            mockup_id,
            version,
            content
          )
          VALUES (?, ?, ?, ?)
        `).run(
          randomUUID(),
          mockupId,
          mockupVersion,
          mockupContent
        );

        const confirmationMessage = {
          type: 'criteria_mockup_confirmed',
          message: 'Kasutaja kinnitas vastuvõtukriteeriumid ja maketi.',
          storyId: story.id,
          acceptanceCriteria: criteria,
          mockup: {
            id: mockupId,
            version: mockupVersion,
            ...mockup
          }
        };

        db.prepare(`
          INSERT INTO messages
          (id, conversation_id, role, content)
          VALUES (?, ?, ?, ?)
        `).run(
          randomUUID(),
          conversationId,
          'user',
          JSON.stringify(confirmationMessage)
        );

        db.prepare("UPDATE projects SET current_stage='refinement', updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(conversation.project_id);
        db.exec('COMMIT');

        const savedCriteria = db.prepare(`
          SELECT
            id,
            description,
            position,
            is_testable AS isTestable,
            warning,
            status
          FROM acceptance_criteria
          WHERE story_id = ?
          ORDER BY position ASC
        `).all(story.id);

        return res.json({
          message: 'Vastuvõtukriteeriumid ja makett on kinnitatud ning salvestatud.',
          story,
          acceptanceCriteria: savedCriteria,
          mockup: {
            id: mockupId,
            version: mockupVersion,
            ...mockup
          }
        });
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      console.error('Criteria and mockup confirmation error:', error);

      return res.status(500).json({
        error: 'Vastuvõtukriteeriumide ja maketi salvestamine ebaõnnestus.'
      });
    }
  }
);
// Projekti backlog'i pärimine koos kriteeriumide ja makettidega
// Arhiveeritud kasutajalood on aktiivsest backlog'ist eraldi nähtavad ja taastatavad.
app.get('/api/projects/:projectId/archived-stories', (req, res) => {
  try {
    const { projectId } = req.params;
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Projekti ei leitud.' });
    const stories = db.prepare(`
      SELECT id, role, action, benefit, status, position, notes, updated_at
      FROM stories
      WHERE project_id = ? AND is_archived = 1
      ORDER BY updated_at DESC, position ASC
    `).all(projectId);
    return res.json({ stories });
  } catch (error) {
    console.error('Archived stories retrieval error:', error);
    return res.status(500).json({ error: 'Arhiveeritud lugude laadimine ebaõnnestus.' });
  }
});

app.post('/api/projects/:projectId/stories/:storyId/restore', (req, res) => {
  try {
    const { projectId, storyId } = req.params;
    const story = db.prepare('SELECT id FROM stories WHERE id = ? AND project_id = ? AND is_archived = 1')
      .get(storyId, projectId);
    if (!story) return res.status(404).json({ error: 'Arhiveeritud kasutajalugu ei leitud.' });
    db.prepare(`UPDATE stories SET is_archived = 0, status = 'needs_clarification', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?`)
      .run(storyId, projectId);
    return res.json({ message: 'Kasutajalugu taastati backlog’i.', storyId });
  } catch (error) {
    console.error('Story restore error:', error);
    return res.status(500).json({ error: 'Kasutajaloo taastamine ebaõnnestus.' });
  }
});

app.get('/api/projects/:projectId/backlog', (req, res) => {
  try {
    const { projectId } = req.params;

    const project = db.prepare(`
      SELECT id, name, description, current_stage
      FROM projects
      WHERE id = ?
    `).get(projectId);

    if (!project) {
      return res.status(404).json({
        error: 'Projekti ei leitud.'
      });
    }

    const stories = db.prepare(`
      SELECT
        id,
        project_id,
        role,
        action,
        benefit,
        status,
        position,
        size,
        origin,
        notes,
        open_questions,
        is_mvp,
        created_at,
        updated_at
      FROM stories
      WHERE project_id = ? AND is_archived = 0
      ORDER BY position ASC
    `).all(projectId) as Array<{
      id: string;
      project_id: string;
      role: string;
      action: string;
      benefit: string;
      status: string;
      position: number;
      size: string | null;
      origin: string;
      notes: string | null;
      is_mvp: number;
      created_at: string;
      updated_at: string;
    }>;

    const getCriteria = db.prepare(`
      SELECT
        id,
        description,
        position,
        is_testable,
        warning,
        status
      FROM acceptance_criteria
      WHERE story_id = ?
      ORDER BY position ASC
    `);

    const getMockup = db.prepare(`
      SELECT
        m.id,
        m.name,
        m.current_version,
        mv.content,
        mv.created_at AS version_created_at
      FROM mockups m
      LEFT JOIN mockup_versions mv
        ON mv.mockup_id = m.id
        AND mv.version = m.current_version
      WHERE m.story_id = ?
    `);

    const backlog = stories.map(story => {
      const criteria = getCriteria.all(story.id) as Array<{
        id: string;
        description: string;
        position: number;
        is_testable: number;
        warning: string | null;
        status: string;
      }>;

      const mockup = getMockup.get(story.id) as {
        id: string;
        name: string;
        current_version: number;
        content: string | null;
        version_created_at: string | null;
      } | undefined;

      return {
        ...story,
        is_mvp: Boolean(story.is_mvp),
        acceptanceCriteria: criteria.map(criterion => ({
          ...criterion,
          isTestable: Boolean(criterion.is_testable)
        })),
        mockup: mockup
          ? {
              id: mockup.id,
              name: mockup.name,
              currentVersion: mockup.current_version,
              content: mockup.content
                ? JSON.parse(mockup.content)
                : null,
              versionCreatedAt: mockup.version_created_at
            }
          : null
      };
    });

    return res.json({
      project,
      totalStories: backlog.length,
      backlog
    });

  } catch (error) {
    console.error('Backlog retrieval error:', error);

    return res.status(500).json({
      error: 'Backlog’i laadimine ebaõnnestus.'
    });
  }
});

// Kasutajaloo muutmine
app.patch(
  '/api/projects/:projectId/stories/:storyId',
  (req, res) => {
    try {
      const { projectId, storyId } = req.params;

      const updateSchema = z.object({
        role: z.string().trim().min(1).max(150).optional(),
        action: z.string().trim().min(1).max(1000).optional(),
        benefit: z.string().trim().min(1).max(1000).optional(),
        notes: z.string().max(5000).optional(),
        size: z.string().max(50).nullable().optional(),
        openQuestions: z.array(
          z.string().trim().min(1).max(1000)
        ).max(50).optional()
      }).refine(data => Object.keys(data).length > 0);

      const input = updateSchema.safeParse(req.body);

      if (!input.success) {
        return res.status(400).json({
          error: 'Kasutajaloo andmed on vigased.',
          details: input.error.issues
        });
      }

      const existingStory = db.prepare(`
        SELECT id
        FROM stories
        WHERE id = ? AND project_id = ?
      `).get(storyId, projectId);

      if (!existingStory) {
        return res.status(404).json({
          error: 'Kasutajalugu ei leitud.'
        });
      }

      saveStorySnapshot(projectId, storyId);
      const updates: string[] = [];
      const values: Array<string | null> = [];
      const data = input.data;

      if (data.role !== undefined) {
        updates.push('role = ?');
        values.push(data.role);
      }
      if (data.action !== undefined) {
        updates.push('action = ?');
        values.push(data.action);
      }
      if (data.benefit !== undefined) {
        updates.push('benefit = ?');
        values.push(data.benefit);
      }
      if (data.notes !== undefined) {
        updates.push('notes = ?');
        values.push(data.notes);
      }
      if (data.size !== undefined) {
        updates.push('size = ?');
        values.push(data.size);
      }
      if (data.openQuestions !== undefined) {
        updates.push('open_questions = ?');
        values.push(JSON.stringify(data.openQuestions));
      }

      updates.push('updated_at = CURRENT_TIMESTAMP');

      db.prepare(`
        UPDATE stories
        SET ${updates.join(', ')}
        WHERE id = ? AND project_id = ?
      `).run(...values, storyId, projectId);

      const updatedStory = db.prepare(`
        SELECT *
        FROM stories
        WHERE id = ? AND project_id = ?
      `).get(storyId, projectId);

      return res.json({
        message: 'Kasutajalugu on uuendatud.',
        story: updatedStory
      });
    } catch (error) {
      console.error('Story update error:', error);
      return res.status(500).json({
        error: 'Kasutajaloo muutmine ebaõnnestus.'
      });
    }
  }
);

// Kasutajaloo kustutamine
app.delete(
  '/api/projects/:projectId/stories/:storyId',
  (req, res) => {
    try {
      const { projectId, storyId } = req.params;

      const existing = db.prepare('SELECT id FROM stories WHERE id = ? AND project_id = ?').get(storyId, projectId);
      if (existing) saveStorySnapshot(projectId, storyId);
      const result = db.prepare(`
        DELETE FROM stories
        WHERE id = ? AND project_id = ?
      `).run(storyId, projectId);

      if (result.changes === 0) {
        return res.status(404).json({
          error: 'Kasutajalugu ei leitud.'
        });
      }

      return res.json({
        message: 'Kasutajalugu ja sellega seotud andmed on kustutatud.'
      });
    } catch (error) {
      console.error('Story deletion error:', error);
      return res.status(500).json({
        error: 'Kasutajaloo kustutamine ebaõnnestus.'
      });
    }
  }
);

// Backlog'i kasutajalugude järjestamine
app.patch(
  '/api/projects/:projectId/backlog/reorder',
  (req, res) => {
    try {
      const { projectId } = req.params;

      const input = z.object({
        storyIds: z.array(z.string().uuid()).min(1).max(500)
      }).safeParse(req.body);

      if (!input.success) {
        return res.status(400).json({
          error: 'Järjestuse andmed on vigased.',
          details: input.error.issues
        });
      }

      const storyIds = input.data.storyIds;

      if (new Set(storyIds).size !== storyIds.length) {
        return res.status(400).json({
          error: 'Sama kasutajalugu ei tohi esineda järjestuses mitu korda.'
        });
      }

      const projectStories = db.prepare(`
        SELECT id FROM stories WHERE project_id = ? AND is_archived = 0
      `).all(projectId) as Array<{ id: string }>;

      if (projectStories.length !== storyIds.length) {
        return res.status(400).json({
          error: 'Järjestus peab sisaldama kõiki projekti kasutajalugusid.'
        });
      }

      const existingIds = new Set(projectStories.map(story => story.id));
      if (!storyIds.every(id => existingIds.has(id))) {
        return res.status(400).json({
          error: 'Järjestuses on kasutajalugu, mis ei kuulu sellesse projekti.'
        });
      }

      const updatePosition = db.prepare(`
        UPDATE stories
        SET position = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND project_id = ?
      `);

      db.exec('BEGIN');
      try {
        storyIds.forEach((id, index) => {
          updatePosition.run(index + 1, id, projectId);
        });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      const backlog = db.prepare(`
        SELECT id, role, action, benefit, position
        FROM stories
        WHERE project_id = ?
        ORDER BY position ASC
      `).all(projectId);

      return res.json({
        message: 'Backlog’i järjestus on uuendatud.',
        backlog
      });
    } catch (error) {
      console.error('Backlog reorder error:', error);
      return res.status(500).json({
        error: 'Backlog’i järjestamine ebaõnnestus.'
      });
    }
  }
);

// Kasutajaloo lisamine või eemaldamine MVP-st
app.patch(
  '/api/projects/:projectId/stories/:storyId/mvp',
  (req, res) => {
    try {
      const { projectId, storyId } = req.params;
      const input = z.object({
        isMvp: z.boolean()
      }).safeParse(req.body);

      if (!input.success) {
        return res.status(400).json({
          error: 'MVP märgistuse andmed on vigased.',
          details: input.error.issues
        });
      }

      const exists = db.prepare('SELECT id FROM stories WHERE id = ? AND project_id = ?').get(storyId, projectId);
      if (exists) saveStorySnapshot(projectId, storyId);
      const result = db.prepare(`
        UPDATE stories
        SET is_mvp = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND project_id = ?
      `).run(input.data.isMvp ? 1 : 0, storyId, projectId);

      if (result.changes === 0) {
        return res.status(404).json({
          error: 'Kasutajalugu ei leitud.'
        });
      }

      return res.json({
        message: input.data.isMvp
          ? 'Kasutajalugu lisati MVP-sse.'
          : 'Kasutajalugu eemaldati MVP-st.',
        storyId,
        isMvp: input.data.isMvp
      });
    } catch (error) {
      console.error('MVP update error:', error);
      return res.status(500).json({
        error: 'MVP märgistuse muutmine ebaõnnestus.'
      });
    }
  }
);

// Kasutajaloo Definition of Ready kontroll
app.get(
  '/api/projects/:projectId/stories/:storyId/ready-check',
  (req, res) => {
    try {
      const { projectId, storyId } = req.params;

      const story = db.prepare(`
        SELECT id, role, action, benefit, open_questions
        FROM stories
        WHERE id = ? AND project_id = ?
      `).get(storyId, projectId) as {
        id: string;
        role: string;
        action: string;
        benefit: string;
        open_questions: string;
      } | undefined;

      if (!story) {
        return res.status(404).json({
          error: 'Kasutajalugu ei leitud.'
        });
      }

      const criteria = db.prepare(`
        SELECT description, is_testable, status
        FROM acceptance_criteria
        WHERE story_id = ?
        ORDER BY position ASC
      `).all(storyId) as Array<{
        description: string;
        is_testable: number;
        status: string;
      }>;

      const mockup = db.prepare(`
        SELECT id
        FROM mockups
        WHERE story_id = ?
      `).get(storyId);

      let openQuestions: string[];
      try {
        const parsed: unknown = JSON.parse(story.open_questions || '[]');
        openQuestions = Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === 'string')
          : ['Avatud küsimuste andmed on vigased.'];
      } catch {
        openQuestions = ['Avatud küsimuste andmeid ei saanud lugeda.'];
      }

      const connextraValid = Boolean(
        story.role.trim() &&
        story.action.trim() &&
        story.benefit.trim()
      );

      const activeCriteria = criteria.filter(criterion => criterion.status !== 'rejected');
      const enoughCriteria = activeCriteria.length >= 3;
      const nonTestableCriteria = activeCriteria
        .filter(criterion => criterion.is_testable !== 1 || !checkCriterion(criterion.description).testable)
        .map(criterion => criterion.description);

      const allCriteriaTestable =
        activeCriteria.length > 0 && nonTestableCriteria.length === 0;

      const viewRelated = /\b(vaade|vaadet|ekraan|ekraani|leht|lehe|vorm|liides|kuva|kuvama|näitama|näha)\b/i
        .test(`${story.action} ${story.benefit}`);

      const mockupRequired = viewRelated;
      const mockupExists = Boolean(mockup);
      const noOpenQuestions = openQuestions.length === 0;

      const checks = {
        connextraValid: {
          passed: connextraValid,
          description: 'Connextra kasutajaloo kõik kolm osa on täidetud.'
        },
        enoughCriteria: {
          passed: enoughCriteria,
          description: 'Vähemalt kolm vastuvõtukriteeriumi.',
          actual: activeCriteria.length,
          required: 3
        },
        allCriteriaTestable: {
          passed: allCriteriaTestable,
          description: 'Kõik vastuvõtukriteeriumid on testitavad.',
          nonTestableCriteria
        },
        mockup: {
          passed: !mockupRequired || mockupExists,
          description: mockupRequired
            ? 'Vaatega seotud kasutajalugu vajab maketti.'
            : 'Kasutajalugu ei vaja selle kontrolli järgi maketti.',
          required: mockupRequired,
          exists: mockupExists
        },
        openQuestions: {
          passed: noOpenQuestions,
          description: 'Avatud küsimusi ei ole.',
          questions: openQuestions
        }
      };

      const ready = Object.values(checks).every(check => check.passed);

      return res.json({
        storyId,
        ready,
        status: ready ? 'ready' : 'not_ready',
        checks
      });
    } catch (error) {
      console.error('Definition of Ready error:', error);
      return res.status(500).json({
        error: 'Definition of Ready kontroll ebaõnnestus.'
      });
    }
  }
);


// AI backlog'i ülevaatus: loob kinnitamist ootavad ettepanekud, kuid ei muuda lugusid.
app.post('/api/projects/:projectId/backlog/review', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = db.prepare(`
      SELECT id, name FROM projects WHERE id = ?
    `).get(projectId) as { id: string; name: string } | undefined;

    if (!project) {
      return res.status(404).json({ error: 'Projekti ei leitud.' });
    }

    const stories = db.prepare(`
      SELECT id, role, action, benefit, status, position, size, notes, open_questions
      FROM stories WHERE project_id = ? AND is_archived = 0 ORDER BY position ASC
    `).all(projectId) as Array<{
      id: string; role: string; action: string; benefit: string;
      status: string; position: number; size: string | null;
      notes: string | null; open_questions: string | null;
    }>;

    const criteriaQuery = db.prepare(`
      SELECT description, is_testable, warning, status
      FROM acceptance_criteria WHERE story_id = ? ORDER BY position ASC
    `);
    const mockupQuery = db.prepare(`
      SELECT id, name, current_version FROM mockups WHERE story_id = ?
    `);

    const backlog = stories.map(story => ({
      ...story,
      openQuestions: (() => {
        try { return JSON.parse(story.open_questions || '[]'); }
        catch { return ['Avatud küsimuste andmed vigased']; }
      })(),
      acceptanceCriteria: criteriaQuery.all(story.id),
      mockups: mockupQuery.all(story.id)
    }));

    const review = await reviewProjectBacklog(project.name, backlog);
    db.prepare("UPDATE projects SET current_stage='grooming', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(projectId);

    // Uus analüüs asendab vanad läbi vaatamata ettepanekud, et kasutaja ei näeks
    // sama probleemi kohta korduvaid või aegunud soovitusi.
    db.prepare(`
      UPDATE ai_proposals
      SET status = 'superseded'
      WHERE project_id = ? AND status = 'pending'
    `).run(projectId);

    const insertProposal = db.prepare(`
      INSERT INTO ai_proposals
        (id, project_id, story_id, proposal_type, payload, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `);

    const proposalIds: string[] = [];
    db.exec('BEGIN');
    try {
      for (const finding of review.findings) {
        const proposalId = randomUUID();
        proposalIds.push(proposalId);
        insertProposal.run(
          proposalId,
          projectId,
          finding.storyId,
          finding.category,
          JSON.stringify(finding)
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return res.json({
      message: 'Backlog on analüüsitud. Ühtegi kasutajalugu ei muudetud.',
      summary: review.summary,
      totalFindings: review.findings.length,
      proposalIds,
      findings: review.findings.map((finding, index) => ({
        id: proposalIds[index],
        ...finding
      }))
    });
  } catch (error) {
    console.error('AI backlog review error:', error);
    return res.status(502).json({
      error: 'AI backlog’i ülevaatus ebaõnnestus. Proovi uuesti.',
    });
  }
});

// Projekti AI ettepanekute loend.
app.get('/api/projects/:projectId/proposals', (req, res) => {
  const { projectId } = req.params;
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Projekti ei leitud.' });

  const proposals = db.prepare(`
    SELECT id, story_id, proposal_type, payload, status, created_at
    FROM ai_proposals WHERE project_id = ? ORDER BY created_at DESC
  `).all(projectId).map((row: any) => ({
    ...row,
    payload: JSON.parse(row.payload)
  }));
  return res.json({ proposals });
});

// Ettepaneku kinnitamine või tagasilükkamine. Muudatus rakendub ainult kinnitamisel.
app.patch('/api/projects/:projectId/proposals/:proposalId', (req, res) => {
  try {
    const { projectId, proposalId } = req.params;
    const input = z.object({
      decision: z.enum(['apply', 'reject']),
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
        openQuestions: z.array(z.string().max(1000)).max(30).optional(),
        newStories: z.array(z.object({
          role: z.string().min(1).max(150), action: z.string().min(1).max(1000),
          benefit: z.string().min(1).max(1000), criteria: z.array(z.string()).optional()
        })).min(2).max(5).optional(),
        mergeStoryIds: z.array(z.string().uuid()).min(2).max(5).optional(),
        newStory: z.object({ role:z.string().min(1), action:z.string().min(1), benefit:z.string().min(1), criteria:z.array(z.string().min(1).max(1000)).min(3).max(12).optional() }).optional(),
        prototype: z.object({
          story: z.object({role:z.string().min(1),action:z.string().min(1),benefit:z.string().min(1)}),
          acceptanceCriteria: z.array(z.object({description:z.string().min(1),isTestable:z.boolean(),warning:z.string().nullable()})).min(3),
          mockup: z.object({title:z.string().min(1),purpose:z.string().min(1),components:z.array(z.object({
            id:z.string(),type:z.enum(['heading','text','button','input','card','list','progress','navigation']),
            label:z.string(),content:z.string(),actions:z.array(z.string())
          })).min(1),primaryAction:z.string().nullable().optional()})
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
    }).safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: 'Otsus peab olema apply või reject.' });
    }

    const proposal = db.prepare(`
      SELECT id, story_id, payload, status
      FROM ai_proposals WHERE id = ? AND project_id = ?
    `).get(proposalId, projectId) as {
      id: string; story_id: string | null; payload: string; status: string;
    } | undefined;
    if (!proposal) return res.status(404).json({ error: 'Ettepanekut ei leitud.' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: 'Ettepanek on juba läbi vaadatud.' });
    }

    if (input.data.decision === 'reject') {
      db.prepare(`UPDATE ai_proposals SET status = 'rejected' WHERE id = ?`).run(proposalId);
      return res.json({ message: 'Ettepanek lükati tagasi. Backlog jäi muutmata.' });
    }

    const proposalPayload = JSON.parse(proposal.payload) as { changes?: any };
    const changesForStructure = input.data.changes ?? proposalPayload.changes;
    if (changesForStructure?.prototype) {
      const p=changesForStructure.prototype;
      const maxPos=(db.prepare('SELECT COALESCE(MAX(position),0) AS p FROM stories WHERE project_id=?').get(projectId) as {p:number}).p;
      const newId=randomUUID();
      db.exec('BEGIN');
      try {
        db.prepare(`INSERT INTO stories (id,project_id,role,action,benefit,position,origin,status,open_questions)
          VALUES (?,?,?,?,?,?,'ai','idea','[]')`).run(newId,projectId,p.story.role,p.story.action,p.story.benefit,maxPos+1);
        const add=db.prepare(`INSERT INTO acceptance_criteria (id,story_id,description,position,is_testable,warning,status)
          VALUES (?,?,?,?,?,?,'accepted')`);
        p.acceptanceCriteria.forEach((c:any,i:number)=>{
          const check=checkCriterion(c.description);
          add.run(randomUUID(),newId,c.description,i+1,(c.isTestable && check.testable)?1:0,check.warning ?? c.warning);
        });
        const mockupId=randomUUID();
        db.prepare('INSERT INTO mockups (id,story_id,name,current_version) VALUES (?,?,?,1)').run(mockupId,newId,p.mockup.title);
        db.prepare('INSERT INTO mockup_versions (id,mockup_id,version,content) VALUES (?,?,1,?)')
          .run(randomUUID(),mockupId,JSON.stringify(p.mockup));
        db.prepare(`UPDATE ai_proposals SET status='approved' WHERE id=?`).run(proposalId);
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
      return res.json({message:'Uus kasutajalugu, kriteeriumid ja makett lisati backlog’i.', storyId:newId});
    }
    if (changesForStructure?.newStories) {
      const maxPos = (db.prepare('SELECT COALESCE(MAX(position),0) AS p FROM stories WHERE project_id=?').get(projectId) as {p:number}).p;
      db.exec('BEGIN');
      try {
        const addStory = db.prepare(`INSERT INTO stories (id,project_id,role,action,benefit,position,origin,status,open_questions)
          VALUES (?,?,?,?,?,?,'ai','idea','[]')`);
        const addC = db.prepare(`INSERT INTO acceptance_criteria (id,story_id,description,position,is_testable,warning,status)
          VALUES (?,?,?,?,?,?, 'pending')`);
        changesForStructure.newStories.forEach((s:any,i:number) => {
          const newId=randomUUID(); addStory.run(newId,projectId,s.role,s.action,s.benefit,maxPos+i+1);
          (s.criteria ?? []).forEach((c:string,j:number) => {
            const check = checkCriterion(c);
            addC.run(randomUUID(),newId,c,j+1,check.testable ? 1 : 0,check.warning);
          });
        });
        if (proposal.story_id) {
          saveStorySnapshot(projectId, proposal.story_id);
          db.prepare('UPDATE stories SET is_archived=1, status=?, notes=COALESCE(notes,\'\') || ?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
            .run('needs_clarification', '\\nJagati väiksemateks lugudeks.', proposal.story_id);
        }
        db.prepare(`UPDATE ai_proposals SET status='approved' WHERE id=?`).run(proposalId);
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
      return res.json({message:'Jagatud kasutajalood lisati backlog’i.', appliedChanges:changesForStructure});
    }
    if (changesForStructure?.mergeStoryIds && changesForStructure?.newStory) {
      const ids:string[]=changesForStructure.mergeStoryIds;
      const placeholders=ids.map(()=>'?').join(',');
      const found=db.prepare(`SELECT id FROM stories WHERE project_id=? AND id IN (${placeholders})`).all(projectId,...ids) as any[];
      if(found.length!==ids.length) return res.status(409).json({error:'Ühendatavad lood pole enam saadaval.'});
      const maxPos=(db.prepare('SELECT COALESCE(MAX(position),0) AS p FROM stories WHERE project_id=?').get(projectId) as {p:number}).p;
      const n=changesForStructure.newStory;
      ids.forEach(id => saveStorySnapshot(projectId,id));
      const mergedStoryId = randomUUID();
      db.exec('BEGIN');
      try {
        db.prepare(`INSERT INTO stories (id,project_id,role,action,benefit,position,origin,status,open_questions) VALUES (?,?,?,?,?,?,'ai','idea','[]')`)
          .run(mergedStoryId,projectId,n.role,n.action,n.benefit,maxPos+1);
        const addMergedCriterion = db.prepare(`INSERT INTO acceptance_criteria (id,story_id,description,position,is_testable,warning,status) VALUES (?,?,?,?,?,?, 'pending')`);
        (n.criteria ?? []).forEach((description:string,index:number) => {
          const check = checkCriterion(description);
          addMergedCriterion.run(randomUUID(),mergedStoryId,description,index+1,check.testable?1:0,check.warning);
        });
        db.prepare(`UPDATE stories SET is_archived=1, status='needs_clarification', notes=COALESCE(notes,'') || char(10) || 'Ühendati uue kasutajalooga.', updated_at=CURRENT_TIMESTAMP WHERE project_id=? AND id IN (${placeholders})`).run(projectId,...ids);
        db.prepare(`UPDATE ai_proposals SET status='approved' WHERE id=?`).run(proposalId);
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
      return res.json({message:'Ühendatud kasutajalugu koos vastuvõtukriteeriumidega lisati; algsed lood arhiveeriti ja jäid taastatavaks.', storyId:mergedStoryId});
    }
    if (!proposal.story_id) {
      return res.status(409).json({ error: 'Ettepanekul puudub seotud kasutajalugu.' });
    }
    const payload = JSON.parse(proposal.payload) as {
      changes?: {
        role?: string; action?: string; benefit?: string; size?: 'S' | 'M' | 'L' | null;
        acceptanceCriteria?: Array<{ description: string; isTestable: boolean; warning: string | null }>;
        openQuestions?: string[];
        newStories?: Array<{role:string;action:string;benefit:string;criteria?:string[]}>;
        mergeStoryIds?: string[];
        newStory?: {role:string;action:string;benefit:string};
        prototype?: {story:{role:string;action:string;benefit:string}; acceptanceCriteria:Array<{description:string;isTestable:boolean;warning:string|null}>; mockup:{title:string;purpose:string;components:Array<{id:string;type:string;label:string;content:string;actions:string[]}>;primaryAction?:string|null}};
        mockup?: {
          title: string; purpose: string;
          components: Array<{ id: string; type: string; label: string; content: string; actions: string[] }>;
          primaryAction?: string | null;
        };
      }
    };
    const changes = input.data.changes ?? payload.changes;
    if (!changes || Object.keys(changes).length === 0) {
      return res.status(400).json({ error: 'Ettepanekul pole rakendatavaid muudatusi. Käivita backlog’i analüüs uuesti, et saada paranduse sisu.' });
    }

    const story = db.prepare('SELECT id FROM stories WHERE id = ? AND project_id = ?')
      .get(proposal.story_id, projectId);
    if (!story) return res.status(409).json({ error: 'Seotud kasutajalugu ei kuulu enam projekti.' });
    saveStorySnapshot(projectId, proposal.story_id);

    db.exec('BEGIN');
    try {
      const updates: string[] = [];
      const values: Array<string | number | null> = [];
      if (changes.role !== undefined) { updates.push('role = ?'); values.push(changes.role); }
      if (changes.action !== undefined) { updates.push('action = ?'); values.push(changes.action); }
      if (changes.benefit !== undefined) { updates.push('benefit = ?'); values.push(changes.benefit); }
      if (changes.size !== undefined) { updates.push('size = ?'); values.push(changes.size); }
      if (changes.openQuestions !== undefined) { updates.push('open_questions = ?'); values.push(JSON.stringify(changes.openQuestions)); }
      if (updates.length) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        db.prepare(`UPDATE stories SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`)
          .run(...values, proposal.story_id, projectId);
      }

      if (changes.acceptanceCriteria?.length) {
        const proposalCategory = (JSON.parse(proposal.payload) as any).category;
        const replaceCriteria = ['client_refinement','missing_criteria','untestable_criteria'].includes(proposalCategory);
        if (replaceCriteria) db.prepare('DELETE FROM acceptance_criteria WHERE story_id = ?').run(proposal.story_id);
        const current = db.prepare('SELECT COALESCE(MAX(position), 0) AS maxPosition FROM acceptance_criteria WHERE story_id = ?')
          .get(proposal.story_id) as { maxPosition: number };
        const addCriterion = db.prepare(`
          INSERT INTO acceptance_criteria
            (id, story_id, description, position, is_testable, warning, status)
          VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `);
        changes.acceptanceCriteria.forEach((criterion, index) => {
          const check = checkCriterion(criterion.description);
          addCriterion.run(randomUUID(), proposal.story_id, criterion.description,
            current.maxPosition + index + 1, (criterion.isTestable && check.testable) ? 1 : 0,
            check.warning ?? criterion.warning);
        });
      }

      if (changes.mockup) {
        const existingMockup = db.prepare(`
          SELECT id, current_version FROM mockups WHERE story_id = ?
        `).get(proposal.story_id) as { id: string; current_version: number } | undefined;
        const mockupId = existingMockup?.id ?? randomUUID();
        const version = existingMockup ? existingMockup.current_version + 1 : 1;
        const content = JSON.stringify({
          title: changes.mockup.title,
          purpose: changes.mockup.purpose,
          components: changes.mockup.components,
          primaryAction: changes.mockup.primaryAction ?? null
        });

        if (existingMockup) {
          db.prepare(`
            UPDATE mockups SET name = ?, current_version = ? WHERE id = ?
          `).run(changes.mockup.title, version, mockupId);
        } else {
          db.prepare(`
            INSERT INTO mockups (id, story_id, name, current_version)
            VALUES (?, ?, ?, ?)
          `).run(mockupId, proposal.story_id, changes.mockup.title, version);
        }

        db.prepare(`
          INSERT INTO mockup_versions (id, mockup_id, version, content)
          VALUES (?, ?, ?, ?)
        `).run(randomUUID(), mockupId, version, content);
      }

      db.prepare(`UPDATE ai_proposals SET status = 'approved' WHERE id = ?`).run(proposalId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return res.json({
      message: 'Ettepanek rakendati kinnituse järel.',
      storyId: proposal.story_id,
      appliedChanges: changes
    });
  } catch (error) {
    console.error('AI proposal decision error:', error);
    return res.status(500).json({ error: 'Ettepaneku rakendamine ebaõnnestus.' });
  }
});




// Käsitsi loodud kasutajaloo lisamine (AI pole vajalik).
app.post('/api/projects/:projectId/stories', (req, res) => {
  const input = z.object({
    role: z.string().trim().min(1).max(150),
    action: z.string().trim().min(1).max(1000),
    benefit: z.string().trim().min(1).max(1000),
    size: z.enum(['S','M','L']).nullable().optional(),
    notes: z.string().max(5000).optional()
  }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Kasutajaloo andmed on vigased.' });
  const projectId = req.params.projectId;
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Projekti ei leitud.' });
  const position = (db.prepare('SELECT COALESCE(MAX(position),0) AS p FROM stories WHERE project_id = ?').get(projectId) as {p:number}).p + 1;
  const id = randomUUID();
  db.prepare(`INSERT INTO stories (id, project_id, role, action, benefit, position, size, origin, notes, status, open_questions)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'idea', '[]')`)
    .run(id, projectId, input.data.role, input.data.action, input.data.benefit, position, input.data.size ?? null, input.data.notes ?? '');
  return res.status(201).json({ id, message: 'Kasutajalugu lisati backlog’i.' });
});

// Kasutajaloo staatuse muutmine. Ready on lubatud ainult DoR kontrolli läbimisel.
app.patch('/api/projects/:projectId/stories/:storyId/status', (req, res) => {
  const { projectId, storyId } = req.params;
  const input = z.object({ status: z.enum(['idea','needs_clarification','reviewed','ready']) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Vigane staatus.' });
  const story = db.prepare('SELECT * FROM stories WHERE id = ? AND project_id = ?').get(storyId, projectId) as any;
  if (!story) return res.status(404).json({ error: 'Kasutajalugu ei leitud.' });
  if (input.data.status === 'ready') {
    const criteria = db.prepare('SELECT description, is_testable, status FROM acceptance_criteria WHERE story_id = ?').all(storyId) as any[];
    const mockup = db.prepare('SELECT id FROM mockups WHERE story_id = ?').get(storyId);
    let questions: string[] = [];
    try { questions = JSON.parse(story.open_questions || '[]'); } catch { questions = ['Avatud küsimuste andmed vigased']; }
    const viewRelated = /\b(vaade|vaadet|ekraan|ekraani|leht|lehe|vorm|liides|kuva|kuvama|näitama|näha)\b/i.test(`${story.action} ${story.benefit}`);
    const valid = Boolean(story.role?.trim() && story.action?.trim() && story.benefit?.trim())
      && criteria.filter(c => c.status !== 'rejected').length >= 3
      && criteria.filter(c => c.status !== 'rejected').every(c => c.is_testable === 1 && checkCriterion(c.description).testable)
      && (!viewRelated || Boolean(mockup)) && questions.length === 0;
    if (!valid) return res.status(409).json({ error: 'Kasutajalugu ei vasta Definition of Ready tingimustele. Kontrolli kriteeriume, maketti ja avatud küsimusi.', ready: false });
  }
  saveStorySnapshot(projectId, storyId);
  db.prepare('UPDATE stories SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?')
    .run(input.data.status, storyId, projectId);
  return res.json({ message: 'Kasutajaloo staatus uuendatud.', status: input.data.status });
});

// Vastuvõtukriteeriumi muutmine, kinnitamine või tagasilükkamine.
app.patch('/api/stories/:storyId/criteria/:criterionId', (req, res) => {
  const { storyId, criterionId } = req.params;
  const input = z.object({
    description: z.string().trim().min(1).max(1000).optional(),
    status: z.enum(['pending','accepted','rejected']).optional()
  }).refine(v => Object.keys(v).length > 0).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Kriteeriumi andmed on vigased.' });
  const criterion = db.prepare(`SELECT ac.id, s.project_id FROM acceptance_criteria ac
    JOIN stories s ON s.id = ac.story_id WHERE ac.id = ? AND ac.story_id = ?`)
    .get(criterionId, storyId) as {id:string; project_id:string} | undefined;
  if (!criterion) return res.status(404).json({ error: 'Kriteeriumi ei leitud.' });
  saveStorySnapshot(criterion.project_id, storyId);
  const updates: string[] = []; const values: Array<string> = [];
  if (input.data.description !== undefined) {
    const check = checkCriterion(input.data.description);
    updates.push('description = ?', 'is_testable = ?', 'warning = ?');
    values.push(input.data.description, check.testable ? '1' : '0', check.warning ?? '');
  }
  if (input.data.status !== undefined) { updates.push('status = ?'); values.push(input.data.status); }
  db.prepare(`UPDATE acceptance_criteria SET ${updates.join(', ')} WHERE id = ?`).run(...values, criterionId);
  return res.json({ message: 'Vastuvõtukriteerium uuendatud.' });
});

// Kriteeriumide lisamine valitud loole.
app.post('/api/projects/:projectId/stories/:storyId/criteria', (req, res) => {
  const { projectId, storyId } = req.params;
  const input = z.object({ description: z.string().trim().min(1).max(1000) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Kriteeriumi kirjeldus on vigane.' });
  const story = db.prepare('SELECT id FROM stories WHERE id = ? AND project_id = ?').get(storyId, projectId);
  if (!story) return res.status(404).json({ error: 'Kasutajalugu ei leitud.' });
  saveStorySnapshot(projectId, storyId);
  const pos = (db.prepare('SELECT COALESCE(MAX(position),0) AS p FROM acceptance_criteria WHERE story_id = ?').get(storyId) as {p:number}).p + 1;
  const check = checkCriterion(input.data.description);
  const id = randomUUID();
  db.prepare(`INSERT INTO acceptance_criteria (id, story_id, description, position, is_testable, warning, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(id, storyId, input.data.description, pos, check.testable ? 1 : 0, check.warning);
  return res.status(201).json({ id, isTestable: check.testable, warning: check.warning });
});

// Mockup’i versiooniajalugu ja versiooni taastamine.
app.get('/api/stories/:storyId/mockup-versions', (req, res) => {
  const mockup = db.prepare('SELECT id FROM mockups WHERE story_id = ?').get(req.params.storyId) as {id:string} | undefined;
  if (!mockup) return res.json({ versions: [] });
  const versions = db.prepare('SELECT version, content, created_at FROM mockup_versions WHERE mockup_id = ? ORDER BY version DESC')
    .all(mockup.id).map((v:any) => ({ ...v, content: JSON.parse(v.content) }));
  return res.json({ versions });
});
app.post('/api/projects/:projectId/stories/:storyId/mockup-restore', (req, res) => {
  const { projectId, storyId } = req.params;
  const input = z.object({ version: z.number().int().positive() }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Versioon on vigane.' });
  const mockup = db.prepare('SELECT m.id AS id, m.current_version AS current_version FROM mockups m JOIN stories s ON s.id=m.story_id WHERE m.story_id=? AND s.project_id=?')
    .get(storyId, projectId) as {id:string; current_version:number} | undefined;
  if (!mockup) return res.status(404).json({ error: 'Maketti ei leitud.' });
  const version = db.prepare('SELECT content FROM mockup_versions WHERE mockup_id=? AND version=?')
    .get(mockup.id, input.data.version) as {content:string} | undefined;
  if (!version) return res.status(404).json({ error: 'Maketi versiooni ei leitud.' });
  saveStorySnapshot(projectId, storyId);
  const next = mockup.current_version + 1;
  const content = JSON.parse(version.content);
  db.prepare('UPDATE mockups SET name=?, current_version=? WHERE id=?').run(content.title ?? 'Makett', next, mockup.id);
  db.prepare('INSERT INTO mockup_versions (id,mockup_id,version,content) VALUES (?,?,?,?)')
    .run(randomUUID(), mockup.id, next, version.content);
  return res.json({ message: 'Varasem makett taastati uue versioonina.', version: next });
});

app.get('/api/projects/:projectId/undo/latest', (req,res) => {
  const row=db.prepare(`SELECT story_id, created_at FROM undo_snapshots
    WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(req.params.projectId) as {story_id:string;created_at:string}|undefined;
  return res.json({ available:Boolean(row), storyId:row?.story_id ?? null, createdAt:row?.created_at ?? null });
});

// Ühe loo viimase muudatuse tagasivõtmine.
app.post('/api/projects/:projectId/stories/:storyId/undo', (req, res) => {
  const { projectId, storyId } = req.params;
  const snap = db.prepare(`SELECT id, snapshot FROM undo_snapshots WHERE project_id=? AND story_id=?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(projectId, storyId) as {id:string; snapshot:string} | undefined;
  if (!snap) return res.status(404).json({ error: 'Tagasivõetavat muudatust ei leitud.' });
  const data = JSON.parse(snap.snapshot);
  db.exec('BEGIN');
  try {
    const old = data.story;
    const stillExists = db.prepare('SELECT id FROM stories WHERE id=?').get(storyId);
    if (stillExists) {
      db.prepare(`UPDATE stories SET role=?, action=?, benefit=?, status=?, position=?, size=?, notes=?, is_mvp=?, is_archived=?, open_questions=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(old.role, old.action, old.benefit, old.status, old.position, old.size, old.notes, old.is_mvp, old.is_archived ?? 0, old.open_questions ?? '[]', storyId);
    } else {
      db.prepare(`INSERT INTO stories (id,project_id,role,action,benefit,status,position,size,origin,notes,is_mvp,is_archived,open_questions)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(old.id, old.project_id, old.role, old.action, old.benefit, old.status, old.position, old.size, old.origin, old.notes, old.is_mvp, old.is_archived ?? 0, old.open_questions ?? '[]');
    }
    db.prepare('DELETE FROM acceptance_criteria WHERE story_id=?').run(storyId);
    db.prepare('DELETE FROM mockups WHERE story_id=?').run(storyId);
    const add = db.prepare(`INSERT INTO acceptance_criteria (id,story_id,description,position,is_testable,warning,status)
      VALUES (?,?,?,?,?,?,?)`);
    for (const c of data.criteria) add.run(c.id,c.story_id,c.description,c.position,c.is_testable,c.warning,c.status);
    for (const item of data.versions) {
      const existing = db.prepare('SELECT id FROM mockups WHERE id=?').get(item.mockup.id);
      if (!existing) db.prepare('INSERT INTO mockups (id,story_id,name,current_version) VALUES (?,?,?,?)')
        .run(item.mockup.id,item.mockup.story_id,item.mockup.name,item.mockup.current_version);
      else db.prepare('UPDATE mockups SET name=?,current_version=? WHERE id=?')
        .run(item.mockup.name,item.mockup.current_version,item.mockup.id);
      for (const v of item.versions) {
        const has = db.prepare('SELECT id FROM mockup_versions WHERE id=?').get(v.id);
        if (!has) db.prepare('INSERT INTO mockup_versions (id,mockup_id,version,content,created_at) VALUES (?,?,?,?,?)')
          .run(v.id,v.mockup_id,v.version,v.content,v.created_at);
      }
    }
    db.prepare('DELETE FROM undo_snapshots WHERE id=?').run(snap.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return res.json({ message: 'Viimane muudatus võeti tagasi.' });
});

// Kliendi täpsustuse põhjal luuakse eelvaateks AI ettepanek; backlog ei muutu.
app.post('/api/projects/:projectId/stories/:storyId/refinement', async (req, res) => {
  try {
    const { projectId, storyId } = req.params;
    const input = z.object({ clarification: z.string().trim().min(3).max(4000) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Täpsustus peab olema vähemalt 3 märki.' });
    const project = db.prepare('SELECT name FROM projects WHERE id=?').get(projectId) as {name:string} | undefined;
    const story = db.prepare('SELECT role,action,benefit FROM stories WHERE id=? AND project_id=?').get(storyId,projectId) as any;
    if (!project || !story) return res.status(404).json({ error: 'Projekti või kasutajalugu ei leitud.' });
    const criteria = db.prepare('SELECT description,status FROM acceptance_criteria WHERE story_id=? ORDER BY position').all(storyId) as any[];
    const mockupRow = db.prepare(`SELECT mv.content FROM mockups m JOIN mockup_versions mv ON mv.mockup_id=m.id AND mv.version=m.current_version WHERE m.story_id=?`).get(storyId) as {content:string} | undefined;
    const proposal = await proposeStoryRefinement(project.name, story, criteria, mockupRow ? JSON.parse(mockupRow.content) : null, input.data.clarification);
    const id = randomUUID();
    const payload = { ...proposal, category:'client_refinement', problem:'Kliendi täpsustus', rationale:proposal.summary, suggestion:'Vaata muudatuste eelvaade üle ja kinnita või lükka tagasi.', changes:proposal.changes, before:{story,criteria,mockup:mockupRow ? JSON.parse(mockupRow.content) : null} };
    db.prepare(`INSERT INTO ai_proposals (id,project_id,story_id,proposal_type,payload,status) VALUES (?,?,?,?,?,'pending')`)
      .run(id,projectId,storyId,'client_refinement',JSON.stringify(payload));
    return res.status(201).json({ proposalId:id, proposal:payload });
  } catch (e) { console.error(e); return res.status(502).json({ error:'AI ei suutnud täpsustusest ettepanekut koostada. Proovi uuesti.' }); }
});

// Uue vaate promptist AI prototüübi eelvaade. Midagi ei salvestata enne kinnitamist.
app.post('/api/projects/:projectId/prototype', async (req,res) => {
  try {
    const {projectId}=req.params;
    const input=z.object({prompt:z.string().trim().min(5).max(4000)}).safeParse(req.body);
    if(!input.success) return res.status(400).json({error:'Kirjelda uut vaadet vähemalt viie märgiga.'});
    const project=db.prepare('SELECT name FROM projects WHERE id=?').get(projectId) as {name:string}|undefined;
    if(!project) return res.status(404).json({error:'Projekti ei leitud.'});
    const roles=(db.prepare('SELECT name FROM project_roles WHERE project_id=?').all(projectId) as Array<{name:string}>).map(r=>r.name);
    const result=await generatePrototypeFromPrompt(project.name,input.data.prompt,roles);
    const proposalId=randomUUID();
    const payload={problem:'Uue vaate prototüübi ettepanek',rationale:result.explanation,suggestion:'Vaata kasutajalugu, kriteeriume ja maketti üle ning kinnita.',changes:{prototype:result}};
    db.prepare(`INSERT INTO ai_proposals (id,project_id,story_id,proposal_type,payload,status) VALUES (?,?,NULL,'new_prototype',?,'pending')`)
      .run(proposalId,projectId,JSON.stringify(payload));
    return res.status(201).json({proposalId,proposal:payload});
  } catch(e) { console.error(e); return res.status(502).json({error:'AI prototüübi loomine ebaõnnestus. Proovi prompti täpsustada.'}); }
});

// AI-põhine kasutajaloo jagamise ettepanek. Algset backlog'i ei muudeta enne kinnitamist.
app.post('/api/projects/:projectId/stories/:storyId/split-proposal', async (req, res) => {
  try {
    const { projectId, storyId } = req.params;
    const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
    const story = db.prepare('SELECT role, action, benefit, notes FROM stories WHERE id = ? AND project_id = ? AND is_archived = 0').get(storyId, projectId) as { role: string; action: string; benefit: string; notes: string | null } | undefined;
    if (!project || !story) return res.status(404).json({ error: 'Projekti või kasutajalugu ei leitud.' });
    const criteria = db.prepare('SELECT description, status FROM acceptance_criteria WHERE story_id = ? ORDER BY position').all(storyId) as Array<{ description: string; status: string }>;
    const result = await proposeStorySplit(project.name, story, criteria, story.notes);
    const newStories = result.stories.map(item => ({ ...item, criteria: item.criteria }));
    const id = randomUUID();
    const payload = {
      category: 'split_story',
      problem: 'AI soovitab jagada kasutajaloo väiksemateks osadeks.',
      rationale: result.rationale,
      suggestion: 'Vaata iga uut kasutajalugu ja selle vastuvõtukriteeriume üle. Kinnitamisel lisatakse uued lood backlog’i.',
      before: { story, criteria },
      changes: { newStories }
    };
    db.prepare(`INSERT INTO ai_proposals (id, project_id, story_id, proposal_type, payload, status) VALUES (?, ?, ?, 'split_story', ?, 'pending')`)
      .run(id, projectId, storyId, JSON.stringify(payload));
    return res.status(201).json({ proposalId: id, proposal: payload });
  } catch (error) {
    console.error('AI story split proposal error:', error);
    return res.status(502).json({ error: 'AI ei suutnud kasutajalugu jagada. Proovi uuesti.' });
  }
});

// AI koostab valitud lugudest ühendamise ettepaneku. Algseid lugusid ei muudeta.
app.post('/api/projects/:projectId/merge-proposal', async (req, res) => {
  try {
    const { projectId } = req.params;
    const input = z.object({ storyIds: z.array(z.string().uuid()).min(2).max(5) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Vali 2–5 kasutajalugu.' });
    const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
    if (!project) return res.status(404).json({ error: 'Projekti ei leitud.' });
    const placeholders = input.data.storyIds.map(() => '?').join(',');
    const selected = db.prepare(`SELECT id, role, action, benefit FROM stories WHERE project_id = ? AND is_archived = 0 AND id IN (${placeholders})`).all(projectId, ...input.data.storyIds) as Array<{id:string;role:string;action:string;benefit:string}>;
    if (selected.length !== input.data.storyIds.length) return res.status(400).json({ error: 'Kõik valitud lood peavad kuuluma sellesse projekti ja olema aktiivsed.' });
    const ordered = input.data.storyIds.map(id => selected.find(story => story.id === id)!);
    const stories = ordered.map(story => ({
      ...story,
      criteria: db.prepare('SELECT description, status FROM acceptance_criteria WHERE story_id = ? ORDER BY position').all(story.id) as Array<{description:string;status:string}>
    }));
    const result = await proposeStoryMerge(project.name, stories);
    const id = randomUUID();
    const payload = {
      category: 'merge_stories',
      problem: 'AI pakub valitud kasutajalugude ühendamist üheks terviklikuks looks.',
      rationale: result.rationale,
      suggestion: 'Kontrolli ühendatud loo sõnastust ja vastuvõtukriteeriume. Algseid lugusid muudetakse alles kinnitamisel.',
      before: stories,
      changes: {
        mergeStoryIds: input.data.storyIds,
        newStory: { ...result.story, criteria: result.criteria }
      }
    };
    db.prepare(`INSERT INTO ai_proposals (id, project_id, story_id, proposal_type, payload, status) VALUES (?, ?, NULL, 'merge_stories', ?, 'pending')`)
      .run(id, projectId, JSON.stringify(payload));
    return res.status(201).json({ proposalId: id, proposal: payload });
  } catch (error) {
    console.error('AI story merge proposal error:', error);
    return res.status(502).json({ error: 'AI ei suutnud kasutajalugusid ühendada. Proovi uuesti.' });
  }
});

export default app;
