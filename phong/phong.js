/**
 * phong/phong.js
 *
 * Demo interactiva del modelo de iluminación de Phong renderizada por software
 * sobre Canvas 2D (sin WebGL). Sirve como referencia pedagógica para entender
 * cómo un rasterizador implementa la ecuación de Phong píxel a píxel.
 *
 * ─── Modelo de iluminación de Phong ────────────────────────────────────────
 *
 * Bui Tuong Phong lo propuso en 1975 como aproximación empírica (no física)
 * de la apariencia de superficies iluminadas. Descompone la luz reflejada en
 * tres términos independientes:
 *
 *   I = Iₐ·kₐ  +  Id·kd·(L·N)  +  Ie·ke·(R·V)ⁿ
 *       ───────   ────────────    ──────────────
 *       ambiental    difusa         especular
 *
 *   donde:
 *     Iₐ, Id, Ie  intensidad de la fuente para cada término   [0, 1]
 *     kₐ, kd, ke  coeficientes del material para cada término [0, 1]
 *     N           normal unitaria en el punto de la superficie
 *     L           vector unitario del punto hacia la fuente de luz
 *     R           reflexión perfecta de L respecto a N: R = 2(L·N)N − L
 *     V           vector unitario del punto hacia el observador (cámara)
 *     n           exponente de brillo (shininess): a mayor n, brillo más puntual
 *
 * ─── Organización del código ───────────────────────────────────────────────
 *
 * Todo el módulo vive dentro de un IIFE (Immediately Invoked Function
 * Expression) para evitar contaminar el scope global. El flujo es:
 *
 *   init()  →  update()  →  buildRenderState()
 *                        →  drawSphere()   (rasterización píxel a píxel)
 *                        →  drawPolar()    (diagrama de distribución angular)
 *
 * Requisitos del HTML:
 *   - Botones .tab con atributo data-mode="full|ambient|diffuse|specular"
 *   - Sliders  #sl-ka, #sl-kd, #sl-ke, #sl-n, #sl-langle
 *   - Spans    #val-ka, #val-kd, #val-ke, #val-n, #val-langle
 *   - Div      #formula-display
 *   - Canvas   #sphere  y  #polar  (ambos 220×220 px)
 */
