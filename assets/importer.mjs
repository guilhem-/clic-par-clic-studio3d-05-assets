// Bibliothèque d'assets du studio 3D (module s3d05) : télécharge les assets choisis (API Poly Haven),
// vérifie leurs empreintes MD5, les prépare dans Blender (preparer.py, dans l'image du studio),
// construit l'image d'assets studio3d-assets:<version> (FROM scratch : rien que des fichiers),
// l'importe dans les nœuds du cluster et, avec --deployer, l'inscrit dans le manifeste et dans les
// deux déploiements (serveur MCP et workers). L'image du studio (Blender) n'est jamais reconstruite.
//
//   node services/studio3d/assets/importer.mjs                    construit la version de selection.json
//   node services/studio3d/assets/importer.mjs --deployer         … puis la monte dans le studio
//   node services/studio3d/assets/importer.mjs --ajouter potted_plant_01 --nom plante_verte --deployer
//                                                                  ajoute un asset Poly Haven : version suivante
//   --sans-import : construit l'image sans l'importer dans le cluster ; --reparer : refait la préparation ;
//   --reconstruire : reconstruit et réimporte l'image même si elle est à jour
//
// Sans dépendance (Node 20 ou plus). Poly Haven : API publique, gratuite, un User-Agent explicite à
// chaque requête ; assets sous licence CC0. Les fichiers téléchargés (telechargements/) et préparés
// (preparees/, bibliotheque/) restent hors git.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as k3d from './k3d.mjs'; // outillage k3d (copie de services/k3d/k3d.mjs du projet de tournage)

const ICI = path.dirname(fileURLToPath(import.meta.url));
const SELECTION = path.join(ICI, 'selection.json');
const TELECHARGEMENTS = path.join(ICI, 'telechargements');
const PREPAREES = path.join(ICI, 'preparees');
const BIBLIOTHEQUE = path.join(ICI, 'bibliotheque');
const MANIFESTE = path.join(ICI, '..', 'k8s-echelle.yaml');
export const IMAGE_ASSETS = 'studio3d-assets';
/** Image du studio qui prépare les assets (son Blender) : la même que celle des workers. */
export const IMAGE_BLENDER = process.env.IMAGE_BLENDER ?? 'studio3d:4';
const ESPACE = 'studio3d';
const API = 'https://api.polyhaven.com';
const UA = 'clic-par-clic-studio3d/1.0'; // exigé par Poly Haven : un User-Agent qui identifie le projet
const VERSION_PREPARATION = '1'; // à changer quand preparer.py change : tout est préparé à nouveau

let dire = (ligne) => console.log(ligne);
const mo = (octets) => `${(octets / 1e6).toFixed(1).replace('.', ',')} Mo`;
const metres = (d) => d.map((x) => x.toFixed(2).replace('.', ',')).join(' × ');

// ---------------------------------------------------------------- Sélection

export const lireSelection = () => JSON.parse(fs.readFileSync(SELECTION, 'utf8'));
const ecrireSelection = (s) => fs.writeFileSync(SELECTION, `${JSON.stringify(s, null, 2)}\n`);

// ---------------------------------------------------------------- Téléchargement (API Poly Haven)

async function api(chemin) {
  const r = await fetch(`${API}${chemin}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Poly Haven ${chemin} : ${r.status}`);
  return r.json();
}
const md5 = (f) => createHash('md5').update(fs.readFileSync(f)).digest('hex');

/** Télécharge `url` dans `fichier` si absent ou si son MD5 diffère ; renvoie « téléchargé » ou « en cache ». */
async function telecharger(url, attendu, fichier) {
  if (fs.existsSync(fichier) && md5(fichier) === attendu) return 'en cache';
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`téléchargement ${r.status} : ${url}`);
  fs.writeFileSync(fichier, Buffer.from(await r.arrayBuffer()));
  if (md5(fichier) !== attendu) { fs.rmSync(fichier); throw new Error(`empreinte MD5 incorrecte : ${url}`); }
  return 'téléchargé';
}

