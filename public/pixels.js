// Pixel art. Every icon and portrait is drawn on a 10 by 10 grid and rendered as crisp SVG rectangles.

const SVG = 'http://www.w3.org/2000/svg';

const ICONS = {
  crown: ['..........', '#...##...#', '##..##..##', '###.##.###', '##########', '##########', '##########', '..........', '##########', '..........'],
  board: ['..######..', '..#....#..', '..#.##.#..', '..#....#..', '..#.##.#..', '..#....#..', '..#.##.#..', '..#....#..', '..#.##.#..', '.########.'],
  archive: ['..........', '##########', '#........#', '##########', '.#......#.', '.#.####.#.', '.#......#.', '.#......#.', '.########.', '..........'],
  plus: ['..........', '....##....', '....##....', '....##....', '.########.', '.########.', '....##....', '....##....', '....##....', '..........'],
  play: ['..........', '..##......', '..####....', '..######..', '..########', '..########', '..######..', '..####....', '..##......', '..........'],
  pause: ['..........', '..##..##..', '..##..##..', '..##..##..', '..##..##..', '..##..##..', '..##..##..', '..##..##..', '..##..##..', '..........'],
  sliders: ['..........', '......##..', '######..##', '......##..', '..........', '..##......', '##..######', '..##......', '..........', '..........'],
  check: ['..........', '..........', '........##', '.......##.', '#.....##..', '##...##...', '.##.##....', '..###.....', '...#......', '..........'],
  x: ['..........', '##......##', '.##....##.', '..##..##..', '...####...', '...####...', '..##..##..', '.##....##.', '##......##', '..........'],
  back: ['..........', '...#......', '..##......', '.########.', '..##.....#', '...#.....#', '.........#', '....#####.', '..........', '..........'],
  handover: ['....##....', '....##....', '....##....', '.#..##..#.', '..#.##.#..', '...####...', '#...##...#', '#........#', '##########', '..........'],
  trash: ['...####...', '##########', '..........', '.########.', '.#.#..#.#.', '.#.#..#.#.', '.#.#..#.#.', '.#.#..#.#.', '.########.', '..........'],
  alert: ['....##....', '...####...', '...#..#...', '..##..##..', '..##..##..', '.###..###.', '.########.', '####..####', '##########', '..........'],
  chat: ['..........', '.########.', '#........#', '#.######.#', '#........#', '#.####...#', '#........#', '.###.####.', '..##......', '..#.......'],
  megaphone: ['..........', '.......##.', '.....####.', '.########.', '#########.', '#########.', '.########.', '..##.####.', '..##...##.', '..........'],
  search: ['..####....', '.#....#...', '#......#..', '#......#..', '#......#..', '.#....#...', '..####.#..', '.......##.', '........##', '.........#'],
  chevron: ['..........', '...##.....', '....##....', '.....##...', '......##..', '......##..', '.....##...', '....##....', '...##.....', '..........'],
  grid: ['..........', '.###..###.', '.###..###.', '.###..###.', '..........', '..........', '.###..###.', '.###..###.', '.###..###.', '..........'],
  clock: ['..######..', '.#......#.', '#...#....#', '#...#....#', '#...#....#', '#...###..#', '#........#', '#........#', '.#......#.', '..######..'],
  box: ['..........', '##########', '#...##...#', '#...##...#', '##########', '#........#', '#........#', '#........#', '##########', '..........'],
  bolt: ['.....###..', '....###...', '...###....', '..######..', '..######..', '....###...', '...###....', '..###.....', '..##......', '..#.......'],
  gauge: ['..........', '..######..', '.#......#.', '#......#.#', '#.....#..#', '#....#...#', '#...##...#', '#........#', '..........', '..........'],
  idea: ['..######..', '.#......#.', '#........#', '#........#', '#........#', '.#......#.', '..#....#..', '..######..', '...####...', '...####...'],
  terminal: ['..........', '##########', '#........#', '#.#......#', '#..#.....#', '#.#......#', '#....###.#', '#........#', '##########', '..........'],
};

