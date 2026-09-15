// Cemetery: one stone per instance. Dead tokens are dark slabs, survivors glow green.
struct GParams { viewport: vec2f, hover: f32, pad: f32 }
@group(0) @binding(0) var<uniform> gp: GParams;
@group(0) @binding(1) var<storage, read> stones: array<vec4f>;   // x, y (clip), alive, seed

struct Out {
  @builtin(position) p: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) alive: f32,
  @location(2) @interpolate(flat) seed: f32,
}

@vertex fn vs_main(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let s = stones[i];
  let c = corners[v];
  let size = vec2f(5.0, 7.0) * (0.8 + s.w * 0.4);
  var o: Out;
  o.p = vec4f(s.xy + c * size * 2.0 / gp.viewport, 0.0, 1.0);
  o.uv = c;
  o.alive = s.z;
  o.seed = s.w;
  return o;
}

@fragment fn fs_main(in: Out) -> @location(0) vec4f {
  let top = in.uv.y > 0.2;
  let dTop = length(vec2f(in.uv.x, in.uv.y - 0.2));
  let inside = select(abs(in.uv.x) < 0.8, dTop < 0.8, top);
  if (!inside) { discard; }
  let edge = select(0.8 - abs(in.uv.x), 0.8 - dTop, top);
  let rim = smoothstep(0.0, 0.18, edge);
  let dead = vec3f(0.10, 0.12, 0.14) * (0.7 + 0.3 * in.seed) * rim + vec3f(0.0, 0.25, 0.05) * (1.0 - rim) * 0.6;
  let live = vec3f(0.14, 1.0, 0.25) * (0.7 + 0.3 * rim) + vec3f(0.6, 1.0, 0.7) * (1.0 - rim);
  let rgb = mix(dead, live, in.alive);
  return vec4f(rgb, 1.0);
}