/** Fichiers d'un asset : objet (.blend 1k et ses textures) ou environnement (HDRI 2k). */
async function telechargerAsset(nom, fiche, genre) {
  const id = fiche.polyhaven;
  const dossier = path.join(TELECHARGEMENTS, id);
  const fichiers = await api(`/files/${id}`);
  const info = await api(`/info/${id}`);
  const liste = [];
  if (genre === 'modele') {
    const b = fichiers.blend?.['1k']?.blend;
    if (!b) throw new Error(`${id} : pas de fichier .blend 1k`);
    liste.push([b.url, b.md5, path.join(dossier, path.basename(b.url))]);
    for (const [rel, t] of Object.entries(b.include ?? {})) liste.push([t.url, t.md5, path.join(dossier, rel)]);
  } else {
    const h = fichiers.hdri?.['2k']?.hdr;
    if (!h) throw new Error(`${id} : pas de HDRI 2k`);
    liste.push([h.url, h.md5, path.join(dossier, path.basename(h.url))]);
  }
  let taille = 0;
  const etats = new Set();
  for (const [url, attendu, f] of liste) {
    etats.add(await telecharger(url, attendu, f));
    taille += fs.statSync(f).size;
  }
  const etat = etats.has('téléchargé') ? 'téléchargé' : 'en cache';
  return { fichier: liste[0][2], auteurs: Object.keys(info.authors ?? {}), empreinte: liste.map((l) => l[1]).join(''), etat, taille };
}

// ---------------------------------------------------------------- Préparation (Blender)

