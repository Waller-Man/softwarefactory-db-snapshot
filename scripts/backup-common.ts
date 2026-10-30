import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export type Row = Record<string, any>;
export const schemaKinds = ['propertykeys', 'vertexlabels', 'edgelabels', 'indexlabels'] as const;
export type Snapshot = { schema: Record<string, Row[]>; vertices: Row[]; edges: Row[] };
export function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export function canonical(v: any): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const idKey = (id: unknown) => canonical(id);
export const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Credentials exist only in this process. Export paths permit GET only. */
export class Client {
  base: string;
  #authorization: string;
  readonlyOnly: boolean;
  constructor(base: string, username: string, password: string, readonlyOnly = true) {
    const url = new URL(base);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only local target addresses are supported; use a local tunnel for a remote server.');
    assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Expected a local HTTP(S) origin without credentials.');
    this.base = url.origin; this.readonlyOnly = readonlyOnly;
    this.#authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  }
  clear() { this.#authorization = ''; }
  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    assert(!this.readonlyOnly || method === 'GET', 'Export/verification cannot write to HugeGraph.');
    assert(path.startsWith('/') && !path.startsWith('//'), 'Invalid request path');
    const r = await fetch(this.base + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: this.#authorization, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) { await r.body?.cancel(); throw new Error(`HTTP ${r.status}: ${method} ${path}`); }
    return r.status === 204 ? {} : r.json();
  }
}
export type Api = Pick<Client, 'request'>;
export function credentialClient(base: string, readonlyOnly = true): Client {
  const username = process.env.HUGEGRAPH_USERNAME, password = process.env.HUGEGRAPH_PASSWORD;
  delete process.env.HUGEGRAPH_USERNAME; delete process.env.HUGEGRAPH_PASSWORD;
  assert(username && password, 'Credentials required. Use the PowerShell wrapper for hidden local password input.');
  return new Client(base, username, password, readonlyOnly);
}
export async function discover(api: Api, requested: string): Promise<string> {
  assert(requested && !requested.startsWith('~') && !requested.startsWith('__'), 'A non-system graph name is required.');
  const prefix = '/graphspaces/DEFAULT/graphs';
  const response = await api.request('GET', prefix);
  assert(Array.isArray(response.graphs), 'Invalid graph-list response');
  const names = response.graphs.map((x: any) => typeof x === 'string' ? x : x.name);
  assert(names.includes(requested), `Existing graph not found: ${requested}. No graph will be created.`);
  return prefix + '/' + encodeURIComponent(requested);
}
export async function list(api: Api, graph: string, resource: 'vertices' | 'edges'): Promise<Row[]> {
  const result: Row[] = [], tokens = new Set<string>(), ids = new Set<string>();
  let page = '';
  do {
    const r = await api.request('GET', `${graph}/graph/${resource}?${new URLSearchParams({ limit: '100', page })}`);
    assert(Array.isArray(r[resource]), `Invalid ${resource} page`);
    for (const row of r[resource]) {
      const key = idKey(row.id); assert(key !== undefined && !ids.has(key), `Duplicate/missing ${resource} ID`);
      ids.add(key); result.push(row);
    }
    page = r.page ?? ''; assert(typeof page === 'string' && (!page || !tokens.has(page)), 'Invalid/repeated pagination token');
    if (page) tokens.add(page);
  } while (page);
  return result.sort((a, b) => idKey(a.id).localeCompare(idKey(b.id)));
}
export async function snapshot(api: Api, graph: string): Promise<Snapshot> {
  const schema = await api.request('GET', graph + '/schema');
  for (const kind of schemaKinds) {
    assert(Array.isArray(schema[kind]), `Missing Schema collection: ${kind}`);
    schema[kind].sort((a: Row, b: Row) => a.name.localeCompare(b.name));
  }
  const state = { schema, vertices: await list(api, graph, 'vertices'), edges: await list(api, graph, 'edges') };
  validate(state); return state;
}
export function validate(state: Snapshot): void {
  const ids = new Map(state.vertices.map(v => [idKey(v.id), v]));
  assert(ids.size === state.vertices.length, 'Duplicate vertex IDs');
  assert(new Set(state.edges.map(e => idKey(e.id))).size === state.edges.length, 'Duplicate edge IDs');
  for (const kind of schemaKinds) {
    assert(Array.isArray(state.schema[kind]), `Missing Schema: ${kind}`);
    assert(new Set(state.schema[kind].map(d => d.name)).size === state.schema[kind].length, `Duplicate Schema: ${kind}`);
  }
  const vl = new Map(state.schema.vertexlabels.map(d => [d.name, d]));
  const el = new Map(state.schema.edgelabels.map(d => [d.name, d]));
  for (const v of state.vertices) assert(vl.has(v.label) && v.properties && typeof v.properties === 'object', 'Vertex without valid Schema/properties');
  for (const e of state.edges) {
    const out = ids.get(idKey(e.outV)), into = ids.get(idKey(e.inV)), label = el.get(e.label);
    assert(out && into && label, 'Dangling edge or unknown EdgeLabel');
    assert(out.label === e.outVLabel && into.label === e.inVLabel && label.source_label === out.label && label.target_label === into.label, 'Edge endpoint label mismatch');
  }
  // Refuse label/schema features not representable by the portable importer.
  for (const d of [...state.schema.vertexlabels, ...state.schema.edgelabels]) assert(Number(d.ttl ?? 0) === 0, 'TTL data require an official backup tool; portable importer does not support expiration.');
}
export function counts(state: Snapshot) {
  const byLabel = (rows: Row[]) => Object.fromEntries([...new Set(rows.map(r => r.label))].sort().map(label => [label, rows.filter(r => r.label === label).length]));
  const groups = state.vertices.filter(v => v.label === 'FieldGroup');
  return { schema: Object.fromEntries(schemaKinds.map(k => [k, state.schema[k].length])),
    vertices: byLabel(state.vertices), edges: byLabel(state.edges), totalVertices: state.vertices.length, totalEdges: state.edges.length,
    fieldGroups: groups.length, fieldDefinitions: groups.reduce((n, v) => n + JSON.parse(v.properties.fields_json).length, 0) };
}
export async function readBackup(file: string): Promise<{ document: any; state: Snapshot }> {
  const bytes = await readFile(file);
  const expected = (await readFile(file + '.sha256', 'utf8')).trim().split(/\s+/)[0];
  assert(/^[a-f0-9]{64}$/.test(expected) && hash(bytes) === expected, 'Backup checksum mismatch');
  const document = JSON.parse(bytes.toString('utf8'));
  assert(document.format === 'softwarefactory-hugegraph-rest-v1', 'Unsupported backup format (not a HugeGraph-Tools backup).');
  const state = document.data as Snapshot; validate(state);
  assert(hash(canonical(state)) === document.dataSha256, 'Backup content digest mismatch');
  return { document, state };
}
