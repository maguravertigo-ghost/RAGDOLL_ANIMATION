'use strict';

// ============================================================
//  char3d-editor.js — Интерактивная 3D-студия персонажей (v0.7.0)
//  - 4-проекционный вьюпорт (Quad: Спереди XY / Сбоку ZY / Сверху XZ / 3D Орбита)
//  - Метрическая сетка и ростомер (0.00..2.20 м) + калибровка женского и мужского .glb
//  - Подгонка шарнирного скелета в 3 проекциях с симметрией L ↔ R
//  - Встроенный редактор частей тела, одежды и пропсов (Кольца Loft + Вершины меша!)
//  - Живой двухкостный 3D IK рук и ног + фиксация стоп на полу (Pin Feet IK)
//  - Редактор Позы и 3D-Таймлайн анимаций с кривыми разгона/возврата/перехлёста
//  - Сохранение в серверную папку char3d/, экспорт/импорт .char3d.json и бинарного .glb
// ============================================================

const Char3DEditor = (() => {
  const C = Char3DCore;

  const state = {
    initialized: false,
    subMode: 'mesh',            // 'rig' | 'mesh' | 'pose' | 'anim'
    viewLayout: 'quad',         // 'quad' | 'persp' | 'front' | 'side' | 'top'
    activePane: 'persp',
    dirty: false,

    // Камеры для 3D-орбиты и 3 ортогональных проекций
    perspCam: { yaw: 0.48, pitch: 0.22, dist: 3.15, target: { x: 0, y: 0.94, z: 0 } },
    orthoCam: {
      front: { cx: 0, cy: 0.95, scale: 185 }, // px на 1 метр
      side:  { cx: 0, cy: 0.95, scale: 185 },
      top:   { cx: 0, cz: 0.00, scale: 185 }
    },

    showMetricGrid: true,
    showHeightRuler: true,
    showSkeletonOverlay: true,
    showWireframe: false,
    editMeshMode: 'rings',      // 'rings' | 'verts'
    selectedRingIdx: 0,
    selectedVertexIdx: -1,

    // Эталонные .glb меши (Женский и Мужской слоты для выравнивания по росту и подгонки скелета)
    refSlots: {
      female: null,
      male: null
    },
    refSideBySide: true,
    refOpacity: 0.34,
    refWireframe: true,
    pendingGlbGender: 'female',

    // Текущий персонаж и выделение
    currentName: 'king_cape',
    charData: null,
    selectedBoneId: 'chest',
    selectedPartId: 'part_chest',

    // Состояние живого IK
    ikEnabled: true,
    pinFeetToGround: false,
    ikTargets: {},              // { arm_L: v3, arm_R: v3, leg_L: v3, leg_R: v3 }
    ikPoles: {},

    // Состояние 3D-анимации и таймлайна
    animClipIdx: 0,
    playing: false,
    animTime: 0,
    animSpeed: 1.0,
    selectedKeyIdx: 1,
    rafId: null,
    lastRafTs: 0,

    // Взаимодействие мышью на 3D-холсте
    drag: null,
    lastHitHandles: [],
    paneRects: []
  };

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    // Создаём эталонные слоты Женской и Мужской базы (до загрузки внешних .glb работают встроенные манекены)
    state.refSlots.female = C.createBuiltinReferenceGlbSlot('female');
    state.refSlots.male   = C.createBuiltinReferenceGlbSlot('male');
    syncRefOffsets();

    // По умолчанию открываем «Короля в плаще» (из запроса про Tower Defense!)
    loadArchetype('king_cape', false);

    bindDomEvents();
  }

  function syncRefOffsets() {
    if (!state.refSlots.female || !state.refSlots.male) return;
    if (state.refSideBySide && state.refSlots.female.visible && state.refSlots.male.visible) {
      state.refSlots.female.offsetX = -0.52;
      state.refSlots.male.offsetX   =  0.52;
    } else {
      state.refSlots.female.offsetX = 0;
      state.refSlots.male.offsetX   = 0;
    }
  }

  function markChar3DDirty() {
    if (!state.dirty) {
      state.dirty = true;
      if (typeof updateSaveButtonUI === 'function') updateSaveButtonUI();
    }
  }

  function clearChar3DDirty() {
    state.dirty = false;
    if (typeof updateSaveButtonUI === 'function') updateSaveButtonUI();
  }

  function loadArchetype(archetypeId, markAsDirty = false) {
    stopAnimPlayback();
    const ch = C.createArchetypeCharacter(archetypeId);
    applyLoadedCharacterData(ch, markAsDirty);
  }

  function applyLoadedCharacterData(ch, markAsDirty = false) {
    state.charData = ch;
    state.currentName = ch.name || 'char_3d';
    if (!state.charData.activePose) {
      state.charData.activePose = (ch.poses && ch.poses[0]) ? C.clonePose(ch.poses[0].pose) : { rootOffset: C.v3(), bones: {} };
    }
    state.selectedPartId = (ch.parts && ch.parts[0]) ? ch.parts[0].id : null;
    state.selectedBoneId = 'chest';
    state.selectedRingIdx = 0;
    state.selectedVertexIdx = -1;
    state.animClipIdx = 0;
    state.animTime = 0;
    state.selectedKeyIdx = 1;

    syncIkTargetsFromCurrentPose();
    if (markAsDirty) markChar3DDirty();
    else clearChar3DDirty();

    const nameInp = document.getElementById('char3d-name');
    if (nameInp) nameInp.value = state.currentName;

    if (App.editorMode === 'char3d') {
      renderAllUI();
    }
  }

  function syncIkTargetsFromCurrentPose() {
    if (!state.charData) return;
    const fk = C.evaluateSkeletonFK(state.charData.jointsRest, state.charData.activePose);
    for (const key of Object.keys(C.IK_CHAINS)) {
      const ch = C.IK_CHAINS[key];
      if (fk[ch.end]) state.ikTargets[key] = C.v3Clone(fk[ch.end].worldPos);
      if (fk[ch.upper]) state.ikPoles[key] = C.v3Add(fk[ch.upper].worldPos, ch.defaultPole);
    }
  }

  // -------------------- Серверный и файловый обмен (char3d/ + .char3d.json + .glb) --------------------
  async function fetchChar3DList() {
    try {
      const r = await fetch('api/chars3d');
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.characters)) return j.characters;
      }
    } catch (_) {}
    try {
      const r2 = await fetch('char3d/index.json');
      if (r2.ok) {
        const j2 = await r2.json();
        if (Array.isArray(j2.characters)) return j2.characters;
      }
    } catch (_) {}
    return ['king_cape', 'mage_staff', 'zombie_suit', 'base_human'];
  }

  async function openChar3DByName(name) {
    stopAnimPlayback();
    // Пробуем загрузить с сервера / статики
    try {
      const r = await fetch('api/char3d/' + encodeURIComponent(name));
      if (r.ok) {
        const j = await r.json();
        if (j && j.character) {
          applyLoadedCharacterData(j.character, false);
          setHint('Открыт 3D-персонаж «' + name + '»', 2000);
          return;
        }
      }
    } catch (_) {}
    try {
      const r2 = await fetch('char3d/' + encodeURIComponent(name) + '/character.json');
      if (r2.ok) {
        const ch = await r2.json();
        applyLoadedCharacterData(ch, false);
        setHint('Открыт 3D-персонаж «' + name + '»', 2000);
        return;
      }
    } catch (_) {}

    // Иначе встроенный архетип
    loadArchetype(name, false);
    setHint('Загружен архетип «' + name + '»', 2000);
  }

  async function saveCurrentChar3D() {
    if (!state.charData) return false;
    const safe = String(state.currentName || state.charData.name || 'character_3d')
      .trim().replace(/[^a-zA-Z0-9_-]+/g, '_') || 'character_3d';
    state.currentName = safe;
    state.charData.name = safe;

    const payload = JSON.stringify(state.charData, null, 2);
    try {
      const r = await fetch('api/char3d/' + encodeURIComponent(safe) + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (r.ok) {
        clearChar3DDirty();
        setHint('Сохранено: char3d/' + safe + '/character.json', 2200);
        return true;
      }
    } catch (_) {}

    // Fallback для GitHub Pages (скачивание игрового JSON)
    downloadBlob(new Blob([payload], { type: 'application/json' }), safe + '.char3d.json');
    clearChar3DDirty();
    setHint('Скачан игровой файл ' + safe + '.char3d.json', 2400);
    return true;
  }

  function exportCurrentCharGlb() {
    if (!state.charData) return;
    const buf = C.exportCharacterToGlbArrayBuffer(state.charData, getDisplayedPose());
    const safe = (state.currentName || 'character') + '.glb';
    downloadBlob(new Blob([buf], { type: 'model/gltf-binary' }), safe);
    setHint('Экспортирован бинарный 3D-файл ' + safe + ' (glTF 2.0)', 2600);
  }

  function exportCurrentCharJson() {
    if (!state.charData) return;
    const safe = (state.currentName || 'character') + '.char3d.json';
    const payload = JSON.stringify(state.charData, null, 2);
    downloadBlob(new Blob([payload], { type: 'application/json' }), safe);
    setHint('Экспортирован игровой риг + анимации: ' + safe, 2600);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -------------------- Поза на экране (Поза редактора vs Поза кадра анимации) --------------------
  function getActiveClip() {
    if (!state.charData || !Array.isArray(state.charData.animations)) return null;
    return state.charData.animations[state.animClipIdx] || state.charData.animations[0] || null;
  }

  function getDisplayedPose() {
    if (!state.charData) return { rootOffset: C.v3(), bones: {} };
    if (state.subMode === 'rig') {
      // В режиме подгонки скелета и калибровки показываем чистую позу покоя (T-Pose), чтобы суставы совпадали с .glb!
      return { rootOffset: C.v3(), bones: {} };
    }
    if (state.subMode === 'anim') {
      const clip = getActiveClip();
      if (clip) return C.sampleAnimationPose(clip, state.animTime);
    }
    return state.charData.activePose || { rootOffset: C.v3(), bones: {} };
  }

  // -------------------- Проекция 3D -> 2D для каждой панели вьюпорта --------------------
  function computePaneRects(W, H) {
    if (state.viewLayout === 'quad') {
      const hw = Math.floor(W / 2);
      const hh = Math.floor(H / 2);
      return [
        { id: 'front', title: 'СПЕРЕДИ (XY · Рост)', x: 0,  y: 0,  w: hw,     h: hh },
        { id: 'side',  title: 'СБОКУ (ZY · Профиль)', x: hw, y: 0,  w: W - hw, h: hh },
        { id: 'top',   title: 'СВЕРХУ (XZ · План)',   x: 0,  y: hh, w: hw,     h: H - hh },
        { id: 'persp', title: '3D ОРБИТА (ЛКМ вращ · Колесо зум)', x: hw, y: hh, w: W - hw, h: H - hh }
      ];
    }
    const titles = {
      persp: '3D ОРБИТА (ЛКМ по фону — вращение · Shift+ЛКМ — панорама · Колесо — зум)',
      front: 'ПРОЕКЦИЯ СПЕРЕДИ (XY · Выравнивание роста и симметрии L ↔ R)',
      side:  'ПРОЕКЦИЯ СБОКУ (ZY · Подгонка позвоночника, колена, локтя и плаща)',
      top:   'ПРОЕКЦИЯ СВЕРХУ (XZ · Плечи, разворот и сокеты)'
    };
    return [{ id: state.viewLayout, title: titles[state.viewLayout] || '3D', x: 0, y: 0, w: W, h: H }];
  }

  function makeProjector(pane) {
    const cxScr = pane.x + pane.w * 0.5;
    const cyScr = pane.y + pane.h * 0.5;
    const zoomFit = state.viewLayout === 'quad' ? 0.72 : 1.18;

    if (pane.id === 'front') {
      const cam = state.orthoCam.front;
      const sc = cam.scale * zoomFit;
      return {
        pane,
        isOrtho: true,
        scale: sc,
        project(p) {
          return {
            x: cxScr + (p.x - cam.cx) * sc,
            y: cyScr - (p.y - cam.cy) * sc,
            depth: -p.z,
            visible: true
          };
        },
        unprojectDelta(dxPx, dyPx, origWorld) {
          return { x: origWorld.x + dxPx / sc, y: origWorld.y - dyPx / sc, z: origWorld.z };
        }
      };
    }

    if (pane.id === 'side') {
      const cam = state.orthoCam.side;
      const sc = cam.scale * zoomFit;
      return {
        pane,
        isOrtho: true,
        scale: sc,
        project(p) {
          return {
            x: cxScr + (p.z - cam.cx) * sc,
            y: cyScr - (p.y - cam.cy) * sc,
            depth: -p.x,
            visible: true
          };
        },
        unprojectDelta(dxPx, dyPx, origWorld) {
          return { x: origWorld.x, y: origWorld.y - dyPx / sc, z: origWorld.z + dxPx / sc };
        }
      };
    }

    if (pane.id === 'top') {
      const cam = state.orthoCam.top;
      const sc = cam.scale * zoomFit;
      return {
        pane,
        isOrtho: true,
        scale: sc,
        project(p) {
          return {
            x: cxScr + (p.x - cam.cx) * sc,
            y: cyScr + (p.z - cam.cz) * sc,
            depth: -p.y,
            visible: true
          };
        },
        unprojectDelta(dxPx, dyPx, origWorld) {
          return { x: origWorld.x + dxPx / sc, y: origWorld.y, z: origWorld.z + dyPx / sc };
        }
      };
    }

    // 3D Перспектива (Орбитальная камера)
    const pc = state.perspCam;
    const cy = Math.cos(pc.yaw), sy = Math.sin(pc.yaw);
    const cp = Math.cos(pc.pitch), sp = Math.sin(pc.pitch);
    const forward = { x: -sy * cp, y: -sp, z: -cy * cp };
    const eye = {
      x: pc.target.x - forward.x * pc.dist,
      y: pc.target.y - forward.y * pc.dist,
      z: pc.target.z - forward.z * pc.dist
    };
    const right = C.v3Norm(C.v3Cross(forward, { x: 0, y: 1, z: 0 }));
    const up = C.v3Norm(C.v3Cross(right, forward));
    const focal = Math.min(pane.w, pane.h) * 0.98;

    return {
      pane,
      isOrtho: false,
      right,
      up,
      forward,
      project(p) {
        const rel = C.v3Sub(p, eye);
        const vz = C.v3Dot(rel, forward);
        if (vz < 0.08) return { x: cxScr, y: cyScr, depth: 9999, visible: false };
        const vx = C.v3Dot(rel, right);
        const vy = C.v3Dot(rel, up);
        return {
          x: cxScr + (vx / vz) * focal,
          y: cyScr - (vy / vz) * focal,
          depth: vz,
          visible: true
        };
      },
      unprojectDelta(dxPx, dyPx, origWorld) {
        const rel = C.v3Sub(origWorld, eye);
        const vz = Math.max(0.2, C.v3Dot(rel, forward));
        const worldPerPx = vz / focal;
        return {
          x: origWorld.x + right.x * dxPx * worldPerPx - up.x * dyPx * worldPerPx,
          y: origWorld.y + right.y * dxPx * worldPerPx - up.y * dyPx * worldPerPx,
          z: origWorld.z + right.z * dxPx * worldPerPx - up.z * dyPx * worldPerPx
        };
      }
    };
  }

  // -------------------- Отрисовка 3D-сцены и оверлеев --------------------
  function renderViewport() {
    const canvas = document.getElementById('char3d-canvas');
    if (!canvas || App.editorMode !== 'char3d' || !state.charData) return;

    const vp = els.viewport;
    const cssW = Math.max(320, vp.clientWidth || 960);
    const cssH = Math.max(240, vp.clientHeight || 560);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);

    // Фон 3D-студии
    ctx.fillStyle = '#121620';
    ctx.fillRect(0, 0, cssW, cssH);

    const panes = computePaneRects(cssW, cssH);
    state.paneRects = panes;
    state.lastHitHandles = [];

    const pose = getDisplayedPose();
    const fk = C.evaluateSkeletonFK(state.charData.jointsRest, pose);

    // Предварительно собираем мировую геометрию всех видимых частей персонажа
    const worldPartMeshes = [];
    for (const part of (state.charData.parts || [])) {
      if (part.visible === false) continue;
      const bInfo = fk[part.bone];
      if (!bInfo) continue;
      const localGeom = C.buildPartLocalGeometry(part, bInfo);
      const wVerts = localGeom.verts.map(lv => C.v3Add(bInfo.worldPos, C.qRotateVec(bInfo.worldQ, lv)));
      worldPartMeshes.push({ part, bInfo, localGeom, wVerts });
    }

    // Эталонные .glb меши (если включены)
    const activeRefMeshes = [];
    for (const key of ['female', 'male']) {
      const slot = state.refSlots[key];
      if (slot && slot.visible) {
        activeRefMeshes.push({
          slot,
          color: key === 'female' ? '#ff8787' : '#4dabf7',
          verts: C.getCalibratedRefVertices(slot)
        });
      }
    }

    for (const pane of panes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(pane.x, pane.y, pane.w, pane.h);
      ctx.clip();

      const grad = ctx.createLinearGradient(0, pane.y, 0, pane.y + pane.h);
      grad.addColorStop(0, '#181e2c');
      grad.addColorStop(1, '#10141d');
      ctx.fillStyle = grad;
      ctx.fillRect(pane.x, pane.y, pane.w, pane.h);

      const proj = makeProjector(pane);

      if (state.showMetricGrid) drawMetricGridInPane(ctx, proj);
      if (state.showHeightRuler && pane.id !== 'top') drawHeightStadiometer(ctx, proj);

      // 1) Полупрозрачные эталонные .glb модели (Ghost / Wireframe)
      for (const rm of activeRefMeshes) {
        drawReferenceGlbMesh(ctx, proj, rm);
      }

      // 2) Затенённые 3D-меши модульных частей персонажа (Z-sort художником + направленный свет)
      drawCharacterShadedMeshes(ctx, proj, worldPartMeshes);

      // 3) Оверлей шарнирного скелета, IK-ручек или колец/вершин выбранного меша
      if (state.showSkeletonOverlay || state.subMode === 'rig' || state.subMode === 'pose' || state.subMode === 'anim') {
        drawSkeletonAndHandles(ctx, proj, fk);
      }
      if (state.subMode === 'mesh') {
        drawMeshEditHandles(ctx, proj, worldPartMeshes);
      }

      // Заголовок проекции и рамка квадранта
      ctx.fillStyle = 'rgba(13, 17, 25, 0.78)';
      ctx.fillRect(pane.x + 8, pane.y + 8, Math.min(pane.w - 16, pane.title.length * 6.8 + 18), 22);
      ctx.fillStyle = state.activePane === pane.id ? '#b197fc' : '#9fb0c8';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText(pane.title, pane.x + 15, pane.y + 23);

      ctx.strokeStyle = state.activePane === pane.id ? 'rgba(151, 117, 250, 0.7)' : 'rgba(255,255,255,0.09)';
      ctx.lineWidth = state.activePane === pane.id && state.viewLayout === 'quad' ? 1.8 : 1;
      ctx.strokeRect(pane.x + 0.5, pane.y + 0.5, pane.w - 1, pane.h - 1);

      ctx.restore();
    }

    ctx.restore();
    updateChar3DReadout();
  }

  function drawMetricGridInPane(ctx, proj) {
    const pane = proj.pane;
    ctx.lineWidth = 1;

    if (pane.id === 'persp' || pane.id === 'top') {
      // Напольная сетка на уровне стоп Y = 0 (-1.5 м .. +1.5 м с шагом 0.25 м)
      for (let i = -6; i <= 6; i++) {
        const v = i * 0.25;
        const isAxis = i === 0;
        const isMeter = (i % 4 === 0);
        const a1 = proj.project({ x: v, y: 0, z: -1.5 });
        const a2 = proj.project({ x: v, y: 0, z:  1.5 });
        if (a1.visible && a2.visible) {
          ctx.strokeStyle = isAxis ? 'rgba(77, 171, 247, 0.55)' : (isMeter ? 'rgba(173,181,189,0.24)' : 'rgba(173,181,189,0.10)');
          ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.stroke();
        }
        const b1 = proj.project({ x: -1.5, y: 0, z: v });
        const b2 = proj.project({ x:  1.5, y: 0, z: v });
        if (b1.visible && b2.visible) {
          ctx.strokeStyle = isAxis ? 'rgba(255, 107, 107, 0.55)' : (isMeter ? 'rgba(173,181,189,0.24)' : 'rgba(173,181,189,0.10)');
          ctx.beginPath(); ctx.moveTo(b1.x, b1.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
        }
      }
    } else {
      // Ортогональная метрическая сетка Спереди (XY) и Сбоку (ZY): деления каждые 0.10 м, крупные 0.50 м
      for (let ix = -12; ix <= 12; ix++) {
        const u = ix * 0.10;
        const p1 = pane.id === 'front' ? proj.project({ x: u, y: -0.2, z: 0 }) : proj.project({ x: 0, y: -0.2, z: u });
        const p2 = pane.id === 'front' ? proj.project({ x: u, y:  2.3, z: 0 }) : proj.project({ x: 0, y:  2.3, z: u });
        ctx.strokeStyle = ix === 0
          ? 'rgba(151, 117, 250, 0.50)'
          : (ix % 5 === 0 ? 'rgba(173,181,189,0.20)' : 'rgba(173,181,189,0.07)');
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }
      for (let iy = -2; iy <= 23; iy++) {
        const y = iy * 0.10;
        const p1 = pane.id === 'front' ? proj.project({ x: -1.3, y, z: 0 }) : proj.project({ x: 0, y, z: -1.3 });
        const p2 = pane.id === 'front' ? proj.project({ x:  1.3, y, z: 0 }) : proj.project({ x: 0, y, z:  1.3 });
        ctx.strokeStyle = iy === 0
          ? 'rgba(56, 217, 169, 0.72)' // Уровень пола Y = 0!
          : (iy % 5 === 0 ? 'rgba(173,181,189,0.22)' : 'rgba(173,181,189,0.07)');
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }
    }
  }

  function drawHeightStadiometer(ctx, proj) {
    // Вертикальная линейка роста (0.00 м .. 2.00 м) сбоку от персонажа
    const rulerX = -0.82;
    const pBot = proj.project({ x: rulerX, y: 0, z: 0 });
    const pTop = proj.project({ x: rulerX, y: 2.0, z: 0 });
    if (!pBot.visible || !pTop.visible) return;

    ctx.strokeStyle = 'rgba(255, 212, 59, 0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(pBot.x, pBot.y);
    ctx.lineTo(pTop.x, pTop.y);
    ctx.stroke();

    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255, 212, 59, 0.88)';
    const marks = [0, 0.5, 1.0, 1.5, 1.68, 1.80, 2.0];
    for (const m of marks) {
      const pm = proj.project({ x: rulerX, y: m, z: 0 });
      const pmTick = proj.project({ x: rulerX + 0.06, y: m, z: 0 });
      if (!pm.visible) continue;
      const isHumanRef = (m === 1.68 || m === 1.80);
      ctx.strokeStyle = isHumanRef ? 'rgba(56, 217, 169, 0.85)' : 'rgba(255, 212, 59, 0.55)';
      ctx.beginPath();
      ctx.moveTo(pm.x - 4, pm.y);
      ctx.lineTo(pmTick.x, pmTick.y);
      ctx.stroke();
      ctx.fillStyle = isHumanRef ? '#63e6be' : 'rgba(255, 212, 59, 0.82)';
      ctx.fillText(m.toFixed(2) + 'м', pm.x - 42, pm.y + 3);
    }
  }

  function drawReferenceGlbMesh(ctx, proj, rm) {
    const verts = rm.verts;
    const faces = rm.slot.faces || [];
    if (!verts.length || !faces.length) return;

    const projVerts = verts.map(v => proj.project(v));
    const maxDraw = Math.min(faces.length, 4500);
    const step = Math.max(1, Math.floor(faces.length / maxDraw));

    ctx.save();
    ctx.globalAlpha = state.refOpacity;
    ctx.strokeStyle = rm.color;
    ctx.fillStyle = rm.color;
    ctx.lineWidth = 0.75;

    for (let i = 0; i < faces.length; i += step) {
      const f = faces[i];
      const pa = projVerts[f.a], pb = projVerts[f.b], pc = projVerts[f.c];
      if (!pa || !pb || !pc || !pa.visible || !pb.visible || !pc.visible) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.lineTo(pc.x, pc.y);
      ctx.closePath();
      if (state.refWireframe) ctx.stroke();
      else ctx.fill();
    }

    // Метка роста эталонного меша над макушкой
    const curH = rm.slot.calibrated ? rm.slot.targetHeight : rm.slot.rawHeight;
    const topPt = proj.project({ x: rm.slot.offsetX || 0, y: curH + 0.05, z: 0 });
    if (topPt.visible) {
      ctx.globalAlpha = 0.95;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillStyle = rm.color;
      ctx.fillText(rm.slot.name + ' · ' + curH.toFixed(2) + 'м', topPt.x - 48, topPt.y);
    }
    ctx.restore();
  }

  function shadeHexColor(hex, factor) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    const n = m ? parseInt(m[1], 16) : 0xadb5bd;
    const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * factor)));
    const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * factor)));
    const b = Math.min(255, Math.max(0, Math.round((n & 255) * factor)));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function drawCharacterShadedMeshes(ctx, proj, worldPartMeshes) {
    const lightDir = C.v3Norm({ x: 0.42, y: 0.72, z: 0.55 });
    const drawTris = [];

    for (const pm of worldPartMeshes) {
      const pVerts = pm.wVerts.map(v => proj.project(v));
      const isSelPart = (state.subMode === 'mesh' && pm.part.id === state.selectedPartId);
      for (const f of pm.localGeom.faces) {
        const pa = pVerts[f.a], pb = pVerts[f.b], pc = pVerts[f.c];
        if (!pa.visible || !pb.visible || !pc.visible) continue;

        const wa = pm.wVerts[f.a], wb = pm.wVerts[f.b], wc = pm.wVerts[f.c];
        const n = C.v3Norm(C.v3Cross(C.v3Sub(wb, wa), C.v3Sub(wc, wa)));
        const ndotl = Math.abs(C.v3Dot(n, lightDir)); // двустороннее освещение (для плаща и открытых краёв)
        const shade = 0.48 + ndotl * 0.58;
        const depth = (pa.depth + pb.depth + pc.depth) / 3;

        drawTris.push({
          pa, pb, pc, depth,
          fill: shadeHexColor(f.color || pm.part.color, shade),
          isSelPart
        });
      }
    }

    // Сортировка от дальних граней к ближним
    drawTris.sort((a, b) => b.depth - a.depth);

    for (let i = 0; i < drawTris.length; i++) {
      const t = drawTris[i];
      ctx.beginPath();
      ctx.moveTo(t.pa.x, t.pa.y);
      ctx.lineTo(t.pb.x, t.pb.y);
      ctx.lineTo(t.pc.x, t.pc.y);
      ctx.closePath();
      ctx.fillStyle = t.fill;
      ctx.fill();

      if (state.showWireframe || t.isSelPart) {
        ctx.strokeStyle = t.isSelPart ? 'rgba(56, 217, 169, 0.55)' : 'rgba(15, 20, 30, 0.35)';
        ctx.lineWidth = t.isSelPart ? 0.9 : 0.6;
        ctx.stroke();
      } else {
        ctx.strokeStyle = t.fill;
        ctx.lineWidth = 0.45;
        ctx.stroke();
      }
    }
  }

  function registerHitHandle(handle) {
    state.lastHitHandles.push(handle);
  }

  function drawSkeletonAndHandles(ctx, proj, fk) {
    // 1) Кости-октаэдры / линии между суставами
    for (const def of C.BONE_HIERARCHY) {
      const b = fk[def.id];
      if (!b) continue;
      const p0 = proj.project(b.worldPos);
      const p1 = proj.project(b.worldTip);
      if (!p0.visible || !p1.visible) continue;

      const isSel = state.selectedBoneId === def.id;
      if (!def.isSocket) {
        ctx.strokeStyle = isSel ? '#ffd43b' : (def.group === 'cape' ? 'rgba(255, 135, 135, 0.85)' : 'rgba(116, 192, 252, 0.82)');
        ctx.lineWidth = isSel ? 3.0 : 1.8;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }

      // Точка шарнира (Joint / Socket)
      const r = def.isSocket ? 4.2 : (isSel ? 5.8 : 4.2);
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, r, 0, Math.PI * 2);
      ctx.fillStyle = def.isSocket ? '#da77f2' : (isSel ? '#ffd43b' : '#18202c');
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = isSel ? '#ffffff' : (def.isSocket ? '#f3d9fa' : '#4dabf7');
      ctx.stroke();

      registerHitHandle({
        kind: state.subMode === 'rig' ? 'rig-joint' : 'select-bone',
        id: def.id,
        paneId: proj.pane.id,
        projector: proj,
        x: p0.x,
        y: p0.y,
        r: 9,
        worldPos: C.v3Clone(b.worldPos)
      });
    }

    // В режиме КАЛИБРОВКА И СКЕЛЕТ также рисуем концевые точки (макушка headTop и носки стоп toe_L/toe_R)
    if (state.subMode === 'rig') {
      for (const extraKey of ['headTop', 'toe_L', 'toe_R']) {
        const wp = state.charData.jointsRest[extraKey];
        if (!wp) continue;
        const sp = proj.project(wp);
        if (!sp.visible) continue;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = '#63e6be';
        ctx.fill();
        registerHitHandle({
          kind: 'rig-joint',
          id: extraKey,
          paneId: proj.pane.id,
          projector: proj,
          x: sp.x,
          y: sp.y,
          r: 9,
          worldPos: C.v3Clone(wp)
        });
      }
    }

    // 2) Живые ручки IK (Кисти, Стопы, Полюсы локтей/коленей и Таз) в режимах ПОЗА и АНИМАЦИЯ
    if ((state.subMode === 'pose' || state.subMode === 'anim') && state.ikEnabled) {
      // Ручка перемещения Таза (для живых приседаний при включённом Pin Feet IK!)
      const pelv = fk.pelvis;
      if (pelv) {
        const pp = proj.project(pelv.worldPos);
        if (pp.visible) {
          ctx.save();
          ctx.strokeStyle = '#38d9a9';
          ctx.fillStyle = 'rgba(56, 217, 169, 0.24)';
          ctx.lineWidth = 2;
          ctx.strokeRect(pp.x - 8, pp.y - 8, 16, 16);
          ctx.fillRect(pp.x - 8, pp.y - 8, 16, 16);
          ctx.restore();
          registerHitHandle({
            kind: 'pelvis-move',
            id: 'pelvis',
            paneId: proj.pane.id,
            projector: proj,
            x: pp.x,
            y: pp.y,
            r: 12,
            worldPos: C.v3Clone(pelv.worldPos)
          });
        }
      }

      for (const key of Object.keys(C.IK_CHAINS)) {
        const ch = C.IK_CHAINS[key];
        const endB = fk[ch.end];
        if (!endB) continue;
        const pEnd = proj.project(endB.worldPos);
        if (pEnd.visible) {
          // Яркий ромб IK-цели (кисть / стопа)
          ctx.save();
          ctx.translate(pEnd.x, pEnd.y);
          ctx.rotate(Math.PI / 4);
          ctx.fillStyle = 'rgba(255, 107, 107, 0.32)';
          ctx.strokeStyle = '#ff6b6b';
          ctx.lineWidth = 2;
          ctx.fillRect(-6.5, -6.5, 13, 13);
          ctx.strokeRect(-6.5, -6.5, 13, 13);
          ctx.restore();

          registerHitHandle({
            kind: 'ik-target',
            chainKey: key,
            paneId: proj.pane.id,
            projector: proj,
            x: pEnd.x,
            y: pEnd.y,
            r: 13,
            worldPos: C.v3Clone(endB.worldPos)
          });
        }

        // Полюс направления локтя/колена (Pole Vector)
        const poleW = state.ikPoles[key] || C.v3Add(fk[ch.upper].worldPos, ch.defaultPole);
        const pPole = proj.project(poleW);
        const pMid = proj.project(fk[ch.lower].worldPos);
        if (pPole.visible && pMid.visible) {
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = 'rgba(151, 117, 250, 0.55)';
          ctx.beginPath();
          ctx.moveTo(pMid.x, pMid.y);
          ctx.lineTo(pPole.x, pPole.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#b197fc';
          ctx.beginPath();
          ctx.arc(pPole.x, pPole.y, 4.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          registerHitHandle({
            kind: 'ik-pole',
            chainKey: key,
            paneId: proj.pane.id,
            projector: proj,
            x: pPole.x,
            y: pPole.y,
            r: 9,
            worldPos: C.v3Clone(poleW)
          });
        }
      }
    }
  }

  function drawMeshEditHandles(ctx, proj, worldPartMeshes) {
    const selMesh = worldPartMeshes.find(m => m.part.id === state.selectedPartId);
    if (!selMesh) return;

    if (state.editMeshMode === 'verts') {
      // Режим прямого перетаскивания вершин меша в 3 проекциях!
      for (let vi = 0; vi < selMesh.wVerts.length; vi++) {
        const wv = selMesh.wVerts[vi];
        const sp = proj.project(wv);
        if (!sp.visible) continue;
        const isSelV = (vi === state.selectedVertexIdx);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, isSelV ? 5.2 : 3.4, 0, Math.PI * 2);
        ctx.fillStyle = isSelV ? '#ffd43b' : '#38d9a9';
        ctx.fill();
        ctx.strokeStyle = '#0c1017';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        registerHitHandle({
          kind: 'mesh-vertex',
          partId: selMesh.part.id,
          vertexIdx: vi,
          paneId: proj.pane.id,
          projector: proj,
          x: sp.x,
          y: sp.y,
          r: 8,
          worldPos: C.v3Clone(wv)
        });
      }
      return;
    }

    // Режим Колец сечения (Loft Rings): рисуем контур каждого кольца и интерактивные маркеры ширины/глубины/высоты!
    if (selMesh.part.kind === 'loft' && Array.isArray(selMesh.part.rings)) {
      const ranges = selMesh.localGeom.ringVertexRanges || [];
      for (const rgInfo of ranges) {
        const isSelR = rgInfo.ringIndex === state.selectedRingIdx;
        ctx.beginPath();
        let sumX = 0, sumY = 0, sumZ = 0;
        for (let k = 0; k < rgInfo.count; k++) {
          const wv = selMesh.wVerts[rgInfo.start + k];
          sumX += wv.x; sumY += wv.y; sumZ += wv.z;
          const sp = proj.project(wv);
          if (k === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        }
        ctx.closePath();
        ctx.strokeStyle = isSelR ? '#ffd43b' : 'rgba(56, 217, 169, 0.72)';
        ctx.lineWidth = isSelR ? 2.2 : 1.3;
        ctx.stroke();

        const centerW = { x: sumX / rgInfo.count, y: sumY / rgInfo.count, z: sumZ / rgInfo.count };
        const sc = proj.project(centerW);
        if (sc.visible) {
          ctx.beginPath();
          ctx.arc(sc.x, sc.y, isSelR ? 5.5 : 4.0, 0, Math.PI * 2);
          ctx.fillStyle = isSelR ? '#ffd43b' : '#38d9a9';
          ctx.fill();
          registerHitHandle({
            kind: 'loft-ring-center',
            partId: selMesh.part.id,
            ringIdx: rgInfo.ringIndex,
            paneId: proj.pane.id,
            projector: proj,
            x: sc.x,
            y: sc.y,
            r: 10,
            worldPos: centerW
          });
        }

        // Боковая ручка радиуса на выбранном кольце (позволяет тянуть ширину/раструб прямо мышкой!)
        if (isSelR && rgInfo.count >= 4) {
          for (const sideIdx of [0, Math.floor(rgInfo.count / 4)]) {
            const rimW = selMesh.wVerts[rgInfo.start + sideIdx];
            const sr = proj.project(rimW);
            if (sr.visible) {
              ctx.fillStyle = '#ff922b';
              ctx.fillRect(sr.x - 4.5, sr.y - 4.5, 9, 9);
              registerHitHandle({
                kind: sideIdx === 0 ? 'loft-ring-rx' : 'loft-ring-rz',
                partId: selMesh.part.id,
                ringIdx: rgInfo.ringIndex,
                paneId: proj.pane.id,
                projector: proj,
                x: sr.x,
                y: sr.y,
                r: 9,
                worldPos: C.v3Clone(rimW)
              });
            }
          }
        }
      }
    }
  }

  // -------------------- Обработка мыши во вьюпорте 3D-студии --------------------
  function getCanvasLocalCoords(e) {
    const canvas = document.getElementById('char3d-canvas');
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function findPaneAt(x, y) {
    for (const p of state.paneRects) {
      if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return p;
    }
    return state.paneRects[0] || null;
  }

  function findHitHandleAt(x, y) {
    let best = null;
    let bestDist = Infinity;
    // Приоритет у более специфичных ручек (IK / вершины / кольца > обычный выбор кости)
    for (let i = state.lastHitHandles.length - 1; i >= 0; i--) {
      const h = state.lastHitHandles[i];
      const d = Math.hypot(x - h.x, y - h.y);
      if (d <= h.r) {
        const prio = (h.kind === 'select-bone') ? d + 4 : d;
        if (prio < bestDist) {
          bestDist = prio;
          best = h;
        }
      }
    }
    return best;
  }

  function onCanvasMouseDown(e) {
    if (App.editorMode !== 'char3d' || !state.charData) return;
    const pt = getCanvasLocalCoords(e);
    const pane = findPaneAt(pt.x, pt.y);
    if (!pane) return;
    state.activePane = pane.id;

    // Зажатый Пробел или средняя кнопка — панорамирование активной проекции
    if (App.spaceDown || e.button === 1 || (e.button === 0 && e.shiftKey)) {
      state.drag = {
        kind: 'pan-pane',
        paneId: pane.id,
        x0: pt.x,
        y0: pt.y,
        perspTarget0: C.v3Clone(state.perspCam.target),
        ortho0: JSON.parse(JSON.stringify(state.orthoCam))
      };
      renderViewport();
      return;
    }

    if (e.button !== 0) return;

    const hit = findHitHandleAt(pt.x, pt.y);
    if (hit) {
      if (hit.kind === 'select-bone') {
        state.selectedBoneId = hit.id;
        // В режиме Позы потянув за кость в орто-проекции можно сразу вращать её!
        const curRot = (state.charData.activePose.bones && state.charData.activePose.bones[hit.id]) || { rx: 0, ry: 0, rz: 0 };
        state.drag = {
          kind: 'fk-rotate-bone',
          boneId: hit.id,
          paneId: hit.paneId,
          x0: pt.x,
          y0: pt.y,
          rot0: { rx: curRot.rx || 0, ry: curRot.ry || 0, rz: curRot.rz || 0 }
        };
        renderAllUI();
        return;
      }

      if (hit.kind === 'rig-joint') {
        if (C.BONE_HIERARCHY.some(b => b.id === hit.id)) state.selectedBoneId = hit.id;
        state.drag = {
          kind: 'rig-joint',
          jointId: hit.id,
          projector: hit.projector,
          x0: pt.x,
          y0: pt.y,
          world0: C.v3Clone(state.charData.jointsRest[hit.id] || hit.worldPos)
        };
        renderAllUI();
        return;
      }

      if (hit.kind === 'ik-target' || hit.kind === 'ik-pole') {
        if (state.subMode === 'anim') ensureEditablePoseForAnimFrame();
        state.drag = {
          kind: hit.kind,
          chainKey: hit.chainKey,
          projector: hit.projector,
          x0: pt.x,
          y0: pt.y,
          world0: C.v3Clone(hit.worldPos)
        };
        return;
      }

      if (hit.kind === 'pelvis-move') {
        if (state.subMode === 'anim') ensureEditablePoseForAnimFrame();
        const pose = state.charData.activePose;
        const fkNow = C.evaluateSkeletonFK(state.charData.jointsRest, pose);
        state.drag = {
          kind: 'pelvis-move',
          projector: hit.projector,
          x0: pt.x,
          y0: pt.y,
          world0: C.v3Clone(hit.worldPos),
          rootOff0: C.v3Clone(pose.rootOffset || C.v3()),
          pinnedFootL: fkNow.foot_L ? C.v3Clone(fkNow.foot_L.worldPos) : null,
          pinnedFootR: fkNow.foot_R ? C.v3Clone(fkNow.foot_R.worldPos) : null
        };
        return;
      }

      if (hit.kind === 'mesh-vertex') {
        state.selectedVertexIdx = hit.vertexIdx;
        const part = state.charData.parts.find(p => p.id === hit.partId);
        const fk = C.evaluateSkeletonFK(state.charData.jointsRest, getDisplayedPose());
        const bInfo = part ? fk[part.bone] : null;
        const vo0 = (part && part.vertexOffsets && part.vertexOffsets[hit.vertexIdx]) || { x: 0, y: 0, z: 0 };
        state.drag = {
          kind: 'mesh-vertex',
          part,
          vertexIdx: hit.vertexIdx,
          bInfo,
          projector: hit.projector,
          x0: pt.x,
          y0: pt.y,
          world0: C.v3Clone(hit.worldPos),
          vo0: C.v3Clone(vo0)
        };
        renderRightPanels();
        renderViewport();
        return;
      }

      if (hit.kind === 'loft-ring-center' || hit.kind === 'loft-ring-rx' || hit.kind === 'loft-ring-rz') {
        state.selectedRingIdx = hit.ringIdx;
        const part = state.charData.parts.find(p => p.id === hit.partId);
        const ring = part && part.rings ? part.rings[hit.ringIdx] : null;
        const fk = C.evaluateSkeletonFK(state.charData.jointsRest, getDisplayedPose());
        const bInfo = part ? fk[part.bone] : null;
        if (part && ring && bInfo) {
          state.drag = {
            kind: hit.kind,
            part,
            ringIdx: hit.ringIdx,
            ring0: JSON.parse(JSON.stringify(ring)),
            boneLen: bInfo.length,
            projector: hit.projector,
            x0: pt.x,
            y0: pt.y
          };
          renderRightPanels();
          renderViewport();
          return;
        }
      }
    }

    // Если клик по свободному месту: в 3D — вращение орбиты, в орто-проекциях — панорамирование
    if (pane.id === 'persp') {
      state.drag = {
        kind: 'orbit',
        x0: pt.x,
        y0: pt.y,
        yaw0: state.perspCam.yaw,
        pitch0: state.perspCam.pitch
      };
    } else {
      state.drag = {
        kind: 'pan-pane',
        paneId: pane.id,
        x0: pt.x,
        y0: pt.y,
        perspTarget0: C.v3Clone(state.perspCam.target),
        ortho0: JSON.parse(JSON.stringify(state.orthoCam))
      };
    }
    renderViewport();
  }

  function ensureEditablePoseForAnimFrame() {
    const clip = getActiveClip();
    if (!clip) return;
    stopAnimPlayback();
    state.charData.activePose = C.sampleAnimationPose(clip, state.animTime);
  }

  function writeActivePoseBackToAnimIfNeeded() {
    if (state.subMode !== 'anim') return;
    const clip = getActiveClip();
    if (!clip || !Array.isArray(clip.keyframes)) return;
    // Если время стоит рядом с существующим ключом — обновляем его, иначе обновляем выбранный ключ
    let k = clip.keyframes.find(kf => Math.abs(kf.time - state.animTime) < 0.025);
    if (!k && clip.keyframes[state.selectedKeyIdx]) {
      k = clip.keyframes[state.selectedKeyIdx];
      state.animTime = k.time;
    }
    if (k) k.pose = C.clonePose(state.charData.activePose);
  }

  function onWindowMouseMove(e) {
    if (!state.drag || App.editorMode !== 'char3d' || !state.charData) return;
    const pt = getCanvasLocalCoords(e);
    const dx = pt.x - state.drag.x0;
    const dy = pt.y - state.drag.y0;
    const d = state.drag;

    if (d.kind === 'orbit') {
      state.perspCam.yaw = d.yaw0 - dx * 0.01;
      state.perspCam.pitch = Math.max(-1.35, Math.min(1.35, d.pitch0 + dy * 0.01));
      renderViewport();
      return;
    }

    if (d.kind === 'pan-pane') {
      const zFit = state.viewLayout === 'quad' ? 0.72 : 1.18;
      if (d.paneId === 'front') {
        const sc = d.ortho0.front.scale * zFit;
        state.orthoCam.front.cx = d.ortho0.front.cx - dx / sc;
        state.orthoCam.front.cy = d.ortho0.front.cy + dy / sc;
      } else if (d.paneId === 'side') {
        const sc = d.ortho0.side.scale * zFit;
        state.orthoCam.side.cx = d.ortho0.side.cx - dx / sc;
        state.orthoCam.side.cy = d.ortho0.side.cy + dy / sc;
      } else if (d.paneId === 'top') {
        const sc = d.ortho0.top.scale * zFit;
        state.orthoCam.top.cx = d.ortho0.top.cx - dx / sc;
        state.orthoCam.top.cz = d.ortho0.top.cz - dy / sc;
      } else {
        const proj = makeProjector(findPaneAt(d.x0, d.y0) || state.paneRects[0]);
        if (proj.right) {
          state.perspCam.target = {
            x: d.perspTarget0.x - proj.right.x * dx * 0.004 + proj.up.x * dy * 0.004,
            y: d.perspTarget0.y - proj.right.y * dx * 0.004 + proj.up.y * dy * 0.004,
            z: d.perspTarget0.z - proj.right.z * dx * 0.004 + proj.up.z * dy * 0.004
          };
        }
      }
      renderViewport();
      return;
    }

    if (d.kind === 'rig-joint') {
      const nextW = d.projector.unprojectDelta(dx, dy, d.world0);
      state.charData.jointsRest[d.jointId] = {
        x: Math.round(nextW.x * 1000) / 1000,
        y: Math.max(0, Math.round(nextW.y * 1000) / 1000),
        z: Math.round(nextW.z * 1000) / 1000
      };
      // Симметричное отражение парных суставов L <-> R
      if (state.charData.symmetry) {
        const mirrorId = d.jointId.endsWith('_L')
          ? d.jointId.slice(0, -2) + '_R'
          : (d.jointId.endsWith('_R') ? d.jointId.slice(0, -2) + '_L' : null);
        if (mirrorId && state.charData.jointsRest[mirrorId]) {
          const cur = state.charData.jointsRest[d.jointId];
          state.charData.jointsRest[mirrorId] = { x: -cur.x, y: cur.y, z: cur.z };
        }
      }
      if (d.jointId === 'headTop') {
        state.charData.heightM = state.charData.jointsRest.headTop.y;
      }
      syncIkTargetsFromCurrentPose();
      markChar3DDirty();
      renderViewport();
      syncInspectorInputsLive();
      return;
    }

    if (d.kind === 'ik-target') {
      const nextW = d.projector.unprojectDelta(dx, dy, d.world0);
      state.ikTargets[d.chainKey] = nextW;
      C.solveTwoBoneIK(
        state.charData.jointsRest,
        state.charData.activePose,
        d.chainKey,
        nextW,
        state.ikPoles[d.chainKey]
      );
      writeActivePoseBackToAnimIfNeeded();
      markChar3DDirty();
      renderViewport();
      syncInspectorInputsLive();
      return;
    }

    if (d.kind === 'ik-pole') {
      const nextPole = d.projector.unprojectDelta(dx, dy, d.world0);
      state.ikPoles[d.chainKey] = nextPole;
      const curTarget = state.ikTargets[d.chainKey];
      if (curTarget) {
        C.solveTwoBoneIK(
          state.charData.jointsRest,
          state.charData.activePose,
          d.chainKey,
          curTarget,
          nextPole
        );
      }
      writeActivePoseBackToAnimIfNeeded();
      markChar3DDirty();
      renderViewport();
      return;
    }

    if (d.kind === 'pelvis-move') {
      const nextW = d.projector.unprojectDelta(dx, dy, d.world0);
      const deltaW = C.v3Sub(nextW, d.world0);
      state.charData.activePose.rootOffset = C.v3Add(d.rootOff0, deltaW);
      if (state.pinFeetToGround) {
        if (d.pinnedFootL) {
          C.solveTwoBoneIK(state.charData.jointsRest, state.charData.activePose, 'leg_L', d.pinnedFootL, state.ikPoles.leg_L);
        }
        if (d.pinnedFootR) {
          C.solveTwoBoneIK(state.charData.jointsRest, state.charData.activePose, 'leg_R', d.pinnedFootR, state.ikPoles.leg_R);
        }
      }
      writeActivePoseBackToAnimIfNeeded();
      markChar3DDirty();
      renderViewport();
      syncInspectorInputsLive();
      return;
    }

    if (d.kind === 'fk-rotate-bone') {
      if (Math.hypot(dx, dy) < 3) return;
      if (state.subMode === 'anim') ensureEditablePoseForAnimFrame();
      if (!state.charData.activePose.bones) state.charData.activePose.bones = {};
      const nextRot = { ...d.rot0 };
      if (d.paneId === 'side') {
        nextRot.rx = Math.round((d.rot0.rx + dy * 0.55) * 10) / 10;
      } else if (d.paneId === 'top') {
        nextRot.ry = Math.round((d.rot0.ry + dx * 0.55) * 10) / 10;
      } else {
        nextRot.rz = Math.round((d.rot0.rz - dx * 0.55) * 10) / 10;
        nextRot.rx = Math.round((d.rot0.rx + dy * 0.45) * 10) / 10;
      }
      state.charData.activePose.bones[d.boneId] = nextRot;
      writeActivePoseBackToAnimIfNeeded();
      markChar3DDirty();
      renderViewport();
      syncInspectorInputsLive();
      return;
    }

    if (d.kind === 'mesh-vertex') {
      const nextW = d.projector.unprojectDelta(dx, dy, d.world0);
      const worldDelta = C.v3Sub(nextW, d.world0);
      const localDelta = d.bInfo ? C.qRotateVec(C.qConj(d.bInfo.worldQ), worldDelta) : worldDelta;
      if (!d.part.vertexOffsets) d.part.vertexOffsets = {};
      d.part.vertexOffsets[d.vertexIdx] = {
        x: Math.round((d.vo0.x + localDelta.x) * 1000) / 1000,
        y: Math.round((d.vo0.y + localDelta.y) * 1000) / 1000,
        z: Math.round((d.vo0.z + localDelta.z) * 1000) / 1000
      };
      syncMirrorPartIfSymmetric(d.part);
      markChar3DDirty();
      renderViewport();
      return;
    }

    if (d.kind === 'loft-ring-center' || d.kind === 'loft-ring-rx' || d.kind === 'loft-ring-rz') {
      const sc = d.projector.scale || 180;
      const ring = d.part.rings[d.ringIdx];
      if (!ring) return;
      if (d.kind === 'loft-ring-center') {
        ring.t = Math.round((d.ring0.t - (dy / sc) / Math.max(0.05, d.boneLen)) * 100) / 100;
        if (d.projector.pane.id === 'side') {
          ring.oz = Math.round(((d.ring0.oz || 0) + dx / sc) * 1000) / 1000;
        } else {
          ring.ox = Math.round(((d.ring0.ox || 0) + dx / sc) * 1000) / 1000;
        }
      } else if (d.kind === 'loft-ring-rx') {
        ring.rx = Math.max(0.005, Math.round((d.ring0.rx + (dx - dy * 0.25) / sc) * 1000) / 1000);
        if (e.altKey !== true) ring.rz = Math.max(0.005, Math.round((d.ring0.rz + (dx - dy * 0.25) / sc) * 1000) / 1000);
      } else if (d.kind === 'loft-ring-rz') {
        ring.rz = Math.max(0.005, Math.round((d.ring0.rz + (dx + dy * 0.25) / sc) * 1000) / 1000);
      }
      syncMirrorPartIfSymmetric(d.part);
      markChar3DDirty();
      renderViewport();
      syncInspectorInputsLive();
    }
  }

  function syncMirrorPartIfSymmetric(part) {
    if (!state.charData || !state.charData.symmetry || !part || !part.mirrorId) return;
    const mirror = state.charData.parts.find(p => p.id === part.mirrorId);
    if (!mirror) return;
    mirror.kind = part.kind;
    mirror.sides = part.sides;
    mirror.color = part.color;
    mirror.accentColor = part.accentColor;
    mirror.capJoint = part.capJoint;
    mirror.openBottom = part.openBottom;
    if (part.rings) {
      mirror.rings = part.rings.map(r => ({
        ...r,
        ox: -(r.ox || 0)
      }));
    }
    if (part.size) mirror.size = { ...part.size };
    if (part.radius) mirror.radius = { ...part.radius };
  }

  function onWindowMouseUp() {
    if (!state.drag) return;
    const wasEdit = state.drag.kind !== 'orbit' && state.drag.kind !== 'pan-pane';
    state.drag = null;
    if (wasEdit && App.editorMode === 'char3d') {
      renderRightPanels();
      if (state.subMode === 'anim') renderAnimTimelineBar();
    }
  }

  function onCanvasWheel(e) {
    if (App.editorMode !== 'char3d') return;
    e.preventDefault();
    const pt = getCanvasLocalCoords(e);
    const pane = findPaneAt(pt.x, pt.y);
    if (!pane) return;
    const factor = e.deltaY < 0 ? 1.12 : (1 / 1.12);
    if (pane.id === 'persp') {
      state.perspCam.dist = Math.max(0.7, Math.min(12, state.perspCam.dist / factor));
    } else if (state.orthoCam[pane.id]) {
      state.orthoCam[pane.id].scale = Math.max(45, Math.min(900, state.orthoCam[pane.id].scale * factor));
    }
    renderViewport();
  }

  function fitChar3DCamera() {
    const h = (state.charData && state.charData.heightM) || 1.80;
    state.perspCam = { yaw: 0.48, pitch: 0.22, dist: h * 1.75, target: { x: 0, y: h * 0.52, z: 0 } };
    state.orthoCam.front = { cx: 0, cy: h * 0.52, scale: 330 / h };
    state.orthoCam.side  = { cx: 0, cy: h * 0.52, scale: 330 / h };
    state.orthoCam.top   = { cx: 0, cz: 0,        scale: 330 / h };
    renderViewport();
  }

  // -------------------- Воспроизведение 3D-анимации --------------------
  function startAnimPlayback() {
    if (state.playing) return;
    if (state.subMode !== 'anim') state.subMode = 'anim';
    state.playing = true;
    state.lastRafTs = 0;
    renderSubModeTabs();
    renderAnimTimelineBar();

    function tick(ts) {
      if (!state.playing || App.editorMode !== 'char3d') {
        state.playing = false;
        return;
      }
      if (state.lastRafTs > 0) {
        const dt = Math.min(0.08, Math.max(0, (ts - state.lastRafTs) / 1000));
        const clip = getActiveClip();
        const dur = (clip && clip.duration) || 1.2;
        state.animTime += dt * (state.animSpeed || 1);
        if (state.animTime >= dur) {
          if (clip && clip.loop !== false) {
            state.animTime = state.animTime % dur;
          } else {
            state.animTime = dur;
            stopAnimPlayback();
            renderViewport();
            renderAnimTimelineBar();
            return;
          }
        }
      }
      state.lastRafTs = ts;
      renderViewport();
      updateTimelineScrubberLive();
      state.rafId = requestAnimationFrame(tick);
    }
    state.rafId = requestAnimationFrame(tick);
  }

  function stopAnimPlayback() {
    state.playing = false;
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    const playIcon = document.getElementById('char3d-play-icon');
    if (playIcon) playIcon.textContent = 'play_arrow';
  }

  // -------------------- Отрисовка правых панелей (Дерево костей/мешей + Инспектор свойств) --------------------
  function renderAllUI() {
    if (App.editorMode !== 'char3d') return;
    renderSubModeTabs();
    renderRightPanels();
    renderAnimTimelineBar();
    renderViewport();
  }

  function renderSubModeTabs() {
    $$('[data-c3d-submode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.c3dSubmode === state.subMode);
    });
    $$('[data-c3d-view]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.c3dView === state.viewLayout);
    });
    const gridBtn = document.getElementById('btn-c3d-grid');
    if (gridBtn) gridBtn.classList.toggle('active', state.showMetricGrid);
    const skelBtn = document.getElementById('btn-c3d-skel');
    if (skelBtn) skelBtn.classList.toggle('active', state.showSkeletonOverlay);
    const wireBtn = document.getElementById('btn-c3d-wire');
    if (wireBtn) wireBtn.classList.toggle('active', state.showWireframe);
  }

  function renderRightPanels() {
    const listEl = document.getElementById('char3d-layers-list');
    const propsEl = els.props;
    if (!listEl || !propsEl || !state.charData) return;

    // 1) Верхняя правая панель: либо Дерево костей/сокетов, либо Список модульных мешей персонажа
    listEl.innerHTML = '';
    if (state.subMode === 'mesh') {
      if (els.layersHeaderTitle) els.layersHeaderTitle.textContent = 'Меши и экипировка (' + state.charData.parts.length + ')';
      for (const part of state.charData.parts) {
        const li = document.createElement('li');
        li.className = 'c3d-tree-item' + (part.id === state.selectedPartId ? ' selected' : '');
        const bDef = C.BONE_HIERARCHY.find(b => b.id === part.bone);
        li.innerHTML =
          '<span class="c3d-swatch" style="background:' + (part.color || '#adb5bd') + '"></span>' +
          '<span class="c3d-tree-name">' + escapeHtml(part.label || part.id) + '</span>' +
          '<span class="c3d-tree-tag">' + escapeHtml(bDef ? bDef.id : part.bone) + '</span>' +
          '<button type="button" class="icon-btn icon-btn-sm c3d-vis-btn" title="Видимость меша">' +
            '<span class="material-icons">' + (part.visible === false ? 'visibility_off' : 'visibility') + '</span>' +
          '</button>';
        li.addEventListener('click', (e) => {
          if (e.target.closest('.c3d-vis-btn')) {
            part.visible = (part.visible === false);
            markChar3DDirty();
            renderRightPanels();
            renderViewport();
            return;
          }
          state.selectedPartId = part.id;
          state.selectedBoneId = part.bone;
          state.selectedRingIdx = 0;
          state.selectedVertexIdx = -1;
          renderRightPanels();
          renderViewport();
        });
        listEl.appendChild(li);
      }
    } else {
      if (els.layersHeaderTitle) els.layersHeaderTitle.textContent = 'Шарнирный скелет и сокеты';
      for (const def of C.BONE_HIERARCHY) {
        const li = document.createElement('li');
        li.className = 'c3d-tree-item' + (def.id === state.selectedBoneId ? ' selected' : '');
        let depth = 0, cur = def;
        while (cur && cur.parent) {
          depth++;
          cur = C.BONE_HIERARCHY.find(x => x.id === cur.parent);
        }
        li.style.paddingLeft = (8 + depth * 10) + 'px';
        li.innerHTML =
          '<span class="material-icons c3d-bone-ico">' + (def.isSocket ? 'extension' : (def.group === 'cape' ? 'flag' : 'hub')) + '</span>' +
          '<span class="c3d-tree-name">' + escapeHtml(def.label) + '</span>';
        li.addEventListener('click', () => {
          state.selectedBoneId = def.id;
          renderRightPanels();
          renderViewport();
        });
        listEl.appendChild(li);
      }
    }

    // 2) Нижняя правая панель: контекстный Инспектор активного режима
    if (state.subMode === 'rig') renderRigAndGlbCalibrationInspector(propsEl);
    else if (state.subMode === 'mesh') renderMeshAndOutfitInspector(propsEl);
    else if (state.subMode === 'pose') renderPoseAndIkInspector(propsEl);
    else renderAnimAndEasingInspector(propsEl);
  }

  // ---- Инспектор 1: Калибровка эталонных .glb мешей по росту + подгонка скелета ----
  function renderRigAndGlbCalibrationInspector(props) {
    if (els.propsTitle) els.propsTitle.textContent = '1. Калибровка .GLB и Скелет';
    const fem = state.refSlots.female;
    const mal = state.refSlots.male;
    const jId = state.selectedBoneId;
    const jPos = state.charData.jointsRest[jId] || C.v3();

    props.innerHTML =
      '<div class="pgroup">' +
        '<div class="pgroup-title">Эталонные меши (.GLB) и Ростомер</div>' +
        '<div class="stage-help-note">Загрузите свои <code>female_base_mesh.glb</code> / <code>male_base_mesh.glb</code> (или включите встроенные). Калибратор автоматически ставит стопы на <b>Y = 0.00 м</b> и приводит модели к нужному росту!</div>' +
        buildRefSlotHtml('female', 'Женская база (.glb)', fem, '#ff8787') +
        buildRefSlotHtml('male',   'Мужская база (.glb)', mal, '#4dabf7') +
        '<div class="prow"><label>Сравнение</label>' +
          '<button type="button" id="c3d-ref-layout" class="stage-btn-sm">' +
            (state.refSideBySide ? 'Стоят рядом (±0.52м)' : 'По центру X=0 (наложение)') +
          '</button>' +
        '</div>' +
        '<div class="prow"><label>Прозрачность</label>' +
          '<input type="range" id="c3d-ref-opacity" min="10" max="90" value="' + Math.round(state.refOpacity * 100) + '">' +
        '</div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" id="c3d-fit-fem" class="stage-btn-sm">Подогнать скелет под Жен</button>' +
          '<button type="button" id="c3d-fit-mal" class="stage-btn-sm primary-violet">Подогнать скелет под Муж</button>' +
        '</div>' +
      '</div>' +

      '<div class="pgroup">' +
        '<div class="pgroup-title">Подгонка сустава в 3 проекциях: ' + escapeHtml(jId) + '</div>' +
        '<label class="c3d-check-row"><input type="checkbox" id="c3d-sym-chk" ' + (state.charData.symmetry ? 'checked' : '') + '> <span>Симметрия скелета и мешей L ↔ R</span></label>' +
        '<div class="prow"><label>X (лево/право, м)</label><input type="number" step="0.01" data-c3d-jpos="x" value="' + jPos.x.toFixed(3) + '"></div>' +
        '<div class="prow"><label>Y (высота от пола, м)</label><input type="number" step="0.01" data-c3d-jpos="y" value="' + jPos.y.toFixed(3) + '"></div>' +
        '<div class="prow"><label>Z (глубина профиль, м)</label><input type="number" step="0.01" data-c3d-jpos="z" value="' + jPos.z.toFixed(3) + '"></div>' +
        '<div class="stage-help-note">Тяните голубые/жёлтые кружки суставов мышью прямо в окнах <b>Спереди XY</b>, <b>Сбоку ZY</b> и <b>Сверху XZ</b>.</div>' +
      '</div>';

    props.querySelectorAll('[data-ref-vis]').forEach(chk => {
      chk.addEventListener('change', () => {
        const g = chk.dataset.refVis;
        state.refSlots[g].visible = chk.checked;
        syncRefOffsets();
        renderRightPanels();
        renderViewport();
      });
    });

    props.querySelectorAll('[data-ref-cal]').forEach(chk => {
      chk.addEventListener('change', () => {
        const g = chk.dataset.refCal;
        state.refSlots[g].calibrated = chk.checked;
        renderRightPanels();
        renderViewport();
      });
    });

    props.querySelectorAll('[data-ref-h]').forEach(inp => {
      inp.addEventListener('change', () => {
        const g = inp.dataset.refH;
        state.refSlots[g].targetHeight = Math.max(0.4, Math.min(3.5, parseFloat(inp.value) || 1.75));
        state.refSlots[g].calibrated = true;
        renderRightPanels();
        renderViewport();
      });
    });

    props.querySelectorAll('[data-load-glb]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.pendingGlbGender = btn.dataset.loadGlb;
        const fi = document.getElementById('char3d-glb-input');
        if (fi) { fi.value = ''; fi.click(); }
      });
    });

    props.querySelector('#c3d-ref-layout').addEventListener('click', () => {
      state.refSideBySide = !state.refSideBySide;
      syncRefOffsets();
      renderRightPanels();
      renderViewport();
    });

    props.querySelector('#c3d-ref-opacity').addEventListener('input', (e) => {
      state.refOpacity = (parseInt(e.target.value, 10) || 34) / 100;
      renderViewport();
    });

    props.querySelector('#c3d-fit-fem').addEventListener('click', () => {
      const h = state.refSlots.female.targetHeight || 1.68;
      state.charData.heightM = h;
      state.charData.jointsRest = C.createDefaultJointPositions(h, true);
      state.refSlots.female.visible = true;
      state.refSlots.male.visible = false;
      syncRefOffsets();
      syncIkTargetsFromCurrentPose();
      markChar3DDirty();
      renderRightPanels();
      renderViewport();
      setHint('Скелет выровнен под женские пропорции (' + h.toFixed(2) + ' м)', 2000);
    });

    props.querySelector('#c3d-fit-mal').addEventListener('click', () => {
      const h = state.refSlots.male.targetHeight || 1.80;
      state.charData.heightM = h;
      state.charData.jointsRest = C.createDefaultJointPositions(h, false);
      state.refSlots.male.visible = true;
      state.refSlots.female.visible = false;
      syncRefOffsets();
      syncIkTargetsFromCurrentPose();
      markChar3DDirty();
      renderRightPanels();
      renderViewport();
      setHint('Скелет выровнен под мужские пропорции (' + h.toFixed(2) + ' м)', 2000);
    });

    props.querySelector('#c3d-sym-chk').addEventListener('change', (e) => {
      state.charData.symmetry = !!e.target.checked;
      markChar3DDirty();
    });

    props.querySelectorAll('[data-c3d-jpos]').forEach(inp => {
      inp.addEventListener('input', () => {
        const ax = inp.dataset.c3dJpos;
        const val = parseFloat(inp.value);
        if (!isFinite(val) || !state.charData.jointsRest[jId]) return;
        state.charData.jointsRest[jId][ax] = val;
        if (state.charData.symmetry) {
          const mId = jId.endsWith('_L') ? jId.slice(0, -2) + '_R' : (jId.endsWith('_R') ? jId.slice(0, -2) + '_L' : null);
          if (mId && state.charData.jointsRest[mId]) {
            const c = state.charData.jointsRest[jId];
            state.charData.jointsRest[mId] = { x: -c.x, y: c.y, z: c.z };
          }
        }
        markChar3DDirty();
        renderViewport();
      });
    });
  }

  function buildRefSlotHtml(gender, title, slot, badgeColor) {
    return (
      '<div class="c3d-ref-card">' +
        '<div class="c3d-ref-head">' +
          '<label><input type="checkbox" data-ref-vis="' + gender + '" ' + (slot.visible ? 'checked' : '') + '> ' +
            '<b style="color:' + badgeColor + '">' + title + '</b></label>' +
          '<button type="button" class="stage-btn-sm" data-load-glb="' + gender + '">Загрузить .glb</button>' +
        '</div>' +
        '<div class="c3d-ref-meta">Файл: ' + escapeHtml(slot.name) + ' · сырой размер: <b>' + slot.rawHeight.toFixed(2) + ' u</b></div>' +
        '<div class="prow">' +
          '<label><input type="checkbox" data-ref-cal="' + gender + '" ' + (slot.calibrated ? 'checked' : '') + '> Рост (м):</label>' +
          '<input type="number" step="0.02" min="0.5" max="3.0" data-ref-h="' + gender + '" value="' + slot.targetHeight.toFixed(2) + '">' +
        '</div>' +
      '</div>'
    );
  }

  // ---- Инспектор 2: Редактор частей тела, одежды, колец Loft и вершин меша ----
  function renderMeshAndOutfitInspector(props) {
    if (els.propsTitle) els.propsTitle.textContent = '2. Редактор Меша и Персонажа';
    const part = state.charData.parts.find(p => p.id === state.selectedPartId) || state.charData.parts[0];

    let html =
      '<div class="pgroup">' +
        '<div class="pgroup-title">Готовые архетипы для игр</div>' +
        '<div class="c3d-archetype-grid">' +
          '<button type="button" class="stage-btn-sm' + (state.currentName === 'king_cape' ? ' primary-violet' : '') + '" data-c3d-arch="king_cape">Король в плаще</button>' +
          '<button type="button" class="stage-btn-sm' + (state.currentName === 'mage_staff' ? ' primary-violet' : '') + '" data-c3d-arch="mage_staff">Маг в шляпе</button>' +
          '<button type="button" class="stage-btn-sm' + (state.currentName === 'zombie_suit' ? ' primary-violet' : '') + '" data-c3d-arch="zombie_suit">Зомби (рваный)</button>' +
          '<button type="button" class="stage-btn-sm' + (state.currentName === 'base_human' ? ' primary-violet' : '') + '" data-c3d-arch="base_human">База Манекен</button>' +
        '</div>' +
      '</div>' +

      '<div class="pgroup">' +
        '<div class="pgroup-title">Добавить примитив / одежду / оружие</div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" data-c3d-add="loft">+ Труба (кольца)</button>' +
          '<button type="button" class="stage-btn-sm" data-c3d-add="box">+ Короб / Щит</button>' +
          '<button type="button" class="stage-btn-sm" data-c3d-add="sphere">+ Сфера</button>' +
        '</div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" data-c3d-preset-equip="cape">+ Плащ (3 шарнира)</button>' +
          '<button type="button" class="stage-btn-sm" data-c3d-preset-equip="hat">+ Шляпа мага</button>' +
        '</div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" data-c3d-preset-equip="axe">+ Топор в руку</button>' +
          '<button type="button" class="stage-btn-sm" data-c3d-preset-equip="staff">+ Посох</button>' +
          '<button type="button" class="stage-btn-sm" data-c3d-preset-equip="torn_leg">Рваная штанина П</button>' +
        '</div>' +
      '</div>';

    if (part) {
      const boneOpts = C.BONE_HIERARCHY.map(b =>
        '<option value="' + b.id + '"' + (b.id === part.bone ? ' selected' : '') + '>' + escapeHtml(b.label) + '</option>'
      ).join('');

      html +=
        '<div class="pgroup">' +
          '<div class="pgroup-title">Выбранный меш: ' + escapeHtml(part.label || part.id) + '</div>' +
          '<div class="stage-btn-row">' +
            '<button type="button" class="stage-btn-sm' + (state.editMeshMode === 'rings' ? ' primary-violet' : '') + '" data-c3d-em="rings">Режим: Кольца сечений</button>' +
            '<button type="button" class="stage-btn-sm' + (state.editMeshMode === 'verts' ? ' primary-violet' : '') + '" data-c3d-em="verts">Режим: Точки меша</button>' +
          '</div>' +
          '<label class="c3d-check-row"><input type="checkbox" id="c3d-mesh-sym" ' + (state.charData.symmetry ? 'checked' : '') + '> <span>Симметрия L ↔ R (выкл = асимметрия)</span></label>' +
          '<div class="prow"><label>Имя части</label><input type="text" id="c3d-part-label" value="' + escapeHtml(part.label || '') + '"></div>' +
          '<div class="prow"><label>Кость / Сокет</label><select id="c3d-part-bone">' + boneOpts + '</select></div>' +
          '<div class="prow"><label>Цвет осн / доп</label>' +
            '<span style="display:flex;gap:6px">' +
              '<input type="color" id="c3d-part-col" value="' + (part.color || '#adb5bd') + '">' +
              '<input type="color" id="c3d-part-acc" value="' + (part.accentColor || part.color || '#adb5bd') + '">' +
            '</span>' +
          '</div>';

      if (part.kind === 'loft' && Array.isArray(part.rings)) {
        const rIdx = Math.max(0, Math.min(part.rings.length - 1, state.selectedRingIdx));
        const rg = part.rings[rIdx];
        html +=
          '<div class="prow"><label>Граней по кругу</label><input type="number" id="c3d-part-sides" min="4" max="16" value="' + (part.sides || 8) + '"></div>' +
          '<label class="c3d-check-row"><input type="checkbox" id="c3d-part-cap" ' + (part.capJoint !== false ? 'checked' : '') + '> <span>Шарнирный купол в суставе</span></label>' +
          '<div class="pgroup-subtitle">Кольцо #' + (rIdx + 1) + ' из ' + part.rings.length + ' (тяните оранжевые ручки во вьюпорте)</div>' +
          '<div class="stage-btn-row">' +
            part.rings.map((_, idx) =>
              '<button type="button" class="stage-btn-sm' + (idx === rIdx ? ' primary-violet' : '') + '" data-c3d-selring="' + idx + '">К' + (idx + 1) + '</button>'
            ).join('') +
            '<button type="button" class="stage-btn-sm" id="c3d-ring-add" title="Вставить кольцо сечения">+ Кольцо</button>' +
            (part.rings.length > 2 ? '<button type="button" class="stage-btn-sm" id="c3d-ring-del">− Кольцо</button>' : '') +
          '</div>' +
          '<div class="prow"><label>Позиция вдоль кости</label><input type="number" step="0.05" data-c3d-ring="t" value="' + rg.t.toFixed(2) + '"></div>' +
          '<div class="prow"><label>Радиус шир (RX, м)</label><input type="number" step="0.005" min="0.004" data-c3d-ring="rx" value="' + rg.rx.toFixed(3) + '"></div>' +
          '<div class="prow"><label>Радиус глуб (RZ, м)</label><input type="number" step="0.005" min="0.004" data-c3d-ring="rz" value="' + rg.rz.toFixed(3) + '"></div>';
      } else if (part.kind === 'box' && part.size) {
        html +=
          '<div class="prow"><label>Размер X (м)</label><input type="number" step="0.01" data-c3d-box="x" value="' + part.size.x.toFixed(3) + '"></div>' +
          '<div class="prow"><label>Размер Y (м)</label><input type="number" step="0.01" data-c3d-box="y" value="' + part.size.y.toFixed(3) + '"></div>' +
          '<div class="prow"><label>Размер Z (м)</label><input type="number" step="0.01" data-c3d-box="z" value="' + part.size.z.toFixed(3) + '"></div>';
      } else if (part.kind === 'cape_plate') {
        html +=
          '<div class="prow"><label>Ширина верх (м)</label><input type="number" step="0.01" data-c3d-cape="wTop" value="' + (part.wTop || 0.22).toFixed(2) + '"></div>' +
          '<div class="prow"><label>Ширина низ (м)</label><input type="number" step="0.01" data-c3d-cape="wBot" value="' + (part.wBot || 0.28).toFixed(2) + '"></div>';
      }

      if (state.editMeshMode === 'verts') {
        const cnt = part.vertexOffsets ? Object.keys(part.vertexOffsets).length : 0;
        html +=
          '<div class="stage-help-note">В режиме <b>Точки меша</b> кликайте и тяните любую зелёную вершину меша в проекциях <b>Спереди / Сбоку / Сверху</b>! Смещено точек: <b>' + cnt + '</b>.</div>' +
          (cnt ? '<button type="button" class="stage-btn-sm" id="c3d-reset-verts">Сбросить смещения точек этой части</button>' : '');
      }

      html +=
        '<div class="stage-btn-row" style="margin-top:8px">' +
          '<button type="button" class="stage-btn-sm" id="c3d-part-del" style="color:#ff8787">Удалить выбранную часть</button>' +
        '</div>' +
      '</div>';
    }

    props.innerHTML = html;

    props.querySelectorAll('[data-c3d-arch]').forEach(btn => {
      btn.addEventListener('click', () => loadArchetype(btn.dataset.c3dArch, false));
    });

    props.querySelectorAll('[data-c3d-add]').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.c3dAdd;
        const targetBone = state.selectedBoneId || 'chest';
        const np = kind === 'box'
          ? { id: C.uidPart('box'), label: 'Короб (' + targetBone + ')', bone: targetBone, kind: 'box', color: '#ced4da', size: { x: 0.14, y: 0.18, z: 0.14 }, offset: { x: 0, y: 0.05, z: 0 } }
          : (kind === 'sphere'
            ? { id: C.uidPart('sph'), label: 'Сфера (' + targetBone + ')', bone: targetBone, kind: 'sphere', color: '#ffd43b', radius: { x: 0.08, y: 0.08, z: 0.08 }, offset: { x: 0, y: 0.06, z: 0 } }
            : {
                id: C.uidPart('tube'), label: 'Цилиндр / Рукав (' + targetBone + ')', bone: targetBone, kind: 'loft', sides: 8,
                color: '#748ffc', accentColor: '#4c6ef5', capJoint: true,
                rings: [{ t: 0.0, rx: 0.07, rz: 0.07, ox: 0, oz: 0 }, { t: 1.0, rx: 0.055, rz: 0.055, ox: 0, oz: 0 }]
              });
        state.charData.parts.push(np);
        state.selectedPartId = np.id;
        markChar3DDirty();
        renderRightPanels();
        renderViewport();
      });
    });

    props.querySelectorAll('[data-c3d-preset-equip]').forEach(btn => {
      btn.addEventListener('click', () => applyQuickEquipmentPreset(btn.dataset.c3dPresetEquip));
    });

    if (!part) return;

    props.querySelectorAll('[data-c3d-em]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.editMeshMode = btn.dataset.c3dEm;
        renderRightPanels();
        renderViewport();
      });
    });

    props.querySelector('#c3d-mesh-sym').addEventListener('change', (e) => {
      state.charData.symmetry = !!e.target.checked;
      markChar3DDirty();
    });

    props.querySelector('#c3d-part-label').addEventListener('input', (e) => {
      part.label = e.target.value;
      markChar3DDirty();
    });

    props.querySelector('#c3d-part-bone').addEventListener('change', (e) => {
      part.bone = e.target.value;
      state.selectedBoneId = part.bone;
      markChar3DDirty();
      renderRightPanels();
      renderViewport();
    });

    props.querySelector('#c3d-part-col').addEventListener('input', (e) => {
      part.color = e.target.value;
      syncMirrorPartIfSymmetric(part);
      markChar3DDirty();
      renderViewport();
    });

    props.querySelector('#c3d-part-acc').addEventListener('input', (e) => {
      part.accentColor = e.target.value;
      syncMirrorPartIfSymmetric(part);
      markChar3DDirty();
      renderViewport();
    });

    const sidesInp = props.querySelector('#c3d-part-sides');
    if (sidesInp) {
      sidesInp.addEventListener('change', () => {
        part.sides = Math.max(4, Math.min(16, parseInt(sidesInp.value, 10) || 8));
        syncMirrorPartIfSymmetric(part);
        markChar3DDirty();
        renderViewport();
      });
    }

    const capChk = props.querySelector('#c3d-part-cap');
    if (capChk) {
      capChk.addEventListener('change', () => {
        part.capJoint = !!capChk.checked;
        syncMirrorPartIfSymmetric(part);
        markChar3DDirty();
        renderViewport();
      });
    }

    props.querySelectorAll('[data-c3d-selring]').forEach(b => {
      b.addEventListener('click', () => {
        state.selectedRingIdx = parseInt(b.dataset.c3dSelring, 10) || 0;
        renderRightPanels();
        renderViewport();
      });
    });

    const addRingBtn = props.querySelector('#c3d-ring-add');
    if (addRingBtn) {
      addRingBtn.addEventListener('click', () => {
        const idx = Math.min(part.rings.length - 1, state.selectedRingIdx);
        const rA = part.rings[idx];
        const rB = part.rings[Math.min(part.rings.length - 1, idx + 1)];
        const mid = {
          t: Math.round(((rA.t + rB.t) * 0.5 + (rA === rB ? 0.25 : 0)) * 100) / 100,
          rx: Math.round(((rA.rx + rB.rx) * 0.5) * 1000) / 1000,
          rz: Math.round(((rA.rz + rB.rz) * 0.5) * 1000) / 1000,
          ox: 0, oz: 0
        };
        part.rings.splice(idx + 1, 0, mid);
        state.selectedRingIdx = idx + 1;
        syncMirrorPartIfSymmetric(part);
        markChar3DDirty();
        renderRightPanels();
        renderViewport();
      });
    }

    const delRingBtn = props.querySelector('#c3d-ring-del');
    if (delRingBtn) {
      delRingBtn.addEventListener('click', () => {
        if (part.rings.length <= 2) return;
        part.rings.splice(state.selectedRingIdx, 1);
        state.selectedRingIdx = Math.max(0, state.selectedRingIdx - 1);
        syncMirrorPartIfSymmetric(part);
        markChar3DDirty();
        renderRightPanels();
        renderViewport();
      });
    }

    props.querySelectorAll('[data-c3d-ring]').forEach(inp => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.c3dRing;
        const v = parseFloat(inp.value);
        if (!isFinite(v)) return;
        const r = part.rings[state.selectedRingIdx];
        if (!r) return;
        r[k] = k === 't' ? v : Math.max(0.004, v);
        syncMirrorPartIfSymmetric(part);
        markChar3DDirty();
        renderViewport();
      });
    });

    props.querySelectorAll('[data-c3d-box]').forEach(inp => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.c3dBox;
        part.size[k] = Math.max(0.01, parseFloat(inp.value) || 0.1);
        syncMirrorPartIfSymmetric(part);
        markChar3DDirty();
        renderViewport();
      });
    });

    props.querySelectorAll('[data-c3d-cape]').forEach(inp => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.c3dCape;
        part[k] = Math.max(0.04, parseFloat(inp.value) || 0.2);
        markChar3DDirty();
        renderViewport();
      });
    });

    const rstV = props.querySelector('#c3d-reset-verts');
    if (rstV) {
      rstV.addEventListener('click', () => {
        delete part.vertexOffsets;
        markChar3DDirty();
        renderRightPanels();
        renderViewport();
      });
    }

    props.querySelector('#c3d-part-del').addEventListener('click', () => {
      state.charData.parts = state.charData.parts.filter(p => p.id !== part.id);
      state.selectedPartId = state.charData.parts[0] ? state.charData.parts[0].id : null;
      markChar3DDirty();
      renderRightPanels();
      renderViewport();
    });
  }

  function applyQuickEquipmentPreset(kind) {
    const parts = state.charData.parts;
    if (kind === 'cape') {
      state.charData.parts = parts.filter(p => !p.bone.startsWith('cape_'));
      state.charData.parts.push(
        { id: C.uidPart('cape1'), label: 'Плащ: верх (плечи)', bone: 'cape_1', kind: 'cape_plate', wTop: 0.21, wBot: 0.25, thick: 0.018, color: '#c92a2a', accentColor: '#c92a2a' },
        { id: C.uidPart('cape2'), label: 'Плащ: середина',     bone: 'cape_2', kind: 'cape_plate', wTop: 0.25, wBot: 0.30, thick: 0.016, color: '#c92a2a', accentColor: '#c92a2a' },
        { id: C.uidPart('cape3'), label: 'Плащ: подол',        bone: 'cape_3', kind: 'cape_plate', wTop: 0.30, wBot: 0.35, thick: 0.016, color: '#c92a2a', accentColor: '#ffd43b' }
      );
    } else if (kind === 'hat') {
      const hat = {
        id: C.uidPart('hat'), label: 'Шляпа мага', bone: 'socket_head', kind: 'loft', sides: 10,
        color: '#3b2874', accentColor: '#9775fa', capJoint: false,
        rings: [
          { t: -0.25, rx: 0.22, rz: 0.22, ox: 0, oz: 0.01 },
          { t:  0.10, rx: 0.095, rz: 0.102, ox: 0, oz: 0.01 },
          { t:  1.85, rx: 0.055, rz: 0.055, ox: 0, oz: -0.02 },
          { t:  3.40, rx: 0.008, rz: 0.008, ox: 0, oz: -0.09 }
        ]
      };
      parts.push(hat);
      state.selectedPartId = hat.id;
    } else if (kind === 'axe') {
      parts.push(
        { id: C.uidPart('axe_h'), label: 'Топорище', bone: 'socket_hand_R', kind: 'loft', sides: 6, color: '#7f4f24', capJoint: false, rings: [{ t: -1.8, rx: 0.017, rz: 0.022, ox: 0, oz: 0.02 }, { t: 5.2, rx: 0.020, rz: 0.026, ox: 0, oz: 0.02 }] },
        { id: C.uidPart('axe_b'), label: 'Лезвие топора', bone: 'socket_hand_R', kind: 'box', color: '#ced4da', size: { x: 0.024, y: 0.16, z: 0.19 }, offset: { x: 0, y: 0.36, z: 0.09 } }
      );
    } else if (kind === 'staff') {
      parts.push(
        { id: C.uidPart('staff'), label: 'Древко посоха', bone: 'socket_hand_R', kind: 'loft', sides: 6, color: '#6c472b', capJoint: false, rings: [{ t: -6.0, rx: 0.018, rz: 0.018, ox: 0, oz: 0.02 }, { t: 8.5, rx: 0.025, rz: 0.025, ox: 0, oz: 0.02 }] },
        { id: C.uidPart('orb'), label: 'Навершие посоха', bone: 'socket_hand_R', kind: 'sphere', color: '#4dabf7', radius: { x: 0.06, y: 0.075, z: 0.06 }, offset: { x: 0, y: 0.72, z: 0.02 } }
      );
    } else if (kind === 'torn_leg') {
      state.charData.symmetry = false;
      const shinR = parts.find(p => p.bone === 'shin_R');
      if (shinR) {
        shinR.label = 'Рваная штанина + голень П';
        shinR.rings = [
          { t: 0.0,  rx: 0.062, rz: 0.062, ox: 0, oz: 0, color: shinR.color },
          { t: 0.36, rx: 0.070, rz: 0.068, ox: 0.006, oz: 0, color: shinR.color },
          { t: 0.39, rx: 0.043, rz: 0.043, ox: 0, oz: 0, color: '#e9c4a6' },
          { t: 1.0,  rx: 0.036, rz: 0.036, ox: 0, oz: 0, color: '#e9c4a6' }
        ];
        state.selectedPartId = shinR.id;
      }
    }
    markChar3DDirty();
    renderRightPanels();
    renderViewport();
  }

  // ---- Инспектор 3: Редактор Позы и Живой IK рук/ног ----
  function renderPoseAndIkInspector(props) {
    if (els.propsTitle) els.propsTitle.textContent = '3. Редактор Позы и Живой IK';
    const bId = state.selectedBoneId || 'chest';
    const pose = state.charData.activePose;
    const rot = (pose.bones && pose.bones[bId]) || { rx: 0, ry: 0, rz: 0 };

    const poseBtns = (state.charData.poses || []).map((p, idx) =>
      '<button type="button" class="stage-btn-sm" data-c3d-pose="' + idx + '">' + escapeHtml(p.label) + '</button>'
    ).join('');

    props.innerHTML =
      '<div class="pgroup">' +
        '<div class="pgroup-title">Живой 3D IK конечностей</div>' +
        '<label class="c3d-check-row"><input type="checkbox" id="c3d-ik-on" ' + (state.ikEnabled ? 'checked' : '') + '> <span>Включить IK-ромбы на кистях и стопах</span></label>' +
        '<label class="c3d-check-row"><input type="checkbox" id="c3d-pin-feet" ' + (state.pinFeetToGround ? 'checked' : '') + '> <span>Закрепить стопы на полу (тяните зелёный квадрат Таза для приседа!)</span></label>' +
        '<div class="stage-help-note">Тяните <b>красные ромбы</b> на кистях и стопах в любом из 4 окон — локти и колени сгибаются сами! Фиолетовые точки — направление локтя/колена.</div>' +
      '</div>' +

      '<div class="pgroup">' +
        '<div class="pgroup-title">Поворот шарнира: ' + escapeHtml(bId) + '</div>' +
        '<div class="prow"><label>X (сгиб / наклон °)</label><input type="range" min="-160" max="160" step="1" data-c3d-rot="rx" value="' + (rot.rx || 0) + '"><span class="c3d-val" data-c3d-rot-lbl="rx">' + Math.round(rot.rx || 0) + '°</span></div>' +
        '<div class="prow"><label>Y (скрутка / пов °)</label><input type="range" min="-160" max="160" step="1" data-c3d-rot="ry" value="' + (rot.ry || 0) + '"><span class="c3d-val" data-c3d-rot-lbl="ry">' + Math.round(rot.ry || 0) + '°</span></div>' +
        '<div class="prow"><label>Z (отведение °)</label><input type="range" min="-160" max="160" step="1" data-c3d-rot="rz" value="' + (rot.rz || 0) + '"><span class="c3d-val" data-c3d-rot-lbl="rz">' + Math.round(rot.rz || 0) + '°</span></div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" id="c3d-bone-zero">Сбросить сустав</button>' +
          '<button type="button" class="stage-btn-sm" id="c3d-pose-mirror">Отзеркалить L ↔ R</button>' +
        '</div>' +
      '</div>' +

      '<div class="pgroup">' +
        '<div class="pgroup-title">Библиотека поз</div>' +
        '<div class="c3d-pose-list">' + poseBtns + '</div>' +
        '<div class="stage-btn-row" style="margin-top:6px">' +
          '<button type="button" class="stage-btn-sm primary-violet" id="c3d-save-pose">+ Сохранить текущую позу</button>' +
        '</div>' +
      '</div>';

    props.querySelector('#c3d-ik-on').addEventListener('change', (e) => {
      state.ikEnabled = !!e.target.checked;
      syncIkTargetsFromCurrentPose();
      renderViewport();
    });

    props.querySelector('#c3d-pin-feet').addEventListener('change', (e) => {
      state.pinFeetToGround = !!e.target.checked;
    });

    props.querySelectorAll('[data-c3d-rot]').forEach(sl => {
      sl.addEventListener('input', () => {
        const ax = sl.dataset.c3dRot;
        const v = parseFloat(sl.value) || 0;
        if (!pose.bones) pose.bones = {};
        if (!pose.bones[bId]) pose.bones[bId] = { rx: 0, ry: 0, rz: 0 };
        pose.bones[bId][ax] = v;
        const lbl = props.querySelector('[data-c3d-rot-lbl="' + ax + '"]');
        if (lbl) lbl.textContent = Math.round(v) + '°';
        syncIkTargetsFromCurrentPose();
        markChar3DDirty();
        renderViewport();
      });
    });

    props.querySelector('#c3d-bone-zero').addEventListener('click', () => {
      if (pose.bones) delete pose.bones[bId];
      syncIkTargetsFromCurrentPose();
      markChar3DDirty();
      renderRightPanels();
      renderViewport();
    });

    props.querySelector('#c3d-pose-mirror').addEventListener('click', () => {
      const oldB = pose.bones || {};
      const nextB = {};
      for (const k of Object.keys(oldB)) {
        const r = oldB[k];
        if (k.endsWith('_L')) nextB[k.slice(0, -2) + '_R'] = { rx: r.rx, ry: -r.ry, rz: -r.rz };
        else if (k.endsWith('_R')) nextB[k.slice(0, -2) + '_L'] = { rx: r.rx, ry: -r.ry, rz: -r.rz };
        else nextB[k] = { rx: r.rx, ry: -r.ry, rz: -r.rz };
      }
      pose.bones = nextB;
      syncIkTargetsFromCurrentPose();
      markChar3DDirty();
      renderRightPanels();
      renderViewport();
    });

    props.querySelectorAll('[data-c3d-pose]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = state.charData.poses[parseInt(btn.dataset.c3dPose, 10)];
        if (!p) return;
        state.charData.activePose = C.clonePose(p.pose);
        syncIkTargetsFromCurrentPose();
        markChar3DDirty();
        renderRightPanels();
        renderViewport();
      });
    });

    props.querySelector('#c3d-save-pose').addEventListener('click', () => {
      const label = prompt('Название позы:', 'Поза ' + ((state.charData.poses || []).length + 1));
      if (!label) return;
      state.charData.poses.push({ id: C.uidPart('pose'), label, pose: C.clonePose(state.charData.activePose) });
      markChar3DDirty();
      renderRightPanels();
    });
  }

  // ---- Инспектор 4: Анимации, ключи поз и кривые интерполяции (разгон / плавный возврат / перехлёст) ----
  function renderAnimAndEasingInspector(props) {
    if (els.propsTitle) els.propsTitle.textContent = '4. Анимация и Кривые Переходов';
    const clip = getActiveClip();
    if (!clip) return;

    const kIdx = Math.max(0, Math.min(clip.keyframes.length - 1, state.selectedKeyIdx));
    const kf = clip.keyframes[kIdx];
    const curEasing = (kf && kf.easing) || 'easeInOut';

    const easingOpts = Object.keys(C.EASING_DEFS).map(k =>
      '<option value="' + k + '"' + (k === curEasing ? 'selected' : '') + '>' + escapeHtml(C.EASING_DEFS[k].label) + '</option>'
    ).join('');

    props.innerHTML =
      '<div class="pgroup">' +
        '<div class="pgroup-title">Клип: ' + escapeHtml(clip.name) + '</div>' +
        '<div class="prow"><label>Название</label><input type="text" id="c3d-clip-name" value="' + escapeHtml(clip.name) + '"></div>' +
        '<div class="prow"><label>Длительность (с)</label><input type="number" step="0.1" min="0.2" max="20" id="c3d-clip-dur" value="' + clip.duration.toFixed(2) + '"></div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm primary-violet" id="c3d-new-clip">+ Новый клип</button>' +
          '<button type="button" class="stage-btn-sm" id="c3d-demo-recoil" title="Создать/открыть клип запрокидывания головы с нарастанием скорости и плавным возвратом">Эффект: Запрокидывание головы</button>' +
        '</div>' +
      '</div>' +

      '<div class="pgroup">' +
        '<div class="pgroup-title">Переход к Ключу #' + (kIdx + 1) + ' (t = ' + (kf ? kf.time.toFixed(2) : '0.00') + ' с)</div>' +
        '<div class="prow"><label>Время ключа (с)</label><input type="number" step="0.05" min="0" id="c3d-kf-time" value="' + (kf ? kf.time.toFixed(2) : '0') + '"></div>' +
        '<div class="prow"><label>Кривая входа</label><select id="c3d-kf-easing">' + easingOpts + '</select></div>' +
        '<canvas id="c3d-easing-preview" width="230" height="72" class="c3d-easing-canvas"></canvas>' +
        '<div class="stage-help-note">Для эффекта <b>«рывок с нарастанием скорости → плавный возврат»</b> ставьте на пиковый ключ <b>Нарастание скорости (easeIn)</b>, а на возвратный ключ — <b>Плавное торможение (easeOut)</b>!</div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" id="c3d-apply-pose-to-kf">Вставить позу из библиотеки…</button>' +
          (clip.keyframes.length > 1 ? '<button type="button" class="stage-btn-sm" id="c3d-del-kf" style="color:#ff8787">Удалить ключ</button>' : '') +
        '</div>' +
      '</div>' +

      '<div class="pgroup">' +
        '<div class="pgroup-title">Экспорт для твоих игр (TD / Выживач / Шутер)</div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm primary-violet" id="c3d-exp-json">Скачать .char3d.json</button>' +
          '<button type="button" class="stage-btn-sm" id="c3d-exp-glb">Экспорт .GLB</button>' +
        '</div>' +
      '</div>';

    drawEasingCurvePreview(props.querySelector('#c3d-easing-preview'), curEasing);

    props.querySelector('#c3d-clip-name').addEventListener('input', (e) => {
      clip.name = e.target.value;
      markChar3DDirty();
      renderAnimTimelineBar();
    });

    props.querySelector('#c3d-clip-dur').addEventListener('change', (e) => {
      clip.duration = Math.max(0.2, parseFloat(e.target.value) || 1.2);
      markChar3DDirty();
      renderAnimTimelineBar();
    });

    props.querySelector('#c3d-new-clip').addEventListener('click', () => {
      const basePose = C.clonePose(getDisplayedPose());
      state.charData.animations.push({
        id: C.uidPart('anim'),
        name: 'Новая анимация ' + (state.charData.animations.length + 1),
        duration: 1.2,
        loop: true,
        keyframes: [
          { time: 0.0, easing: 'easeInOut', pose: C.clonePose(basePose) },
          { time: 1.2, easing: 'easeInOut', pose: C.clonePose(basePose) }
        ]
      });
      state.animClipIdx = state.charData.animations.length - 1;
      state.animTime = 0;
      state.selectedKeyIdx = 0;
      markChar3DDirty();
      renderAllUI();
    });

    props.querySelector('#c3d-demo-recoil').addEventListener('click', () => {
      const idx = state.charData.animations.findIndex(a => a.id === 'head_recoil');
      if (idx >= 0) state.animClipIdx = idx;
      state.animTime = 0;
      state.selectedKeyIdx = 1;
      renderAllUI();
      startAnimPlayback();
    });

    props.querySelector('#c3d-kf-time').addEventListener('change', (e) => {
      if (!kf) return;
      kf.time = Math.max(0, Math.min(clip.duration, parseFloat(e.target.value) || 0));
      clip.keyframes.sort((a, b) => a.time - b.time);
      state.selectedKeyIdx = clip.keyframes.indexOf(kf);
      state.animTime = kf.time;
      markChar3DDirty();
      renderAnimTimelineBar();
      renderViewport();
    });

    props.querySelector('#c3d-kf-easing').addEventListener('change', (e) => {
      if (!kf) return;
      kf.easing = e.target.value;
      drawEasingCurvePreview(props.querySelector('#c3d-easing-preview'), kf.easing);
      markChar3DDirty();
      renderAnimTimelineBar();
    });

    props.querySelector('#c3d-apply-pose-to-kf').addEventListener('click', () => {
      if (!kf || !state.charData.poses.length) return;
      const names = state.charData.poses.map((p, i) => (i + 1) + ': ' + p.label).join('\n');
      const ans = prompt('Номер позы для вставки в этот ключ:\n' + names, '1');
      const pick = state.charData.poses[(parseInt(ans, 10) || 1) - 1];
      if (pick) {
        kf.pose = C.clonePose(pick.pose);
        state.animTime = kf.time;
        markChar3DDirty();
        renderViewport();
      }
    });

    const delKfBtn = props.querySelector('#c3d-del-kf');
    if (delKfBtn) {
      delKfBtn.addEventListener('click', () => {
        if (clip.keyframes.length <= 1) return;
        clip.keyframes.splice(kIdx, 1);
        state.selectedKeyIdx = Math.max(0, kIdx - 1);
        markChar3DDirty();
        renderAllUI();
      });
    }

    props.querySelector('#c3d-exp-json').addEventListener('click', exportCurrentCharJson);
    props.querySelector('#c3d-exp-glb').addEventListener('click', exportCurrentCharGlb);
  }

  function drawEasingCurvePreview(cv, easingName) {
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#10141e';
    ctx.fillRect(0, 0, w, h);

    const padX = 14, padY = 14;
    const gw = w - padX * 2, gh = h - padY * 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.strokeRect(padX, padY, gw, gh);

    ctx.strokeStyle = '#9775fa';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const v = C.evalEasing(easingName, t);
      const x = padX + t * gw;
      const y = padY + (1 - v) * gh;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function syncInspectorInputsLive() {
    const props = els.props;
    if (!props || !state.charData) return;
    if (state.subMode === 'rig') {
      const j = state.charData.jointsRest[state.selectedBoneId];
      if (!j) return;
      for (const ax of ['x', 'y', 'z']) {
        const inp = props.querySelector('[data-c3d-jpos="' + ax + '"]');
        if (inp && document.activeElement !== inp) inp.value = j[ax].toFixed(3);
      }
    } else if (state.subMode === 'pose') {
      const r = (state.charData.activePose.bones && state.charData.activePose.bones[state.selectedBoneId]) || { rx: 0, ry: 0, rz: 0 };
      for (const ax of ['rx', 'ry', 'rz']) {
        const sl = props.querySelector('[data-c3d-rot="' + ax + '"]');
        const lb = props.querySelector('[data-c3d-rot-lbl="' + ax + '"]');
        if (sl && document.activeElement !== sl) sl.value = String(Math.round(r[ax] || 0));
        if (lb) lb.textContent = Math.round(r[ax] || 0) + '°';
      }
    } else if (state.subMode === 'mesh') {
      const part = state.charData.parts.find(p => p.id === state.selectedPartId);
      const r = part && part.rings && part.rings[state.selectedRingIdx];
      if (r) {
        for (const k of ['t', 'rx', 'rz']) {
          const inp = props.querySelector('[data-c3d-ring="' + k + '"]');
          if (inp && document.activeElement !== inp) inp.value = r[k].toFixed(k === 't' ? 2 : 3);
        }
      }
    }
  }

  // -------------------- Нижняя панель 3D-Таймлайна и быстрого управления --------------------
  function renderAnimTimelineBar() {
    const bar = document.getElementById('char3d-bar');
    if (!bar || !state.charData) return;

    const clipSel = document.getElementById('char3d-clip-select');
    if (clipSel) {
      clipSel.innerHTML = (state.charData.animations || []).map((a, idx) =>
        '<option value="' + idx + '"' + (idx === state.animClipIdx ? ' selected' : '') + '>' + escapeHtml(a.name) + '</option>'
      ).join('');
    }

    const playIcon = document.getElementById('char3d-play-icon');
    if (playIcon) playIcon.textContent = state.playing ? 'pause' : 'play_arrow';

    drawTimelineTrackCanvas();
  }

  function updateTimelineScrubberLive() {
    drawTimelineTrackCanvas();
    const tc = document.getElementById('char3d-time-label');
    const clip = getActiveClip();
    if (tc && clip) {
      tc.textContent = state.animTime.toFixed(2) + ' / ' + clip.duration.toFixed(2) + ' с';
    }
  }

  function drawTimelineTrackCanvas() {
    const cv = document.getElementById('char3d-tl-canvas');
    const clip = getActiveClip();
    if (!cv || !clip) return;

    const w = Math.max(260, cv.clientWidth || 520);
    const h = 34;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#11151f';
    ctx.fillRect(0, 0, w, h);

    const pad = 14;
    const tw = w - pad * 2;
    const dur = Math.max(0.1, clip.duration || 1.2);

    // Деления по 0.1 с
    const steps = Math.min(60, Math.round(dur * 10));
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= steps; i++) {
      const x = pad + (i / steps) * tw;
      ctx.beginPath();
      ctx.moveTo(x, i % 5 === 0 ? 4 : 10);
      ctx.lineTo(x, 16);
      ctx.stroke();
    }

    // Полоса переходов между ключами с подписями кривых
    const keys = clip.keyframes || [];
    for (let i = 0; i < keys.length - 1; i++) {
      const x0 = pad + (keys[i].time / dur) * tw;
      const x1 = pad + (keys[i + 1].time / dur) * tw;
      const ez = keys[i + 1].easing || 'easeInOut';
      ctx.fillStyle = ez === 'easeIn' ? 'rgba(255, 107, 107, 0.22)'
        : (ez === 'easeOut' ? 'rgba(56, 217, 169, 0.22)' : 'rgba(151, 117, 250, 0.20)');
      ctx.fillRect(x0, 17, Math.max(2, x1 - x0), 12);
      if (x1 - x0 > 46) {
        ctx.fillStyle = '#ced4da';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(ez, (x0 + x1) * 0.5 - 18, 26);
      }
    }

    // Ключевые кадры (ромбы)
    for (let i = 0; i < keys.length; i++) {
      const kx = pad + (keys[i].time / dur) * tw;
      const isSel = i === state.selectedKeyIdx;
      ctx.save();
      ctx.translate(kx, 22);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = isSel ? '#ffd43b' : '#b197fc';
      ctx.strokeStyle = '#0b0e14';
      ctx.lineWidth = 1.4;
      ctx.fillRect(-5, -5, 10, 10);
      ctx.strokeRect(-5, -5, 10, 10);
      ctx.restore();
    }

    // Курсор времени (Playhead)
    const px = pad + Math.min(1, Math.max(0, state.animTime / dur)) * tw;
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();

    const tc = document.getElementById('char3d-time-label');
    if (tc) tc.textContent = state.animTime.toFixed(2) + ' / ' + dur.toFixed(2) + ' с';
  }

  function updateChar3DReadout() {
    if (!els.selSize || !state.charData) return;
    els.selSize.textContent =
      'Рост ' + (state.charData.heightM || 1.8).toFixed(2) + 'м · мешей ' + state.charData.parts.length;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // -------------------- Привязка событий DOM --------------------
  function bindDomEvents() {
    const canvas = document.getElementById('char3d-canvas');
    if (canvas) {
      canvas.addEventListener('mousedown', onCanvasMouseDown);
      canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
    }
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);

    // Переключатели подрежимов (1..4) и видов проекции (Quad / 3D / Front / Side / Top)
    $$('[data-c3d-submode]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.playing && btn.dataset.c3dSubmode !== 'anim') stopAnimPlayback();
        state.subMode = btn.dataset.c3dSubmode;
        if (state.subMode === 'pose') syncIkTargetsFromCurrentPose();
        renderAllUI();
      });
    });

    $$('[data-c3d-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.viewLayout = btn.dataset.c3dView;
        if (state.viewLayout !== 'quad') state.activePane = state.viewLayout;
        renderSubModeTabs();
        renderViewport();
      });
    });

    const gridBtn = document.getElementById('btn-c3d-grid');
    if (gridBtn) {
      gridBtn.addEventListener('click', () => {
        state.showMetricGrid = !state.showMetricGrid;
        state.showHeightRuler = state.showMetricGrid;
        renderSubModeTabs();
        renderViewport();
      });
    }

    const skelBtn = document.getElementById('btn-c3d-skel');
    if (skelBtn) {
      skelBtn.addEventListener('click', () => {
        state.showSkeletonOverlay = !state.showSkeletonOverlay;
        renderSubModeTabs();
        renderViewport();
      });
    }

    const wireBtn = document.getElementById('btn-c3d-wire');
    if (wireBtn) {
      wireBtn.addEventListener('click', () => {
        state.showWireframe = !state.showWireframe;
        renderSubModeTabs();
        renderViewport();
      });
    }

    // Импорт пользовательского .glb в слот Женской или Мужской базы
    const glbInput = document.getElementById('char3d-glb-input');
    if (glbInput) {
      glbInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const buf = await file.arrayBuffer();
          const parsed = C.parseGlbArrayBuffer(buf, file.name);
          const g = state.pendingGlbGender || 'female';
          parsed.gender = g;
          parsed.visible = true;
          parsed.calibrated = true;
          parsed.targetHeight = g === 'female' ? 1.68 : 1.80;
          state.refSlots[g] = parsed;
          syncRefOffsets();
          renderRightPanels();
          renderViewport();
          setHint('Загружен и откалиброван ' + file.name + ' (сырой рост ' + parsed.rawHeight.toFixed(2) + ' -> ' + parsed.targetHeight.toFixed(2) + 'м)', 3200);
        } catch (err) {
          setHint('Ошибка чтения .glb: ' + err.message, 3400);
        }
      });
    }

    // Импорт сохранённого .char3d.json
    const jsonInput = document.getElementById('char3d-json-input');
    if (jsonInput) {
      jsonInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const txt = await file.text();
          const obj = JSON.parse(txt);
          applyLoadedCharacterData(obj, true);
          setHint('Импортирован 3D-персонаж из ' + file.name, 2400);
        } catch (err) {
          setHint('Ошибка чтения JSON: ' + err.message, 3200);
        }
      });
    }

    const openBtn = document.getElementById('btn-char3d-open');
    if (openBtn) {
      openBtn.addEventListener('click', async () => {
        const list = await fetchChar3DList();
        const ans = prompt('Открыть 3D-персонажа (введите имя):\nДоступны: ' + list.join(', '), state.currentName);
        if (ans && ans.trim()) openChar3DByName(ans.trim());
      });
    }

    const impBtn = document.getElementById('btn-char3d-import-json');
    if (impBtn && jsonInput) {
      impBtn.addEventListener('click', () => { jsonInput.value = ''; jsonInput.click(); });
    }

    const expGlbBtn = document.getElementById('btn-char3d-export-glb');
    if (expGlbBtn) expGlbBtn.addEventListener('click', exportCurrentCharGlb);

    const nameInp = document.getElementById('char3d-name');
    if (nameInp) {
      nameInp.addEventListener('change', () => {
        const cleaned = nameInp.value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
        if (cleaned) {
          state.currentName = cleaned;
          state.charData.name = cleaned;
          nameInp.value = cleaned;
          markChar3DDirty();
        }
      });
    }

    // Нижняя панель 3D-анимации
    const playBtn = document.getElementById('char3d-play-btn');
    if (playBtn) {
      playBtn.addEventListener('click', () => {
        if (state.playing) {
          stopAnimPlayback();
          renderAnimTimelineBar();
        } else {
          startAnimPlayback();
        }
      });
    }

    const clipSel = document.getElementById('char3d-clip-select');
    if (clipSel) {
      clipSel.addEventListener('change', () => {
        state.animClipIdx = parseInt(clipSel.value, 10) || 0;
        state.animTime = 0;
        state.selectedKeyIdx = 0;
        if (state.subMode !== 'anim') state.subMode = 'anim';
        renderAllUI();
      });
    }

    const addKeyBtn = document.getElementById('char3d-add-key');
    if (addKeyBtn) {
      addKeyBtn.addEventListener('click', () => {
        const clip = getActiveClip();
        if (!clip) return;
        const curPose = C.clonePose(getDisplayedPose());
        const t = Math.round(state.animTime * 100) / 100;
        const existing = clip.keyframes.findIndex(k => Math.abs(k.time - t) < 0.02);
        if (existing >= 0) {
          clip.keyframes[existing].pose = curPose;
          state.selectedKeyIdx = existing;
        } else {
          clip.keyframes.push({ time: t, easing: 'easeInOut', pose: curPose });
          clip.keyframes.sort((a, b) => a.time - b.time);
          state.selectedKeyIdx = clip.keyframes.findIndex(k => Math.abs(k.time - t) < 0.001);
        }
        state.subMode = 'anim';
        markChar3DDirty();
        renderAllUI();
        setHint('Записан ключевой кадр 3D-позы на ' + t.toFixed(2) + ' с', 1800);
      });
    }

    const speedSl = document.getElementById('char3d-speed-slider');
    const speedVal = document.getElementById('char3d-speed-val');
    if (speedSl) {
      speedSl.addEventListener('input', () => {
        state.animSpeed = (parseInt(speedSl.value, 10) || 100) / 100;
        if (speedVal) speedVal.textContent = state.animSpeed.toFixed(1) + '×';
      });
    }

    const tlCanvas = document.getElementById('char3d-tl-canvas');
    if (tlCanvas) {
      const scrubAt = (e, clickSelectKey) => {
        const clip = getActiveClip();
        if (!clip) return;
        const rect = tlCanvas.getBoundingClientRect();
        const pad = 14;
        const tw = Math.max(10, rect.width - pad * 2);
        const lx = e.clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, (lx - pad) / tw));
        const t = ratio * (clip.duration || 1.2);
        stopAnimPlayback();
        state.animTime = t;
        if (state.subMode !== 'anim') state.subMode = 'anim';

        if (clickSelectKey && clip.keyframes) {
          for (let i = 0; i < clip.keyframes.length; i++) {
            const kx = pad + (clip.keyframes[i].time / clip.duration) * tw;
            if (Math.abs(lx - kx) <= 9) {
              state.selectedKeyIdx = i;
              state.animTime = clip.keyframes[i].time;
              break;
            }
          }
        }
        state.charData.activePose = C.sampleAnimationPose(clip, state.animTime);
        renderAllUI();
      };

      let scrubbing = false;
      tlCanvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        scrubbing = true;
        scrubAt(e, true);
      });
      window.addEventListener('mousemove', (e) => {
        if (scrubbing) scrubAt(e, false);
      });
      window.addEventListener('mouseup', () => { scrubbing = false; });
    }
  }

  return {
    state,
    init,
    loadArchetype,
    openChar3DByName,
    saveCurrentChar3D,
    exportCurrentCharGlb,
    exportCurrentCharJson,
    fitChar3DCamera,
    stopAnimPlayback,
    renderAllUI,
    renderViewport
  };
})();
