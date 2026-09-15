import { Cam, palette, toClip } from "./common.wgsl";
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> attr: array<vec4f>;

struct Out {
  @builtin(position) p: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec4f,
  @location(2) @interpolate(flat) sel: f32,
  @location(3) @interpolate(flat) role: f32,
}

@vertex fn vs_main(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let a = attr[i];
  let c = corners[v];
  let on = f32((cam.mask >> u32(a.y)) & 1u);
  let sel = select(0.0, 1.0, i32(i) == cam.hover);
  let r = (clamp(1.3 + sqrt(max(a.x, 0.0)) * 2.4, 1.3, 26.0) * cam.zoomPx + sel * 3.0);
  let clip = toClip(pos[i].xy, cam.center, cam.scale, cam.aspect);
  var o: Out;
  o.p = vec4f(clip + c * r * 2.0 / cam.viewport, 0.0, 1.0);
  o.uv = c;
  o.col = vec4f(palette(u32(a.y)), mix(0.18, 1.0, on));
  o.sel = sel;
  o.role = a.z;
  return o;
}

@fragment fn fs_main(in: Out) -> @location(0) vec4f {
  let q = max(abs(in.uv.x), abs(in.uv.y));          // square voxel
  if (q > 1.0) { discard; }
  let body = 1.0 - smoothstep(0.80, 0.86, q);        // fill
  let outline = smoothstep(0.80, 0.86, q) * (1.0 - smoothstep(0.96, 1.0, q)); // dark pixel rim
  let ring = smoothstep(0.10, 0.0, abs(q - 0.72)) * in.sel;
  let isPool = in.role > 0.5 && in.role < 1.5;
  let poolRing = smoothstep(0.05, 0.0, abs(q - 0.60)) * select(0.0, 1.0, isPool);
  let shade = mix(0.78, 1.0, 1.0 - in.uv.y * 0.5);   // top lighter, voxel feel
  var rgb = in.col.rgb * body * shade + vec3f(0.03, 0.05, 0.06) * outline;
  rgb = rgb + vec3f(0.22, 1.0, 0.08) * (ring * 1.5 + poolRing * 0.8);
  let a = clamp(body + outline + ring + poolRing, 0.0, 1.0) * in.col.a;
  return vec4f(rgb * a, a);
}
