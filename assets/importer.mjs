// Asset library of the 3D studio (module s3d05): downloads the chosen assets (Poly Haven API),
// checks their MD5 fingerprints, prepares them in Blender (prepare.py, in the studio image),
// builds the asset image studio3d-assets:<version> (FROM scratch: nothing but files),
// imports it into the cluster nodes and, with --deploy, writes it into the manifest and into the
// two deployments (MCP server and workers). The studio image (Blender) is never rebuilt.
//
//   node assets/importer.mjs                    builds the version of selection.json
//   node assets/importer.mjs --deploy           … then mounts it in the studio
//   node assets/importer.mjs --add potted_plant_01 --name potted_plant --deploy
//                                                adds a Poly Haven asset: next version
//   --no-import: builds the image without importing it into the cluster; --reprepare: prepares again;
//   --rebuild: rebuilds and reimports the image even if it is up to date
//
// No dependency (Node 20 or later). Poly Haven: public, free API, an explicit User-Agent on every
// request; assets under the CC0 license. The downloaded (downloads/) and prepared (prepared/,
// library/) files stay out of git.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as k3d from './k3d.mjs'; // k3d tooling (cluster nodes, image import, kubectl)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELECTION = path.join(HERE, 'selection.json');
const DOWNLOADS = path.join(HERE, 'downloads');
const PREPARED = path.join(HERE, 'prepared');
const LIBRARY = path.join(HERE, 'library');
const MANIFEST = process.env.STUDIO_MANIFEST ?? path.join(HERE, '..', 'k8s-scale.yaml');
export const ASSETS_IMAGE = process.env.ASSETS_IMAGE ?? 'studio3d-assets';
/** Studio image that prepares the assets (its Blender): the same as the workers'. */
export const BLENDER_IMAGE = process.env.BLENDER_IMAGE ?? 'studio3d:4';
const NAMESPACE = 'studio3d';
const API = 'https://api.polyhaven.com';
const UA = 'clic-par-clic-studio3d/1.0'; // required by Poly Haven: a User-Agent that identifies the project
const PREPARATION_VERSION = '1'; // to change when prepare.py changes: everything is prepared again

let say = (line) => console.log(line);
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const meters = (d) => d.map((x) => x.toFixed(2)).join(' × ');

// ---------------------------------------------------------------- Selection

export const readSelection = () => JSON.parse(fs.readFileSync(SELECTION, 'utf8'));
const writeSelection = (s) => fs.writeFileSync(SELECTION, `${JSON.stringify(s, null, 2)}\n`);

// ---------------------------------------------------------------- Download (Poly Haven API)

async function api(route) {
  const r = await fetch(`${API}${route}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Poly Haven ${route}: ${r.status}`);
  return r.json();
}
const md5 = (f) => createHash('md5').update(fs.readFileSync(f)).digest('hex');

