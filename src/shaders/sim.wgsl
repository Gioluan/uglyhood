// Force-directed layout, one thread per wallet. Repulsion is brute force (n^2) which is fine on a GPU
// for a few thousand nodes; attraction walks the CSR adjacency; gravity keeps islands in view.
struct Params { n: u32, dt: f32, repulsion: f32, attraction: f32, gravity: f32, damping: f32, maxSpeed: f32, pad: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;        // xy position, zw velocity
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read> attr: array<vec4f>;       // x mass, y token, z role, w degree
@group(0) @binding(4) var<storage, read> offsets: array<u32>;
@group(0) @binding(5) var<storage, read> neighbors: array<u32>;
@group(0) @binding(6) var<storage, read> weights: array<f32>;
@group(0) @binding(7) var<storage, read> anchors: array<vec2f>;   // one per token, index 7 = centre

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.n) { return; }
  let p = src[i].xy;
  var v = src[i].zw;
  let mi = attr[i].x;
  var f = vec2f(0.0);
  for (var j = 0u; j < params.n; j = j + 1u) {
    if (j == i) { continue; }
    let d = p - src[j].xy;
    let d2 = dot(d, d) + 0.05;
    f = f + d / d2 * params.repulsion * (0.4 + attr[j].x);
  }
  let start = offsets[i];
  let end = offsets[i + 1u];
  for (var k = start; k < end; k = k + 1u) {
    let j = neighbors[k];
    let d = src[j].xy - p;
    let hub = 1.0 / (1.0 + sqrt(attr[j].w) * 0.35);   // mega hubs pull less, so hoods can form
    f = f + d * params.attraction * (0.2 + weights[k]) * hub;
  }
  let role = attr[i].z;
  var anchor = anchors[7];
  if (role < 0.5) { anchor = anchors[u32(attr[i].y)]; }
  f = f - (p - anchor) * params.gravity * (0.5 + mi);
  v = (v + f * params.dt / (0.6 + mi)) * params.damping;
  let sp = length(v);
  if (sp > params.maxSpeed) { v = v / sp * params.maxSpeed; }
  dst[i] = vec4f(p + v * params.dt, v);
}