(function PhongDemo() {

// ---------------------------------------------------------------------------
// Estado del módulo
// ---------------------------------------------------------------------------

/**
 * Componente de iluminación actualmente visible.
 * 'full' muestra la suma de los tres términos; los demás aíslan uno solo.
 * Esta separación es útil para comprender la contribución de cada componente.
 *
 * @type {'full'|'ambient'|'diffuse'|'specular'}
 */
let mode = 'full';

/**
 * MediaQueryList que observa el tema del sistema operativo.
 * Se suscribe una única vez en init() para reaccionar a cambios en tiempo real
 * (el usuario cambia el tema del SO sin recargar la página).
 *
 * La propiedad 'prefers-color-scheme' forma parte de Media Queries Level 5.
 */
const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * Caché del resultado actual de darkModeQuery.matches.
 * Se actualiza en el listener de cambio de tema y lo leen drawSphere/drawPolar
 * para elegir la paleta de colores adecuada.
 */
let isDark = darkModeQuery.matches;

// ---------------------------------------------------------------------------
// Caché de referencias DOM — poblada en init(), antes de cualquier render
// ---------------------------------------------------------------------------

/**
 * Objeto que centraliza todas las referencias a elementos del DOM.
 * Se rellena una sola vez en init(). Esto evita llamadas repetidas a
 * document.getElementById() en cada frame, que fuerzan una búsqueda en el
 * árbol DOM (operación O(n) sobre el total de nodos).
 *
 * @type {{
 *   sliders: { ka, kd, ke, n, langle: HTMLInputElement },
 *   values:  { ka, kd, ke, n, langle: HTMLElement },
 *   formulaDisplay: HTMLElement,
 *   canvasSphere: HTMLCanvasElement,
 *   canvasPolar:  HTMLCanvasElement,
 *   ctxSphere: CanvasRenderingContext2D,
 *   ctxPolar:  CanvasRenderingContext2D,
 *   tabs: NodeList
 * }}
 */
let DOM = null;

/**
 * Buffer de píxeles reutilizado entre frames.
 *
 * Un objeto ImageData encapsula un Uint8ClampedArray de tamaño W×H×4 bytes
 * (un byte por canal RGBA). Crearlo desde cero cada frame fuerza una
 * reserva de memoria y, eventualmente, una pasada del Garbage Collector.
 *
 * En su lugar se crea una sola vez y se rellena con fill(0) para limpiar
 * todos los canales. fill(0) opera sobre el TypedArray nativo y es
 * significativamente más rápido que createImageData + clearRect.
 */
let _sphereImageData = null;

// ---------------------------------------------------------------------------
// Constantes de configuración
// ---------------------------------------------------------------------------

/**
 * Parámetros geométricos y visuales de la demo.
 * Agruparlos en un único objeto literal permite localizar y ajustar
 * cualquier "número mágico" sin buscar por todo el código.
 */
const CONFIG = {
  // ── Geometría de la esfera ────────────────────────────────────────────────
  // La esfera ocupa un canvas de 220×220 px. El radio de 96 px deja un margen
  // de (220/2 − 96) = 14 px a cada lado para el borde y la flecha de luz.
  SPHERE_RADIUS: 96,

  // ── Flecha indicadora de L en la vista de esfera ─────────────────────────
  LIGHT_ARROW_DIST:   80,   // distancia del centro al punto de inicio de la flecha (px)
  LIGHT_ARROW_Y_DIST: 60,   // desplazamiento Y del punto de inicio (px)
  LIGHT_ARROW_LEN:    40,   // componente horizontal de la longitud de la flecha (px)
  LIGHT_ARROW_Y_LEN:  30,   // componente vertical de la longitud de la flecha (px)

  // ── Intensidades de la fuente de luz ─────────────────────────────────────
  // Valores fijos en esta demo; en un motor real serían propiedades del objeto Light.
  //   Ia = 0.6  →  luz ambiental moderada (evita zonas completamente negras)
  //   Id = 0.8  →  luz difusa fuerte (domina la forma percibida del objeto)
  //   Ie = 1.0  →  luz especular al máximo (el brillo blanco puede saturar)
  LIGHT_INTENSITY: { Ia: 0.6, Id: 0.8, Ie: 1.0 },

  // ── Mezcla del brillo especular blanco sobre el color base ───────────────
  // La luz especular produce un reflejo casi blanco independiente del color
  // del material. Se añade proporcionalmente a cada canal RGB del píxel.
  // Los factores son asimétricos (r > g > b) para dar un tono cálido al brillo.
  SPECULAR_BLEND: { r: 0.15, g: 0.10, b: 0.08 },

  // ── Colores base del material por modo (R, G, B en [0, 255]) ─────────────
  // Cada modo usa un color diferente para facilitar la identificación visual
  // del componente que se está estudiando.
  SPHERE_COLORS: {
    full:     [180, 130,  80],   // marrón cálido — muestra los tres términos
    ambient:  [100, 160, 220],   // azul   — constante, sin variación angular
    diffuse:  [ 80, 170, 100],   // verde  — gradiente suave según cos θ
    specular: [200, 180,  90],   // dorado — punto brillante concentrado
  },

  // ── Geometría del diagrama polar ─────────────────────────────────────────
  // El diagrama polar representa la distribución angular de la intensidad
  // reflejada en el plano XZ (sección vertical de la BRDF simplificada).
  POLAR_RADIUS:        90,   // radio máximo del trazado (px)
  POLAR_BOTTOM_MARGIN: 30,   // margen inferior (cy = H − margen) para etiquetas
  POLAR_AXIS_EXT:      10,   // extensión de ejes más allá del radio (px)
  POLAR_MAX_VAL:       1.2,  // clamp visual: evita que valores > 1 salgan del canvas
  POLAR_LIGHT_ARROW:   50,   // longitud de la flecha L en el diagrama (px)
  POLAR_LABEL_OFFSET:  12,   // separación vertical entre líneas de la leyenda (px)
};

/**
 * Fórmulas matemáticas mostradas en el panel de descripción.
 * Se usan caracteres Unicode para subíndices y superíndices (no MathML)
 * para máxima compatibilidad sin dependencias externas.
 */
const FORMULAS = {
  full:
    'I = Iₐ·kₐ  +  Id·kd·(L·N)  +  Ie·ke·(R·V)ⁿ',
  ambient:
    'Iamb = Iₐ · kₐ\n\nConstante para toda la superficie.\nNo depende de N, L ni V.',
  diffuse:
    'Idif = Id · kd · (L·N) = Id · kd · cos θ\n\nθ = ángulo entre normal N y luz L\nMáxima cuando L ∥ N  (θ=0)',
  specular:
    'Iesp = Ie · ke · (R·V)ⁿ = Ie · ke · cosⁿ φ\n\nR = 2(L·N)N − L    (reflexión perfecta)\nφ = ángulo entre V y R\nn alto → brillo pequeño y concentrado',
};

// ---------------------------------------------------------------------------
// Lógica de iluminación — funciones puras, sin dependencia de estado externo
// ---------------------------------------------------------------------------

/**
 * Implementa la ecuación de iluminación de Phong para un único punto de la
 * superficie. Es una función pura: dado el mismo input siempre produce el
 * mismo output y no lee ni escribe ningún estado global.
 *
 * ── Término ambiental ──────────────────────────────────────────────────────
 *   Iamb = Iₐ · kₐ
 *
 *   Representa la luz indirecta (rebotes múltiples, cielo, etc.) de forma
 *   simplificada como una constante uniforme. No depende de la geometría.
 *   En PBR moderno se sustituye por mapas de irradiancia (IBL).
 *
 * ── Término difuso (Lambert) ───────────────────────────────────────────────
 *   Idif = Id · kd · max(0, L·N)  =  Id · kd · max(0, cos θ)
 *
 *   La ley del coseno de Lambert: una superficie recibe más energía cuanto
 *   más perpendicular está a la dirección de la luz. El max(0, …) descarta
 *   ángulos obtusos (cara trasera de la geometría), donde cos θ < 0.
 *   Es independiente de la posición del observador (V): la rugosidad difusa
 *   dispersa la luz por igual en todas las direcciones (superficie Lambertiana).
 *
 * ── Término especular (Phong) ──────────────────────────────────────────────
 *   Iesp = Ie · ke · max(0, R·V)ⁿ  =  Ie · ke · max(0, cos φ)ⁿ
 *
 *   R = 2(L·N)N − L  es el vector de reflexión perfecta especular.
 *   Geométricamente, R es el simétrico de L respecto a N.
 *
 *   (R·V) = cos φ, donde φ es el ángulo entre R y el observador V.
 *   El exponente n controla la "apertura" del lóbulo especular:
 *     n = 1   → brillo muy difuso, cubre casi toda la superficie
 *     n = 200 → brillo muy puntual, superficies muy pulidas (metales, plásticos)
 *
 *   Nota: Blinn-Phong (1977) sustituye R·V por (H·N) donde H = normalize(L+V),
 *   lo que es más eficiente y físicamente más coherente, pero ambos son modelos
 *   empíricos, no derivados de una BRDF físicamente correcta.
 *
 * @param {{ x: number, y: number, z: number }} N  Normal unitaria del fragmento
 * @param {{ x: number, y: number, z: number }} L  Vector unitario punto→luz
 * @param {number} ka   Coeficiente ambiental del material [0, 1]
 * @param {number} kd   Coeficiente difuso    del material [0, 1]
 * @param {number} ke   Coeficiente especular del material [0, 1]
 * @param {number} n    Exponente de brillo (shininess) [1, 200]
 * @param {number} Ia   Intensidad de la componente ambiental  [0, 1]
 * @param {number} Id   Intensidad de la componente difusa     [0, 1]
 * @param {number} Ie   Intensidad de la componente especular  [0, 1]
 * @returns {{ ambient: number, diffuse: number, specular: number }}
 */
function computePhong(N, L, ka, kd, ke, n, Ia, Id, Ie) {
  // Producto escalar L·N = cos θ.  max(0, …) descarta la cara trasera.
  const LdotN = Math.max(0, L.x * N.x + L.y * N.y + L.z * N.z);

  // Término ambiental: constante, independiente de la geometría
  const ambient = Ia * ka;

  // Término difuso: proporcional al coseno del ángulo de incidencia
  const diffuse = Id * kd * LdotN;

  // ── Cálculo del vector de reflexión R ──────────────────────────────────
  // R = 2(L·N)N − L
  // Derivación geométrica: proyectamos L sobre N → la componente normal es
  // (L·N)N.  El doble de esa proyección menos L da el simétrico.
  // R no está normalizado porque las imprecisiones de punto flotante pueden
  // dar un módulo ligeramente distinto de 1; lo normalizamos explícitamente.
  const Rx = 2 * LdotN * N.x - L.x;
  const Ry = 2 * LdotN * N.y - L.y;
  const Rz = 2 * LdotN * N.z - L.z;
  const reflectLen = Math.sqrt(Rx * Rx + Ry * Ry + Rz * Rz) || 1; // || 1 evita ÷0

  // ── Observador V ───────────────────────────────────────────────────────
  // En esta demo se asume proyección ortográfica con el observador en +Z
  // (mirada perpendicular al plano XY). Por tanto V = (0, 0, 1).
  // El producto R·V simplifica a Rz/|R|, solo la componente Z de R normalizada.
  const RdotV = Math.max(0, Rz / reflectLen);

  // Término especular: lóbulo de coseno elevado al exponente de brillo
  const specular = Ie * ke * Math.pow(RdotV, n);

  return { ambient, diffuse, specular };
}

/**
 * Combina los tres componentes de Phong según el modo de visualización.
 *
 * Separar esta función de computePhong tiene una ventaja pedagógica importante:
 * computePhong siempre calcula los tres términos (permite comparar en un mismo
 * frame el valor de cada uno), mientras que intensityForMode decide cuál
 * mostrar según el tab activo.
 *
 * @param {{ ambient: number, diffuse: number, specular: number }} components
 * @param {'full'|'ambient'|'diffuse'|'specular'} m  Modo de visualización activo
 * @returns {number}  Intensidad final [0, ~2] (puede superar 1 si los tres suman)
 */
function intensityForMode({ ambient, diffuse, specular }, m) {
  switch (m) {
    case 'ambient':  return ambient;
    case 'diffuse':  return diffuse;
    case 'specular': return specular;
    default:         return ambient + diffuse + specular; // 'full'
  }
}

// ---------------------------------------------------------------------------
// Estado de render — calculado una sola vez por frame en update()
// ---------------------------------------------------------------------------

/**
 * Construye el objeto de estado compartido por drawSphere y drawPolar.
 *
 * El patrón "builder de estado de render" evita que cada función de dibujo
 * vuelva a convertir grados→radianes o normalizar el vector de luz. Todas
 * las operaciones costosas (sin, cos, sqrt) se ejecutan una sola vez por frame.
 *
 * ── Vector de luz L ────────────────────────────────────────────────────────
 *
 * La posición de la luz se codifica como un ángulo 'la' en grados medido
 * desde el eje +Z (hacia el observador) hacia el eje +X (derecha):
 *
 *   lx = sin(la)         componente horizontal (derecha al aumentar la)
 *   lz = cos(la)         componente de profundidad (→ 0 cuando la → 90°)
 *   ly = −sin(la/2)      componente vertical negativa: da la ilusión de que
 *                        la luz viene ligeramente de arriba (no es físico,
 *                        es una elección estética para la demo)
 *
 * Finalmente el vector se normaliza (módulo = 1) para que el producto
 * escalar L·N dé directamente el coseno del ángulo entre ellos.
 *
 * @param {number} ka   Coeficiente ambiental  [0, 1]
 * @param {number} kd   Coeficiente difuso     [0, 1]
 * @param {number} ke   Coeficiente especular  [0, 1]
 * @param {number} n    Exponente de brillo    [1, 200]
 * @param {number} la   Ángulo de la luz en grados [0, 85]
 * @returns {{ ka, kd, ke, n, sinLa, cosLa, light: {x,y,z} }}
 */
function buildRenderState(ka, kd, ke, n, la) {
  const lightAngleRad = la * (Math.PI / 180);  // conversión grados → radianes
  const sinLa = Math.sin(lightAngleRad);
  const cosLa = Math.cos(lightAngleRad);

  // Componentes del vector de luz antes de normalizar
  const lx =  sinLa;
  const ly = -Math.sin(lightAngleRad * 0.5);   // inclinación vertical suave
  const lz =  cosLa;
  const ll =  Math.sqrt(lx * lx + ly * ly + lz * lz);  // módulo del vector

  return {
    ka, kd, ke, n,
    sinLa,  // usados directamente para dibujar las flechas de L en los canvas
    cosLa,
    light: { x: lx / ll, y: ly / ll, z: lz / ll },  // vector L normalizado
  };
}

// ---------------------------------------------------------------------------
// Renderizado — esfera rasterizada por software (Canvas 2D)
// ---------------------------------------------------------------------------

/**
 * Rasteriza la esfera iluminada con Phong píxel a píxel sobre el canvas #sphere.
 *
 * ── ¿Qué es la rasterización por software? ────────────────────────────────
 *
 * En una GPU, el fragment shader ejecuta la ecuación de iluminación en paralelo
 * para miles de píxeles simultáneamente. Aquí lo hacemos en la CPU, de forma
 * secuencial, para que el código sea legible y fácil de depurar.
 * El resultado visual es idéntico; el rendimiento, mucho peor.
 *
 * ── Mapeo píxel → normal de la esfera ────────────────────────────────────
 *
 * La esfera de radio r está centrada en (cx, cy) en coordenadas del canvas.
 * Para un píxel (px, py), definimos:
 *
 *   dx = px − cx  (componente X en espacio de pantalla)
 *   dy = py − cy  (componente Y en espacio de pantalla)
 *
 * Condición de estar dentro de la esfera: dx² + dy² ≤ r²
 *
 * La normal en ese punto (suponiendo proyección ortográfica) es el vector
 * que apunta desde el centro de la esfera hacia el punto de la superficie
 * en la dirección de la cámara (+Z):
 *
 *   nx = dx / r          (en [−1, 1])
 *   ny = dy / r          (en [−1, 1])
 *   nz = √(1 − nx²−ny²)  (siempre ≥ 0, cara frontal visible)
 *
 * Como nx = dx/r, ny = dy/r, se tiene: nx² + ny² = (dx²+dy²)/r² = dist2/r²
 * Por tanto: nz = √(1 − dist2/r²) = √(1 − dist2·invR²)
 *
 * Esto produce una normal unitaria |N| = 1 por construcción, lo que
 * simplifica los cálculos de Phong (L·N = |L||N|cos θ = cos θ directamente).
 *
 * ── Mapeo de intensidad a color ───────────────────────────────────────────
 *
 * La intensidad I ∈ [0, ~2] se escala a [0, 255] para el canal del color
 * base, y además se mezcla un brillo blanco proporcional al término especular
 * para simular el halo brillante característico de las superficies pulidas.
 *
 * @param {{ ka, kd, ke, n, light, sinLa, cosLa }} state  Estado de render
 */
function drawSphere(state) {
  const { ka, kd, ke, n, sinLa, cosLa, light } = state;

  const cv  = DOM.canvasSphere;
  const ctx = DOM.ctxSphere;           // contexto cacheado en init(), no getContext() cada frame
  const W   = cv.width;
  const H   = cv.height;
  const cx  = W / 2;                  // centro X del canvas (= centro de la esfera)
  const cy  = H / 2;                  // centro Y del canvas
  const r   = CONFIG.SPHERE_RADIUS;
  const [cr, cg, cb] = CONFIG.SPHERE_COLORS[mode];  // color base RGB del material

  // ── Gestión del buffer de píxeles ─────────────────────────────────────
  // ImageData.data es un Uint8ClampedArray: valores enteros en [0, 255] que
  // se "clampean" automáticamente (ningún valor sale del rango aunque escribas 300).
  // Se reutiliza entre frames; solo se recrea si el canvas cambia de tamaño.
  if (!_sphereImageData || _sphereImageData.width !== W || _sphereImageData.height !== H) {
    _sphereImageData = ctx.createImageData(W, H);
  }
  _sphereImageData.data.fill(0);        // RGBA = (0,0,0,0) → transparente en toda la imagen
  const pixels = _sphereImageData.data; // referencia directa al TypedArray

  const { Ia, Id, Ie } = CONFIG.LIGHT_INTENSITY;

  // ── Precálculo fuera del doble bucle ──────────────────────────────────
  // invR y r2 se usarían ~47.000 veces (220×220 iteraciones) si se calculasen
  // dentro. Precalcularlos fuera es una micro-optimización clásica en rasterizadores.
  const invR = 1 / r;    // 1/r → sustituye divisiones por multiplicaciones (más rápidas)
  const r2   = r * r;    // r² → evita recalcular la multiplicación en cada píxel

  // ── Doble bucle de rasterización (equivalente al fragment shader en GPU) ──
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const dx    = px - cx;           // distancia horizontal al centro
      const dy    = py - cy;           // distancia vertical al centro
      const dist2 = dx * dx + dy * dy; // distancia al centro al cuadrado (evita sqrt)

      // Descarte rápido: el píxel está fuera de la esfera → saltar
      if (dist2 > r2) continue;

      // ── Normal unitaria en la superficie (opción B: normalizar con invR) ──
      // nx y ny se obtienen multiplicando por invR en lugar de dividir por r.
      // nz se calcula directamente en espacio normalizado: argumento ya en [0,1].
      const nx = dx * invR;
      const ny = dy * invR;
      const nz = Math.sqrt(1 - dist2 * invR * invR);
      // Nota: no se llama a normalize() separado porque la construcción garantiza
      // que |N|² = nx²+ny²+nz² = (dist2/r²) + (1 − dist2/r²) = 1 exactamente.

      // ── Cálculo de Phong para este píxel ──────────────────────────────
      const I  = intensityForMode(
        computePhong({ x: nx, y: ny, z: nz }, light, ka, kd, ke, n, Ia, Id, Ie),
        mode
      );

      // Convertir intensidad [0, ~2] a byte [0, 255]
      // Math.min evita overflow del Uint8ClampedArray aunque este lo haría solo
      const ic = Math.min(255, Math.round(I * 255));

      // ── Mezcla color base + brillo especular blanco ────────────────────
      // El color final de cada canal mezcla el color del material modulado por I
      // con una contribución blanca proporcional al brillo especular (ic).
      // SPECULAR_BLEND pesa más el canal rojo para dar un tono cálido al reflejo.
      const ri = Math.min(255, Math.round(cr * I + ic * CONFIG.SPECULAR_BLEND.r));
      const gi = Math.min(255, Math.round(cg * I + ic * CONFIG.SPECULAR_BLEND.g));
      const bi = Math.min(255, Math.round(cb * I + ic * CONFIG.SPECULAR_BLEND.b));

      // ── Escritura en el buffer RGBA ────────────────────────────────────
      // El índice del píxel (px, py) en el array lineal es (py·W + px)·4.
      // Los 4 bytes son: [R, G, B, A]. Alpha = 255 → completamente opaco.
      const idx = (py * W + px) * 4;
      pixels[idx]     = ri;
      pixels[idx + 1] = gi;
      pixels[idx + 2] = bi;
      pixels[idx + 3] = 255;
    }
  }

  // Vuelca el buffer de píxeles al canvas de una sola vez (una sola llamada a la API)
  ctx.putImageData(_sphereImageData, 0, 0);

  // ── Borde sutil de la esfera ──────────────────────────────────────────
  // Se dibuja encima del ImageData para delimitar visualmente la silueta.
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.stroke();

  // ── Flecha indicadora de la dirección de la luz (vector L) ────────────
  // Se posiciona en el borde exterior de la esfera proyectando la dirección
  // de la luz sobre el plano de pantalla con sinLa y cosLa.
  const arrowX = cx + sinLa * CONFIG.LIGHT_ARROW_DIST;
  const arrowY = cy - cosLa * CONFIG.LIGHT_ARROW_Y_DIST;
  ctx.strokeStyle = '#EF9F27';   // naranja — identifica L en ambos canvas
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowY);
  ctx.lineTo(arrowX - sinLa * CONFIG.LIGHT_ARROW_LEN, arrowY + cosLa * CONFIG.LIGHT_ARROW_Y_LEN);
  ctx.stroke();
  ctx.fillStyle = '#EF9F27';
  ctx.font      = '11px sans-serif';
  ctx.fillText('L', arrowX + 4, arrowY - 4);
}

