// Outillage commun du cluster k3d de tournage : construire et importer une image locale,
// créer un secret ou une ConfigMap, appliquer des manifestes, attendre un déploiement, retirer un espace de noms.
// Aucun registre : les images sont importées dans les nœuds par « k3d image import ».
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Cluster visé : tterm (tournage) par défaut ; un service d'un autre cluster (tgpu…) appelle utiliser().
export let CLUSTER = process.env.K3D_CLUSTER ?? 'tterm';
/**
 * Exécutable k3d : K3D_BIN, sinon celui installé par winget (son dossier n'est dans le PATH
 * que des terminaux ouverts après l'installation), sinon « k3d ».
 */
function trouverK3d() {
  if (process.env.K3D_BIN) return process.env.K3D_BIN;
  const paquets = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  const dossier = fs.existsSync(paquets) ? fs.readdirSync(paquets).find((d) => d.startsWith('k3d.k3d_')) : null;
  const exe = dossier ? path.join(paquets, dossier, 'k3d.exe') : null;
  return exe && fs.existsSync(exe) ? exe : 'k3d';
}
export const K3D = trouverK3d();
export let CONTEXTE = `k3d-${CLUSTER}`;

/** Fait viser un autre cluster à toutes les fonctions de ce module (ex. utiliser('tgpu')). */
export function utiliser(cluster) {
  CLUSTER = cluster;
  CONTEXTE = `k3d-${cluster}`;
}

export const run =(cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...opts });
const kubectl = (args, opts) => run('kubectl', ['--context', CONTEXTE, ...args], opts);

/**
 * Construit l'image si elle n'existe pas (ou si `force`), puis l'importe dans les nœuds du cluster.
 * `empreinte` (facultatif) : empreinte des sources, gardée en étiquette de l'image ; une image dont
 * l'étiquette diffère est reconstruite (sources modifiées depuis la dernière construction).
 * L'import est sauté quand chaque nœud a déjà cette image (même identifiant) ; la construction aussi
 * quand l'image locale a disparu (nettoyage de Docker) mais que les nœuds en ont la bonne version
 * (même empreinte) : une image de plusieurs Go met des dizaines de minutes à s'importer.
 */
export function image(nom, dossier, { force = false, empreinte = '' } = {}) {
  const existe = run('docker', ['images', '-q', nom]).trim();
  const perimee = existe && empreinte && etiquette(nom, 'clic-par-clic.empreinte') !== empreinte;
  const dansNoeuds = noeuds().map((n) => imageNoeud(n, nom));
  if (!force && !existe && empreinte && dansNoeuds.length && dansNoeuds.every((i) => i?.empreinte === empreinte)) return;
  if (force || !existe || perimee) {
    run('docker', ['build', '-t', nom, ...(empreinte ? ['--label', `clic-par-clic.empreinte=${empreinte}`] : []), dossier], { stdio: 'inherit' });
  }
  const id = run('docker', ['image', 'inspect', nom, '--format', '{{.Id}}']).trim();
  if (dansNoeuds.length && dansNoeuds.every((i) => i?.id === id)) return;
  run(K3D, ['image', 'import', nom, '-c', CLUSTER], { stdio: 'inherit' });
}

/** Conteneurs Docker des nœuds k3s (serveurs et agents) du cluster. */
export function noeuds() {
  return run('docker', ['ps', '--filter', `label=k3d.cluster=${CLUSTER}`, '--format', '{{.Names}} {{.Label "k3d.role"}}'])
    .trim().split('\n').map((l) => l.split(' ')).filter(([, role]) => role === 'server' || role === 'agent').map(([n]) => n);
}

/** Image `nom` dans le containerd d'un nœud : { id, empreinte }, ou null si absente. */
export function imageNoeud(noeud, nom) {
  const ref = nom.includes('/') ? nom : `docker.io/library/${nom}`;
  try {
    const info = JSON.parse(run('docker', ['exec', noeud, 'crictl', '-r', 'unix:///run/k3s/containerd/containerd.sock',
      'inspecti', '-o', 'json', ref], { stdio: ['pipe', 'pipe', 'ignore'] }));
    return { id: info.status?.id, empreinte: info.info?.imageSpec?.config?.Labels?.['clic-par-clic.empreinte'] ?? '' };
  } catch { return null; }
}

