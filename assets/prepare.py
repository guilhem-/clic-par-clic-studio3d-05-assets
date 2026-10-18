"""Preparation of an asset for the studio library (module s3d05), run by headless Blender.

Started by importer.mjs, in the Blender of the studio image:
  blender -b <source.blend> --python prepare.py -- model '<JSON parameters>'
  blender -b --factory-startup --python prepare.py -- environment '<JSON parameters>' <source.hdr>

Object: armatures applied then deleted, a root Empty placed on the floor (bottom of the bounding box
at z = 0, centered in x and y), a collection named after the asset marked as a Blender asset (catalog,
description, tags), textures copied next to the .blend with relative paths, dimensions
measured. Environment: copy of the HDRI. In both cases, a 256 × 256 thumbnail rendered by
Blender (Poly Haven's sample renders cannot be reused) and a JSON record.
"""
import hashlib
import json
import math
import shutil
import sys
from pathlib import Path

import bpy
from mathutils import Vector

OUTPUT = Path("/output")
args = sys.argv[sys.argv.index("--") + 1:]
kind, p = args[0], json.loads(args[1])
name = p["name"]


def catalog_uuid(key: str) -> str:
    """Same UUID as importer.mjs (catalogUuid): the .blend and blender_assets.cats.txt match."""
    h = hashlib.sha1(f"studio3d:{key}".encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-5{h[13:16]}-a{h[17:20]}-{h[20:32]}"


def box(objects):
    """Min and max corners (world space) of the given meshes."""
    corners = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
    return (Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners))),
            Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners))))


def hdri_world(path: Path, strength: float = 1.0):
    """World lit by an HDRI (same node setup as the studio's environment function)."""
    world = bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    tree = world.node_tree
    tree.nodes.clear()
    texture = tree.nodes.new("ShaderNodeTexEnvironment")
    background = tree.nodes.new("ShaderNodeBackground")
    output = tree.nodes.new("ShaderNodeOutputWorld")
    texture.image = bpy.data.images.load(str(path), check_existing=True)
    background.inputs["Strength"].default_value = strength
    tree.links.new(texture.outputs["Color"], background.inputs["Color"])
    tree.links.new(background.outputs["Background"], output.inputs["Surface"])


def thumbnail(objects, file: Path):
    """Cycles render 256 × 256, three-quarter view slightly from above, JPEG."""
    scene = bpy.context.scene
    cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    low, high = box(objects)
    center = (low + high) / 2
    radius = max((high - low).length / 2, 0.05)
    half_angle = cam.data.angle / 2
    cam.location = center + Vector((1.0, -1.25, 0.65)).normalized() * radius / math.sin(half_angle) * 1.05
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 256
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 85
    file.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(file)
    bpy.ops.render.render(write_still=True)


def write_record(**info):
    folder = OUTPUT / "records"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.json").write_text(json.dumps({"name": name, "key": p["key"], **info}, ensure_ascii=False), encoding="utf-8")


