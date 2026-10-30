import { writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, canonical, counts, credentialClient, discover, equal, idKey, readBackup, schemaKinds, snapshot,
  type Api, type Row, type Snapshot } from './backup-common.ts';

/** Portable logical restore: does not set graph modes, delete, update or overwrite. */
export function schemaBody(kind: string, definition: Row): Row {
  const fields: Record<string, string[]> = {
    propertykeys: ['name', 'data_type', 'cardinality'],
    vertexlabels: ['name', 'id_strategy', 'primary_keys', 'properties', 'nullable_keys', 'enable_label_index'],
    edgelabels: ['name', 'source_label', 'target_label', 'frequency', 'properties', 'nullable_keys', 'sort_keys', 'enable_label_index'],
    indexlabels: ['name', 'base_type', 'base_value', 'index_type', 'fields'],
  };
  const body = Object.fromEntries(fields[kind].filter(k => definition[k] !== undefined).map(k => [k, structuredClone(definition[k])]));
  const user = Object.fromEntries(Object.entries(definition.user_data ?? {}).filter(([k]) => !['~create_time', '~update_time'].includes(k)));
  if (Object.keys(user).length) body.user_data = user;
  for (const key of ['properties', 'nullable_keys']) if (Array.isArray(body[key])) body[key].sort();
  return body;
}
function portable(state: Snapshot) {
  for (const p of state.schema.propertykeys) assert(['TEXT', 'INT'].includes(p.data_type) && p.cardinality === 'SINGLE' && (p.aggregate_type ?? 'NONE') === 'NONE' && (p.write_type ?? 'OLTP') === 'OLTP', 'Portable restore only supports current TEXT/INT SINGLE non-aggregate OLTP properties.');
  for (const d of state.schema.vertexlabels) {
    assert(['CUSTOMIZE_STRING', 'PRIMARY_KEY'].includes(d.id_strategy), 'Unsupported vertex ID strategy; use an official backup tool.');
    if (d.id_strategy === 'PRIMARY_KEY') assert(d.primary_keys?.length, 'Primary keys are missing');
  }
  for (const d of state.schema.edgelabels) {
    assert((d.edgelabel_type ?? 'NORMAL') === 'NORMAL' && d.frequency === 'SINGLE' && !(d.sort_keys ?? []).length, 'Only normal SINGLE edges without sort keys are supported.');
    assert(!d.links || (d.links.length === 1 && equal(d.links[0], { [d.source_label]: d.target_label })), 'Multiple edge endpoint types are unsupported.');
  }
  for (const d of state.schema.indexlabels) assert(d.index_type === 'SECONDARY', 'Only current SECONDARY indexes are supported.');
  for (const k of schemaKinds) for (const d of state.schema[k]) {
    assert(!d.status || d.status === 'CREATED', `Schema is not ready: ${d.name}`);
    assert(!d.name.startsWith('~') && !d.name.startsWith('__'), 'System Schema is outside the portable restore scope');
  }
}
function vertexIdentity(v: Row, source: Snapshot) {
  const d = source.schema.vertexlabels.find(d => d.name === v.label);
  assert(d, 'Unknown vertex label');
  if (d.id_strategy === 'PRIMARY_KEY') {
    const values = d.primary_keys.map((key: string) => {
      assert(v.properties[key] !== undefined && v.properties[key] !== null, 'Missing primary key property'); return v.properties[key];
    });
    return canonical([v.label, 'primary', values]);
  }
  assert(typeof v.id === 'string', 'Expected custom string vertex ID');
  return canonical([v.label, 'custom', v.id]);
}
function vertexMaps(state: Snapshot, source: Snapshot) {
  const logical = new Map<string, Row>(), native = new Map<string, string>();
  for (const v of state.vertices) {
    const key = vertexIdentity(v, source); assert(!logical.has(key), 'Duplicate logical vertex identity');
    logical.set(key, v); native.set(idKey(v.id), key);
  }
  return { logical, native };
}
function edgeMaps(state: Snapshot, vertices: ReturnType<typeof vertexMaps>) {
  const logical = new Map<string, Row>();
  for (const e of state.edges) {
    const from = vertices.native.get(idKey(e.outV)), to = vertices.native.get(idKey(e.inV));
    assert(from && to, 'Missing edge endpoint');
    const key = canonical([e.label, from, to]); assert(!logical.has(key), 'Duplicate SINGLE relation'); logical.set(key, e);
  }
  return logical;
}
export function preflight(source: Snapshot, target: Snapshot) {
  portable(source); portable(target);
  const missingSchema: { kind: string; body: Row }[] = [];
  for (const kind of schemaKinds) {
    for (const actual of target.schema[kind]) {
      const desired = source.schema[kind].find(d => d.name === actual.name);
      assert(desired && equal(schemaBody(kind, desired), schemaBody(kind, actual)), `Target Schema differs or is outside this backup: ${kind}/${actual.name}. No overwrite is permitted.`);
    }
    for (const d of source.schema[kind]) if (!target.schema[kind].some(a => a.name === d.name)) missingSchema.push({ kind, body: schemaBody(kind, d) });
  }
  const desired = vertexMaps(source, source), current = vertexMaps(target, source);
  for (const [key, actual] of current.logical) {
    const wanted = desired.logical.get(key);
    assert(wanted && equal(actual.properties, wanted.properties), `Target vertex differs or is outside this backup: ${actual.label}/${String(actual.id)}. No overwrite is permitted.`);
  }
  const desiredEdges = edgeMaps(source, desired), currentEdges = edgeMaps(target, current);
  for (const [key, actual] of currentEdges) {
    const wanted = desiredEdges.get(key);
    assert(wanted && equal(actual.properties, wanted.properties), `Target edge differs or is outside this backup: ${actual.label}. No overwrite is permitted.`);
  }
  return { missingSchema, desired, current, desiredEdges, currentEdges,
    missingVertices: [...desired.logical].filter(([key]) => !current.logical.has(key)),
    missingEdges: [...desiredEdges].filter(([key]) => !currentEdges.has(key)) };
}
async function task(api: Api, graph: string, result: any) {
  if (!result.task_id || String(result.task_id) === '0') return;
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const r = await api.request('GET', `${graph}/tasks/${encodeURIComponent(result.task_id)}`);
    const t = r.task ?? r, state = String(t.task_status ?? t.status).toUpperCase();
    if (state === 'SUCCESS') return;
    assert(!['FAILED', 'CANCELLED', 'CANCELED'].includes(state), 'Schema task failed');
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Schema task timed out; inspect target before retrying.');
}
export async function restore(api: Api, graph: string, source: Snapshot, checkOnly: boolean) {
  const before = await snapshot(api, graph), plan = preflight(source, before);
  const planned = { schema: plan.missingSchema.length, vertices: plan.missingVertices.length, edges: plan.missingEdges.length };
  if (checkOnly) return { mode: 'check-only', planned, sourceCounts: counts(source), targetCounts: counts(before), writes: 0 };
  let writes = 0;
  for (const action of plan.missingSchema) {
    await task(api, graph, await api.request('POST', `${graph}/schema/${action.kind}`, action.body)); writes++;
  }
  const remap = new Map<string, unknown>();
  for (const [key, v] of plan.desired.logical) {
    const existing = plan.current.logical.get(key);
    if (existing) { remap.set(idKey(v.id), existing.id); continue; }
    const d = source.schema.vertexlabels.find(d => d.name === v.label)!;
    const body = { ...(d.id_strategy === 'CUSTOMIZE_STRING' ? { id: v.id } : {}), label: v.label, properties: v.properties };
    const response = await api.request('POST', `${graph}/graph/vertices`, body), stored = response.vertex ?? response;
    assert(stored.id !== undefined && stored.label === v.label && equal(stored.properties, v.properties), 'Vertex creation response differs; inspect target before retrying.');
    if (d.id_strategy === 'CUSTOMIZE_STRING') assert(stored.id === v.id, 'Custom vertex ID changed');
    remap.set(idKey(v.id), stored.id); writes++;
  }
  for (const [, e] of plan.missingEdges) {
    const outV = remap.get(idKey(e.outV)), inV = remap.get(idKey(e.inV));
    assert(outV !== undefined && inV !== undefined, 'Missing target vertex ID mapping');
    await api.request('POST', `${graph}/graph/edges`, { label: e.label, outV, inV, outVLabel: e.outVLabel, inVLabel: e.inVLabel, properties: e.properties ?? {} }); writes++;
  }
  const after = await snapshot(api, graph), repeat = preflight(source, after);
  assert(!repeat.missingSchema.length && !repeat.missingVertices.length && !repeat.missingEdges.length, 'Readback differs from backup; inspect target before retrying.');
  return { mode: 'restore', success: true, planned, writes, counts: counts(after), repeatWouldWrite: 0,
    identityPolicy: 'Custom/business IDs preserved. PRIMARY_KEY native IDs and edge native IDs may differ; endpoint IDs are remapped.' };
}
async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => { const at = args.indexOf(name); assert(at >= 0 && args[at + 1] && !args[at + 1].startsWith('--'), `Required: ${name}`); return args[at + 1]; };
  assert(args.includes('--check-only') || args.includes('--apply'), 'Choose --check-only (read-only) or --apply (writes missing objects).');
  assert(!(args.includes('--check-only') && args.includes('--apply')), 'Choose one mode');
  const file = resolve(option('--file')), base = option('--url'), name = option('--graph');
  const { state } = await readBackup(file), checkOnly = args.includes('--check-only');
  portable(state);
  const api = credentialClient(base, checkOnly);
  try {
    const graph = await discover(api, name);
    const currentMode = await api.request('GET', graph + '/mode');
    assert(currentMode.mode === 'NONE', 'Target graph must be in ordinary NONE mode. This script does not change graph modes.');
    const result = await restore(api, graph, state, checkOnly);
    const report = { completedAt: new Date().toISOString(), endpoint: api.base, graph, ...result };
    if (!checkOnly) await writeFile(join(dirname(file), 'last-restore-result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally { api.clear(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (e) { console.error(e instanceof Error ? e.message : 'Restore failed'); process.exitCode = 1; }
}
