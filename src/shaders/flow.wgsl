import { Cam, palette, toClip, hash1 } from "./common.wgsl";
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> flows: array<vec4f>;  // from, to, token, strength
@group(0) @binding(3) var<storage, read> births: array<f32>;   // clock time a live transfer arrived, very negative for snapshot flows

struct Out { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) col: vec4f }

const PER_FLOW: u32 = 2u;
const FRESH: f32 = 2.4;

@vertex fn vs_main(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let fi = i / PER_FLOW;
  let f = flows[fi];
  let phase = hash1(i * 7919u + 13u);
  let speed = 0.12 + hash1(i * 104729u) * 0.10;
  let age = cam.time - births[fi];
  var t = fract(cam.time * speed + phase);
  var fresh = 0.0;
  if (age >= 0.0 && age < FRESH) {
    // a transfer that just landed: one fast bright run from sender to receiver, both sparks together
    t = age / FRESH;
    fresh = 1.0 - age / FRESH;
  }
  let a = pos[u32(f.x)].xy;
  let b = pos[u32(f.y)].xy;
  let w = mix(a, b, t);
  let clip = toClip(w, cam.center, cam.scale, cam.aspect);
  let on = f32((cam.mask >> u32(f.z)) & 1u) * select(1.0, 0.0, age < 0.0);   // not born yet: hidden
  let size = (1.6 + f.w * 2.6) * (1.0 + fresh * 1.8) * sqrt(cam.zoomPx) * on;
  let c = corners[v];
  var o: Out;
  o.p = vec4f(clip + c * size * 2.0 / cam.viewport, 0.0, 1.0);
  o.uv = c;
  let life = select(sin(t * 3.14159), 1.0, fresh > 0.0);
  let base = mix(palette(u32(f.z)), vec3f(1.0), 0.35);
  o.col = vec4f(mix(base, vec3f(1.0), fresh * 0.7), (0.35 + f.w * 0.6 + fresh * 0.8) * life);
  return o;
}

@fragment fn fs_main(in: Out) -> @location(0) vec4f {
  let q = max(abs(in.uv.x), abs(in.uv.y));
  if (q > 1.0) { discard; }
  let a = (1.0 - smoothstep(0.55, 1.0, q)) * in.col.a;
  return vec4f(in.col.rgb * a, a);
}
