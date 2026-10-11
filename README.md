# Une bibliothèque d'assets pour tous les rendus — volume image Kubernetes, MCP et Blender

Code de la démonstration du module 5 de la série « Clic par clic » **Créer un service d'IA
compatible agentique : le studio 3D**.

Vidéo : {{video}}

## But

Jusqu'ici, le modèle de langage construit chaque scène avec des cubes et des cylindres. Ce dépôt
donne au studio du module 4 une **bibliothèque d'assets commune** — de vrais meubles et de vrais
éclairages HDRI — partagée par tous les rendus, tous les workers et tous les utilisateurs :

- **stockage et distribution** : une **image d'assets** (`FROM scratch`, rien que des fichiers),
  montée **en lecture seule** sur `/assets` par le **volume `image`** de Kubernetes (bêta activée
  par défaut depuis Kubernetes 1.35, stable en 1.36), dans le serveur MCP et dans les workers.
  Chaque nœud la garde en cache : un worker créé par KEDA la trouve à sa naissance, sans
  téléchargement ni règle réseau à ouvrir ;
- **format** : des `.blend` normalisés (un Empty racine posé au sol, armatures appliquées, textures
  à côté, chemins relatifs), marqués comme assets Blender (catalogues de l'Asset Browser) ; des HDRI
  2k ; des vignettes rendues par Blender ; un `catalogue.json` (noms en trois langues, dimensions
  en mètres, source, auteurs, licence) ;
- **découverte** : un outil MCP `lister_assets(recherche, genre)` qui renvoie le nom à écrire dans le
  code, les dimensions, une vignette en Markdown, un exemple d'appel et la source ;
- **utilisation** : deux fonctions placées dans l'espace d'exécution du code du modèle,
  `charger_asset("nom", position=(x, y, z), rotation_z=…)` et `environnement("nom")` : **un nom,
  jamais un chemin** ; un nom inconnu lève une erreur qui liste les noms valides (le modèle se
  corrige) ; l'objet est **ajouté** (pas lié) : le modèle peut le déplacer et le recolorer, le
  fichier d'origine reste intact (montage en lecture seule) ;
- **versionnement** : la version de la bibliothèque est l'étiquette de l'image
  (`studio3d-assets:1`, `:2`… ; en production, l'empreinte `@sha256:…`) inscrite dans le manifeste.
  Ajouter un asset construit une nouvelle image de quelques dizaines de Mo, **sans reconstruire
  l'image de Blender** ; un pod garde la version montée à sa naissance ;
- **trace** : chaque rendu note les assets utilisés (nom, source, licence) et la version de la
  bibliothèque, dans la demande, dans les mesures Prometheus (`studio_assets_utilises_total`) et
  dans le marquage du module 4 (`asset.extras.assets` du GLB, champ texte `Assets` du PNG).

## Pourquoi ce mécanisme

| Option | Verdict |
|---|---|
| Assets dans l'image du studio | simple, mais chaque ajout reconstruit et redistribue plusieurs Go, et lie le rythme de l'équipe graphique à celui du code |
| Volume partagé `ReadOnlyMany` (NFS, CephFS, Azure Files…) | bon choix pour une très grosse bibliothèque qui change souvent, mais demande un stockage réseau (absent d'un cluster k3d) et n'a pas de version : un fichier remplacé change sous les pieds d'un rendu en cours |
| Stockage objet (MinIO, S3) et cache local | un service et des identifiants de plus, une règle réseau à ouvrir (que le code du modèle pourrait emprunter), un téléchargement à chaque naissance de worker |
| **Image d'assets montée par le volume `image`** | **retenu** : naissance instantanée des workers (cache du nœud), lecture seule garantie par le moteur de conteneurs, version par étiquette ou empreinte, aucune règle réseau, distribution par le registre comme n'importe quelle image |

Plan B si votre cluster n'a pas le volume `image` (Kubernetes antérieur à 1.33, moteur de
conteneurs sans prise en charge) : la même image, copiée au démarrage par un conteneur
d'initialisation dans un `emptyDir`, monté `readOnly: true` dans le conteneur principal.

## Contenu

| Fichier | Rôle |
|---|---|
| `assets/selection.json` | La sélection : nom dans le studio → identifiant Poly Haven, noms et descriptions en trois langues, étiquettes, catalogue ; `version` ; `proposes` : assets prêts à ajouter (la plante) |
| `assets/importer.mjs` | Télécharge par l'API publique de Poly Haven, vérifie les MD5, prépare dans Blender, assemble la bibliothèque, construit `studio3d-assets:<version>`, l'importe dans les nœuds k3d ; `--ajouter <id Poly Haven> --nom <nom>` (version suivante), `--deployer` (inscrit la version dans `k8s-echelle.yaml` et dans les deux déploiements). Node 20 ou plus, sans dépendance |
| `assets/preparer.py` | Exécuté par le Blender de l'image du studio : normalisation de l'objet, asset Blender, dimensions, vignette 256 × 256 |
| `assets/k3d.mjs` | Outillage k3d utilisé par `importer.mjs` (import d'images dans les nœuds, `kubectl`) |
| `assets/Dockerfile` | L'image d'assets : `FROM scratch`, `COPY bibliotheque/ /` |
| `studio/rendu.py` | `charger_asset`, `environnement`, trace des assets ; caméra automatique cadrée sur les sommets réels ; GLB à textures WEBP |
| `studio/api.py` | Outil `lister_assets`, route publique `/a/<nom>.jpg` (vignettes, sans signature), une phrase de plus dans la description de `soumettre_rendu`, assets renvoyés par `etat_rendu` |
| `studio/commun.py`, `studio/travailleur.py`, `studio/metriques.py`, `studio/marquage.py` | Catalogue lu dans `/assets` ; trace rangée avec la demande, comptée et ajoutée au marquage |
| `studio/Dockerfile` | Image `studio3d:4` (Blender 5.2, serveur MCP, worker) |
| `k8s-echelle.yaml` | Manifeste du module 4, plus : volume `image` `studio3d-assets:1` monté `readOnly: true` sur `/assets` dans `studio-api` et `studio-travailleur`, chemin `/a/` dans l'`Ingress`, image `studio3d:4` |
| `essai/bureau-sans-bibliotheque.py` | Le code réellement écrit par le modèle, sans bibliothèque, pour la scène de bureau de la vidéo (l'image « avant ») |
| `lire_marquage.py` | Lecture du marquage d'un PNG ou d'un GLB (module 4), qui montre désormais la trace des assets |
| `open-webui/` | En-tête d'identité de la connexion MCP et prompt système du modèle « Studio 3D » |
| `.env.example` | Variables à renseigner (jeton, mot de passe Redis), sans valeur |

## Prérequis

- Le studio à l'échelle du **module 4** (dépôt
  [`clic-par-clic-studio3d-04-marquage`](https://github.com/guilhem-/clic-par-clic-studio3d-04-marquage)) :
  Redis, KEDA 2.21, secret `studio`, connexion et modèle « Studio 3D » dans Open WebUI.
- Un cluster dont le moteur de conteneurs monte les volumes `image` : Kubernetes 1.35 ou plus
  (k3s 1.35.5, containerd 2.2.3 dans la vidéo, cluster **k3d** `tterm`, Traefik publié sur le
  port 8080 de la machine).
- Docker et Node 20 ou plus sur le poste ; un accès à `api.polyhaven.com` et `dl.polyhaven.org`
  pour le premier téléchargement (environ 65 Mo).

## Installation pas à pas

1. **Image du studio** (Blender, serveur, worker) :

   ```bash
   docker build -t studio3d:4 studio
   k3d image import studio3d:4 -c tterm      # k3d ; sinon, poussez l'image dans votre registre
   ```

2. **Bibliothèque, version 1** : téléchargement, préparation dans Blender (environ une minute et
   demie la première fois), image d'assets, import dans les nœuds :

   ```bash
   node assets/importer.mjs                   # K3D_CLUSTER=autre-cluster pour un autre cluster k3d
   ```

   Les fichiers téléchargés (`assets/telechargements/`), préparés (`assets/preparees/`) et la
   bibliothèque assemblée (`assets/bibliotheque/`) restent hors git.

3. **Studio** :

   ```bash
   kubectl apply -f k8s-echelle.yaml
   kubectl -n studio3d rollout status deployment/studio-api
   ```

   Vérification : `http://studio.localhost:8080/a/chaise_bois.jpg` affiche la vignette de la chaise.

4. **Open WebUI** : dans le modèle « Studio 3D », remplacez le prompt système par celui de
   `open-webui/consignes-modele.txt` (une phrase sur la bibliothèque ; la réponse d'état recopie
   l'image et l'artefact 3D). Rafraîchissez la connexion MCP pour que l'outil `lister_assets` soit lu.

5. **Essai** : « Quels meubles et quels éclairages sont disponibles ? », puis « Crée une scène de
   bureau avec la bibliothèque : le bureau métallique, la chaise en bois devant, la lampe de bureau
   posée dessus, sous l'éclairage studio doux. », puis « Où en est mon rendu ? ».

6. **Ajouter un asset** (version 2, sans toucher à l'image de Blender) :

   ```bash
   node assets/importer.mjs --ajouter potted_plant_01 --nom plante_verte --deployer
   ```

   Le script ajoute la plante à `selection.json`, construit `studio3d-assets:2`, l'importe, puis
   inscrit la nouvelle référence dans `k8s-echelle.yaml` et dans les deux déploiements : les deux
   copies du serveur se relaient sans interruption ; les workers en cours finissent leur rendu sur
   la version 1, les suivants naissent avec la version 2. Retour arrière : remettre
   `reference: studio3d-assets:1` et `kubectl apply -f k8s-echelle.yaml`.

## Points à connaître

- **Ajouté, pas lié** (`bpy.data.libraries.load(…, link=False, assets_only=True)`) : un objet lié
  serait en lecture seule dans la scène (ni déplacement, ni couleur sans « library override »).
  La copie vit dans la scène du rendu, jetée ensuite.
- **Lecture seule, pas secret** : le code du modèle reste du Python arbitraire ; la bibliothèque ne
  contient que des fichiers libres de droits. Le montage en lecture seule garantit qu'aucun rendu ne
  peut abîmer ou empoisonner la bibliothèque des autres. Les fonctions « par nom » servent la
  fiabilité (pas de chemin inventé, erreurs claires), pas la sécurité.
- **Orientation** : les objets ont leur face avant tournée vers −y (convention de Poly Haven) ; la
  description de `lister_assets` le dit au modèle (`rotation_z=math.pi` pour la tourner vers +y).
- **Vignettes publiques** (`/a/`) : sans signature, parce qu'elles ne montrent que des assets
  libres de droits ; le nom est cherché dans le catalogue, jamais concaténé à un chemin.
- **Type de source du marquage** : `trainedAlgorithmicMedia` est conservé, même avec un HDRI
  photographique en fond (la scène reste composée par un modèle entraîné).

## Crédits et licences

- **Assets : [Poly Haven](https://polyhaven.com)**, licence **CC0** (domaine public) :
  *Painted Wooden Chair 01* (Kuutti Siitonen), *Modern Arm Chair 01* (Vibrant Nordic),
  *Metal Office Desk* (Ulan Cabanilla), *Desk Lamp Arm 01* (Yann Kervran, Kuutti Siitonen),
  *Ceramic Vase 01* (James Ray Cock), *Potted Plant 01* (Rico Cilliers), HDRI *Studio Small 08* et
  *Photo Studio Loft Hall* (Sergej Majboroda), *Wooden Lounge* (Greg Zaal). Téléchargés par l'API
  publique de Poly Haven (un `User-Agent` explicite à chaque requête). Les vignettes sont rendues
  par Blender : les rendus d'exemple du site ne sont pas réutilisés. Ce dépôt ne contient aucun
  fichier d'asset : `importer.mjs` les télécharge.
- Code : MIT, voir [`LICENSE`](LICENSE). Blender est distribué sous licence GPL par la Blender
  Foundation ; Redis, KEDA et Poly Haven sont des projets indépendants. Cette série est
  indépendante des éditeurs des logiciels présentés.

## Suite de la série

- Module précédent : **Marquer les rendus générés par IA** — dépôt
  [`clic-par-clic-studio3d-04-marquage`](https://github.com/guilhem-/clic-par-clic-studio3d-04-marquage).
- À suivre : la série **Intégrations IA**, qui relie ce studio à Open WebUI de quatre façons
  différentes.