/** Downloads `url` into `file` if missing or if its MD5 differs; returns "downloaded" or "cached". */
async function download(url, expected, file) {
  if (fs.existsSync(file) && md5(file) === expected) return 'cached';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`download ${r.status}: ${url}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  if (md5(file) !== expected) { fs.rmSync(file); throw new Error(`wrong MD5 fingerprint: ${url}`); }
  return 'downloaded';
}

/** Files of an asset: object (.blend 1k and its textures) or environment (HDRI 2k). */
async function downloadAsset(name, sheet, kind) {
  const id = sheet.polyhaven;
  const folder = path.join(DOWNLOADS, id);
  const files = await api(`/files/${id}`);
  const info = await api(`/info/${id}`);
  const list = [];
  if (kind === 'model') {
    const b = files.blend?.['1k']?.blend;
    if (!b) throw new Error(`${id}: no 1k .blend file`);
    list.push([b.url, b.md5, path.join(folder, path.basename(b.url))]);
    for (const [rel, t] of Object.entries(b.include ?? {})) list.push([t.url, t.md5, path.join(folder, rel)]);
  } else {
    const h = files.hdri?.['2k']?.hdr;
    if (!h) throw new Error(`${id}: no 2k HDRI`);
    list.push([h.url, h.md5, path.join(folder, path.basename(h.url))]);
  }
  let size = 0;
  const states = new Set();
  for (const [url, expected, f] of list) {
    states.add(await download(url, expected, f));
    size += fs.statSync(f).size;
  }
  const state = states.has('downloaded') ? 'downloaded' : 'cached';
  return { file: list[0][2], authors: Object.keys(info.authors ?? {}), fingerprint: list.map((l) => l[1]).join(''), state, size };
}

// ---------------------------------------------------------------- Preparation (Blender)

/** Runs prepare.py in the Blender of the studio image (no Blender to install on the workstation). */
function blender(args) {
  return execFileSync('docker', ['run', '--rm',
    '-v', `${DOWNLOADS}:/input:ro`, '-v', `${PREPARED}:/output`, '-v', `${HERE}:/tools:ro`,
    BLENDER_IMAGE, '/opt/blender/blender', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}
const toDocker = (f) => `/input/${path.relative(DOWNLOADS, f).split(path.sep).join('/')}`;

const keyOf = (sheet, source) => createHash('sha256').update(PREPARATION_VERSION + source.fingerprint + JSON.stringify(sheet)).digest('hex').slice(0, 16);
const recordOf = (name) => { const f = path.join(PREPARED, 'records', `${name}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
/** Is the asset already prepared from these same files? */
const alreadyPrepared = (name, sheet, source) => recordOf(name)?.key === keyOf(sheet, source);

/** Prepares an asset in Blender (the result is kept in prepared/ as long as the source does not change). */
function prepare(name, sheet, kind, source) {
  const key = keyOf(sheet, source);
  fs.mkdirSync(path.join(PREPARED, 'records'), { recursive: true });
  const parameters = JSON.stringify({ name, key, kind, polyhaven: sheet.polyhaven, catalog: sheet.catalog ?? 'environments', description: sheet.description?.EN ?? '', tags: sheet.tags ?? [] });
  const output = kind === 'model'
    ? blender(['-b', toDocker(source.file), '--python', '/tools/prepare.py', '--', 'model', parameters])
    : blender(['-b', '--factory-startup', '--python', '/tools/prepare.py', '--', 'environment', parameters, toDocker(source.file)]);
  if (recordOf(name)?.key !== key) {
    const errors = output.split('\n').filter((l) => /Error|error|Traceback/i.test(l)).slice(-12);
    throw new Error(`preparation of ${name} failed:\n${errors.join('\n')}`);
  }
  return recordOf(name);
}
const measures = (f) => (f.dimensions_m ? `${meters(f.dimensions_m)} m` : 'HDRI 2k');

// ---------------------------------------------------------------- Assembly and image

/** Catalog read by the studio: names in three languages, dimensions, source and license of each asset. */
function catalog(selection, prepared, authors) {
  const sheet = (name, f, kind) => ({
    file: kind === 'model' ? `models/${name}/model.blend` : `environments/${name}.hdr`,
    ...(kind === 'model' ? { collection: name } : {}),
    name: f.name,
    description: f.description,
    tags: f.tags ?? [],
    ...(kind === 'model' ? { dimensions_m: prepared[name].dimensions_m, catalog: selection.catalogs[f.catalog]?.EN } : {}),
    thumbnail: `thumbnails/${name}.jpg`,
    source: { polyhaven: f.polyhaven, url: `https://polyhaven.com/a/${f.polyhaven}`, authors: authors[name], license: 'CC0' },
  });
  return {
    version: selection.version,
    source: selection.source,
    models: Object.fromEntries(Object.entries(selection.models).map(([n, f]) => [n, sheet(n, f, 'model')])),
    environments: Object.fromEntries(Object.entries(selection.environments).map(([n, f]) => [n, sheet(n, f, 'environment')])),
  };
}

/** Catalogs of Blender's Asset Browser (the same folder opened as an "Asset Library" on a workstation). */
function blenderCats(selection) {
  const lines = ['# Catalogs of the studio library (Blender Asset Browser)', 'VERSION 1', ''];
  for (const [key, names] of Object.entries(selection.catalogs)) lines.push(`${catalogUuid(key)}:${names.EN}:${names.EN}`);
  return `${lines.join('\n')}\n`;
}
/** Stable UUID of a catalog (derived from its key), the same as the one written by prepare.py. */
export const catalogUuid = (key) => {
  const h = createHash('sha1').update(`studio3d:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Indented JSON, but lists of simple values on one line: a readable catalog. */
function readableJson(value, indent = '') {
  const simple = (v) => v === null || typeof v !== 'object';
  if (simple(value)) return JSON.stringify(value);
  if (Array.isArray(value) && value.every(simple)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  const next = `${indent}  `;
  const items = Array.isArray(value)
    ? value.map((v) => `${next}${readableJson(v, next)}`)
    : Object.entries(value).map(([k, v]) => `${next}${JSON.stringify(k)}: ${readableJson(v, next)}`);
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return items.length ? `${open}\n${items.join(',\n')}\n${indent}${close}` : `${open}${close}`;
}

/** Copies into library/ what goes into the image (and nothing else). */
function assemble(selection, cat) {
  fs.rmSync(LIBRARY, { recursive: true, force: true });
  fs.mkdirSync(path.join(LIBRARY, 'thumbnails'), { recursive: true });
  for (const name of Object.keys(selection.models)) {
    fs.cpSync(path.join(PREPARED, 'models', name), path.join(LIBRARY, 'models', name), { recursive: true });
    fs.copyFileSync(path.join(PREPARED, 'thumbnails', `${name}.jpg`), path.join(LIBRARY, 'thumbnails', `${name}.jpg`));
  }
  fs.mkdirSync(path.join(LIBRARY, 'environments'), { recursive: true });
  for (const name of Object.keys(selection.environments)) {
    fs.copyFileSync(path.join(PREPARED, 'environments', `${name}.hdr`), path.join(LIBRARY, 'environments', `${name}.hdr`));
    fs.copyFileSync(path.join(PREPARED, 'thumbnails', `${name}.jpg`), path.join(LIBRARY, 'thumbnails', `${name}.jpg`));
  }
  fs.writeFileSync(path.join(LIBRARY, 'catalog.json'), `${readableJson(cat)}\n`);
  fs.writeFileSync(path.join(LIBRARY, 'blender_assets.cats.txt'), blenderCats(selection));
}

const folderSize = (d) => fs.readdirSync(d, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile()).reduce((n, e) => n + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size, 0);
/** Fingerprint of the content of library/: the image is rebuilt only if it changes. */
const libraryFingerprint = () => k3d.fingerprint(fs.readdirSync(LIBRARY, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name)).sort());

/** Builds the asset image and imports it into the nodes (skipped if already up to date). */
function buildImage(version, { importIt = true, rebuild = false } = {}) {
  const image = `${ASSETS_IMAGE}:${version}`;
  const fingerprint = libraryFingerprint();
  const upToDate = !rebuild && k3d.label(image, 'clic-par-clic.fingerprint') === fingerprint;
  if (!upToDate) {
    execFileSync('docker', ['build', '-q', '-t', image, '--label', `clic-par-clic.fingerprint=${fingerprint}`, HERE], { stdio: ['ignore', 'pipe', 'inherit'] });
  }
  say(`  docker build -t ${image} (${mb(folderSize(LIBRARY))}${upToDate ? ', already built' : ''})`);
  if (importIt) {
    const id = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
    const nodes = k3d.nodes();
    if (!rebuild && nodes.every((n) => k3d.nodeImage(n, image)?.id === id)) say(`  k3d image import: already in the ${nodes.length} nodes`);
    else {
      const t0 = Date.now();
      execFileSync(k3d.K3D, ['image', 'import', image, '-c', k3d.CLUSTER], { stdio: 'ignore' }); // into each node
      say(`  k3d image import: ${nodes.length} nodes (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }
  return image;
}

// ---------------------------------------------------------------- Deployment

/** Library version written in the manifest (k8s-scale.yaml). */
export function manifestVersion() {
  return Number(fs.readFileSync(MANIFEST, 'utf8').match(new RegExp(`reference: ${ASSETS_IMAGE}:(\\d+)`))?.[1] ?? 0);
}

/** Version mounted by a studio deployment (reference of its "assets" volume). */
export function deployedVersion(deployment = 'studio-api') {
  try {
    const ref = k3d.read(['get', `deploy/${deployment}`, '-n', NAMESPACE, '-o', 'jsonpath={.spec.template.spec.volumes[?(@.name=="assets")].image.reference}']).trim();
    return Number(ref.split(':')[1] ?? 0);
  } catch { return 0; }
}

/**
 * Writes the version into the manifest, then into the two deployments: the template change
 * replaces the pods gradually (the two server copies take turns; the running workers finish
 * their render, the next ones start with the new library).
 */
export function deploy(version, { wait = true } = {}) {
  const image = `${ASSETS_IMAGE}:${version}`;
  const text = fs.readFileSync(MANIFEST, 'utf8');
  const updated = text.replace(new RegExp(`reference: ${ASSETS_IMAGE}:\\d+`, 'g'), `reference: ${image}`);
  if (updated !== text) fs.writeFileSync(MANIFEST, updated);
  say(`  ${path.basename(MANIFEST)}: reference: ${image}`);
  const patch = JSON.stringify({ spec: { template: { spec: { volumes: [{ name: 'assets', image: { reference: image, pullPolicy: 'IfNotPresent' } }] } } } });
  for (const d of ['studio-api', 'studio-worker']) {
    if (deployedVersion(d) !== Number(version)) k3d.read(['patch', `deployment/${d}`, '-n', NAMESPACE, '--type', 'strategic', '-p', patch]);
  }
  if (!wait) return;
  for (const d of ['studio-api', 'studio-worker']) {
    k3d.read(['rollout', 'status', `deployment/${d}`, '-n', NAMESPACE, '--timeout=240s']);
    const ready = k3d.read(['get', `deployment/${d}`, '-n', NAMESPACE, '-o', 'jsonpath={.status.readyReplicas}']).trim() || '0';
    say(`  ${d}: up to date (${Number(ready) > 1 ? `${ready} copies ready` : Number(ready) === 1 ? '1 copy ready' : 'no pod yet: the next ones will start with this version'})`);
  }
}

/**
 * Removes an asset from the selection (it goes back to the "proposed" ones); `version`: number to
 * go back to (return to a version already built, to replay a demo). The image of that version
 * must still exist: deploy(version) mounts it again.
 */
export function remove(name, { version = null } = {}) {
  const s = readSelection();
  if (s.models[name]) {
    s.proposed = { ...(s.proposed ?? {}), [name]: s.models[name] };
    delete s.models[name];
  }
  if (version) s.version = Number(version);
  writeSelection(s);
}

/** Downloads the files of an object (selected or proposed) in advance, without preparing it. */
export async function preload(name) {
  const s = readSelection();
  const sheet = s.models[name] ?? s.proposed?.[name];
  if (!sheet) throw new Error(`${name}: neither in the selection nor among the proposed assets`);
  return downloadAsset(name, sheet, 'model');
}

/** Forgets the preparation of an asset: it will be done again in Blender on the next build. */
export function forgetPreparation(name) {
  for (const f of [path.join('records', `${name}.json`), path.join('models', name), path.join('thumbnails', `${name}.jpg`), path.join('environments', `${name}.hdr`)]) {
    fs.rmSync(path.join(PREPARED, f), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- Full build

/**
 * Builds the library of the selection (version of selection.json): download, preparation,
 * assembly, image, import. `add`: { id, name } of a Poly Haven asset to add (version + 1).
 * `output(line)` receives the log lines (live terminal card). Returns the version.
 */
export async function build({ add = null, deploy: mount = false, importIt = true, reprepare = false, rebuild = false, output = null, summary = Boolean(add) } = {}) {
  if (output) say = output;
  try {
    const selection = readSelection();
    if (add) {
      const { id, name } = add;
      if (selection.models[name]) throw new Error(`${name} is already in the library (version ${selection.version})`);
      const proposed = Object.values(selection.proposed ?? {}).find((p) => p.polyhaven === id) ?? selection.proposed?.[name];
      const info = proposed ? null : await api(`/info/${id}`);
      selection.models[name] = proposed ?? { polyhaven: id, catalog: 'decoration', name: { EN: info.name, FR: info.name, DE: info.name }, description: { EN: info.description ?? '', FR: '', DE: '' }, tags: info.tags ?? [] };
      if (selection.proposed) for (const [k, p] of Object.entries(selection.proposed)) if (p === proposed) delete selection.proposed[k];
      selection.version += 1;
      writeSelection(selection);
    }
    say(`# Asset library, version ${selection.version}`);
    const prepared = {};
    const authors = {};
    const toPrepare = [];
    let unchanged = 0;
    // Environments first: the object thumbnails are rendered under the soft_studio lighting.
    for (const kind of ['environment', 'model']) {
      const sheets = kind === 'model' ? selection.models : selection.environments;
      for (const [name, sheet] of Object.entries(sheets)) {
        const source = await downloadAsset(name, sheet, kind);
        authors[name] = source.authors;
        if (!reprepare && source.state === 'cached' && alreadyPrepared(name, sheet, source)) {
          prepared[name] = recordOf(name);
          unchanged += 1;
          if (!summary) say(`  ${name}: cached, MD5 checked · already prepared, ${measures(prepared[name])}`);
        } else toPrepare.push([name, sheet, kind, source]);
      }
    }
    if (summary && unchanged) say(`  ${unchanged} assets unchanged: cached, MD5 checked, already prepared`);
    for (const [name, sheet, kind, source] of toPrepare) {
      say(`  ${name}: ${source.state}, MD5 checked (${mb(source.size)})`);
      say(`  ${name}: preparing in Blender…`);
      prepared[name] = prepare(name, sheet, kind, source);
      say(`  ${name}: prepared in Blender, ${measures(prepared[name])}`);
    }
    const cat = catalog(selection, prepared, authors);
    assemble(selection, cat);
    say(`  catalog.json: ${Object.keys(cat.models).length} objects, ${Object.keys(cat.environments).length} environments`);
    buildImage(selection.version, { importIt, rebuild });
    if (mount) deploy(selection.version);
    return selection.version;
  } finally {
    say = (line) => console.log(line);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const id = arg('--add');
  const name = arg('--name') ?? id?.replace(/_\d+$/, '');
  build({
    add: id ? { id, name } : null,
    deploy: process.argv.includes('--deploy'),
    importIt: !process.argv.includes('--no-import'),
    reprepare: process.argv.includes('--reprepare'),
    rebuild: process.argv.includes('--rebuild'),
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
