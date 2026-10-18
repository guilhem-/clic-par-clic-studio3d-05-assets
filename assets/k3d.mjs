// k3d tooling used by importer.mjs: cluster nodes, images in the nodes, image labels, kubectl.
// No registry: the images are imported into the nodes with "k3d image import".
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Target cluster: tterm by default (the one in the video); K3D_CLUSTER for another one.
export const CLUSTER = process.env.K3D_CLUSTER ?? 'tterm';
export const CONTEXT = `k3d-${CLUSTER}`;
/**
 * k3d executable: K3D_BIN, otherwise the one installed by winget (its folder is only in the PATH
 * of terminals opened after the installation), otherwise "k3d".
 */
function findK3d() {
  if (process.env.K3D_BIN) return process.env.K3D_BIN;
  const packages = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  const folder = fs.existsSync(packages) ? fs.readdirSync(packages).find((d) => d.startsWith('k3d.k3d_')) : null;
  const exe = folder ? path.join(packages, folder, 'k3d.exe') : null;
  return exe && fs.existsSync(exe) ? exe : 'k3d';
}
export const K3D = findK3d();

export const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...opts });

/** Text output of a kubectl command on the cluster. */
export const read = (args) => run('kubectl', ['--context', CONTEXT, ...args]);

/** Docker containers of the k3s nodes (servers and agents) of the cluster. */
export function nodes() {
  return run('docker', ['ps', '--filter', `label=k3d.cluster=${CLUSTER}`, '--format', '{{.Names}} {{.Label "k3d.role"}}'])
    .trim().split('\n').map((l) => l.split(' ')).filter(([, role]) => role === 'server' || role === 'agent').map(([n]) => n);
}

/** Image `name` in the containerd of a node: { id }, or null if missing. */
export function nodeImage(node, name) {
  const ref = name.includes('/') ? name : `docker.io/library/${name}`;
  try {
    const info = JSON.parse(run('docker', ['exec', node, 'crictl', '-r', 'unix:///run/k3s/containerd/containerd.sock',
      'inspecti', '-o', 'json', ref], { stdio: ['pipe', 'pipe', 'ignore'] }));
    return { id: info.status?.id };
  } catch { return null; }
}

/** Value of a label of a local image (empty string if the image or the label is missing). */
export function label(name, key) {
  try { return run('docker', ['image', 'inspect', name, '--format', `{{ index .Config.Labels "${key}" }}`], { stdio: ['pipe', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

/** Fingerprint (shortened SHA-256) of a list of files: to rebuild an image when its sources change. */
export function fingerprint(files) {
  const h = createHash('sha256');
  for (const f of files) h.update(path.basename(f)).update(fs.existsSync(f) ? fs.readFileSync(f) : '');
  return h.digest('hex').slice(0, 16);
}