// ---------------------------------------------------------------------------
// Helpers de color
// ---------------------------------------------------------------------------

/**
 * Añade o reemplaza el canal alpha en una cadena de color CSS rgb/rgba.
 *
 * Necesario porque el Canvas 2D solo acepta cadenas CSS para fillStyle/strokeStyle,
 * y necesitamos generar la versión semitransparente del color del trazo para
 * el relleno interior del diagrama polar.
 *
 * Ejemplos:
 *   withAlpha('rgb(255, 0, 0)', 0.12)   → 'rgba(255, 0, 0, 0.12)'
 *   withAlpha('rgba(255, 0, 0, 1)', 0.12) → 'rgba(255, 0, 0, 0.12)'
 *
 * @param {string} rgb    Color en formato 'rgb(r,g,b)' o 'rgba(r,g,b,a)'
 * @param {number} alpha  Nuevo valor de opacidad [0, 1]
 * @returns {string}
 */
function withAlpha(rgb, alpha) {
  return rgb.startsWith('rgba')
    ? rgb.replace(/[\d.]+\)$/, `${alpha})`)       // reemplaza el alpha existente
    : rgb.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);  // inserta alpha
}

// ---------------------------------------------------------------------------
// Renderizado — diagrama polar de distribución angular (BRDF simplificada)
// ---------------------------------------------------------------------------