def prepare_model():
    scene = bpy.context.scene
    # The file's collections are not always linked to the scene: link them to evaluate.
    for col in list(bpy.data.collections):
        if col.name not in scene.collection.children and not any(col.name in c.children for c in bpy.data.collections):
            scene.collection.children.link(col)
    bpy.context.view_layer.update()

    # Only the meshes of the main collection are kept (the one carrying the Poly Haven id):
    # a "rigged" object also brings control shapes and helpers, to leave out.
    main = bpy.data.collections.get(p.get("polyhaven", "")) or scene.collection
    kept = [o for o in main.objects if o.type == "MESH"] or [o for o in bpy.data.objects if o.type == "MESH"]
    # Modifiers (armature, curves, nodes…) applied: a frozen mesh, exported as is.
    graph = bpy.context.evaluated_depsgraph_get()
    frozen = {o: bpy.data.meshes.new_from_object(o.evaluated_get(graph), preserve_all_data_layers=True, depsgraph=graph)
              for o in kept if len(o.modifiers)}
    for o, mesh in frozen.items():
        o.modifiers.clear()
        o.data = mesh
    for o in list(bpy.data.objects):
        if o not in kept:
            for child in o.children:
                mw = child.matrix_world.copy()
                child.parent = None
                child.matrix_world = mw
            bpy.data.objects.remove(o, do_unlink=True)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"{name}: no mesh in the file")

    # A root Empty, placed on the floor and centered: load_asset(name) places it in one go.
    low, high = box(meshes)
    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "PLAIN_AXES"
    root.location = ((low.x + high.x) / 2, (low.y + high.y) / 2, low.z)
    collection = bpy.data.collections.new(name)
    scene.collection.children.link(collection)
    collection.objects.link(root)
    bpy.context.view_layer.update()
    for o in meshes:
        if o.parent is None:
            o.parent = root
            o.matrix_parent_inverse = root.matrix_world.inverted()
        for c in list(o.users_collection):
            c.objects.unlink(o)
        collection.objects.link(o)
    root.location = (0, 0, 0)
    bpy.context.view_layer.update()
    for col in list(bpy.data.collections):
        if col != collection:
            bpy.data.collections.remove(col)

    # Blender asset: visible in the Asset Browser, and the only block read by load_asset (assets_only).
    collection.asset_mark()
    collection.asset_data.description = p.get("description", "")
    collection.asset_data.catalog_id = catalog_uuid(p.get("catalog") or "decoration")
    for tag in p.get("tags", [])[:12]:
        collection.asset_data.tags.new(tag, skip_if_exists=True)
    collection.asset_data.author = "Poly Haven (CC0)"

    # Textures copied next to the .blend, relative paths.
    folder = OUTPUT / "models" / name
    shutil.rmtree(folder, ignore_errors=True)
    (folder / "textures").mkdir(parents=True)
    for image in bpy.data.images:
        if image.source != "FILE" or not image.filepath:
            continue
        source = Path(bpy.path.abspath(image.filepath))
        if source.exists():
            shutil.copy2(source, folder / "textures" / source.name)
            image.filepath = f"//textures/{source.name}"
    for world in list(bpy.data.worlds):
        bpy.data.worlds.remove(world)
    bpy.data.orphans_purge(do_recursive=True)
    low, high = box(meshes)
    dimensions = [round(v, 2) for v in (high - low)]
    bpy.ops.wm.save_as_mainfile(filepath=str(folder / "model.blend"), relative_remap=False, compress=True)

    # Thumbnail: empty scene, the asset appended as the studio will do it, soft_studio lighting.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(str(folder / "model.blend"), link=False, assets_only=True) as (source, target):
        target.collections = [name]
    bpy.context.scene.collection.children.link(target.collections[0])
    hdri = OUTPUT / "environments" / "soft_studio.hdr"
    if hdri.exists():
        hdri_world(hdri, 1.0)
    objects = [o for o in target.collections[0].all_objects if o.type == "MESH"]
    thumbnail(objects, OUTPUT / "thumbnails" / f"{name}.jpg")
    write_record(dimensions_m=dimensions, objects=len(objects))


def prepare_environment(source: Path):
    folder = OUTPUT / "environments"
    folder.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, folder / f"{name}.hdr")
    for o in list(bpy.data.objects):  # startup scene: cube, camera, lamp
        bpy.data.objects.remove(o, do_unlink=True)
    # Thumbnail: a mirror sphere and a matte sphere, under the lighting, the HDRI as background.
    hdri_world(folder / f"{name}.hdr", 1.0)
    spheres = []
    for side, metal, roughness in ((-1, 1.0, 0.05), (1, 0.0, 0.6)):  # side by side, facing the camera
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(0.43 * side, 0.34 * side, 0.5), segments=48, ring_count=24)
        s = bpy.context.object
        bpy.ops.object.shade_smooth()
        m = bpy.data.materials.new("Sphere")
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (0.9, 0.9, 0.9, 1)
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = roughness
        s.data.materials.append(m)
        spheres.append(s)
    thumbnail(spheres, OUTPUT / "thumbnails" / f"{name}.jpg")
    write_record()


if kind == "model":
    prepare_model()
else:
    prepare_environment(Path(args[2]))