// Portrait templates. h hair, s skin, e eye, m mouth, c shirt, w white, t tie, g gold, k suit.
const FACES = {
  short: ['..........', '..hhhhhh..', '.hhhhhhhh.', '.hssssssh.', '.ssessess.', '.ssssssss.', '.sssmmsss.', '..ssssss..', '.cccccccc.', 'cccccccccc'],
  long: ['..hhhhhh..', '.hhhhhhhh.', 'hhhhhhhhhh', 'hhsssssshh', 'hhsesseshh', 'hhsssssshh', 'hhssmmsshh', 'h.ssssss.h', '.cccccccc.', 'cccccccccc'],
  cap: ['..........', '..cccccc..', '.cccccccc.', 'cccccccccc', '.ssessess.', '.ssssssss.', '.sssmmsss.', '..ssssss..', '.cccccccc.', 'cccccccccc'],
  glasses: ['..........', '..hhhhhh..', '.hhhhhhhh.', '.hssssssh.', '.wewsswew.', '.ssssssss.', '.sssmmsss.', '..ssssss..', '.cccccccc.', 'cccccccccc'],
  pm: ['..........', '..hhhhhh..', '.hhhhhhhh.', '.hssssssh.', '.wewsswew.', '.ssssssss.', '.sssmmsss.', '..ssssss..', '.cccwtwcc.', 'ccccwtwccc'],
  designer: ['..bbbbbb..', '.bbbbbbbbb', '.hbbbbbbh.', '.hssssssh.', '.ssessess.', '.ssssssss.', '.sssmmsss.', '..ssssss..', '.kkkkkkkk.', 'kkkkkkkkkk'],
  ceo: ['.g..gg..g.', '.gggggggg.', '.gggggggg.', '.hssssssh.', '.ssessess.', '.ssssssss.', '.sssmmsss.', '..ssssss..', '.kkkwtwkk.', 'kkkkwtwkkk'],
};
const SKIN = ['#f1c7a1', '#dba779', '#b07a4f', '#7a5236', '#f5d9bd'];
const HAIR = ['#2a2019', '#5b3b20', '#a85a1c', '#d2ac58', '#8b8b86', '#b33a2e'];
const SHIRT = ['#2f66c9', '#1f8f62', '#d07a26', '#7d55b5', '#bd403a', '#2a8496'];
const FIXED = { b: '#bd403a', e: '#1b1a17', m: '#8c3f36', w: '#f4f2ec', t: '#bd403a', g: '#e2b33c', k: '#26252b' };

/** One path of merged horizontal runs for every cell that matches `cell`. */
function runs(rows, cell) {
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== cell) continue;
      let end = x;
      while (row[end + 1] === cell) end++;
      d += `M${x} ${y}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  });
  return d;
}

function svg(className) {
  const el = document.createElementNS(SVG, 'svg');
  el.setAttribute('class', className);
  el.setAttribute('viewBox', '0 0 10 10');
  el.setAttribute('shape-rendering', 'crispEdges');
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function path(d, fill) {
  const el = document.createElementNS(SVG, 'path');
  el.setAttribute('d', d);
  if (fill) el.setAttribute('fill', fill);
  return el;
}

const iconPaths = new Map();
export function iconPath(name) {
  if (!iconPaths.has(name)) iconPaths.set(name, runs(ICONS[name] ?? ICONS.alert, '#'));
  return iconPaths.get(name);
}

export function icon(name) {
  const el = svg('icon');
  el.append(path(iconPath(name)));
  return el;
}

function hash(text) {
  let n = 2166136261;
  for (const ch of String(text)) n = Math.imul(n ^ ch.codePointAt(0), 16777619);
  return n >>> 0;
}

/** A face for an agent. Developers get a look derived from their name, so Ada always looks like Ada. */
export function portrait(role, name = '') {
  const n = hash(name || role);
  let rows;
  let colors;
  if (role === 'ceo') {
    rows = FACES.ceo;
    colors = { h: HAIR[1], s: SKIN[0] };
  } else if (role === 'designer') {
    rows = FACES.designer;
    colors = { h: HAIR[2], s: SKIN[4] };
  } else if (role === 'pm') {
    rows = FACES.pm;
    colors = { h: HAIR[0], s: SKIN[1], c: '#3d4a5c' };
  } else {
    rows = [FACES.short, FACES.long, FACES.cap, FACES.glasses][n % 4];
    colors = { h: HAIR[(n >>> 3) % HAIR.length], s: SKIN[(n >>> 7) % SKIN.length], c: SHIRT[(n >>> 11) % SHIRT.length] };
  }
  const el = svg('portrait');
  for (const cell of new Set(rows.join('').replace(/\./g, ''))) el.append(path(runs(rows, cell), colors[cell] ?? FIXED[cell]));
  return el;
}
