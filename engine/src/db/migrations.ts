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

const inventory: Migration = {
  // SQLite supports transactional DDL; Kysely's migrator does not use it, so the whole step runs in
  // one transaction here: a failure leaves the 1.0 schema untouched and the step can simply be retried.
  async up(db: Kysely<any>) {
    await db.transaction().execute(async trx => {
      // Snapshots can come from a registered cluster, a file import or the demo inventory.
      // stored_at orders snapshots; collected_at is what the inventory reports and is display only.
      await sql`create table snapshots_new (
        id text primary key,
        project_id text not null references projects(id),
        side text not null check (side in ('source','target')),
        origin text not null check (origin in ('collected','imported','demo')),
        cluster_id text references clusters(id),
        blob_hash text not null references blobs(hash),
        analysis_hash text references blobs(hash),
        resource_count integer not null default 0,
        collected_at text not null,
        stored_at text not null,
        coverage text not null default '{}'
      )`.execute(trx);
      await sql`insert into snapshots_new (id, project_id, side, origin, cluster_id, blob_hash, collected_at, stored_at, coverage)
        select s.id, s.project_id, coalesce(c.role, 'source'), 'collected', s.cluster_id, s.blob_hash, s.collected_at, s.collected_at, s.coverage from snapshots s left join clusters c on c.id = s.cluster_id`.execute(trx);
      await sql`drop table snapshots`.execute(trx);
      await sql`alter table snapshots_new rename to snapshots`.execute(trx);
      await trx.schema.createIndex('snapshots_project_side').on('snapshots').columns(['project_id', 'side', 'stored_at']).execute();

      await trx.schema.alterTable('clusters').addColumn('name', 'text').execute();
      await trx.schema.alterTable('clusters').addColumn('last_error', 'text').execute();
      await trx.schema.alterTable('clusters').addColumn('retired_at', 'text').execute();
      // 1.0 did not enforce unique context names; keep the oldest and retire later duplicates.
      await sql`update clusters set context_name = context_name || '#retired-' || substr(id, 1, 8), retired_at = created_at
        where exists (select 1 from clusters o where o.context_name = clusters.context_name and (o.created_at < clusters.created_at or (o.created_at = clusters.created_at and o.id < clusters.id)))`.execute(trx);
      await trx.schema.createIndex('clusters_context').on('clusters').column('context_name').unique().execute();

      for (const [column, type] of [['kind', 'text'], ['namespace', 'text'], ['name', 'text'], ['snapshot_id', 'text'], ['blockers', 'integer'], ['reviews', 'integer']] as const) {
        await trx.schema.alterTable('workloads').addColumn(column, type, c => (type === 'integer' ? c.notNull().defaultTo(0) : c)).execute();
      }
      for (const column of ['project_id', 'progress', 'result', 'error']) await trx.schema.alterTable('jobs').addColumn(column, 'text').execute();
      await trx.schema.createIndex('jobs_project').on('jobs').columns(['project_id', 'created_at']).execute();
    });
  },
};

const pilots: Migration = {
  async up(db: Kysely<any>) {
    await db.transaction().execute(async trx => {
      // A target cluster's pilot login: a separate kubeconfig context with write access to the pilot
      // namespace only. It must reach the same cluster (same kube-system UID) as the read-only context.
      await trx.schema.alterTable('clusters').addColumn('pilot_context_name', 'text').execute();
      for (const [column, type] of [['project_id', 'text'], ['settings', 'text'], ['blockers', 'integer'], ['source_snapshot_id', 'text'], ['target_snapshot_id', 'text']] as const) {
        await trx.schema.alterTable('plans').addColumn(column, type, c => (type === 'integer' ? c.notNull().defaultTo(0) : c)).execute();
      }
      await trx.schema.alterTable('runs').addColumn('project_id', 'text').execute();
      await trx.schema.alterTable('runs').addColumn('status_detail', 'text').execute();
      // Runs that ended without leaving anything on the target no longer block a new run.
      await sql`drop index runs_one_active_per_workload`.execute(trx);
      await sql`create unique index runs_one_active_per_workload on runs (workload_id) where state not in ('Cleaned','Absent','Discarded','ValidationFailed','NothingCreated')`.execute(trx);
      await trx.schema.createIndex('evidence_run').on('evidence').columns(['run_id', 'observed_at']).execute();
    });
  },
};

export const migrations: Record<string, Migration> = { '001_initial': initial, '002_inventory': inventory, '003_pilots': pilots };

export const provider: MigrationProvider = { getMigrations: async () => migrations };
