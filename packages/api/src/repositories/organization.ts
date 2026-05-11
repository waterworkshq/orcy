import { getDb } from '../db/index.js';
import { organizations } from '../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export function createOrganization(input: { name: string; slug: string }): Organization {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(organizations).values({
    id,
    name: input.name,
    slug: input.slug,
    createdAt: now,
  }).run();

  return getOrganizationById(id)!;
}

export function getOrganizationById(id: string): Organization | null {
  const db = getDb();
  const rows = db.select().from(organizations).where(eq(organizations.id, id)).all();
  return rows.length > 0 ? rows[0] as Organization : null;
}

export function getOrganizationBySlug(slug: string): Organization | null {
  const db = getDb();
  const rows = db.select().from(organizations).where(eq(organizations.slug, slug)).all();
  return rows.length > 0 ? rows[0] as Organization : null;
}

export function listOrganizations(): Organization[] {
  const db = getDb();
  return db.select().from(organizations).orderBy(sql`${organizations.createdAt} DESC`).all() as Organization[];
}

export function deleteOrganization(id: string): void {
  const db = getDb();
  db.delete(organizations).where(eq(organizations.id, id)).run();
}
