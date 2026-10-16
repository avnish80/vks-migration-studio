import { type Kysely, sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

const initial: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.createTable('projects')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('name', 'text', c => c.notNull())
      .addColumn('description', 'text', c => c.notNull().defaultTo(''))
      .addColumn('source_cluster_id', 'text', c => c.references('clusters.id'))
      .addColumn('target_cluster_id', 'text', c => c.references('clusters.id'))
      .addColumn('settings', 'text', c => c.notNull().defaultTo('{}'))
      .addColumn('created_at', 'text', c => c.notNull())
      .addColumn('updated_at', 'text', c => c.notNull())
      .execute();
    await db.schema.createTable('clusters')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('context_name', 'text', c => c.notNull())
      .addColumn('role', 'text', c => c.notNull().check(sql`role in ('source','target')`))
      .addColumn('observed_uid', 'text')
      .addColumn('last_seen_at', 'text')
      .addColumn('created_at', 'text', c => c.notNull())
      .execute();
    // Content-addressed documents (inventories, manifests, receipts), stored once per hash.
    await db.schema.createTable('blobs')
      .addColumn('hash', 'text', c => c.primaryKey())
      .addColumn('size', 'integer', c => c.notNull())
      .addColumn('compressed', 'blob', c => c.notNull())
      .addColumn('created_at', 'text', c => c.notNull())
      .execute();
    await db.schema.createTable('snapshots')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('project_id', 'text', c => c.notNull().references('projects.id'))
      .addColumn('cluster_id', 'text', c => c.notNull().references('clusters.id'))
      .addColumn('blob_hash', 'text', c => c.notNull().references('blobs.hash'))
      .addColumn('collected_at', 'text', c => c.notNull())
      .addColumn('coverage', 'text', c => c.notNull().defaultTo('{}'))
      .execute();
    await db.schema.createTable('workloads')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('project_id', 'text', c => c.notNull().references('projects.id'))
      .addColumn('resource_id', 'text', c => c.notNull())
      .addColumn('state', 'text', c => c.notNull())
      .addColumn('wave_id', 'text')
      .addColumn('updated_at', 'text', c => c.notNull())
      .addUniqueConstraint('workloads_project_resource', ['project_id', 'resource_id'])
      .execute();
    await db.schema.createTable('plans')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('workload_id', 'text', c => c.notNull().references('workloads.id'))
      .addColumn('input_hash', 'text', c => c.notNull())
      .addColumn('blob_hash', 'text', c => c.notNull().references('blobs.hash'))
      .addColumn('created_at', 'text', c => c.notNull())
      .execute();
    await db.schema.createTable('runs')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('plan_id', 'text', c => c.notNull().references('plans.id'))
      .addColumn('workload_id', 'text', c => c.notNull().references('workloads.id'))
      .addColumn('run_label', 'text', c => c.notNull().unique())
      .addColumn('state', 'text', c => c.notNull())
      .addColumn('lease_owner', 'text')
      .addColumn('heartbeat_at', 'text')
      .addColumn('created_at', 'text', c => c.notNull())
      .addColumn('updated_at', 'text', c => c.notNull())
      .execute();
    // One unresolved run per workload (design 3.6): closed runs are Cleaned or Absent.
    await sql`create unique index runs_one_active_per_workload on runs (workload_id) where state not in ('Cleaned','Absent')`.execute(db);
    await db.schema.createTable('evidence')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('run_id', 'text', c => c.notNull().references('runs.id'))
      .addColumn('kind', 'text', c => c.notNull())
      .addColumn('input_hash', 'text', c => c.notNull())
      .addColumn('blob_hash', 'text', c => c.notNull().references('blobs.hash'))
      .addColumn('observed_at', 'text', c => c.notNull())
      .execute();
    await db.schema.createTable('jobs')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('type', 'text', c => c.notNull())
      .addColumn('payload', 'text', c => c.notNull())
      .addColumn('state', 'text', c => c.notNull())
      .addColumn('attempts', 'integer', c => c.notNull().defaultTo(0))
      .addColumn('lease_owner', 'text')
      .addColumn('lease_until', 'text')
      .addColumn('created_at', 'text', c => c.notNull())
      .addColumn('updated_at', 'text', c => c.notNull())
      .execute();
    await db.schema.createIndex('jobs_state').on('jobs').columns(['state', 'lease_until']).execute();
    await db.schema.createTable('audit')
      .addColumn('seq', 'integer', c => c.primaryKey().autoIncrement())
      .addColumn('at', 'text', c => c.notNull())
      .addColumn('actor', 'text', c => c.notNull())
      .addColumn('action', 'text', c => c.notNull())
      .addColumn('subject', 'text', c => c.notNull())
      .addColumn('detail', 'text', c => c.notNull().defaultTo('{}'))
      .execute();
    // The audit log is append-only.
    await sql`create trigger audit_no_update before update on audit begin select raise(abort, 'audit log is append-only'); end`.execute(db);
    await sql`create trigger audit_no_delete before delete on audit begin select raise(abort, 'audit log is append-only'); end`.execute(db);
    // INSERT OR REPLACE does not fire delete triggers unless recursive_triggers is on; refuse it outright.
    await sql`create trigger audit_no_replace before insert on audit when new.seq is not null and exists (select 1 from audit where seq = new.seq) begin select raise(abort, 'audit log is append-only'); end`.execute(db);
  },
};

export const migrations: Record<string, Migration> = { '001_initial': initial };

export const provider: MigrationProvider = { getMigrations: async () => migrations };