/**
 * Dibuja el diagrama polar de distribución angular sobre el canvas #polar.
 *
 * ── ¿Qué es un diagrama polar en el contexto de iluminación? ─────────────
 *
 * Una BRDF (Bidirectional Reflectance Distribution Function) describe cómo
 * un material refleja la luz en función de la dirección de entrada (L) y de
 * salida (V). Para cada par (L, V) da un valor de reflectancia.
 *
 * El diagrama polar aquí representado es una sección 2D de la BRDF en el
 * plano XZ (y=0), fijando L y barriendo todos los posibles observadores V.
 * Para cada ángulo θ ∈ [0°, 180°] se calcula la normal N = (sin θ, 0, cos θ)
 * y se evalúa computePhong con el observador siempre en +Z (V = (0,0,1)).
 *
 * La distancia desde el centro al punto del polígono en la dirección de N
 * es proporcional a la intensidad reflejada en esa dirección. El resultado
 * muestra visualmente:
 *   - Ambiental: semicírculo perfecto (constante en todo ángulo)
 *   - Difusa:    lóbulo coseno (más ancho, gradual, centrado en N ∥ L)
 *   - Especular: lóbulo estrecho y puntiagudo (mayor n → más estrecho)
 *
 * ── Coordenadas del diagrama ──────────────────────────────────────────────
 *
 * El origen (0,0) del canvas está en la esquina superior izquierda.
 * El origen del diagrama polar está en (cx, cy) donde:
 *   cy = H − POLAR_BOTTOM_MARGIN   (parte inferior del canvas, con margen)
 *
 * Para cada ángulo θ, el punto del polígono es:
 *   pointX = cx + sin(θ) · r · val   (positivo → derecha)
 *   pointY = cy − cos(θ) · r · val   (negativo → arriba, invierte eje Y del canvas)
 *
 * @param {{ ka, kd, ke, n, sinLa, cosLa }} state  Estado de render
 */
