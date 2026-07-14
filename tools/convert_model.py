# FBX(Meshy) → 精簡 GLB:減面、貼圖縮 512、最大邊正規化為 1、原點在底部中心
import sys
sys.path.insert(0, '/private/tmp/claude-502/-Users-Ray0517/9f263e78-eeaa-4911-a960-e92302c799f3/scratchpad/pyshadow')
import bpy, os
import mathutils

argv = sys.argv[sys.argv.index('--') + 1:]
fbx_path, tex_path, out_glb, target_tris = argv[0], argv[1], argv[2], int(argv[3])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx_path)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in bpy.data.objects:
    o.select_set(o.type == 'MESH')
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# 減面
obj.data.calc_loop_triangles()
cur = len(obj.data.loop_triangles)
if cur > target_tris:
    mod = obj.modifiers.new('dec', 'DECIMATE')
    mod.ratio = target_tris / cur
    bpy.ops.object.modifier_apply(modifier='dec')
obj.data.calc_loop_triangles()
print(f'TRIS {cur} -> {len(obj.data.loop_triangles)}')

# 正規化:最大邊 = 1,底部中心在原點
mn = mathutils.Vector((1e9,)*3); mx = mathutils.Vector((-1e9,)*3)
for v in obj.data.vertices:
    for i in range(3):
        mn[i] = min(mn[i], v.co[i]); mx[i] = max(mx[i], v.co[i])
size = mx - mn
s = 1.0 / max(size)
pivot = mathutils.Vector(((mn.x+mx.x)/2, (mn.y+mx.y)/2, mn.z))  # Z-up:底部中心
for v in obj.data.vertices:
    v.co = (v.co - pivot) * s
print(f'SIZE ({size.x*s:.3f},{size.y*s:.3f},{size.z*s:.3f})')

# 材質:只留 base color 貼圖(縮 512)
img = bpy.data.images.load(tex_path)
img.scale(512, 512)
mat = bpy.data.materials.new('mat')
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes['Principled BSDF']
bsdf.inputs['Roughness'].default_value = 0.9
tex = nt.nodes.new('ShaderNodeTexImage')
tex.image = img
nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
obj.data.materials.clear()
obj.data.materials.append(mat)

bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=out_glb, export_format='GLB', use_selection=True,
    export_image_format='JPEG', export_jpeg_quality=80,
    export_animations=False, export_skins=False, export_morph=False,
    export_apply=True, export_yup=True, export_tangents=False,
)
print('DONE', out_glb, os.path.getsize(out_glb))