/** Lance preparer.py dans le Blender de l'image du studio (aucun Blender à installer sur le poste). */
function blender(args) {
  return execFileSync('docker', ['run', '--rm',
    '-v', `${TELECHARGEMENTS}:/entree:ro`, '-v', `${PREPAREES}:/sortie`, '-v', `${ICI}:/outils:ro`,
    IMAGE_BLENDER, '/opt/blender/blender', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}
const versDocker = (f) => `/entree/${path.relative(TELECHARGEMENTS, f).split(path.sep).join('/')}`;

const cleDe = (fiche, source) => createHash('sha256').update(VERSION_PREPARATION + source.empreinte + JSON.stringify(fiche)).digest('hex').slice(0, 16);
const ficheDe = (nom) => { const f = path.join(PREPAREES, 'fiches', `${nom}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
/** L'asset est-il déjà préparé à partir de ces mêmes fichiers ? */
const dejaPrete = (nom, fiche, source) => ficheDe(nom)?.cle === cleDe(fiche, source);

/** Prépare un asset dans Blender (le résultat est gardé dans preparees/ tant que la source ne change pas). */
function preparer(nom, fiche, genre, source) {
  const cle = cleDe(fiche, source);
  fs.mkdirSync(path.join(PREPAREES, 'fiches'), { recursive: true });
  const parametres = JSON.stringify({ nom, cle, genre, polyhaven: fiche.polyhaven, catalogue: fiche.catalogue ?? 'environnements', description: fiche.description?.EN ?? '', etiquettes: fiche.etiquettes ?? [] });
  const sortie = genre === 'modele'
    ? blender(['-b', versDocker(source.fichier), '--python', '/outils/preparer.py', '--', 'modele', parametres])
    : blender(['-b', '--factory-startup', '--python', '/outils/preparer.py', '--', 'environnement', parametres, versDocker(source.fichier)]);
  if (ficheDe(nom)?.cle !== cle) {
    const erreurs = sortie.split('\n').filter((l) => /Error|erreur|Traceback/i.test(l)).slice(-12);
    throw new Error(`préparation de ${nom} échouée :\n${erreurs.join('\n')}`);
  }
  return ficheDe(nom);
}
const mesures = (f) => (f.dimensions_m ? `${metres(f.dimensions_m)} m` : 'HDRI 2k');

// ---------------------------------------------------------------- Assemblage et image

/** Catalogue lu par le studio : noms en trois langues, dimensions, source et licence de chaque asset. */
function catalogue(selection, preparees, auteurs) {
  const fiche = (nom, f, genre) => ({
    fichier: genre === 'modele' ? `modeles/${nom}/modele.blend` : `environnements/${nom}.hdr`,
    ...(genre === 'modele' ? { collection: nom } : {}),
    nom: f.nom,
    description: f.description,
    etiquettes: f.etiquettes ?? [],
    ...(genre === 'modele' ? { dimensions_m: preparees[nom].dimensions_m, catalogue: selection.catalogues[f.catalogue]?.FR } : {}),
    vignette: `vignettes/${nom}.jpg`,
    source: { polyhaven: f.polyhaven, url: `https://polyhaven.com/a/${f.polyhaven}`, auteurs: auteurs[nom], licence: 'CC0' },
  });
  return {
    version: selection.version,
    source: selection.source,
    modeles: Object.fromEntries(Object.entries(selection.modeles).map(([n, f]) => [n, fiche(n, f, 'modele')])),
    environnements: Object.fromEntries(Object.entries(selection.environnements).map(([n, f]) => [n, fiche(n, f, 'environnement')])),
  };
}

/** Catalogues de l'Asset Browser de Blender (même dossier ouvert comme « Asset Library » sur un poste). */
function catsBlender(selection) {
  const lignes = ['# Catalogues de la bibliothèque du studio (Asset Browser de Blender)', 'VERSION 1', ''];
  for (const [cle, noms] of Object.entries(selection.catalogues)) lignes.push(`${uuidCatalogue(cle)}:${noms.FR}:${noms.FR}`);
  return `${lignes.join('\n')}\n`;
}
/** UUID stable d'un catalogue (dérivé de sa clé), le même que celui écrit par preparer.py. */
export const uuidCatalogue = (cle) => {
  const h = createHash('sha1').update(`studio3d:${cle}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** JSON indenté, mais listes de valeurs simples sur une ligne : un catalogue lisible. */
function jsonLisible(valeur, retrait = '') {
  const simple = (v) => v === null || typeof v !== 'object';
  if (simple(valeur)) return JSON.stringify(valeur);
  if (Array.isArray(valeur) && valeur.every(simple)) return `[${valeur.map((v) => JSON.stringify(v)).join(', ')}]`;
  const suivant = `${retrait}  `;
  const elements = Array.isArray(valeur)
    ? valeur.map((v) => `${suivant}${jsonLisible(v, suivant)}`)
    : Object.entries(valeur).map(([k, v]) => `${suivant}${JSON.stringify(k)}: ${jsonLisible(v, suivant)}`);
  const [ouvre, ferme] = Array.isArray(valeur) ? ['[', ']'] : ['{', '}'];
  return elements.length ? `${ouvre}\n${elements.join(',\n')}\n${retrait}${ferme}` : `${ouvre}${ferme}`;
}

/** Copie dans bibliotheque/ ce qui entre dans l'image (et rien d'autre). */
function assembler(selection, cat) {
  fs.rmSync(BIBLIOTHEQUE, { recursive: true, force: true });
  fs.mkdirSync(path.join(BIBLIOTHEQUE, 'vignettes'), { recursive: true });
  for (const nom of Object.keys(selection.modeles)) {
    fs.cpSync(path.join(PREPAREES, 'modeles', nom), path.join(BIBLIOTHEQUE, 'modeles', nom), { recursive: true });
    fs.copyFileSync(path.join(PREPAREES, 'vignettes', `${nom}.jpg`), path.join(BIBLIOTHEQUE, 'vignettes', `${nom}.jpg`));
  }
  fs.mkdirSync(path.join(BIBLIOTHEQUE, 'environnements'), { recursive: true });
  for (const nom of Object.keys(selection.environnements)) {
    fs.copyFileSync(path.join(PREPAREES, 'environnements', `${nom}.hdr`), path.join(BIBLIOTHEQUE, 'environnements', `${nom}.hdr`));
    fs.copyFileSync(path.join(PREPAREES, 'vignettes', `${nom}.jpg`), path.join(BIBLIOTHEQUE, 'vignettes', `${nom}.jpg`));
  }
  fs.writeFileSync(path.join(BIBLIOTHEQUE, 'catalogue.json'), `${jsonLisible(cat)}\n`);
  fs.writeFileSync(path.join(BIBLIOTHEQUE, 'blender_assets.cats.txt'), catsBlender(selection));
}

const tailleDossier = (d) => fs.readdirSync(d, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile()).reduce((n, e) => n + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size, 0);
/** Empreinte du contenu de bibliotheque/ : l'image n'est reconstruite que si elle change. */
const empreinteBibliotheque = () => k3d.empreinte(fs.readdirSync(BIBLIOTHEQUE, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name)).sort());

/** Construit l'image d'assets et l'importe dans les nœuds (sautés si déjà à jour). */
function construireImage(version, { importer = true, reconstruire = false } = {}) {
  const image = `${IMAGE_ASSETS}:${version}`;
  const empreinte = empreinteBibliotheque();
  const aJour = !reconstruire && k3d.etiquette(image, 'clic-par-clic.empreinte') === empreinte;
  if (!aJour) {
    execFileSync('docker', ['build', '-q', '-t', image, '--label', `clic-par-clic.empreinte=${empreinte}`, ICI], { stdio: ['ignore', 'pipe', 'inherit'] });
  }
  dire(`  docker build -t ${image} : ${mo(tailleDossier(BIBLIOTHEQUE))}${aJour ? ' (déjà construite)' : ''}`);
  if (importer) {
    const id = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
    const noeuds = k3d.noeuds();
    if (!reconstruire && noeuds.every((n) => k3d.imageNoeud(n, image)?.id === id)) dire(`  k3d image import : déjà dans les ${noeuds.length} nœuds`);
    else {
      const t0 = Date.now();
      execFileSync(k3d.K3D, ['image', 'import', image, '-c', k3d.CLUSTER], { stdio: 'ignore' }); // dans chaque nœud
      dire(`  k3d image import : ${noeuds.length} nœuds (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }
  return image;
}

// ---------------------------------------------------------------- Déploiement

/** Version de la bibliothèque inscrite dans le manifeste (k8s-echelle.yaml). */
export function versionManifeste() {
  return Number(fs.readFileSync(MANIFESTE, 'utf8').match(new RegExp(`reference: ${IMAGE_ASSETS}:(\\d+)`))?.[1] ?? 0);
}

/** Version montée par un déploiement du studio (référence de son volume « assets »). */
export function versionDeployee(deploiement = 'studio-api') {
  try {
    const ref = k3d.lire(['get', `deploy/${deploiement}`, '-n', ESPACE, '-o', 'jsonpath={.spec.template.spec.volumes[?(@.name=="assets")].image.reference}']).trim();
    return Number(ref.split(':')[1] ?? 0);
  } catch { return 0; }
}

/**
 * Inscrit la version dans le manifeste, puis dans les deux déploiements : le changement de gabarit
 * remplace les pods progressivement (les deux copies du serveur se relaient ; les workers en cours
 * finissent leur rendu, les suivants naissent avec la nouvelle bibliothèque).
 */
export function deployer(version, { attendre = true } = {}) {
  const image = `${IMAGE_ASSETS}:${version}`;
  const texte = fs.readFileSync(MANIFESTE, 'utf8');
  const nouveau = texte.replace(new RegExp(`reference: ${IMAGE_ASSETS}:\\d+`, 'g'), `reference: ${image}`);
  if (nouveau !== texte) fs.writeFileSync(MANIFESTE, nouveau);
  dire(`  k8s-echelle.yaml : reference: ${image}`);
  const patch = JSON.stringify({ spec: { template: { spec: { volumes: [{ name: 'assets', image: { reference: image, pullPolicy: 'IfNotPresent' } }] } } } });
  for (const d of ['studio-api', 'studio-travailleur']) {
    if (versionDeployee(d) !== Number(version)) k3d.lire(['patch', `deployment/${d}`, '-n', ESPACE, '--type', 'strategic', '-p', patch]);
  }
  if (!attendre) return;
  for (const d of ['studio-api', 'studio-travailleur']) {
    k3d.lire(['rollout', 'status', `deployment/${d}`, '-n', ESPACE, '--timeout=240s']);
    const pretes = k3d.lire(['get', `deployment/${d}`, '-n', ESPACE, '-o', 'jsonpath={.status.readyReplicas}']).trim() || '0';
    dire(`  ${d} : à jour (${Number(pretes) > 1 ? `${pretes} copies prêtes` : Number(pretes) === 1 ? '1 copie prête' : 'aucun pod pour l’instant : les prochains naîtront avec cette version'})`);
  }
}

/**
 * Retire un asset de la sélection (il repasse parmi les « proposés ») ; `version` : numéro à
 * reprendre (retour à une version déjà construite, pour rejouer une démonstration). L'image de
 * cette version doit encore exister : deployer(version) la remonte.
 */
export function retirer(nom, { version = null } = {}) {
  const s = lireSelection();
  if (s.modeles[nom]) {
    s.proposes = { ...(s.proposes ?? {}), [nom]: s.modeles[nom] };
    delete s.modeles[nom];
  }
  if (version) s.version = Number(version);
  ecrireSelection(s);
}

/** Télécharge à l'avance les fichiers d'un objet (sélectionné ou proposé), sans le préparer. */
export async function precharger(nom) {
  const s = lireSelection();
  const fiche = s.modeles[nom] ?? s.proposes?.[nom];
  if (!fiche) throw new Error(`${nom} : ni dans la sélection, ni parmi les assets proposés`);
  return telechargerAsset(nom, fiche, 'modele');
}

/** Oublie la préparation d'un asset : elle sera refaite dans Blender à la prochaine construction. */
export function effacerPreparation(nom) {
  for (const f of [path.join('fiches', `${nom}.json`), path.join('modeles', nom), path.join('vignettes', `${nom}.jpg`), path.join('environnements', `${nom}.hdr`)]) {
    fs.rmSync(path.join(PREPAREES, f), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- Construction complète

/**
 * Construit la bibliothèque de la sélection (version de selection.json) : téléchargement, préparation,
 * assemblage, image, import. `ajouter` : { id, nom } d'un asset Poly Haven à ajouter (version + 1).
 * `sortie(ligne)` reçoit les lignes du journal (carton terminal en direct). Renvoie la version.
 */
export async function construire({ ajouter = null, deployer: monter = false, importer = true, reparer = false, reconstruire = false, sortie = null, resume = Boolean(ajouter) } = {}) {
  if (sortie) dire = sortie;
  try {
    const selection = lireSelection();
    if (ajouter) {
      const { id, nom } = ajouter;
      if (selection.modeles[nom]) throw new Error(`${nom} est déjà dans la bibliothèque (version ${selection.version})`);
      const propose = Object.values(selection.proposes ?? {}).find((p) => p.polyhaven === id) ?? selection.proposes?.[nom];
      const info = propose ? null : await api(`/info/${id}`);
      selection.modeles[nom] = propose ?? { polyhaven: id, catalogue: 'decoration', nom: { FR: info.name, EN: info.name, DE: info.name }, description: { FR: '', EN: info.description ?? '', DE: '' }, etiquettes: info.tags ?? [] };
      if (selection.proposes) for (const [k, p] of Object.entries(selection.proposes)) if (p === propose) delete selection.proposes[k];
      selection.version += 1;
      ecrireSelection(selection);
    }
    dire(`# Bibliothèque d'assets, version ${selection.version}`);
    const preparees = {};
    const auteurs = {};
    const aPreparer = [];
    let inchanges = 0;
    // Environnements d'abord : les vignettes des objets sont rendues sous l'éclairage studio_doux.
    for (const genre of ['environnement', 'modele']) {
      const fiches = genre === 'modele' ? selection.modeles : selection.environnements;
      for (const [nom, fiche] of Object.entries(fiches)) {
        const source = await telechargerAsset(nom, fiche, genre);
        auteurs[nom] = source.auteurs;
        if (!reparer && source.etat === 'en cache' && dejaPrete(nom, fiche, source)) {
          preparees[nom] = ficheDe(nom);
          inchanges += 1;
          if (!resume) dire(`  ${nom} : en cache, MD5 vérifiée · déjà préparée, ${mesures(preparees[nom])}`);
        } else aPreparer.push([nom, fiche, genre, source]);
      }
    }
    if (resume && inchanges) dire(`  ${inchanges} assets inchangés : en cache, MD5 vérifiée, déjà préparés`);
    for (const [nom, fiche, genre, source] of aPreparer) {
      dire(`  ${nom} : ${source.etat === 'téléchargé' ? 'téléchargée' : 'en cache'}, MD5 vérifiée (${mo(source.taille)})`);
      preparees[nom] = preparer(nom, fiche, genre, source);
      dire(`  ${nom} : préparée dans Blender, ${mesures(preparees[nom])}`);
    }
    const cat = catalogue(selection, preparees, auteurs);
    assembler(selection, cat);
    dire(`  catalogue.json : ${Object.keys(cat.modeles).length} objets, ${Object.keys(cat.environnements).length} environnements`);
    construireImage(selection.version, { importer, reconstruire });
    if (monter) deployer(selection.version);
    return selection.version;
  } finally {
    dire = (ligne) => console.log(ligne);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (nom) => { const i = process.argv.indexOf(nom); return i > 0 ? process.argv[i + 1] : null; };
  const id = arg('--ajouter');
  const nom = arg('--nom') ?? id?.replace(/_\d+$/, '');
  construire({
    ajouter: id ? { id, nom } : null,
    deployer: process.argv.includes('--deployer'),
    importer: !process.argv.includes('--sans-import'),
    reparer: process.argv.includes('--reparer'),
    reconstruire: process.argv.includes('--reconstruire'),
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