function drawPolar(state) {
  const { ka, kd, ke, n, sinLa, cosLa } = state;

  const cv  = DOM.canvasPolar;
  const ctx = DOM.ctxPolar;            // contexto cacheado en init()
  const W   = cv.width;
  const H   = cv.height;
  const cx  = W / 2;
  const cy  = H - CONFIG.POLAR_BOTTOM_MARGIN;  // origen en la parte inferior
  const r   = CONFIG.POLAR_RADIUS;

  ctx.clearRect(0, 0, W, H);           // limpia el canvas antes de redibujar

  // Colores de guía adaptados al tema del sistema
  const axisCol = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
  const textCol = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.4)';

  // ── Semicírculos de referencia ────────────────────────────────────────
  // Los anillos al 33%, 66% y 100% del radio actúan como escala visual.
  // Permiten estimar a qué intensidad relativa corresponde cada punto del lóbulo.
  for (const rr of [0.33, 0.66, 1.0]) {
    ctx.strokeStyle = axisCol;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r * rr, Math.PI, 2 * Math.PI); // solo semicírculo superior
    ctx.stroke();
  }

  // ── Ejes de referencia ────────────────────────────────────────────────
  // Eje horizontal (plano tangente en la base de la superficie)
  ctx.strokeStyle = axisCol;
  ctx.lineWidth   = 0.5;
  ctx.beginPath(); ctx.moveTo(cx - r - CONFIG.POLAR_AXIS_EXT, cy); ctx.lineTo(cx + r + CONFIG.POLAR_AXIS_EXT, cy); ctx.stroke();
  // Eje vertical (dirección de la normal central N = (0, 0, 1))
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - r - CONFIG.POLAR_AXIS_EXT); ctx.stroke();

  // ── Vector de luz 2D para el diagrama (sección plano XZ) ─────────────
  // En el plano de corte, L se proyecta como (sin(la), cos(la)) ignorando ly.
  const lx = sinLa;
  const lz = cosLa;

  const { Ia, Id, Ie } = CONFIG.LIGHT_INTENSITY;

  /**
   * Traza el lóbulo polar de un componente de Phong.
   *
   * Para θ de 0° a 180° (hemiesfera superior), calcula la normal N en ese
   * ángulo y evalúa el componente indicado. La intensidad resultante escala
   * la distancia radial del punto. El resultado es un polígono cerrado que,
   * rellenado con transparencia, muestra la "forma" de la distribución.
   *
   * @param {'ambient'|'diffuse'|'specular'} compMode  Componente a trazar
   * @param {string} color  Color CSS en formato 'rgb(r,g,b)'
   */
  const drawComponent = (compMode, color) => {
    ctx.beginPath();
    let first = true;

    for (let i = 0; i <= 180; i++) {
      const theta = i * (Math.PI / 180);

      // Normal en el ángulo theta del plano XZ (y siempre 0 en este corte 2D)
      // Nota: tanto N como L deben ser vectores 3D para reutilizar computePhong.
      const N = { x: Math.sin(theta), y: 0, z: Math.cos(theta) };
      const L = { x: lx, y: 0, z: lz };

      // Intensidad del componente para esta dirección, clampeada al límite visual
      const val = Math.min(
        intensityForMode(computePhong(N, L, ka, kd, ke, n, Ia, Id, Ie), compMode),
        CONFIG.POLAR_MAX_VAL
      );

      // Coordenadas del punto en el canvas: origen en (cx, cy), Y invertido
      const pointX = cx + N.x * r * val;
      const pointY = cy - N.z * r * val;

      if (first) { ctx.moveTo(pointX, pointY); first = false; }
      else        ctx.lineTo(pointX, pointY);
    }

    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.stroke();                               // contorno sólido del lóbulo
    ctx.fillStyle = withAlpha(color, 0.12);     // relleno semitransparente
    ctx.fill();
  };

  // ── Paleta de colores según tema del sistema ──────────────────────────
  // Los tres colores son distintos para poder superponer los tres lóbulos
  // en modo 'full' y distinguirlos claramente.
  const ambColor = isDark ? 'rgb(100, 160, 220)' : 'rgb(60, 120, 200)';   // azul
  const difColor = isDark ? 'rgb(80, 180, 110)'  : 'rgb(40, 150, 70)';    // verde
  const espColor = isDark ? 'rgb(240, 180, 60)'  : 'rgb(200, 130, 20)';   // naranja

  // Dibuja solo el/los componente/s activos según el tab seleccionado
  if (mode === 'full' || mode === 'ambient')  drawComponent('ambient',  ambColor);
  if (mode === 'full' || mode === 'diffuse')  drawComponent('diffuse',  difColor);
  if (mode === 'full' || mode === 'specular') drawComponent('specular', espColor);

  // ── Flecha de la luz (L) ──────────────────────────────────────────────
  // Se traza desde el origen del diagrama en la dirección (sinLa, −cosLa)
  // (el signo negativo invierte el eje Y del canvas para que L apunte "arriba").
  const lax = cx + sinLa * CONFIG.POLAR_LIGHT_ARROW;
  const lay = cy - cosLa * CONFIG.POLAR_LIGHT_ARROW;
  ctx.strokeStyle = '#EF9F27';    // mismo naranja que en drawSphere para coherencia
  ctx.lineWidth   = 1.5;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(lax, lay); ctx.stroke();
  ctx.fillStyle = '#EF9F27';
  ctx.font      = '11px sans-serif';
  ctx.fillText('L', lax + 3, lay - 3);

  // ── Etiqueta del eje normal (N) ────────────────────────────────────────
  ctx.fillStyle = textCol;
  ctx.font      = '10px sans-serif';
  ctx.fillText('N', cx + 3, cy - r - CONFIG.POLAR_LABEL_OFFSET);

  // ── Leyenda de componentes (solo en modo completo) ────────────────────
  // Muestra las etiquetas de color de cada lóbulo en la esquina inferior izquierda.
  if (mode === 'full') {
    const lo = CONFIG.POLAR_LABEL_OFFSET;
    ctx.fillStyle = ambColor; ctx.fillText('ambiental', cx - r + 2, cy - lo);
    ctx.fillStyle = difColor; ctx.fillText('difusa',    cx - r + 2, cy - lo * 2);
    ctx.fillStyle = espColor; ctx.fillText('especular', cx - r + 2, cy - lo * 3);
  }
}