/** Valeur d'une étiquette d'une image locale (chaîne vide si l'image ou l'étiquette manque). */
export function etiquette(nom, cle) {
  try { return run('docker', ['image', 'inspect', nom, '--format', `{{ index .Config.Labels "${cle}" }}`], { stdio: ['pipe', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

/** Empreinte (SHA-256 abrégée) d'une liste de fichiers : pour reconstruire une image quand ses sources changent. */
export function empreinte(fichiers) {
  const h = createHash('sha256');
  for (const f of fichiers) h.update(path.basename(f)).update(fs.existsSync(f) ? fs.readFileSync(f) : '');
  return h.digest('hex').slice(0, 16);
}

/** Crée ou met à jour une ConfigMap à partir de fichiers ({ clé: chemin }), sans rien écrire sur le disque. */
export function configmap(espace, nom, fichiers) {
  const yaml = kubectl(['create', 'configmap', nom, '--namespace', espace,
    ...Object.entries(fichiers).map(([cle, f]) => `--from-file=${cle}=${f}`), '--dry-run=client', '-o', 'yaml']);
  kubectl(['apply', '-f', '-'], { input: yaml, stdio: ['pipe', 'inherit', 'inherit'] });
}

/** Crée l'espace de noms s'il n'existe pas. */
export function espace(nom) {
  const yaml = kubectl(['create', 'namespace', nom, '--dry-run=client', '-o', 'yaml']);
  kubectl(['apply', '-f', '-'], { input: yaml, stdio: ['pipe', 'inherit', 'inherit'] });
}

/** Applique un fichier de manifestes. */
export const appliquer = (fichier) => kubectl(['apply', '-f', fichier], { stdio: 'inherit' });

/** Applique des manifestes donnés en texte (sortie d'un « --dry-run=client -o yaml »). */
export const appliquerTexte = (yaml) => kubectl(['apply', '-f', '-'], { input: yaml, stdio: ['pipe', 'inherit', 'inherit'] });

/** Crée ou met à jour un secret générique (valeurs littérales), sans l'écrire sur le disque. */
export function secret(espace, nom, valeurs) {
  const yaml = kubectl(['create', 'secret', 'generic', nom, '--namespace', espace,
    ...Object.entries(valeurs).map(([k, v]) => `--from-literal=${k}=${v}`), '--dry-run=client', '-o', 'yaml']);
  kubectl(['apply', '-f', '-'], { input: yaml, stdio: ['pipe', 'inherit', 'inherit'] });
}

/** Redémarre un déploiement (nouvelle image, nouveau secret) et attend qu'il soit prêt. */
export function redemarrer(espace, deploiement, { timeout = '180s' } = {}) {
  kubectl(['rollout', 'restart', `deployment/${deploiement}`, '-n', espace], { stdio: 'inherit' });
  kubectl(['rollout', 'status', `deployment/${deploiement}`, '-n', espace, `--timeout=${timeout}`], { stdio: 'inherit' });
}

/** Le déploiement est-il présent et prêt ? */
export function pret(espace, deploiement) {
  try {
    return Number(kubectl(['get', `deployment/${deploiement}`, '-n', espace, '-o', 'jsonpath={.status.readyReplicas}']).trim() || 0) > 0;
  } catch { return false; }
}

/** Version de KEDA (mise à l'échelle pilotée par les événements : longueur d'une file Redis…). */
export const KEDA_VERSION = process.env.KEDA_VERSION ?? '2.21.0';

/** KEDA est-il installé (ses définitions de ressources) ? */
export function kedaInstalle() {
  try { kubectl(['get', 'crd', 'scaledobjects.keda.sh'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Installe KEDA dans l'espace de noms « keda » (manifeste officiel de la version), puis attend ses composants. */
export function installerKeda() {
  if (!kedaInstalle()) {
    const url = `https://github.com/kedacore/keda/releases/download/v${KEDA_VERSION}/keda-${KEDA_VERSION}.yaml`;
    kubectl(['apply', '--server-side', '-f', url], { stdio: 'inherit' });
  }
  for (const d of ['keda-operator', 'keda-metrics-apiserver', 'keda-admission']) {
    kubectl(['rollout', 'status', `deployment/${d}`, '-n', 'keda', '--timeout=300s'], { stdio: 'inherit' });
  }
}

/** Supprime une ressource si elle existe (ex. : passage d'une version du studio à l'autre). */
export const supprimer = (espace, ...ressources) => kubectl(['delete', ...ressources, '-n', espace, '--ignore-not-found'], { stdio: 'inherit' });

/** Sortie texte d'une commande kubectl (lecture, pour les cartons « terminal en direct »). */
export const lire = (args) => kubectl(args);

/** Supprime un espace de noms et tout ce qu'il contient. */
export const retirer = (espace) => kubectl(['delete', 'namespace', espace, '--ignore-not-found', '--wait=true'], { stdio: 'inherit' });
