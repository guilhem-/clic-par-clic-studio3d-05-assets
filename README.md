# An asset library for every render — Kubernetes image volume, MCP and Blender

Code for module 5 of the “Click by Click” series **Building an agent-ready AI service: the 3D studio**
(also published in French as « Clic par clic » and in German as « Klick für Klick »).

Video: {{video}}

## Goal

Until now, the language model has built every scene out of cubes and cylinders. This repository
gives the module 4 studio a **shared asset library** — real furniture and real HDRI lighting —
shared by every render, every worker and every user:

- **storage and distribution**: an **asset image** (`FROM scratch`, nothing but files), mounted
  **read-only** on `/assets` by the Kubernetes **`image` volume** (beta enabled by default since
  Kubernetes 1.35, stable in 1.36), in the MCP server and in the workers. Each node keeps it in its
  cache: a worker created by KEDA finds it as soon as it starts, with no download and no network
  rule to open;
- **format**: normalized `.blend` files (a root Empty placed on the floor, armatures applied, textures
  next to them, relative paths), marked as Blender assets (Asset Browser catalogs); 2k HDRIs;
  thumbnails rendered by Blender; a `catalog.json` (names in three languages, dimensions in meters,
  source, authors, license);
- **discovery**: an MCP tool `list_assets(search, kind)` that returns the name to write in the code,
  the dimensions, a Markdown thumbnail, a call example and the source;
- **use**: two functions placed in the namespace where the model's code runs,
  `load_asset("name", position=(x, y, z), rotation_z=…)` and `environment("name")`: **a name, never
  a path**; an unknown name raises an error that lists the valid names (the model corrects itself);
  the object is **appended** (not linked): the model can move it and recolor it, the original file
  stays untouched (read-only mount);
- **versioning**: the library version is the image tag (`studio3d-assets:1`, `:2`…; in production,
  the `@sha256:…` digest) written in the manifest. Adding an asset builds a new image of a few tens
  of MB, **without rebuilding the Blender image**; a pod keeps the version mounted when it started;
- **trace**: each render records the assets used (name, source, license) and the library version,
  in the request, in the Prometheus metrics (`studio_assets_used_total`) and in the module 4
  marking (`asset.extras.assets` of the GLB, `Assets` text field of the PNG).

## Why this mechanism

