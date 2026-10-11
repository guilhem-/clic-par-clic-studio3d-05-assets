"""Préparation d'un asset pour la bibliothèque du studio (module s3d05), exécutée par Blender sans interface.

Lancé par importer.mjs, dans le Blender de l'image du studio :
  blender -b <source.blend> --python preparer.py -- modele '<paramètres JSON>'
  blender -b --factory-startup --python preparer.py -- environnement '<paramètres JSON>' <source.hdr>

Objet : armatures appliquées puis supprimées, un Empty racine posé au sol (bas de la boîte englobante
à z = 0, centré en x et y), une collection du nom de l'asset marquée comme asset Blender (catalogue,
description, étiquettes), textures copiées à côté du .blend avec des chemins relatifs, dimensions
mesurées. Environnement : copie du HDRI. Dans les deux cas, une vignette 256 × 256 rendue par
Blender (les rendus d'exemple de Poly Haven ne sont pas réutilisables) et une fiche JSON.
"""
import hashlib
import json
import math
import shutil
import sys
from pathlib import Path

import bpy
from mathutils import Vector

SORTIE = Path("/sortie")
args = sys.argv[sys.argv.index("--") + 1:]
genre, p = args[0], json.loads(args[1])
nom = p["nom"]


def uuid_catalogue(cle: str) -> str:
    """Même UUID que importer.mjs (uuidCatalogue) : le .blend et blender_assets.cats.txt concordent."""
    h = hashlib.sha1(f"studio3d:{cle}".encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-5{h[13:16]}-a{h[17:20]}-{h[20:32]}"


def boite(objets):
    """Coins min et max (repère du monde) des maillages donnés."""
    coins = [o.matrix_world @ Vector(c) for o in objets for c in o.bound_box]
    return (Vector((min(c.x for c in coins), min(c.y for c in coins), min(c.z for c in coins))),
            Vector((max(c.x for c in coins), max(c.y for c in coins), max(c.z for c in coins))))


def monde_hdri(chemin: Path, intensite: float = 1.0):
    """Monde éclairé par un HDRI (même montage de nœuds que la fonction environnement du studio)."""
    monde = bpy.data.worlds.new("Monde")
    bpy.context.scene.world = monde
    monde.use_nodes = True
    arbre = monde.node_tree
    arbre.nodes.clear()
    texture = arbre.nodes.new("ShaderNodeTexEnvironment")
    fond = arbre.nodes.new("ShaderNodeBackground")
    sortie = arbre.nodes.new("ShaderNodeOutputWorld")
    texture.image = bpy.data.images.load(str(chemin), check_existing=True)
    fond.inputs["Strength"].default_value = intensite
    arbre.links.new(texture.outputs["Color"], fond.inputs["Color"])
    arbre.links.new(fond.outputs["Background"], sortie.inputs["Surface"])


def vignette(objets, fichier: Path):
    """Rendu Cycles 256 × 256, vue de trois quarts légèrement plongeante, JPEG."""
    scene = bpy.context.scene
    cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    bas, haut = boite(objets)
    centre = (bas + haut) / 2
    rayon = max((haut - bas).length / 2, 0.05)
    demi_angle = cam.data.angle / 2
    cam.location = centre + Vector((1.0, -1.25, 0.65)).normalized() * rayon / math.sin(demi_angle) * 1.05
    cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 256
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 85
    fichier.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(fichier)
    bpy.ops.render.render(write_still=True)


def ecrire_fiche(**infos):
    dossier = SORTIE / "fiches"
    dossier.mkdir(parents=True, exist_ok=True)
    (dossier / f"{nom}.json").write_text(json.dumps({"nom": nom, "cle": p["cle"], **infos}, ensure_ascii=False), encoding="utf-8")


def preparer_modele():
    scene = bpy.context.scene
    # Les collections du fichier ne sont pas toujours reliées à la scène : on les relie pour évaluer.
    for col in list(bpy.data.collections):
        if col.name not in scene.collection.children and not any(col.name in c.children for c in bpy.data.collections):
            scene.collection.children.link(col)
    bpy.context.view_layer.update()

    # On ne garde que les maillages de la collection principale (celle qui porte l'identifiant Poly
    # Haven) : un objet « rigged » apporte aussi des gabarits de contrôle et des aides, à écarter.
    principale = bpy.data.collections.get(p.get("polyhaven", "")) or scene.collection
    gardes = [o for o in principale.objects if o.type == "MESH"] or [o for o in bpy.data.objects if o.type == "MESH"]
    # Modificateurs (armature, courbes, nœuds…) appliqués : un maillage figé, qui s'exporte tel quel.
    graphe = bpy.context.evaluated_depsgraph_get()
    figes = {o: bpy.data.meshes.new_from_object(o.evaluated_get(graphe), preserve_all_data_layers=True, depsgraph=graphe)
             for o in gardes if len(o.modifiers)}
    for o, maillage in figes.items():
        o.modifiers.clear()
        o.data = maillage
    for o in list(bpy.data.objects):
        if o not in gardes:
            for enfant in o.children:
                mw = enfant.matrix_world.copy()
                enfant.parent = None
                enfant.matrix_world = mw
            bpy.data.objects.remove(o, do_unlink=True)
    maillages = [o for o in bpy.data.objects if o.type == "MESH"]
    if not maillages:
        raise RuntimeError(f"{nom} : aucun maillage dans le fichier")

    # Un Empty racine, posé au sol et centré : charger_asset(nom) le place d'un seul geste.
    bas, haut = boite(maillages)
    racine = bpy.data.objects.new(nom, None)
    racine.empty_display_type = "PLAIN_AXES"
    racine.location = ((bas.x + haut.x) / 2, (bas.y + haut.y) / 2, bas.z)
    collection = bpy.data.collections.new(nom)
    scene.collection.children.link(collection)
    collection.objects.link(racine)
    bpy.context.view_layer.update()
    for o in maillages:
        if o.parent is None:
            o.parent = racine
            o.matrix_parent_inverse = racine.matrix_world.inverted()
        for c in list(o.users_collection):
            c.objects.unlink(o)
        collection.objects.link(o)
    racine.location = (0, 0, 0)
    bpy.context.view_layer.update()
    for col in list(bpy.data.collections):
        if col != collection:
            bpy.data.collections.remove(col)

    # Asset Blender : visible dans l'Asset Browser, et seul bloc lu par charger_asset (assets_only).
    collection.asset_mark()
    collection.asset_data.description = p.get("description", "")
    collection.asset_data.catalog_id = uuid_catalogue(p.get("catalogue") or "decoration")
    for etiquette in p.get("etiquettes", [])[:12]:
        collection.asset_data.tags.new(etiquette, skip_if_exists=True)
    collection.asset_data.author = "Poly Haven (CC0)"

    # Textures copiées à côté du .blend, chemins relatifs.
    dossier = SORTIE / "modeles" / nom
    shutil.rmtree(dossier, ignore_errors=True)
    (dossier / "textures").mkdir(parents=True)
    for image in bpy.data.images:
        if image.source != "FILE" or not image.filepath:
            continue
        source = Path(bpy.path.abspath(image.filepath))
        if source.exists():
            shutil.copy2(source, dossier / "textures" / source.name)
            image.filepath = f"//textures/{source.name}"
    for monde in list(bpy.data.worlds):
        bpy.data.worlds.remove(monde)
    bpy.data.orphans_purge(do_recursive=True)
    bas, haut = boite(maillages)
    dimensions = [round(v, 2) for v in (haut - bas)]
    bpy.ops.wm.save_as_mainfile(filepath=str(dossier / "modele.blend"), relative_remap=False, compress=True)

    # Vignette : scène vide, l'asset ajouté comme le fera le studio, éclairage studio_doux.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(str(dossier / "modele.blend"), link=False, assets_only=True) as (source, cible):
        cible.collections = [nom]
    bpy.context.scene.collection.children.link(cible.collections[0])
    hdri = SORTIE / "environnements" / "studio_doux.hdr"
    if hdri.exists():
        monde_hdri(hdri, 1.0)
    objets = [o for o in cible.collections[0].all_objects if o.type == "MESH"]
    vignette(objets, SORTIE / "vignettes" / f"{nom}.jpg")
    ecrire_fiche(dimensions_m=dimensions, objets=len(objets))


def preparer_environnement(source: Path):
    dossier = SORTIE / "environnements"
    dossier.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dossier / f"{nom}.hdr")
    for o in list(bpy.data.objects):  # scène de démarrage : cube, caméra, lampe
        bpy.data.objects.remove(o, do_unlink=True)
    # Vignette : une sphère miroir et une sphère mate, sous l'éclairage, le HDRI en fond.
    monde_hdri(dossier / f"{nom}.hdr", 1.0)
    spheres = []
    for cote, metal, rugosite in ((-1, 1.0, 0.05), (1, 0.0, 0.6)):  # côte à côte, face à la caméra
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(0.43 * cote, 0.34 * cote, 0.5), segments=48, ring_count=24)
        s = bpy.context.object
        bpy.ops.object.shade_smooth()
        m = bpy.data.materials.new("Sphere")
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (0.9, 0.9, 0.9, 1)
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = rugosite
        s.data.materials.append(m)
        spheres.append(s)
    vignette(spheres, SORTIE / "vignettes" / f"{nom}.jpg")
    ecrire_fiche()


if genre == "modele":
    preparer_modele()
else:
    preparer_environnement(Path(args[2]))
