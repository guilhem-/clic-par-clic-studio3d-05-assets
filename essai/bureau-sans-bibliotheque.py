import bpy, math
from mathutils import Vector

# Nettoyage
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Matériaux
def mat(name, color, metallic=0.0, roughness=0.45):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    return m

metal = mat('Métal gris anthracite', (0.12, 0.15, 0.18), 0.8, 0.28)
metal_light = mat('Métal clair', (0.34, 0.38, 0.42), 0.75, 0.24)
wood = mat('Bois chaleureux', (0.42, 0.18, 0.055), 0.0, 0.32)
wood_light = mat('Bois clair', (0.62, 0.30, 0.10), 0.0, 0.38)
black = mat('Caoutchouc noir', (0.018, 0.022, 0.028), 0.05, 0.42)
shade_mat = mat('Abat-jour ivoire', (0.82, 0.68, 0.45), 0.0, 0.5)

# Utilitaires
def cube(name, loc, scale, material, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object; o.name = name; o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if material: o.data.materials.append(material)
    if bevel:
        mod = o.modifiers.new('Bords arrondis', 'BEVEL'); mod.width = bevel; mod.segments = 3
    return o

def cyl(name, loc, radius, depth, material, vertices=48, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    o=bpy.context.object; o.name=name
    if material: o.data.materials.append(material)
    if bevel:
        mod=o.modifiers.new('Bords doux','BEVEL'); mod.width=bevel; mod.segments=3
    return o

# Sol et fond (décor)
cube('Decor Sol', (0, 0, -0.08), (5.2, 4.2, 0.08), mat('Sol studio', (0.16,0.18,0.21), 0, 0.7), 0.03)
cube('Decor Fond', (0, 2.5, 2.8), (5.2, 0.08, 3.0), mat('Fond studio', (0.055,0.07,0.095), 0, 0.8), 0.02)

# Bureau métallique : plateau et piètement
cube('Bureau plateau métallique', (0, 0, 1.62), (1.65, 0.78, 0.10), metal, 0.06)
# chant frontal discret
cube('Bureau chant avant', (0, -0.78, 1.48), (1.58, 0.045, 0.08), metal_light, 0.025)
# pieds en profilés
for x in (-1.42, 1.42):
    cube('Bureau pied latéral', (x, 0, 0.78), (0.09, 0.10, 0.78), metal_light, 0.025)
    cube('Bureau traverse', (x, 0, 0.22), (0.11, 0.65, 0.07), metal, 0.025)
cube('Bureau traverse arrière', (0, 0.58, 0.42), (1.40, 0.07, 0.07), metal, 0.02)

# Chaise en bois devant le bureau
# assise
cube('Chaise assise en bois', (0, -1.38, 0.93), (0.62, 0.58, 0.10), wood, 0.07)
# dossier avec montants et lattes
for x in (-0.52, 0.52):
    cube('Chaise montant bois', (x, -1.82, 1.62), (0.075, 0.075, 0.70), wood_light, 0.035)
cube('Chaise dossier haut', (0, -1.82, 2.17), (0.60, 0.09, 0.10), wood_light, 0.04)
cube('Chaise dossier bas', (0, -1.82, 1.62), (0.52, 0.075, 0.075), wood, 0.03)
# pieds inclinés
for x in (-0.48, 0.48):
    for y in (-1.02, -1.70):
        leg=cube('Chaise pied bois', (x, y, 0.43), (0.075, 0.075, 0.48), wood, 0.025)
        leg.rotation_euler[1] = (-0.12 if x > 0 else 0.12)
# barreaux
cube('Chaise barreau avant', (0, -1.02, 0.48), (0.48, 0.06, 0.055), wood_light, 0.02)

# Lampe de bureau sur le plateau, côté droit
cyl('Lampe base', (0.78, -0.08, 1.84), 0.30, 0.08, black, bevel=0.025)
cyl('Lampe tige verticale', (0.78, -0.08, 2.22), 0.045, 0.72, metal_light, bevel=0.012)
# bras orienté vers l'avant
arm=cube('Lampe bras articulé', (0.78, -0.28, 2.55), (0.055, 0.30, 0.055), metal_light, 0.018)
arm.rotation_euler[0] = math.radians(-10)
# abat-jour conique
bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=0.30, radius2=0.16, depth=0.30, location=(0.78, -0.53, 2.53))
shade=bpy.context.object; shade.name='Lampe abat-jour'; shade.rotation_euler[0]=math.radians(68); shade.data.materials.append(shade_mat)
# ampoule visible sous l'abat-jour
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=0.09, location=(0.78,-0.66,2.47))
bulb=bpy.context.object; bulb.name='Lampe ampoule'; bulb.data.materials.append(mat('Ampoule chaude',(1.0,0.55,0.16),0,0.2))

# Éclairage studio doux
bpy.ops.object.light_add(type='AREA', location=(-3.5, -4.0, 5.5))
key=bpy.context.object; key.name='Decor Lumière principale'; key.data.energy=850; key.data.shape='DISK'; key.data.size=4.5
key.rotation_euler=(math.radians(25),0,math.radians(-35))
# orienter vers centre
def point_at(obj, target): obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
point_at(key,(0,0,1.2))
bpy.ops.object.light_add(type='AREA', location=(3.8,-1.5,3.5))
fill=bpy.context.object; fill.name='Decor Lumière de remplissage'; fill.data.energy=500; fill.data.size=3.0; point_at(fill,(0,0,1.3))
bpy.ops.object.light_add(type='AREA', location=(0,2.0,4.5))
rim=bpy.context.object; rim.name='Decor Contre-jour'; rim.data.energy=700; rim.data.size=2.5; point_at(rim,(0,0,1.5))

# Caméra
bpy.ops.object.camera_add(location=(4.2,-6.6,3.5))
cam=bpy.context.object; cam.name='Decor Caméra'; cam.data.lens=52; point_at(cam,(0,-0.15,1.25)); bpy.context.scene.camera=cam
# légère profondeur de champ
cam.data.dof.use_dof=True; cam.data.dof.focus_object=bpy.data.objects['Bureau plateau métallique']; cam.data.dof.aperture_fstop=5.6

# Organisation visuelle
for o in bpy.context.scene.objects:
    if o.type == 'MESH':
        o.select_set(False)