| Option | Verdict |
|---|---|
| Assets in the studio image | simple, but each addition rebuilds and redistributes several GB, and ties the design team's pace to the code's |
| Shared `ReadOnlyMany` volume (NFS, CephFS, Azure Files…) | a good choice for a very large library that changes often, but it requires network storage (absent from a k3d cluster) and has no version: a replaced file changes under the feet of a render in progress |
| Object storage (MinIO, S3) and a local cache | one more service and credentials, a network rule to open (which the model's code could borrow), a download every time a worker starts |
| **Asset image mounted by the `image` volume** | **chosen**: workers start instantly (node cache), read-only guaranteed by the container runtime, version by tag or digest, no network rule, distributed by the registry like any other image |

Plan B if your cluster does not have the `image` volume (Kubernetes before 1.33, container runtime
without support): the same image, copied at startup by an init container into an `emptyDir`,
mounted `readOnly: true` in the main container.

## Contents

| File | Role |
|---|---|
| `assets/selection.json` | The selection: name in the studio → Poly Haven id, names and descriptions in three languages, tags, catalog; `version`; `proposed`: assets ready to add (the plant) |
| `assets/importer.mjs` | Downloads through the public Poly Haven API, checks the MD5 fingerprints, prepares in Blender, assembles the library, builds `studio3d-assets:<version>`, imports it into the k3d nodes; `--add <Poly Haven id> --name <name>` (next version), `--deploy` (writes the version into `k8s-scale.yaml` and into both deployments). Node 20 or later, no dependency |
| `assets/prepare.py` | Run by the Blender of the studio image: normalization of the object, Blender asset, dimensions, 256 × 256 thumbnail |
| `assets/k3d.mjs` | k3d tooling used by `importer.mjs` (nodes, images in the nodes, `kubectl`) |
| `assets/Dockerfile` | The asset image: `FROM scratch`, `COPY library/ /` |
| `studio/render.py` | `load_asset`, `environment`, asset trace; automatic camera framed on the actual vertices; GLB with WEBP textures |
| `studio/api.py` | `list_assets` tool, public route `/a/<name>.jpg` (thumbnails, unsigned), one more sentence in the description of `submit_render`, assets returned by `render_status` |
| `studio/common.py`, `studio/worker.py`, `studio/metrics.py`, `studio/marking.py` | Catalog read in `/assets`; trace stored with the request, counted and added to the marking |
| `studio/Dockerfile` | Image `studio3d:4` (Blender 5.2, MCP server, worker) |
| `k8s-scale.yaml` | Module 4 manifest, plus: `image` volume `studio3d-assets:1` mounted `readOnly: true` on `/assets` in `studio-api` and `studio-worker`, `/a/` path in the `Ingress`, image `studio3d:4` |
| `test/office-without-library.py` | The code actually written by the model, without a library, for the office scene of the video (the “before” image) |
| `read_marking.py` | Reads the marking of a PNG or a GLB (module 4), which now shows the asset trace |
| `open-webui/` | Identity header of the MCP connection and system prompt of the “Studio 3D” model |
| `.env.example` | Variables to fill in (token, Redis password), without any value |

## Prerequisites

- The scaled studio of **module 4** (repository
  [`clic-par-clic-studio3d-04-marquage`](https://github.com/guilhem-/clic-par-clic-studio3d-04-marquage)):
  Redis, KEDA 2.21, `studio` secret, “Studio 3D” connection and model in Open WebUI.
- A cluster whose container runtime mounts `image` volumes: Kubernetes 1.35 or later
  (k3s 1.35.5, containerd 2.2.3 in the video, **k3d** cluster `tterm`, Traefik published on port
  8080 of the machine).
- Docker and Node 20 or later on the workstation; access to `api.polyhaven.com` and
  `dl.polyhaven.org` for the first download (about 65 MB).

## Step-by-step installation

1. **Studio image** (Blender, server, worker):

   ```bash
   docker build -t studio3d:4 studio
   k3d image import studio3d:4 -c tterm      # k3d; otherwise, push the image to your registry
   ```

2. **Library, version 1**: download, preparation in Blender (about a minute and a half the first
   time), asset image, import into the nodes:

   ```bash
   node assets/importer.mjs                   # K3D_CLUSTER=other-cluster for another k3d cluster
   ```

   The downloaded files (`assets/downloads/`), the prepared ones (`assets/prepared/`) and the
   assembled library (`assets/library/`) stay out of git.

3. **Studio**:

   ```bash
   kubectl apply -f k8s-scale.yaml
   kubectl -n studio3d rollout status deployment/studio-api
   ```

   Check: `http://studio.localhost:8080/a/wooden_chair.jpg` shows the thumbnail of the chair.

4. **Open WebUI**: in the “Studio 3D” model, replace the system prompt with the one in
   `open-webui/system-prompt.txt` (one sentence about the library; the status answer copies the
   image and the 3D artifact). Refresh the MCP connection so that the `list_assets` tool is read.

5. **Try it**: “Which furniture and which lighting are available?”, then “Create an office scene
   with the library: the metal desk, the wooden chair in front of it, the desk lamp standing on it,
   under the soft studio lighting.”, then “How is my render doing?”.

6. **Add an asset** (version 2, without touching the Blender image):

   ```bash
   node assets/importer.mjs --add potted_plant_01 --name potted_plant --deploy
   ```

   The script adds the plant to `selection.json`, builds `studio3d-assets:2`, imports it, then
   writes the new reference into `k8s-scale.yaml` and into both deployments: the two server copies
   take turns with no interruption; the running workers finish their render on version 1, the next
   ones start with version 2. Going back: set `reference: studio3d-assets:1` again and
   `kubectl apply -f k8s-scale.yaml`.

## Good to know

- **Appended, not linked** (`bpy.data.libraries.load(…, link=False, assets_only=True)`): a linked
  object would be read-only in the scene (no moving, no color without a “library override”).
  The copy lives in the render's scene, thrown away afterwards.
- **Read-only, not secret**: the model's code is still arbitrary Python; the library only contains
  royalty-free files. The read-only mount guarantees that no render can damage or poison the
  library of the others. The “by name” functions serve reliability (no invented path, clear
  errors), not security.
- **Orientation**: the objects have their front facing −y (Poly Haven's convention); the
  description of `list_assets` tells the model (`rotation_z=math.pi` to face +y).
- **Public thumbnails** (`/a/`): unsigned, because they only show royalty-free assets; the name is
  looked up in the catalog, never concatenated into a path.
- **Source type of the marking**: `trainedAlgorithmicMedia` is kept, even with a photographic HDRI
  as background (the scene is still composed by a trained model).

## Credits and licenses

- **Assets: [Poly Haven](https://polyhaven.com)**, **CC0** license (public domain):
  *Painted Wooden Chair 01* (Kuutti Siitonen), *Modern Arm Chair 01* (Vibrant Nordic),
  *Metal Office Desk* (Ulan Cabanilla), *Desk Lamp Arm 01* (Yann Kervran, Kuutti Siitonen),
  *Ceramic Vase 01* (James Ray Cock), *Potted Plant 01* (Rico Cilliers), HDRIs *Studio Small 08* and
  *Photo Studio Loft Hall* (Sergej Majboroda), *Wooden Lounge* (Greg Zaal). Downloaded through the
  public Poly Haven API (an explicit `User-Agent` on every request). The thumbnails are rendered
  by Blender: the site's sample renders are not reused. This repository contains no asset file:
  `importer.mjs` downloads them.
- Code: MIT, see [`LICENSE`](LICENSE). Blender is distributed under the GPL license by the Blender
  Foundation; Redis, KEDA and Poly Haven are independent projects. This series is independent of
  the publishers of the software shown.

## Next in the series

- Previous module: **Marking AI-generated renders** — repository
  [`clic-par-clic-studio3d-04-marquage`](https://github.com/guilhem-/clic-par-clic-studio3d-04-marquage).
- Next module: **Downloading the Blender scene from another team's storage** — repository
  [`clic-par-clic-studio3d-06-stockage-s3`](https://github.com/guilhem-/clic-par-clic-studio3d-06-stockage-s3).
