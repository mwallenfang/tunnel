#version 400 core
#define FAR_PLANE 50.
#define EPSILON 0.0001

out vec4 frag_color;
uniform uvec2 uRes;
uniform float uTime;

vec3 light_sources[1];

// Structs for refactoring later on
struct Ray {
    vec3 origin;
    vec3 direction;
};

struct Hit {
    vec3 position;
    float distance;
    vec3 normal;
};

struct Light {
    vec3 position;
    vec3 color;
    float intensity;
};

// Source https://gist.github.com/patriciogonzalezvivo/670c22f3966e662d2f83
float mod289(float x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
vec4 mod289(vec4 x){return x - floor(x * (1.0 / 289.0)) * 289.0;}
vec4 perm(vec4 x){return mod289(((x * 34.0) + 1.0) * x);}

float noise(vec3 p){
    vec3 a = floor(p);
    vec3 d = p - a;
    d = d * d * (3.0 - 2.0 * d);

    vec4 b = a.xxyy + vec4(0.0, 1.0, 0.0, 1.0);
    vec4 k1 = perm(b.xyxy);
    vec4 k2 = perm(k1.xyxy + b.zzww);

    vec4 c = k2 + a.zzzz;
    vec4 k3 = perm(c);
    vec4 k4 = perm(c + 1.0);

    vec4 o1 = fract(k3 * (1.0 / 41.0));
    vec4 o2 = fract(k4 * (1.0 / 41.0));

    vec4 o3 = o2 * d.z + o1 * (1.0 - d.z);
    vec2 o4 = o3.yw * d.x + o3.xz * (1.0 - d.x);

    return o4.y * d.y + o4.x * (1.0 - d.y);
    // return 0.;
}

// A mod(float, int) without weird precision loss on the float
float modulo(float n, int val) {
    return (int(n) % val) + fract(n);
}

// The path the camera takes, ran over using t
vec3 path(float t) {
    return vec3(0., 3. + 0.2*sin(0.5*t), 5*t);
}


// **********************
// General SDF operations
// **********************

// A sharp union, basically just min()
float opSharpUnion(float object_1, float object_2) {
    return min(object_1, object_2);
}

// A smooth combination of two objects, taken from Inigo Quilez
float opSmoothUnion(float object_1, float object_2, float smoothness) {
    float h = clamp( 0.5 + 0.5*(object_2-object_1)/smoothness, 0.0, 1.0 );
    return mix( object_2, object_1, h ) - smoothness*h*(1.0-h);;
}

// A repetition operator, taken from Inigo Quilez
vec3 opRep( in vec3 ray_pos, in vec3 repeat_direction)
{
    vec3 q = mod(ray_pos+0.5*repeat_direction,repeat_direction)-0.5*repeat_direction;
    return q;
}

vec3 opTx(in vec3 ray_pos, in mat3 transform) {
    return inverse(transform) * ray_pos;
}

// ******************************
// General matrix transformations
// ******************************

mat3 matRotX(float angle) {
    mat3 rotation = mat3(0.);
    rotation[0][0] = 1.;
    rotation[1][2] = - sin(radians(angle));
    rotation[1][1] = cos(radians(angle));
    rotation[2][1] = sin(radians(angle));
    rotation[2][2] = cos(radians(angle));

    return rotation;
}
mat3 matRotY(float angle) {
    mat3 rotation = mat3(0.);
    rotation[0][0] = cos(radians(angle));
    rotation[2][0] = - sin(radians(angle));
    rotation[1][1] = 1.;
    rotation[0][2] = sin(radians(angle));
    rotation[2][2] = cos(radians(angle));

    return rotation;
}
mat3 matRotZ(float angle) {
    mat3 rotation = mat3(0.);
    rotation[0][0] = cos(radians(angle));
    rotation[0][1] = sin(radians(angle));
    rotation[1][1] = cos(radians(angle));
    rotation[1][0] = -sin(radians(angle));
    rotation[2][2] = 1.;

    return rotation;
}

// **************
// SDF primitives
// **************

// A box. shape are the directional radii, rounding allows rounding
float sdBox(vec3 pos, vec3 shape, float rounding) {
    vec3 q = abs(pos) - shape;
    return length(max(q, 0.)) + min( max( q.x, max(q.y, q.z)), 0. ) - rounding;
}

// A sphere
float sdSphere(vec3 pos,  float radius) {
    return length(pos) - radius;
}

float sdCappedCylinder( vec3 pos, float height, float radius )
{
  vec2 d = abs(vec2(length(pos.xz),pos.y)) - vec2(height,radius);
  return min(max(d.x,d.y),0.0) + length(max(d,0.0));
}

// A plane oriented using a normal
float sdPlane(vec3 pos, vec4 normal) {
    return dot(pos, normal.xyz) + normal.w;
}

// An infinite horizontal plane
float sdPlaneY(vec3 pos, float offset) {
    return sdPlane(pos, vec4(0., 1., 0., offset));
}

float sdTriPrism(vec3 pos, vec3 p, vec2 h )
{
    p -= pos;
    vec3 q = abs(p);
    return max(q.z-h.y,max(q.x*0.866025+p.y*0.5,-p.y)-h.x*0.5);
}

// *******************
// Combined primitives
// *******************

// Distance function of the rails with details
float sdTrack(vec3 ray_pos) {
    float top_box = sdBox(ray_pos - vec3(0.,0.18,0.), vec3(0.15,0.01,10.), 0.);
    float middle_box = sdBox(ray_pos - vec3(0., 0.08, 0.), vec3(0.08,0.08,10.), 0.);
    float bottom_box = sdBox(ray_pos - vec3(0.,0.0,0.), vec3(0.15,0.01,10.), 0.);
    return min(min(top_box, middle_box), bottom_box);
}

float sdWoodBeams(vec3 ray_pos, float size) {
    float top_bar = sdBox(ray_pos - vec3(0., size, 0.), vec3(size,0.2,0.2), 0.05);
    float left_bar = sdBox(ray_pos - vec3(-(size-1), 2, 0.), vec3(0.2,size,0.2), 0.05);
    float right_bar = sdBox(ray_pos - vec3((size-1), 2, 0.), vec3(0.2,size,0.2), 0.05);

    return opSmoothUnion(top_bar, opSmoothUnion(left_bar, right_bar, 0.1), 0.1);
}

// Distance function of the rail track, where distance is the distance between boards
float sdCartTrack(vec3 ray_pos, int distance) {
    // Draw the wooden boards
    ray_pos = opRep(ray_pos, vec3(0., 0., distance));

    float board_distance = sdBox(ray_pos, vec3(2,0.1,0.4), 0.05);

    // Draw board rail connectors
    float connector_left_distance = sdBox(ray_pos - vec3(.85, .15, .25), vec3(.05), .0);
    float connector_right_distance = sdBox(ray_pos - vec3(-0.85, .15, .25), vec3(.05), .0);

    float connector_distance = opSharpUnion(connector_left_distance, connector_right_distance);

    // Combine connector with boards
    board_distance = opSharpUnion(board_distance, connector_distance);

    // Draw the rails with details
    float left_track = sdTrack(ray_pos - vec3(-1., 0.15, 0.));
    float right_track = sdTrack(ray_pos - vec3(1., 0.15, 0.));

    float track_distance = opSharpUnion(left_track, right_track);


    // Combine the rails and the board
    return opSharpUnion(board_distance, track_distance);
}

float sdCart(vec3 ray_pos) {
    return 1999;//sdCappedCylinder(opTx(ray_pos - path(uTime) - vec3(0.,-2.,8.), matRotZ(90)), 1., 1.);
}

float sdGround(vec3 ray_pos) {
    return sdPlaneY(ray_pos, 0.5*noise(ray_pos) - 0.2);
}

float sdTunnel(vec3 ray_pos, float size) {
    float wall_distance = size - length(ray_pos.xy*vec2(1, 1)) + noise(ray_pos);

    float ground_distance = sdGround(ray_pos);

    wall_distance = opSmoothUnion(wall_distance, ground_distance,2 );

    // Draw the wooden beams
    float beam_distance = sdWoodBeams(opRep(ray_pos, vec3(0., 0., 3)), size);

    return opSharpUnion(wall_distance, beam_distance);
    //return opSmoothUnion(beam_distance, wall_distance, 0.05);
}

// *********
// Rendering
// *********

// Renderer based on https://github.com/electricsquare/raymarching-workshop



float map(vec3 pos){
    float tunnel_distance = sdTunnel(pos, 5);

    float track_distance = sdCartTrack(pos, 2);

    float scene_distance = opSharpUnion(tunnel_distance, track_distance);

    return min(scene_distance, sdCart(pos));
}

vec3 calcNormal(vec3 p){
    vec2 e = vec2(EPSILON, 0.);

    float d = map(p);

    vec3 gradient = d - vec3(
    map(p + e.xyy),
    map(p + e.yxy),
    map(p + e.yyx)
    );

    return normalize(gradient);
}

float ray(vec3 ray_origin, vec3 ray_direction){
    float t = 0.;

    uint steps = 100;

    for (int i=0; i<steps; i++) {
        vec3 pos = ray_origin + t*ray_direction;

        float d = map(pos);
        
        if( d < EPSILON * t) return t;
        if (d > FAR_PLANE) return -1;
        t += d;
    }
    return t;
}

float light_scan(vec3 pos, vec3 normal) {
    // pos += EPSILON * normal;
    vec3 light = light_sources[0];
    // TODO:Iterate over the light sources and take all of them into consideration
    vec3 light_direction = normalize(pos - light);
    float max_t = distance(pos,light);

    float res = 1.0;
    float k = 256;

    for (float t = 0.; t<=max_t;) {
        float h = map(pos - light_direction * t);
        if (h < EPSILON) {
            return 0.;
        }
        res = min(res, k*h/t);
        t += h;
    }

    return res;
}

// float distance_pos_light = distance(pos, light);

    // vec3 hit = pos + ray(pos, (pos - light)) * (pos - light);

    // float distance = distance(pos, hit);

    // if (distance > distance_pos_light) {
    //     return 1.;
    // }

    // return 0.;

vec3 gamma_correction(vec3 col) {
    return pow(col, vec3(0.4545));
}

vec3 render(vec3 ray_origin, vec3 ray_direction) {

    vec3 col = vec3(.5, .46, .42);

    float t = ray(ray_origin, ray_direction);
    if (t > 0.){
        vec3 pos = ray_origin + t*ray_direction;
        vec3 nor = calcNormal(pos);

        col = col * max(dot(normalize(ray_direction), nor), 0.) * light_scan(pos, nor);
    }
    col = mix(col , vec3(.0, .0, .0), smoothstep(0., .95, t*2/FAR_PLANE));
    return gamma_correction(col);
}

vec3 getCameraRayDir(vec2 uv, vec3 camPos, vec3 camTarget) {
    // Calculate camera's transform matrix components

    vec3 camForward = normalize(camTarget - camPos);
    vec3 camRight = normalize(cross(vec3(0., 1., 0.), camForward));
    vec3 camUp = normalize(cross(camForward, camRight));

    float fPersp = 1.0;

    vec3 vDir = normalize(uv.x * camRight + uv.y * camUp + camForward * fPersp);

    return vDir;
}

vec2 normalizeScreenCoords(vec2 screenCoords) {
    // vec2 result = 2. * (screenCoords/uRes.xy - 0.5);
    // result.y *= uRes.x / uRes.y;

    // return result;

    return (2*screenCoords - vec2(uRes.xy)) / float(uRes.y);
}

void main()
{
    // vec2 uv = (2*gl_FragCoord.xy - vec2(uRes.xy)) / float(uRes.y);
    vec2 uv = normalizeScreenCoords(gl_FragCoord.xy);

    vec3 camera_origin = path(uTime);
    vec3 camera_target = vec3(0., 0., 3.) + path(uTime);

    light_sources[0] = camera_target;

    vec3 camera_direction = getCameraRayDir(uv, camera_origin, camera_target);//normalize(vec3(p.xy, -1.));

    vec3 col = render(camera_origin, camera_direction);
    
    frag_color = vec4(col, 1.0);
}