import { db } from './connection.js';
import { schema } from './schema.js';

db.exec(schema);

// Safe migrations for databases created by earlier project versions.
const storyColumns = db.prepare('PRAGMA table_info(stories)').all() as Array<{name:string}>;
if (!storyColumns.some(c => c.name === 'open_questions')) {
  db.exec("ALTER TABLE stories ADD COLUMN open_questions TEXT NOT NULL DEFAULT '[]'");
}
const storyColumnsAfter = db.prepare('PRAGMA table_info(stories)').all() as Array<{name:string}>;
if (!storyColumnsAfter.some(c => c.name === 'is_archived')) {
  db.exec('ALTER TABLE stories ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0');
}
const criterionColumns = db.prepare('PRAGMA table_info(acceptance_criteria)').all() as Array<{name:string}>;
if (!criterionColumns.some(c => c.name === 'is_testable')) {
  db.exec('ALTER TABLE acceptance_criteria ADD COLUMN is_testable INTEGER NOT NULL DEFAULT 1');
}
if (!criterionColumns.some(c => c.name === 'warning')) {
  db.exec('ALTER TABLE acceptance_criteria ADD COLUMN warning TEXT');
}
if (!criterionColumns.some(c => c.name === 'status')) {
  db.exec("ALTER TABLE acceptance_criteria ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
}
console.log('Database initialized successfully!');
