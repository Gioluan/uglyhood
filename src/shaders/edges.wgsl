import { Cam, palette, toClip } from "./common.wgsl";
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> edges: array<vec4f>;   // a, b, weight, token

struct Out { @builtin(position) p: vec4f, @location(0) t: vec2f, @location(1) col: vec4f }

@vertex fn vs_main(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  var corners = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let e = edges[i];
  let a = pos[u32(e.x)].xy;
  let b = pos[u32(e.y)].xy;
  let ca = toClip(a, cam.center, cam.scale, cam.aspect) * cam.viewport * 0.5;
  let cb = toClip(b, cam.center, cam.scale, cam.aspect) * cam.viewport * 0.5;
  let dir = cb - ca;
  let len = max(length(dir), 0.001);
  let n = vec2f(-dir.y, dir.x) / len;
  let c = corners[v];
  let w = clamp(0.45 + e.z * 0.12, 0.45, 3.0) * sqrt(cam.zoomPx);
  let px = ca + dir * c.x + n * c.y * w;
  let on = f32((cam.mask >> u32(e.w)) & 1u);
  var o: Out;
  o.p = vec4f(px * 2.0 / cam.viewport, 0.0, 1.0);
  o.t = c;
  let alpha = (0.02 + min(e.z, 8.0) * 0.011) * mix(0.15, 1.0, on);
  o.col = vec4f(palette(u32(e.w)), alpha);
  return o;
}

@fragment fn fs_main(in: Out) -> @location(0) vec4f {
  let edgeFade = 1.0 - abs(in.t.y);
  let a = in.col.a * edgeFade;
  return vec4f(in.col.rgb * a, a);
}
