/*
 * sprites.js — 도트 스프라이트 정의와 5x7 비트맵 폰트.
 * 한 글자 = 픽셀 하나. 색은 아래 키로 지정하고, 엔티티마다 팔레트를 갈아끼운다.
 *
 *   .  투명      o  외곽선        B  몸통       D  몸통(어두운)   L  몸통(밝은)
 *   w  흰색      e  눈동자        y  노랑       r  빨강           g  초록
 *   k  살구색    c  하늘          m  자주
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sprites = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 오른쪽을 보고 있는 기준. 왼쪽은 좌우 반전해서 쓴다.
  // 왼쪽에 등껍질(D/L), 오른쪽에 얼굴을 둬서 반전했을 때 방향이 드러나게 했다.
  var BUB = [
    '.....oooooo.....',
    '....oBBBBBBo....',
    '...oBBBBBBBBo...',
    '...oBwwoBwwoo...',
    '...oBweoBweBo...',
    '...oBwwoBwwBo...',
    '...oBBBBBBBBo...',
    '..oDBBBBBBBBo...',
    '.oDLLDBBBBBBBo..',
    'oDLLLDBwwwwwwBo.',
    'oDLLLDBwwwwwwwBo',
    'oDLLLDBwwwwwwwBo',
    '.oDLLDBwwwwwwBo.',
    '..oDDBBBBBBBBo..',
    '...oyyo..oyyo...',
    '...oooo..oooo...'
  ];

  // 젠짱 — 파란 몸에 노란 헬멧
  var ZEN = [
    '................',
    '.....oooooo.....',
    '...ooyyyyyyoo...',
    '..oyyyyyyyyyyo..',
    '.oyyyyyyyyyyyyo.',
    '.oooooooooooooo.',
    '..oBBBBBBBBBBo..',
    '.oBBwwoBBwwoBBo.',
    '.oBBweoBBweoBBo.',
    '.oBBwwoBBwwoBBo.',
    '.oBBBBBBBBBBBBo.',
    '..oBBBBBBBBBBo..',
    '...oBBBBBBBBo...',
    '....oBBBBBBo....',
    '...oyyo..oyyo...',
    '...oooo..oooo...'
  ];

  // 마이타 — 크림색 몸에 뾰족한 머리, 팔이 달렸다
  var MIGHTA = [
    '.......oo.......',
    '......oBBo......',
    '.....oBBBBo.....',
    '....oBBBBBBo....',
    '...oBBBBBBBBo...',
    '..oBwwoBBwwoBo..',
    '..oBweoBBweoBo..',
    '.ooBwwoBBwwoBoo.',
    'oDDoBBBBBBBBoDDo',
    'oDDoBBrrrrBBoDDo',
    'oDDoBBBBBBBBoDDo',
    '.ooBBBBBBBBBBoo.',
    '..oBBBBBBBBBBo..',
    '...oBBBBBBBBo...',
    '...oyyo..oyyo...',
    '...oooo..oooo...'
  ];

  // 몬스타 — 자주색 몸에 박쥐 날개
  var MONSTA = [
    '................',
    '..oo........oo..',
    '.oDDo.oooo.oDDo.',
    '.oDDDooBBoooDDo.',
    '.oDDDDoBBoDDDDo.',
    '..oDDDoBBoDDDo..',
    '...oDDoBBoDDo...',
    '....ooBBBBoo....',
    '...oBwwoBwwBo...',
    '...oBweoBweBo...',
    '...oBBBBBBBBo...',
    '..oBrrrrrrrrBo..',
    '..oBBBBBBBBBBo..',
    '...oBBBBBBBBo...',
    '....oyyyyyyo....',
    '....oooooooo....'
  ];

  // 과일 12x12
  var FRUITS = [
    [ // 체리
      '.....g......',
      '....gg......',
      '...gg.......',
      '..gg..gg....',
      '.orro.orro..',
      'orrrroorrrro',
      'orrrroorrrro',
      'orrrroorrrro',
      '.orro..orro.',
      '..oo....oo..',
      '............',
      '............'
    ],
    [ // 바나나
      '......oo....',
      '.....oyyo...',
      '....oyyyo...',
      '...oyyyyo...',
      '..oyyyyo....',
      '.oyyyyo.....',
      'oyyyyo......',
      'oyyyo.......',
      'oyyo........',
      '.oo.........',
      '............',
      '............'
    ],
    [ // 사과
      '.....g......',
      '....gg.g....',
      '...oo.gg....',
      '..orrroo....',
      '.orrrrrro...',
      'orrLrrrrro..',
      'orrLrrrrro..',
      'orrrrrrrro..',
      '.orrrrrro...',
      '..oorroo....',
      '............',
      '............'
    ],
    [ // 포도
      '.....g......',
      '....gg......',
      '..omomomo...',
      '.ommmmmmmo..',
      '.ommmmmmmo..',
      '..ommmmmo...',
      '..ommmmmo...',
      '...ommmo....',
      '....omo.....',
      '............',
      '............',
      '............'
    ],
    [ // 수박
      '...oooooo...',
      '..oggggggo..',
      '.oggrrrrggo.',
      'oggrrrrrrggo',
      'ogrrrerrrrgo',
      'ogrrrrrerrgo',
      'ogrrerrrrrgo',
      'oggrrrrrrggo',
      '.oggrrrrggo.',
      '..oggggggo..',
      '...oooooo...',
      '............'
    ],
    [ // 보석
      '..oooooooo..',
      '.occccccco..',
      'occwwcccccco',
      'occwccccccco',
      '.occcccccco.',
      '..occcccco..',
      '...occcco...',
      '....occo....',
      '.....oo.....',
      '............',
      '............',
      '............'
    ]
  ];

  // 5x7 비트맵 폰트
  var FONT = {
    '0': '01110/10001/10011/10101/11001/10001/01110',
    '1': '00100/01100/00100/00100/00100/00100/01110',
    '2': '01110/10001/00001/00010/00100/01000/11111',
    '3': '11111/00010/00100/00010/00001/10001/01110',
    '4': '00010/00110/01010/10010/11111/00010/00010',
    '5': '11111/10000/11110/00001/00001/10001/01110',
    '6': '00110/01000/10000/11110/10001/10001/01110',
    '7': '11111/00001/00010/00100/01000/01000/01000',
    '8': '01110/10001/10001/01110/10001/10001/01110',
    '9': '01110/10001/10001/01111/00001/00010/01100',
    'A': '01110/10001/10001/11111/10001/10001/10001',
    'B': '11110/10001/10001/11110/10001/10001/11110',
    'C': '01110/10001/10000/10000/10000/10001/01110',
    'D': '11100/10010/10001/10001/10001/10010/11100',
    'E': '11111/10000/10000/11110/10000/10000/11111',
    'F': '11111/10000/10000/11110/10000/10000/10000',
    'G': '01110/10001/10000/10111/10001/10001/01111',
    'H': '10001/10001/10001/11111/10001/10001/10001',
    'I': '01110/00100/00100/00100/00100/00100/01110',
    'J': '00111/00010/00010/00010/00010/10010/01100',
    'K': '10001/10010/10100/11000/10100/10010/10001',
    'L': '10000/10000/10000/10000/10000/10000/11111',
    'M': '10001/11011/10101/10101/10001/10001/10001',
    'N': '10001/11001/10101/10011/10001/10001/10001',
    'O': '01110/10001/10001/10001/10001/10001/01110',
    'P': '11110/10001/10001/11110/10000/10000/10000',
    'Q': '01110/10001/10001/10001/10101/10010/01101',
    'R': '11110/10001/10001/11110/10100/10010/10001',
    'S': '01111/10000/10000/01110/00001/00001/11110',
    'T': '11111/00100/00100/00100/00100/00100/00100',
    'U': '10001/10001/10001/10001/10001/10001/01110',
    'V': '10001/10001/10001/10001/10001/01010/00100',
    'W': '10001/10001/10001/10101/10101/11011/10001',
    'X': '10001/10001/01010/00100/01010/10001/10001',
    'Y': '10001/10001/01010/00100/00100/00100/00100',
    'Z': '11111/00001/00010/00100/01000/10000/11111',
    '-': '00000/00000/00000/11111/00000/00000/00000',
    '!': '00100/00100/00100/00100/00100/00000/00100',
    '.': '00000/00000/00000/00000/00000/01100/01100',
    ':': '00000/01100/01100/00000/01100/01100/00000',
    '?': '01110/10001/00001/00110/00100/00000/00100',
    ' ': '00000/00000/00000/00000/00000/00000/00000'
  };

  var OUTLINE = '#0d0a1a';

  // 엔티티별 색 팔레트
  function playerPalette(color, light, dark) {
    return { o: OUTLINE, B: color, L: light, D: dark, w: '#ffffff', e: '#161020', y: '#ffb02e' };
  }

  var ENEMY_PALETTES = {
    zen:    { o: OUTLINE, B: '#4f6bd8', D: '#2f3f8f', L: '#8fa4ff', w: '#ffffff', e: '#161020', y: '#ffd75f', r: '#ff5f7a' },
    mighta: { o: OUTLINE, B: '#f2e3c2', D: '#b39a6a', L: '#fff7e0', w: '#ffffff', e: '#161020', y: '#ff9a3c', r: '#ff5f7a' },
    monsta: { o: OUTLINE, B: '#b34fd8', D: '#6d2a8f', L: '#e0a0ff', w: '#ffffff', e: '#161020', y: '#ffd75f', r: '#ff9de0' }
  };

  var ANGRY_PALETTE = { o: OUTLINE, B: '#ff4f6b', D: '#a01f3f', L: '#ff9db0', w: '#ffffff', e: '#161020', y: '#ffd75f', r: '#ffd75f' };

  var FRUIT_PALETTE = {
    o: OUTLINE, r: '#ff4f6b', g: '#5fe07a', y: '#ffd75f', m: '#c86bff',
    c: '#7fe8ff', w: '#ffffff', e: '#161020', L: '#ffb9c4', B: '#ff4f6b', D: '#a01f3f'
  };

  var ENEMY_SPRITES = [ZEN, MIGHTA, MONSTA];
  var ENEMY_KEYS = ['zen', 'mighta', 'monsta'];

  return {
    BUB: BUB, ZEN: ZEN, MIGHTA: MIGHTA, MONSTA: MONSTA,
    ENEMY_SPRITES: ENEMY_SPRITES, ENEMY_KEYS: ENEMY_KEYS,
    ENEMY_PALETTES: ENEMY_PALETTES, ANGRY_PALETTE: ANGRY_PALETTE,
    FRUITS: FRUITS, FRUIT_PALETTE: FRUIT_PALETTE,
    playerPalette: playerPalette,
    FONT: FONT, OUTLINE: OUTLINE
  };
});