// ---------------------------------------------------------------------------
// Controladores de UI
// ---------------------------------------------------------------------------

/**
 * Cambia el componente de iluminación activo y actualiza la UI en consecuencia.
 *
 * Se encarga de tres responsabilidades:
 *   1. Actualizar la variable de estado 'mode'.
 *   2. Sincronizar los atributos ARIA (aria-selected) y la clase CSS 'active'
 *      en los botones de tab, cumpliendo el patrón WAI-ARIA Tabs.
 *   3. Actualizar el texto de la fórmula visible y forzar un redibujado.
 *
 * @param {string} m  Nuevo modo: 'full' | 'ambient' | 'diffuse' | 'specular'
 */
function setMode(m) {
  mode = m;

  // aria-selected="true/false" es imprescindible para que los lectores de
  // pantalla anuncien qué tab está activo; solo la clase CSS 'active' no basta.
  DOM.tabs.forEach(btn => {
    const isActive = btn.dataset.mode === m;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  DOM.formulaDisplay.textContent = FORMULAS[m];
  update();
}

/**
 * Lee los valores actuales de los sliders, actualiza las etiquetas numéricas,
 * los atributos ARIA de accesibilidad y redibuja ambos canvas.
 *
 * Esta función es el único punto de entrada al pipeline de render:
 *   sliders → buildRenderState → drawSphere + drawPolar
 *
 * Se llama en cada evento 'input' de cualquier slider y en cada cambio de modo.
 */
function update() {
  // Leer los cinco parámetros del modelo de Phong desde los sliders HTML
  const ka = Number(DOM.sliders.ka.value);
  const kd = Number(DOM.sliders.kd.value);
  const ke = Number(DOM.sliders.ke.value);
  const n  = Number(DOM.sliders.n.value);
  const la = Number(DOM.sliders.langle.value);

  // Actualizar las etiquetas de valor junto a cada slider (feedback visual inmediato)
  DOM.values.ka.textContent     = ka.toFixed(2);
  DOM.values.kd.textContent     = kd.toFixed(2);
  DOM.values.ke.textContent     = ke.toFixed(2);
  DOM.values.n.textContent      = n;
  DOM.values.langle.textContent = la;

  // aria-valuetext permite que lectores de pantalla lean el valor formateado
  // en lugar del valor numérico crudo del input (importante para decimales y unidades)
  DOM.sliders.ka.setAttribute('aria-valuetext',     ka.toFixed(2));
  DOM.sliders.kd.setAttribute('aria-valuetext',     kd.toFixed(2));
  DOM.sliders.ke.setAttribute('aria-valuetext',     ke.toFixed(2));
  DOM.sliders.n.setAttribute('aria-valuetext',      String(n));
  DOM.sliders.langle.setAttribute('aria-valuetext', String(la));

  // Construir el estado de render (una sola vez) y pasárselo a los dos canvas
  const state = buildRenderState(ka, kd, ke, n, la);
  drawSphere(state);
  drawPolar(state);
}

// ---------------------------------------------------------------------------
// Inicialización
// ---------------------------------------------------------------------------

/**
 * Actualiza la variable CSS '--fill' de un slider para colorear la zona
 * izquierda del track (la parte "completada" del rango).
 *
 * La técnica usa un linear-gradient en CSS cuyo punto de corte se controla
 * con la custom property --fill. Como CSS no puede leer el valor del input
 * directamente, JavaScript calcula el porcentaje y lo inyecta como propiedad
 * de estilo inline sobre el elemento.
 *
 *   pct = (valor − min) / (max − min) × 100
 *
 * Por ejemplo, sl-n con value=32, min=1, max=200 → pct ≈ 15.6 %
 *
 * @param {HTMLInputElement} input  El elemento range al que actualizar --fill
 */
function updateSliderFill(input) {
  const min = parseFloat(input.min) || 0;
  const max = parseFloat(input.max) || 100;
  const pct = ((parseFloat(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

/**
 * Obtiene un elemento del DOM por su id y lanza un error descriptivo si no existe.
 *
 * document.getElementById() devuelve null cuando el id no está en el HTML,
 * lo que provoca errores crípticos del tipo "Cannot read property 'value' of null"
 * lejos del punto de fallo real. Este wrapper adelanta el error al momento
 * de la inicialización con un mensaje que identifica exactamente qué falta.
 *
 * @param {string} id  Identificador del elemento
 * @returns {HTMLElement}
 * @throws {Error} Si el elemento no existe en el DOM
 */
function getEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[PhongJS] Elemento #${id} no encontrado en el DOM`);
  return el;
}

/**
 * Inicializa el módulo: construye el objeto DOM, suscribe listeners y
 * ejecuta el primer renderizado.
 *
 * Se invoca una sola vez al final del script (cargado con 'defer', por lo
 * que el DOM ya está completamente parseado en este punto).
 */
function init() {
  // ── Caché de referencias DOM ──────────────────────────────────────────
  // Todas las consultas al DOM ocurren aquí, una sola vez.
  // Después, el render loop accede a propiedades de este objeto (O(1))
  // en lugar de buscar en el árbol DOM en cada frame.
  DOM = {
    sliders: {
      ka:     getEl('sl-ka'),       // coeficiente ambiental
      kd:     getEl('sl-kd'),       // coeficiente difuso
      ke:     getEl('sl-ke'),       // coeficiente especular
      n:      getEl('sl-n'),        // exponente de brillo (shininess)
      langle: getEl('sl-langle'),   // ángulo de la luz en grados
    },
    values: {
      ka:     getEl('val-ka'),      // span que muestra el valor de ka
      kd:     getEl('val-kd'),
      ke:     getEl('val-ke'),
      n:      getEl('val-n'),
      langle: getEl('val-langle'),
    },
    formulaDisplay: getEl('formula-display'),  // div donde se muestra la fórmula activa
    canvasSphere:   getEl('sphere'),            // canvas de la esfera renderizada
    canvasPolar:    getEl('polar'),             // canvas del diagrama polar
    // Contextos 2D cacheados: getContext('2d') en cada frame sería una llamada
    // innecesaria a la API del navegador; el contexto no cambia entre frames.
    ctxSphere:      getEl('sphere').getContext('2d'),
    ctxPolar:       getEl('polar').getContext('2d'),
    // querySelectorAll devuelve una NodeList estática de los cuatro botones tab
    tabs:           document.querySelectorAll('.tab'),
  };

  // ── Reactividad al tema del sistema (dark / light mode) ───────────────
  // MediaQueryList.addEventListener('change', …) es la API moderna.
  // El listener solo actualiza isDark y fuerza un redibujado; no recrea el DOM.
  darkModeQuery.addEventListener('change', e => {
    isDark = e.matches;
    update();
  });

  // ── Navegación por teclado en tabs (patrón WAI-ARIA Tabs) ─────────────
  // WCAG 2.1 Éxito criterio 2.1.1: toda la funcionalidad debe ser operable
  // mediante teclado. El patrón ARIA Tabs especifica:
  //   - ArrowRight / ArrowLeft: mover el foco entre tabs
  //   - El tab que recibe foco se activa automáticamente (listener 'focus')
  // El operador módulo (%) implementa la navegación circular (del último
  // tab vuelve al primero y viceversa).
  DOM.tabs.forEach((btn, idx) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
    btn.addEventListener('keydown', e => {
      const len = DOM.tabs.length;
      if (e.key === 'ArrowRight') DOM.tabs[(idx + 1) % len].focus();
      if (e.key === 'ArrowLeft')  DOM.tabs[(idx - 1 + len) % len].focus();
    });
    btn.addEventListener('focus', () => setMode(btn.dataset.mode));
  });

  // ── Sliders de parámetros ─────────────────────────────────────────────
  // El evento 'input' se dispara en cada movimiento del slider (a diferencia
  // de 'change', que solo se dispara al soltar). Esto proporciona feedback
  // visual inmediato mientras el usuario arrastra.
  Object.values(DOM.sliders).forEach(input => {
    input.addEventListener('input', update);
    input.addEventListener('input', () => updateSliderFill(input));
    updateSliderFill(input); // aplicar relleno inicial según el valor por defecto del HTML
  });

  // Primer renderizado con los valores por defecto del HTML
  update();
}

// El script se carga con el atributo 'defer', lo que garantiza que se ejecuta
// después de que el navegador haya parseado completamente el HTML. Por eso es
// seguro llamar a init() aquí, en el scope del módulo, sin esperar a DOMContentLoaded.
init();

})(); // fin PhongDemo IIFE — cierra el scope privado, nada escapa a window
