'use strict';

// ============================================================
//  char3d-core.js — Ядро 3D-персонажей (v0.7.0)
//  - Векторная/матричная/кватернионная 3D-математика (SLERP, без зависимостей)
//  - Шарнирный скелет (Humanoid + цепочка плаща + сокеты оружия/головных уборов)
//  - Двухкостный аналитический 3D IK (руки и ноги + Pole Vector направления сгиба)
//  - Процедурные примитивы по кольцам (Loft Rings) + прямое редактирование вершин
//  - Кривые интерполяции переходов между позами (разгон, плавный возврат, рывок+возврат, перехлёст)
//  - Импорт и экспорт бинарного .glb (glTF 2.0) + игровой формат RAGDOLL_3D v1 JSON
//  - 4 готовых архетипа: Король в плаще (TD), Маг с посохом, Зомби в рваном костюме, База Муж/Жен
// ============================================================

const Char3DCore = (() => {
  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;

  // -------------------- 3D Векторы --------------------
  function v3(x = 0, y = 0, z = 0) { return { x: +x || 0, y: +y || 0, z: +z || 0 }; }
  function v3Clone(a) { return { x: a.x, y: a.y, z: a.z }; }
  function v3Add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
  function v3Sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function v3Scale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
  function v3Lerp(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  }
  function v3Dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function v3Cross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  }
  function v3Len(a) { return Math.hypot(a.x, a.y, a.z); }
  function v3Norm(a) {
    const l = Math.hypot(a.x, a.y, a.z);
    return l > 1e-8 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 1, z: 0 };
  }

  // -------------------- Кватернионы (x, y, z, w) --------------------
  function qIdent() { return { x: 0, y: 0, z: 0, w: 1 }; }

  function qNorm(q) {
    const l = Math.hypot(q.x, q.y, q.z, q.w);
    return l > 1e-8 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : qIdent();
  }

  function qMul(a, b) {
    return {
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
    };
  }

  function qConj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }

  function qRotateVec(q, v) {
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return {
      x: v.x + q.w * tx + (q.y * tz - q.z * ty),
      y: v.y + q.w * ty + (q.z * tx - q.x * tz),
      z: v.z + q.w * tz + (q.x * ty - q.y * tx)
    };
  }

  function qFromAxisAngle(axis, rad) {
    const half = rad * 0.5;
    const s = Math.sin(half);
    const n = v3Norm(axis);
    return qNorm({ x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(half) });
  }

  function qFromUnitVectors(from, to) {
    const f = v3Norm(from);
    const t = v3Norm(to);
    let r = v3Dot(f, t) + 1;
    if (r < 1e-6) {
      r = 0;
      if (Math.abs(f.x) > Math.abs(f.z)) return qNorm({ x: -f.y, y: f.x, z: 0, w: r });
      return qNorm({ x: 0, y: -f.z, z: f.y, w: r });
    }
    const c = v3Cross(f, t);
    return qNorm({ x: c.x, y: c.y, z: c.z, w: r });
  }

  // Порядок Эйлера YXZ (удобный для персонажей: Y=поворот корпуса/головы, X=наклон/сгиб вперёд-назад, Z=боковой наклон)
  function qFromEulerDeg(rxDeg = 0, ryDeg = 0, rzDeg = 0) {
    const x = (rxDeg || 0) * DEG2RAD * 0.5;
    const y = (ryDeg || 0) * DEG2RAD * 0.5;
    const z = (rzDeg || 0) * DEG2RAD * 0.5;
    const cx = Math.cos(x), sx = Math.sin(x);
    const cy = Math.cos(y), sy = Math.sin(y);
    const cz = Math.cos(z), sz = Math.sin(z);
    return qNorm({
      x: cy * sx * cz + sy * cx * sz,
      y: sy * cx * cz - cy * sx * sz,
      z: cy * cx * sz - sy * sx * cz,
      w: cy * cx * cz + sy * sx * sz
    });
  }

  function qToEulerDeg(qIn) {
    const q = qNorm(qIn);
    // Матричные элементы для YXZ
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    const m11 = 1 - (yy + zz);
    const m12 = xy - wz;
    const m13 = xz + wy;
    const m21 = xy + wz;
    const m22 = 1 - (xx + zz);
    const m23 = yz - wx;
    const m31 = xz - wy;
    const m33 = 1 - (xx + yy);

    const sinX = Math.max(-1, Math.min(1, -m23));
    const rx = Math.asin(sinX);
    let ry, rz;
    if (Math.abs(m23) < 0.99999) {
      ry = Math.atan2(m13, m33);
      rz = Math.atan2(m21, m22);
    } else {
      ry = Math.atan2(-m31, m11);
      rz = 0;
    }
    return {
      rx: Math.round(rx * RAD2DEG * 100) / 100,
      ry: Math.round(ry * RAD2DEG * 100) / 100,
      rz: Math.round(rz * RAD2DEG * 100) / 100
    };
  }

  function qSlerp(qa, qb, t) {
    let bx = qb.x, by = qb.y, bz = qb.z, bw = qb.w;
    let cosHalf = qa.x * bx + qa.y * by + qa.z * bz + qa.w * bw;
    if (cosHalf < 0) {
      cosHalf = -cosHalf;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    if (cosHalf >= 0.9995) {
      return qNorm({
        x: qa.x + (bx - qa.x) * t,
        y: qa.y + (by - qa.y) * t,
        z: qa.z + (bz - qa.z) * t,
        w: qa.w + (bw - qa.w) * t
      });
    }
    const halfAngle = Math.acos(Math.min(1, cosHalf));
    const sinHalf = Math.sqrt(1 - cosHalf * cosHalf);
    const ra = Math.sin((1 - t) * halfAngle) / sinHalf;
    const rb = Math.sin(t * halfAngle) / sinHalf;
    return {
      x: qa.x * ra + bx * rb,
      y: qa.y * ra + by * rb,
      z: qa.z * ra + bz * rb,
      w: qa.w * ra + bw * rb
    };
  }

  // -------------------- Кривые интерполяции переходов между позами --------------------
  const EASING_DEFS = {
    linear: {
      label: 'Линейно (равномерно)',
      fn: (t) => t
    },
    easeIn: {
      label: 'Нарастание скорости (разгон)',
      fn: (t) => t * t * t
    },
    easeOut: {
      label: 'Плавное торможение (мягкая доводка)',
      fn: (t) => 1 - Math.pow(1 - t, 3)
    },
    easeInOut: {
      label: 'Плавный старт и возврат (S-кривая)',
      fn: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    },
    overshoot: {
      label: 'Инерция / перехлёст (живой удар/плащ)',
      fn: (t) => {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
      }
    },
    anticipation: {
      label: 'Предварительный замах → рывок',
      fn: (t) => {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return c3 * t * t * t - c1 * t * t;
      }
    },
    expediteOut: {
      label: 'Резкий выстрел → долгий плавный возврат',
      fn: (t) => (t <= 0 ? 0 : (t >= 1 ? 1 : 1 - Math.pow(2, -8 * t)))
    }
  };

  function evalEasing(name, rawT) {
    const t = Math.max(0, Math.min(1, rawT));
    const def = EASING_DEFS[name] || EASING_DEFS.easeInOut;
    return def.fn(t);
  }

  // -------------------- Стандартный шарнирный скелет (Humanoid + Плащ + Сокеты) --------------------
  // Рост по умолчанию: 1.80 м (Муж) или 1.68 м (Жен), стопы стоят на Y = 0
  function createDefaultJointPositions(heightM = 1.80, feminine = false) {
    const h = heightM;
    const shW = feminine ? h * 0.098 : h * 0.118; // полуширина плеч
    const hipW = feminine ? h * 0.058 : h * 0.054; // полуширина тазобедренных шарниров
    return {
      pelvis:       v3(0,      h * 0.53,  0),
      spine:        v3(0,      h * 0.63,  0),
      chest:        v3(0,      h * 0.74,  0),
      neck:         v3(0,      h * 0.84,  0),
      head:         v3(0,      h * 0.88,  0),
      headTop:      v3(0,      h * 1.00,  0),

      clavicle_L:   v3(shW * 0.35, h * 0.81, 0),
      upperArm_L:   v3(shW,        h * 0.80, 0),
      forearm_L:    v3(shW + h * 0.155, h * 0.80, -0.01),
      hand_L:       v3(shW + h * 0.295, h * 0.80,  0.00),

      clavicle_R:   v3(-shW * 0.35, h * 0.81, 0),
      upperArm_R:   v3(-shW,        h * 0.80, 0),
      forearm_R:    v3(-(shW + h * 0.155), h * 0.80, -0.01),
      hand_R:       v3(-(shW + h * 0.295), h * 0.80,  0.00),

      thigh_L:      v3(hipW,   h * 0.51,  0),
      shin_L:       v3(hipW,   h * 0.275, 0.015),
      foot_L:       v3(hipW,   h * 0.045, 0),
      toe_L:        v3(hipW,   0.00,      h * 0.075),

      thigh_R:      v3(-hipW,  h * 0.51,  0),
      shin_R:       v3(-hipW,  h * 0.275, 0.015),
      foot_R:       v3(-hipW,  h * 0.045, 0),
      toe_R:        v3(-hipW,  0.00,      h * 0.075),

      // Цепочка шарниров плаща за спиной (Z < 0 — спина, Z > 0 — лицо)
      cape_1:       v3(0,      h * 0.81, -h * 0.055),
      cape_2:       v3(0,      h * 0.56, -h * 0.075),
      cape_3:       v3(0,      h * 0.28, -h * 0.095),

      // Сокеты под головные уборы и предметы в руках
      socket_head:   v3(0,      h * 0.965, 0),
      socket_hand_L: v3(shW + h * 0.33, h * 0.80, 0.02),
      socket_hand_R: v3(-(shW + h * 0.33), h * 0.80, 0.02)
    };
  }

  const BONE_HIERARCHY = [
    { id: 'pelvis',        parent: null,         label: 'Таз (Корень)',      endJoint: 'spine',      mirror: null,         group: 'torso' },
    { id: 'spine',         parent: 'pelvis',     label: 'Поясница',          endJoint: 'chest',      mirror: null,         group: 'torso' },
    { id: 'chest',         parent: 'spine',      label: 'Грудь',             endJoint: 'neck',       mirror: null,         group: 'torso' },
    { id: 'neck',          parent: 'chest',      label: 'Шея',               endJoint: 'head',       mirror: null,         group: 'torso' },
    { id: 'head',          parent: 'neck',       label: 'Голова',            endJoint: 'headTop',    mirror: null,         group: 'torso' },

    { id: 'clavicle_L',    parent: 'chest',      label: 'Ключица Л',         endJoint: 'upperArm_L', mirror: 'clavicle_R', group: 'arm_L' },
    { id: 'upperArm_L',    parent: 'clavicle_L', label: 'Плечо Л',           endJoint: 'forearm_L',  mirror: 'upperArm_R', group: 'arm_L' },
    { id: 'forearm_L',     parent: 'upperArm_L', label: 'Предплечье Л',      endJoint: 'hand_L',     mirror: 'forearm_R',  group: 'arm_L' },
    { id: 'hand_L',        parent: 'forearm_L',  label: 'Кисть Л',           endJoint: 'socket_hand_L', mirror: 'hand_R',  group: 'arm_L' },

    { id: 'clavicle_R',    parent: 'chest',      label: 'Ключица П',         endJoint: 'upperArm_R', mirror: 'clavicle_L', group: 'arm_R' },
    { id: 'upperArm_R',    parent: 'clavicle_R', label: 'Плечо П',           endJoint: 'forearm_R',  mirror: 'upperArm_L', group: 'arm_R' },
    { id: 'forearm_R',     parent: 'upperArm_R', label: 'Предплечье П',      endJoint: 'hand_R',     mirror: 'forearm_L',  group: 'arm_R' },
    { id: 'hand_R',        parent: 'forearm_R',  label: 'Кисть П',           endJoint: 'socket_hand_R', mirror: 'hand_L',  group: 'arm_R' },

    { id: 'thigh_L',       parent: 'pelvis',     label: 'Бедро Л',           endJoint: 'shin_L',     mirror: 'thigh_R',    group: 'leg_L' },
    { id: 'shin_L',        parent: 'thigh_L',    label: 'Голень Л',          endJoint: 'foot_L',     mirror: 'shin_R',     group: 'leg_L' },
    { id: 'foot_L',        parent: 'shin_L',     label: 'Стопа Л',           endJoint: 'toe_L',      mirror: 'foot_R',     group: 'leg_L' },

    { id: 'thigh_R',       parent: 'pelvis',     label: 'Бедро П',           endJoint: 'shin_R',     mirror: 'thigh_L',    group: 'leg_R' },
    { id: 'shin_R',        parent: 'thigh_R',    label: 'Голень П',          endJoint: 'foot_R',     mirror: 'shin_L',     group: 'leg_R' },
    { id: 'foot_R',        parent: 'shin_R',     label: 'Стопа П',           endJoint: 'toe_R',      mirror: 'foot_L',     group: 'leg_R' },

    { id: 'cape_1',        parent: 'chest',      label: 'Плащ: верх (шарнир)', endJoint: 'cape_2',   mirror: null,         group: 'cape' },
    { id: 'cape_2',        parent: 'cape_1',     label: 'Плащ: середина',    endJoint: 'cape_3',     mirror: null,         group: 'cape' },
    { id: 'cape_3',        parent: 'cape_2',     label: 'Плащ: подол',       endJoint: null,         mirror: null,         group: 'cape' },

    { id: 'socket_head',   parent: 'head',       label: 'Сокет: Голова (шляпа/корона)', endJoint: null, mirror: null, isSocket: true, group: 'sockets' },
    { id: 'socket_hand_L', parent: 'hand_L',     label: 'Сокет: Рука Л (щит/предмет)',  endJoint: null, mirror: 'socket_hand_R', isSocket: true, group: 'sockets' },
    { id: 'socket_hand_R', parent: 'hand_R',     label: 'Сокет: Рука П (посох/топор)',  endJoint: null, mirror: 'socket_hand_L', isSocket: true, group: 'sockets' }
  ];

  const IK_CHAINS = {
    arm_L: { id: 'arm_L', label: 'IK Рука Л', upper: 'upperArm_L', lower: 'forearm_L', end: 'hand_L', defaultPole: v3( 0.30, 1.25, -0.45) },
    arm_R: { id: 'arm_R', label: 'IK Рука П', upper: 'upperArm_R', lower: 'forearm_R', end: 'hand_R', defaultPole: v3(-0.30, 1.25, -0.45) },
    leg_L: { id: 'leg_L', label: 'IK Нога Л', upper: 'thigh_L',    lower: 'shin_L',    end: 'foot_L', defaultPole: v3( 0.12, 0.55,  0.55) },
    leg_R: { id: 'leg_R', label: 'IK Нога П', upper: 'thigh_R',    lower: 'shin_R',    end: 'foot_R', defaultPole: v3(-0.12, 0.55,  0.55) }
  };

  // -------------------- Прямая кинематика (FK) скелета --------------------
  // Возвращает мировые позиции и кватернионы всех костей для переданной позы
  function evaluateSkeletonFK(jointsRest, pose) {
    const bonesOut = {};
    const rootOffset = (pose && pose.rootOffset) ? pose.rootOffset : { x: 0, y: 0, z: 0 };
    const rots = (pose && pose.bones) ? pose.bones : {};

    for (let i = 0; i < BONE_HIERARCHY.length; i++) {
      const def = BONE_HIERARCHY[i];
      const restPos = jointsRest[def.id] || v3();
      const bRot = rots[def.id] || { rx: 0, ry: 0, rz: 0 };
      const localQ = qFromEulerDeg(bRot.rx || 0, bRot.ry || 0, bRot.rz || 0);

      let worldPos, worldQ;
      if (!def.parent) {
        worldPos = v3Add(restPos, rootOffset);
        worldQ = localQ;
      } else {
        const pOut = bonesOut[def.parent];
        const pRest = jointsRest[def.parent] || v3();
        const restOffset = v3Sub(restPos, pRest);
        worldPos = v3Add(pOut.worldPos, qRotateVec(pOut.worldQ, restOffset));
        worldQ = qNorm(qMul(pOut.worldQ, localQ));
      }

      // Длина и направление кости в покое
      let restTip = null;
      if (def.endJoint && jointsRest[def.endJoint]) {
        restTip = jointsRest[def.endJoint];
      } else if (def.id === 'cape_3') {
        restTip = v3Add(restPos, v3(0, -0.22, -0.02));
      } else {
        restTip = v3Add(restPos, v3(0, 0.08, 0));
      }
      const restVec = v3Sub(restTip, restPos);
      const len = Math.max(0.02, v3Len(restVec));
      const worldTip = v3Add(worldPos, qRotateVec(worldQ, restVec));

      bonesOut[def.id] = {
        id: def.id,
        parent: def.parent,
        label: def.label,
        isSocket: !!def.isSocket,
        group: def.group,
        worldPos,
        worldTip,
        worldQ,
        localQ,
        restPos,
        restVec,
        length: len
      };
    }
    return bonesOut;
  }

  // -------------------- Двухкостный аналитический 3D IK с Pole Vector --------------------
  // Сгибает плечо+предплечье или бедро+голень к целевой точке targetWorld, направляя сустав к poleWorld
  function solveTwoBoneIK(jointsRest, pose, chainKey, targetWorld, poleWorld) {
    const ch = IK_CHAINS[chainKey];
    if (!ch) return pose;
    if (!pose.bones) pose.bones = {};

    // Сбрасываем локальные вращения двух костей цепи, чтобы узнать их чистое базовое положение от родителя
    pose.bones[ch.upper] = { rx: 0, ry: 0, rz: 0 };
    pose.bones[ch.lower] = { rx: 0, ry: 0, rz: 0 };
    const fk0 = evaluateSkeletonFK(jointsRest, pose);

    const upBone = fk0[ch.upper];
    const loBone = fk0[ch.lower];
    const endBone = fk0[ch.end];
    if (!upBone || !loBone || !endBone) return pose;

    const A = upBone.worldPos; // Плечо / Бедро
    const B0 = loBone.worldPos; // Локоть / Колено в покое
    const C0 = endBone.worldPos; // Кисть / Стопа в покое
    const parentQ = upBone.parent && fk0[upBone.parent] ? fk0[upBone.parent].worldQ : qIdent();

    const L1 = Math.max(0.02, v3Len(v3Sub(B0, A)));
    const L2 = Math.max(0.02, v3Len(v3Sub(C0, B0)));
    const maxReach = (L1 + L2) * 0.9992;
    const minReach = Math.abs(L1 - L2) + 0.005;

    const toTarget = v3Sub(targetWorld, A);
    const rawDist = v3Len(toTarget);
    const d = Math.max(minReach, Math.min(maxReach, rawDist));
    const dirAT = rawDist > 1e-6 ? v3Scale(toTarget, 1 / rawDist) : v3(0, -1, 0);

    // Проекция вектора полюса (куда смотрит локоть/колено) на плоскость, перпендикулярную оси A -> Target
    const pole = poleWorld || v3Add(A, ch.defaultPole);
    const toPole = v3Sub(pole, A);
    let bendDir = v3Sub(toPole, v3Scale(dirAT, v3Dot(toPole, dirAT)));
    if (v3Len(bendDir) < 1e-5) {
      bendDir = Math.abs(dirAT.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0);
      bendDir = v3Sub(bendDir, v3Scale(dirAT, v3Dot(bendDir, dirAT)));
    }
    bendDir = v3Norm(bendDir);

    // Теорема косинусов для положения среднего сустава B_new (локоть / колено)
    const cosAlpha = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
    const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));
    const Bnew = v3Add(A, v3Add(v3Scale(dirAT, L1 * cosAlpha), v3Scale(bendDir, L1 * sinAlpha)));
    const Cnew = v3Add(A, v3Scale(dirAT, d));

    // 1) Вычисляем мировой кватернион верхней кости (совмещаем вектор покоя A->B0 с A->Bnew + ориентация плоскости сгиба)
    const restDir1 = v3Norm(v3Sub(B0, A));
    const newDir1 = v3Norm(v3Sub(Bnew, A));
    const swing1 = qFromUnitVectors(restDir1, newDir1);
    const upperWorldQ = qNorm(qMul(swing1, upBone.worldQ));
    const upperLocalQ = qNorm(qMul(qConj(parentQ), upperWorldQ));
    pose.bones[ch.upper] = qToEulerDeg(upperLocalQ);

    // 2) Пересчитываем FK с повернутым плечом/бедром и находим локальный поворот предплечья/голени
    const fk1 = evaluateSkeletonFK(jointsRest, pose);
    const lo1 = fk1[ch.lower];
    const end1 = fk1[ch.end];
    const curDir2 = v3Norm(v3Sub(end1.worldPos, lo1.worldPos));
    const newDir2 = v3Norm(v3Sub(Cnew, Bnew));
    const swing2 = qFromUnitVectors(curDir2, newDir2);
    const lowerWorldQ = qNorm(qMul(swing2, lo1.worldQ));
    const lowerLocalQ = qNorm(qMul(qConj(fk1[ch.upper].worldQ), lowerWorldQ));
    pose.bones[ch.lower] = qToEulerDeg(lowerLocalQ);

    return pose;
  }

  // -------------------- Генератор и редактор мешей частей тела и одежды --------------------
  // Поддерживает:
  //  1) 'loft' — труба по сечениям-кольцам (рукав, штанина, торс, роба, шляпа мага, древко, корона)
  //     с опциональным шарнирным куполом в суставе (capJoint: true) и редактированием каждого кольца!
  //  2) 'cape_plate' — трапеция/пластина сегмента плаща с толщиной
  //  3) 'box' — короб/призма (щит, лезвие топора, ботинок, пряжка)
  //  4) 'sphere' — сфера/эллипсоид (голова, шарнир, навершие посоха)
  //  Плюс массив vertexOffsets: прямое смещение отдельных вершин меша в 3 проекциях!

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return [180, 190, 205];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function buildPartLocalGeometry(part, boneInfo) {
    const verts = [];
    const faces = []; // { a, b, c, color }
    const ringVertexRanges = []; // для подсветки и перетаскивания колец в редакторе

    const baseColor = part.color || '#adb5bd';
    const accentColor = part.accentColor || baseColor;
    const boneVec = boneInfo ? boneInfo.restVec : v3(0, -0.25, 0);
    const boneLen = Math.max(0.04, boneInfo ? boneInfo.length : 0.25);

    // Локальный ортонормированный базис вдоль кости (ось u = вдоль кости от 0 до boneLen)
    const axisY = v3Norm(boneVec);
    let refForward = Math.abs(axisY.z) < 0.92 ? v3(0, 0, 1) : v3(0, 1, 0);
    const axisX = v3Norm(v3Cross(axisY, refForward));
    const axisZ = v3Norm(v3Cross(axisX, axisY));

    function localAlongBone(rx, tAlong, rz) {
      const yDist = tAlong * boneLen;
      return {
        x: axisX.x * rx + axisY.x * yDist + axisZ.x * rz,
        y: axisX.y * rx + axisY.y * yDist + axisZ.y * rz,
        z: axisX.z * rx + axisY.z * yDist + axisZ.z * rz
      };
    }

    if (part.kind === 'loft' || !part.kind) {
      const sides = Math.max(4, Math.min(16, part.sides || 8));
      const rings = (Array.isArray(part.rings) && part.rings.length >= 2)
        ? part.rings
        : [
            { t: 0.0, rx: 0.06, rz: 0.06, ox: 0, oz: 0 },
            { t: 1.0, rx: 0.05, rz: 0.05, ox: 0, oz: 0 }
          ];

      // Шарнирная полусфера в точке сустава (чтобы при сгибе не было щели!)
      if (part.capJoint !== false) {
        const r0 = rings[0];
        const jRad = Math.min(r0.rx, r0.rz) * 0.92;
        const capTipIdx = verts.length;
        verts.push(localAlongBone(r0.ox || 0, (r0.t || 0) - (jRad / boneLen) * 0.85, r0.oz || 0));
        const capRingStart = verts.length;
        for (let s = 0; s < sides; s++) {
          const ang = (s / sides) * Math.PI * 2;
          const vx = (r0.ox || 0) + Math.cos(ang) * r0.rx * 0.72;
          const vz = (r0.oz || 0) + Math.sin(ang) * r0.rz * 0.72;
          verts.push(localAlongBone(vx, (r0.t || 0) - (jRad / boneLen) * 0.35, vz));
        }
        for (let s = 0; s < sides; s++) {
          const sn = (s + 1) % sides;
          faces.push({ a: capTipIdx, b: capRingStart + sn, c: capRingStart + s, color: baseColor });
        }
      }

      const ringStarts = [];
      for (let r = 0; r < rings.length; r++) {
        const rg = rings[r];
        const startIdx = verts.length;
        ringStarts.push(startIdx);
        for (let s = 0; s < sides; s++) {
          const ang = (s / sides) * Math.PI * 2;
          const vx = (rg.ox || 0) + Math.cos(ang) * Math.max(0.004, rg.rx);
          const vz = (rg.oz || 0) + Math.sin(ang) * Math.max(0.004, rg.rz);
          verts.push(localAlongBone(vx, rg.t, vz));
        }
        ringVertexRanges.push({ ringIndex: r, start: startIdx, count: sides });
      }

      // Соединяем шарнирное кольцо с первым основным кольцом
      if (part.capJoint !== false) {
        const capRingStart = 1;
        const firstMain = ringStarts[0];
        for (let s = 0; s < sides; s++) {
          const sn = (s + 1) % sides;
          faces.push({ a: capRingStart + s, b: capRingStart + sn, c: firstMain + sn, color: baseColor });
          faces.push({ a: capRingStart + s, b: firstMain + sn, c: firstMain + s, color: baseColor });
        }
      } else {
        // Плоская крышка сверху
        const cTopIdx = verts.length;
        const r0 = rings[0];
        verts.push(localAlongBone(r0.ox || 0, r0.t, r0.oz || 0));
        for (let s = 0; s < sides; s++) {
          const sn = (s + 1) % sides;
          faces.push({ a: cTopIdx, b: ringStarts[0] + sn, c: ringStarts[0] + s, color: r0.color || baseColor });
        }
      }

      // Боковые грани между кольцами
      for (let r = 0; r < rings.length - 1; r++) {
        const a0 = ringStarts[r];
        const b0 = ringStarts[r + 1];
        const col = rings[r].color || (r === rings.length - 2 ? accentColor : baseColor);
        for (let s = 0; s < sides; s++) {
          const sn = (s + 1) % sides;
          faces.push({ a: a0 + s, b: a0 + sn, c: b0 + sn, color: col });
          faces.push({ a: a0 + s, b: b0 + sn, c: b0 + s, color: col });
        }
      }

      // Нижняя крышка (если не открытый край мантии/рваной штанины или закрыта по умолчанию)
      if (!part.openBottom) {
        const rLast = rings[rings.length - 1];
        const lastStart = ringStarts[ringStarts.length - 1];
        const cBotIdx = verts.length;
        verts.push(localAlongBone(rLast.ox || 0, rLast.t, rLast.oz || 0));
        for (let s = 0; s < sides; s++) {
          const sn = (s + 1) % sides;
          faces.push({ a: cBotIdx, b: lastStart + s, c: lastStart + sn, color: rLast.color || accentColor });
        }
      }
    } else if (part.kind === 'cape_plate') {
      // Трапециевидная пластина сегмента плаща на шарнире
      const wTop = part.wTop || 0.22;
      const wBot = part.wBot || 0.28;
      const thick = part.thick || 0.018;
      const zOff = part.zOff || 0;
      const t0 = part.t0 !== undefined ? part.t0 : 0.0;
      const t1 = part.t1 !== undefined ? part.t1 : 1.02;

      const p = [
        localAlongBone(-wTop, t0, zOff + thick * 0.5),
        localAlongBone( wTop, t0, zOff + thick * 0.5),
        localAlongBone( wBot, t1, zOff + thick * 0.5),
        localAlongBone(-wBot, t1, zOff + thick * 0.5),
        localAlongBone(-wTop, t0, zOff - thick * 0.5),
        localAlongBone( wTop, t0, zOff - thick * 0.5),
        localAlongBone( wBot, t1, zOff - thick * 0.5),
        localAlongBone(-wBot, t1, zOff - thick * 0.5)
      ];
      for (const v of p) verts.push(v);
      const quads = [
        [0, 1, 2, 3, baseColor],
        [5, 4, 7, 6, accentColor],
        [4, 5, 1, 0, baseColor],
        [3, 2, 6, 7, accentColor],
        [4, 0, 3, 7, baseColor],
        [1, 5, 6, 2, baseColor]
      ];
      for (const [a, b, c, d, col] of quads) {
        faces.push({ a, b, c, color: col });
        faces.push({ a, b: c, c: d, color: col });
      }
    } else if (part.kind === 'box') {
      const sx = (part.size && part.size.x) || 0.12;
      const sy = (part.size && part.size.y) || 0.12;
      const sz = (part.size && part.size.z) || 0.12;
      const off = part.offset || { x: 0, y: 0, z: 0 };
      const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
      const raw = [
        v3(off.x - hx, off.y + hy, off.z + hz),
        v3(off.x + hx, off.y + hy, off.z + hz),
        v3(off.x + hx, off.y - hy, off.z + hz),
        v3(off.x - hx, off.y - hy, off.z + hz),
        v3(off.x - hx, off.y + hy, off.z - hz),
        v3(off.x + hx, off.y + hy, off.z - hz),
        v3(off.x + hx, off.y - hy, off.z - hz),
        v3(off.x - hx, off.y - hy, off.z - hz)
      ];
      for (const v of raw) verts.push(v);
      const quads = [
        [0, 1, 2, 3, baseColor],
        [5, 4, 7, 6, baseColor],
        [4, 5, 1, 0, accentColor],
        [3, 2, 6, 7, baseColor],
        [4, 0, 3, 7, baseColor],
        [1, 5, 6, 2, baseColor]
      ];
      for (const [a, b, c, d, col] of quads) {
        faces.push({ a, b, c, color: col });
        faces.push({ a, b: c, c: d, color: col });
      }
    } else if (part.kind === 'sphere') {
      const rx = (part.radius && part.radius.x) || 0.10;
      const ry = (part.radius && part.radius.y) || 0.12;
      const rz = (part.radius && part.radius.z) || 0.11;
      const off = part.offset || { x: 0, y: boneLen * 0.5, z: 0 };
      const stacks = 6, slices = 10;
      const topIdx = verts.length;
      verts.push(v3(off.x, off.y + ry, off.z));
      const ringIdx = [];
      for (let st = 1; st < stacks; st++) {
        const phi = (st / stacks) * Math.PI;
        const sp = Math.sin(phi), cp = Math.cos(phi);
        const start = verts.length;
        ringIdx.push(start);
        for (let sl = 0; sl < slices; sl++) {
          const th = (sl / slices) * Math.PI * 2;
          verts.push(v3(off.x + Math.cos(th) * sp * rx, off.y + cp * ry, off.z + Math.sin(th) * sp * rz));
        }
      }
      const botIdx = verts.length;
      verts.push(v3(off.x, off.y - ry, off.z));

      for (let sl = 0; sl < slices; sl++) {
        const sn = (sl + 1) % slices;
        faces.push({ a: topIdx, b: ringIdx[0] + sn, c: ringIdx[0] + sl, color: baseColor });
      }
      for (let r = 0; r < ringIdx.length - 1; r++) {
        for (let sl = 0; sl < slices; sl++) {
          const sn = (sl + 1) % slices;
          faces.push({ a: ringIdx[r] + sl, b: ringIdx[r] + sn, c: ringIdx[r + 1] + sn, color: baseColor });
          faces.push({ a: ringIdx[r] + sl, b: ringIdx[r + 1] + sn, c: ringIdx[r + 1] + sl, color: baseColor });
        }
      }
      const lastR = ringIdx[ringIdx.length - 1];
      for (let sl = 0; sl < slices; sl++) {
        const sn = (sl + 1) % slices;
        faces.push({ a: botIdx, b: lastR + sl, c: lastR + sn, color: baseColor });
      }
    }

    // Применяем прямые пользовательские смещения отдельных вершин (Vertex Sculpting!)
    if (part.vertexOffsets && typeof part.vertexOffsets === 'object') {
      for (const k of Object.keys(part.vertexOffsets)) {
        const idx = parseInt(k, 10);
        const vo = part.vertexOffsets[k];
        if (verts[idx] && vo) {
          verts[idx] = {
            x: verts[idx].x + (vo.x || 0),
            y: verts[idx].y + (vo.y || 0),
            z: verts[idx].z + (vo.z || 0)
          };
        }
      }
    }

    return { verts, faces, ringVertexRanges };
  }

  // -------------------- Бинарный парсер .glb (glTF 2.0) и калибровка масштаба --------------------
  function parseGlbArrayBuffer(arrayBuffer, fileName = 'mesh.glb') {
    const dv = new DataView(arrayBuffer);
    if (dv.byteLength < 20) throw new Error('Файл слишком мал для .glb');
    const magic = dv.getUint32(0, true);
    if (magic !== 0x46546C67) { // 'glTF'
      throw new Error('Неверная сигнатура .glb (ожидался бинарный glTF 2.0)');
    }
    const totalLen = dv.getUint32(8, true);

    let offset = 12;
    let gltfJson = null;
    let binChunkOffset = 0;

    while (offset + 8 <= Math.min(totalLen, dv.byteLength)) {
      const chunkLen = dv.getUint32(offset, true);
      const chunkType = dv.getUint32(offset + 4, true);
      offset += 8;
      if (chunkType === 0x4E4F534A) { // JSON
        const jsonBytes = new Uint8Array(arrayBuffer, offset, chunkLen);
        const text = new TextDecoder('utf-8').decode(jsonBytes);
        gltfJson = JSON.parse(text);
      } else if (chunkType === 0x004E4942) { // BIN
        binChunkOffset = offset;
      }
      offset += chunkLen;
    }
    if (!gltfJson) throw new Error('В .glb отсутствует JSON-чанк');

    const accessors = gltfJson.accessors || [];
    const bufferViews = gltfJson.bufferViews || [];
    const meshes = gltfJson.meshes || [];
    const nodes = gltfJson.nodes || [];

    function readAccessorFloat3(accIdx) {
      const acc = accessors[accIdx];
      if (!acc) return [];
      const bv = bufferViews[acc.bufferView];
      if (!bv) return [];
      const byteOff = binChunkOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const stride = bv.byteStride || 12;
      const count = acc.count || 0;
      const out = new Array(count);
      for (let i = 0; i < count; i++) {
        const p = byteOff + i * stride;
        out[i] = {
          x: dv.getFloat32(p, true),
          y: dv.getFloat32(p + 4, true),
          z: dv.getFloat32(p + 8, true)
        };
      }
      return out;
    }

    function readAccessorIndices(accIdx, vertexCount) {
      if (accIdx === undefined || accIdx === null) {
        const seq = new Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) seq[i] = i;
        return seq;
      }
      const acc = accessors[accIdx];
      const bv = bufferViews[acc.bufferView];
      const byteOff = binChunkOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const count = acc.count || 0;
      const ct = acc.componentType;
      const out = new Array(count);
      for (let i = 0; i < count; i++) {
        if (ct === 5121) out[i] = dv.getUint8(byteOff + i);
        else if (ct === 5123) out[i] = dv.getUint16(byteOff + i * 2, true);
        else if (ct === 5125) out[i] = dv.getUint32(byteOff + i * 4, true);
        else out[i] = 0;
      }
      return out;
    }

    // Собираем все вершины и треугольники с учётом трансформаций узлов glTF
    const allVerts = [];
    const allFaces = [];

    function applyNodeTRSToVert(v, trsList) {
      let cur = { x: v.x, y: v.y, z: v.z };
      for (let i = trsList.length - 1; i >= 0; i--) {
        const nd = trsList[i];
        if (nd.matrix && nd.matrix.length === 16) {
          const m = nd.matrix;
          cur = {
            x: m[0] * cur.x + m[4] * cur.y + m[8]  * cur.z + m[12],
            y: m[1] * cur.x + m[5] * cur.y + m[9]  * cur.z + m[13],
            z: m[2] * cur.x + m[6] * cur.y + m[10] * cur.z + m[14]
          };
        } else {
          if (nd.scale) {
            cur = { x: cur.x * nd.scale[0], y: cur.y * nd.scale[1], z: cur.z * nd.scale[2] };
          }
          if (nd.rotation) {
            cur = qRotateVec({ x: nd.rotation[0], y: nd.rotation[1], z: nd.rotation[2], w: nd.rotation[3] }, cur);
          }
          if (nd.translation) {
            cur = { x: cur.x + nd.translation[0], y: cur.y + nd.translation[1], z: cur.z + nd.translation[2] };
          }
        }
      }
      return cur;
    }

    function appendMeshPrimitives(meshIdx, chain) {
      const mesh = meshes[meshIdx];
      if (!mesh || !Array.isArray(mesh.primitives)) return;
      for (const prim of mesh.primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue; // только TRIANGLES
        const posAcc = prim.attributes && prim.attributes.POSITION;
        if (posAcc === undefined) continue;
        const vLocal = readAccessorFloat3(posAcc);
        const idxArr = readAccessorIndices(prim.indices, vLocal.length);
        const vBase = allVerts.length;
        for (let i = 0; i < vLocal.length; i++) {
          allVerts.push(applyNodeTRSToVert(vLocal[i], chain));
        }
        for (let i = 0; i + 2 < idxArr.length; i += 3) {
          allFaces.push({ a: vBase + idxArr[i], b: vBase + idxArr[i + 1], c: vBase + idxArr[i + 2] });
        }
      }
    }

    const visitedNodes = new Set();
    function walkNode(nIdx, chain) {
      if (visitedNodes.has(nIdx)) return;
      visitedNodes.add(nIdx);
      const nd = nodes[nIdx];
      if (!nd) return;
      const nextChain = chain.concat([nd]);
      if (nd.mesh !== undefined) appendMeshPrimitives(nd.mesh, nextChain);
      if (Array.isArray(nd.children)) {
        for (const chIdx of nd.children) walkNode(chIdx, nextChain);
      }
    }

    if (nodes.length) {
      const childSet = new Set();
      nodes.forEach(n => (n.children || []).forEach(c => childSet.add(c)));
      for (let i = 0; i < nodes.length; i++) {
        if (!childSet.has(i)) walkNode(i, []);
      }
    } else {
      for (let m = 0; m < meshes.length; m++) appendMeshPrimitives(m, []);
    }

    return computeRawMeshStats({ name: fileName, rawVerts: allVerts, faces: allFaces });
  }

  function computeRawMeshStats(refObj) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const v of refObj.rawVerts) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
    if (!isFinite(minY)) { minX = minY = minZ = 0; maxX = maxY = maxZ = 1; }
    refObj.rawBounds = { minX, minY, minZ, maxX, maxY, maxZ };
    refObj.rawHeight = Math.max(1e-5, maxY - minY);
    return refObj;
  }

  // Процедурные эталонные манекены Жен/Муж (имитируют частую ситуацию бесплатных .glb паков,
  // где женский меш в сырых единицах выше/крупнее, а мужской — мельче, чтобы калибровка работала сразу!)
  function createBuiltinReferenceGlbSlot(gender) {
    const isFemale = gender === 'female';
    const rawScale = isFemale ? 2.15 : 1.52; // до калибровки женская намеренно выше мужской, как описал пользователь!
    const targetHeight = isFemale ? 1.68 : 1.80;
    const jRest = createDefaultJointPositions(1.0, isFemale);
    const dummyPose = { rootOffset: v3(), bones: {} };
    const fk = evaluateSkeletonFK(jRest, dummyPose);

    const bodyParts = makeBodyPartsForArchetype({
      skinColor: '#74c0fc',
      shirtColor: '#74c0fc',
      pantsColor: '#74c0fc',
      bootColor: '#74c0fc',
      feminine: isFemale
    });

    const rawVerts = [];
    const faces = [];
    for (const p of bodyParts) {
      const bInfo = fk[p.bone];
      if (!bInfo) continue;
      const g = buildPartLocalGeometry(p, bInfo);
      const base = rawVerts.length;
      for (const lv of g.verts) {
        const wv = v3Add(bInfo.worldPos, qRotateVec(bInfo.worldQ, lv));
        rawVerts.push(v3Scale(wv, rawScale));
      }
      for (const f of g.faces) {
        faces.push({ a: base + f.a, b: base + f.b, c: base + f.c });
      }
    }
    const slot = computeRawMeshStats({
      name: isFemale ? 'female_base_mesh (эталон)' : 'male_base_mesh (эталон)',
      gender,
      visible: false,
      calibrated: true, // по умолчанию откалиброван к метрике, но видно сырой размер и можно менять целевой рост
      targetHeight,
      offsetX: 0,
      rawVerts,
      faces
    });
    return slot;
  }

  // Возвращает трансформированные вершины эталонного .glb меша (либо в сыром масштабе, либо выровненного по стопам Y=0 и целевому росту!)
  function getCalibratedRefVertices(slot) {
    if (!slot || !slot.rawVerts || !slot.rawVerts.length) return [];
    const b = slot.rawBounds;
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    const s = slot.calibrated ? ((slot.targetHeight || 1.75) / Math.max(1e-5, slot.rawHeight)) : 1.0;
    const groundY = slot.calibrated ? b.minY : 0;
    const offX = slot.offsetX || 0;

    const out = new Array(slot.rawVerts.length);
    for (let i = 0; i < slot.rawVerts.length; i++) {
      const v = slot.rawVerts[i];
      out[i] = {
        x: (v.x - cx) * s + offX,
        y: (v.y - groundY) * s,
        z: (v.z - cz) * s
      };
    }
    return out;
  }

  // -------------------- Экспорт бинарного .glb (glTF 2.0) для движков и прототипов --------------------
  function exportCharacterToGlbArrayBuffer(charData, poseOverride) {
    const pose = poseOverride || getCurrentRestOrActivePose(charData);
    const fk = evaluateSkeletonFK(charData.jointsRest, pose);

    const positions = [];
    const colors = [];
    const indices = [];

    for (const part of (charData.parts || [])) {
      if (part.visible === false) continue;
      const bInfo = fk[part.bone];
      if (!bInfo) continue;
      const geom = buildPartLocalGeometry(part, bInfo);
      const vBase = positions.length / 3;

      // Собираем цвет на каждую вершину (средний от прилегающих граней)
      const vCols = geom.verts.map(() => hexToRgb(part.color || '#adb5bd'));
      for (const f of geom.faces) {
        const rgb = hexToRgb(f.color || part.color);
        vCols[f.a] = rgb; vCols[f.b] = rgb; vCols[f.c] = rgb;
      }

      for (let i = 0; i < geom.verts.length; i++) {
        const wv = v3Add(bInfo.worldPos, qRotateVec(bInfo.worldQ, geom.verts[i]));
        positions.push(wv.x, wv.y, wv.z);
        const c = vCols[i];
        colors.push(c[0] / 255, c[1] / 255, c[2] / 255);
      }
      for (const f of geom.faces) {
        indices.push(vBase + f.a, vBase + f.b, vBase + f.c);
      }
    }

    if (!positions.length) {
      positions.push(0, 0, 0, 0.1, 0, 0, 0, 0.1, 0);
      colors.push(1, 1, 1, 1, 1, 1, 1, 1, 1);
      indices.push(0, 1, 2);
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] < minX) minX = positions[i];
      if (positions[i + 1] < minY) minY = positions[i + 1];
      if (positions[i + 2] < minZ) minZ = positions[i + 2];
      if (positions[i] > maxX) maxX = positions[i];
      if (positions[i + 1] > maxY) maxY = positions[i + 1];
      if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
    }

    const posFloat = new Float32Array(positions);
    const colFloat = new Float32Array(colors);
    const idxUint32 = new Uint32Array(indices);

    const posBytes = posFloat.byteLength;
    const colBytes = colFloat.byteLength;
    const idxBytes = idxUint32.byteLength;
    const rawBinLen = posBytes + colBytes + idxBytes;
    const paddedBinLen = Math.ceil(rawBinLen / 4) * 4;

    const gltf = {
      asset: { version: '2.0', generator: 'RAGDOLL_ANIMATION 3D Studio v0.7.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: charData.name || 'character', mesh: 0 }],
      meshes: [{
        name: charData.name || 'character_mesh',
        primitives: [{
          attributes: { POSITION: 0, COLOR_0: 1 },
          indices: 2,
          mode: 4
        }]
      }],
      buffers: [{ byteLength: paddedBinLen }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
        { buffer: 0, byteOffset: posBytes, byteLength: colBytes, target: 34962 },
        { buffer: 0, byteOffset: posBytes + colBytes, byteLength: idxBytes, target: 34963 }
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: posFloat.length / 3, type: 'VEC3', min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
        { bufferView: 1, componentType: 5126, count: colFloat.length / 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5125, count: idxUint32.length, type: 'SCALAR' }
      ]
    };

    const jsonStr = JSON.stringify(gltf);
    const jsonBytes = new TextEncoder().encode(jsonStr);
    const paddedJsonLen = Math.ceil(jsonBytes.byteLength / 4) * 4;

    const totalLen = 12 + 8 + paddedJsonLen + 8 + paddedBinLen;
    const outBuf = new ArrayBuffer(totalLen);
    const dv = new DataView(outBuf);
    const u8 = new Uint8Array(outBuf);

    // Header
    dv.setUint32(0, 0x46546C67, true); // 'glTF'
    dv.setUint32(4, 2, true);
    dv.setUint32(8, totalLen, true);

    // JSON Chunk
    let off = 12;
    dv.setUint32(off, paddedJsonLen, true);
    dv.setUint32(off + 4, 0x4E4F534A, true);
    off += 8;
    u8.set(jsonBytes, off);
    for (let i = jsonBytes.byteLength; i < paddedJsonLen; i++) u8[off + i] = 0x20; // пробелы по спецификации glTF
    off += paddedJsonLen;

    // BIN Chunk
    dv.setUint32(off, paddedBinLen, true);
    dv.setUint32(off + 4, 0x004E4942, true);
    off += 8;
    u8.set(new Uint8Array(posFloat.buffer), off);
    u8.set(new Uint8Array(colFloat.buffer), off + posBytes);
    u8.set(new Uint8Array(idxUint32.buffer), off + posBytes + colBytes);

    return outBuf;
  }

  function getCurrentRestOrActivePose(charData) {
    return (charData && charData.activePose) ? charData.activePose : { rootOffset: v3(), bones: {} };
  }

  // -------------------- Интерполяция анимаций с кривыми Easing --------------------
  function sampleAnimationPose(animClip, timeSec) {
    const outPose = { rootOffset: v3(0, 0, 0), bones: {} };
    if (!animClip || !Array.isArray(animClip.keyframes) || !animClip.keyframes.length) {
      return outPose;
    }
    const keys = animClip.keyframes.slice().sort((a, b) => a.time - b.time);
    if (keys.length === 1 || timeSec <= keys[0].time) {
      return clonePose(keys[0].pose);
    }
    if (timeSec >= keys[keys.length - 1].time) {
      return clonePose(keys[keys.length - 1].pose);
    }

    let k0 = keys[0], k1 = keys[1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (timeSec >= keys[i].time && timeSec <= keys[i + 1].time) {
        k0 = keys[i];
        k1 = keys[i + 1];
        break;
      }
    }

    const span = Math.max(1e-5, k1.time - k0.time);
    const rawT = (timeSec - k0.time) / span;
    const easedT = evalEasing(k1.easing || 'easeInOut', rawT);

    const ro0 = (k0.pose && k0.pose.rootOffset) || v3();
    const ro1 = (k1.pose && k1.pose.rootOffset) || v3();
    outPose.rootOffset = v3Lerp(ro0, ro1, easedT);

    const allBoneIds = new Set([
      ...Object.keys((k0.pose && k0.pose.bones) || {}),
      ...Object.keys((k1.pose && k1.pose.bones) || {})
    ]);
    for (const bid of allBoneIds) {
      const r0 = (k0.pose && k0.pose.bones && k0.pose.bones[bid]) || { rx: 0, ry: 0, rz: 0 };
      const r1 = (k1.pose && k1.pose.bones && k1.pose.bones[bid]) || { rx: 0, ry: 0, rz: 0 };
      const q0 = qFromEulerDeg(r0.rx, r0.ry, r0.rz);
      const q1 = qFromEulerDeg(r1.rx, r1.ry, r1.rz);
      // Поддержка перехлёста (overshoot > 1 или anticipation < 0)
      if (easedT >= 0 && easedT <= 1) {
        outPose.bones[bid] = qToEulerDeg(qSlerp(q0, q1, easedT));
      } else {
        outPose.bones[bid] = {
          rx: r0.rx + (r1.rx - r0.rx) * easedT,
          ry: r0.ry + (r1.ry - r0.ry) * easedT,
          rz: r0.rz + (r1.rz - r0.rz) * easedT
        };
      }
    }
    return outPose;
  }

  function clonePose(p) {
    return JSON.parse(JSON.stringify(p || { rootOffset: { x: 0, y: 0, z: 0 }, bones: {} }));
  }

  // -------------------- Фабрика модульных частей и 4 готовых архетипов персонажей --------------------
  let _partSeq = 1;
  function uidPart(prefix) { return (prefix || 'part') + '_' + (_partSeq++); }

  function makeBodyPartsForArchetype(opts) {
    const skin = opts.skinColor || '#f1c29b';
    const shirt = opts.shirtColor || '#3b5bdb';
    const sleeve = opts.sleeveColor || shirt;
    const pants = opts.pantsColor || '#2b303a';
    const boot = opts.bootColor || '#495057';
    const fem = !!opts.feminine;

    const parts = [
      {
        id: 'part_pelvis', label: 'Таз / Пояс', bone: 'pelvis', kind: 'loft', sides: 8,
        color: pants, accentColor: pants, capJoint: true,
        rings: [
          { t: -0.15, rx: fem ? 0.135 : 0.13, rz: 0.095, ox: 0, oz: 0 },
          { t:  0.95, rx: fem ? 0.105 : 0.12, rz: 0.088, ox: 0, oz: 0 }
        ]
      },
      {
        id: 'part_spine', label: 'Живот / Талия', bone: 'spine', kind: 'loft', sides: 8,
        color: shirt, accentColor: shirt, capJoint: true,
        rings: [
          { t: 0.0, rx: fem ? 0.105 : 0.125, rz: 0.088, ox: 0, oz: 0 },
          { t: 1.0, rx: fem ? 0.125 : 0.145, rz: 0.098, ox: 0, oz: 0.005 }
        ]
      },
      {
        id: 'part_chest', label: 'Грудная клетка', bone: 'chest', kind: 'loft', sides: 8,
        color: shirt, accentColor: opts.collarColor || shirt, capJoint: true,
        rings: [
          { t: 0.0, rx: fem ? 0.125 : 0.148, rz: 0.10,  ox: 0, oz: 0.005 },
          { t: 0.65, rx: fem ? 0.14 : 0.175, rz: fem ? 0.115 : 0.115, ox: 0, oz: fem ? 0.015 : 0.008 },
          { t: 1.0, rx: fem ? 0.085 : 0.105, rz: 0.075, ox: 0, oz: 0 }
        ]
      },
      {
        id: 'part_neck', label: 'Шея', bone: 'neck', kind: 'loft', sides: 8,
        color: skin, accentColor: skin, capJoint: true,
        rings: [
          { t: 0.0, rx: 0.048, rz: 0.048, ox: 0, oz: 0 },
          { t: 1.0, rx: 0.045, rz: 0.045, ox: 0, oz: 0 }
        ]
      },
      {
        id: 'part_head', label: 'Голова', bone: 'head', kind: 'loft', sides: 10,
        color: skin, accentColor: skin, capJoint: true,
        rings: [
          { t: 0.05, rx: 0.075, rz: 0.085, ox: 0, oz: 0.01 },
          { t: 0.50, rx: 0.098, rz: 0.108, ox: 0, oz: 0.012 },
          { t: 0.96, rx: 0.072, rz: 0.082, ox: 0, oz: 0.005 }
        ]
      },
      // Нос-ориентир чтобы в 3D сразу читалось направление взгляда (+Z)
      {
        id: 'part_nose', label: 'Лицо / Нос', bone: 'head', kind: 'box',
        color: skin, accentColor: skin,
        size: { x: 0.026, y: 0.036, z: 0.035 }, offset: { x: 0, y: 0.10, z: 0.112 }
      }
    ];

    for (const side of ['L', 'R']) {
      const sideRu = side === 'L' ? 'Л' : 'П';
      const isRight = side === 'R';
      const tornRightLeg = !!(opts.tornRightPants && isRight);

      parts.push(
        {
          id: 'part_uarm_' + side, label: 'Плечо / Рукав ' + sideRu, bone: 'upperArm_' + side,
          mirrorId: 'part_uarm_' + (side === 'L' ? 'R' : 'L'),
          kind: 'loft', sides: 8, color: sleeve, accentColor: sleeve, capJoint: true,
          rings: [
            { t: 0.0, rx: 0.058, rz: 0.058, ox: 0, oz: 0 },
            { t: 1.0, rx: opts.wideSleeves ? 0.068 : 0.048, rz: opts.wideSleeves ? 0.068 : 0.048, ox: 0, oz: 0 }
          ]
        },
        {
          id: 'part_farm_' + side, label: 'Предплечье ' + sideRu, bone: 'forearm_' + side,
          mirrorId: 'part_farm_' + (side === 'L' ? 'R' : 'L'),
          kind: 'loft', sides: 8,
          color: opts.bareForearms ? skin : sleeve,
          accentColor: opts.cuffColor || sleeve,
          capJoint: true,
          rings: opts.wideSleeves
            ? [
                { t: 0.0, rx: 0.058, rz: 0.058, ox: 0, oz: 0 },
                { t: 0.98, rx: 0.095, rz: 0.095, ox: 0, oz: 0 }
              ]
            : [
                { t: 0.0, rx: 0.046, rz: 0.046, ox: 0, oz: 0 },
                { t: 1.0, rx: 0.038, rz: 0.038, ox: 0, oz: 0 }
              ]
        },
        {
          id: 'part_hand_' + side, label: (opts.singleLeftGlove && side === 'L' ? 'Перчатка Л' : 'Кисть ' + sideRu),
          bone: 'hand_' + side, mirrorId: 'part_hand_' + (side === 'L' ? 'R' : 'L'),
          kind: 'sphere',
          color: (opts.singleLeftGlove && side === 'L') ? '#212529' : (opts.gloveColor || skin),
          radius: { x: 0.042, y: 0.045, z: 0.035 }, offset: { x: 0, y: 0.02, z: 0 }
        },
        {
          id: 'part_thigh_' + side, label: 'Бедро / Штаны ' + sideRu, bone: 'thigh_' + side,
          mirrorId: 'part_thigh_' + (side === 'L' ? 'R' : 'L'),
          kind: 'loft', sides: 8, color: pants, accentColor: pants, capJoint: true,
          rings: [
            { t: 0.0, rx: 0.078, rz: 0.078, ox: 0, oz: 0 },
            { t: 1.0, rx: 0.062, rz: 0.062, ox: 0, oz: 0 }
          ]
        },
        {
          id: 'part_shin_' + side,
          label: tornRightLeg ? 'Рваная штанина + голень П' : ('Голень / Штанина ' + sideRu),
          bone: 'shin_' + side,
          mirrorId: 'part_shin_' + (side === 'L' ? 'R' : 'L'),
          kind: 'loft', sides: 8,
          color: tornRightLeg ? pants : pants,
          accentColor: tornRightLeg ? skin : pants,
          capJoint: true,
          rings: tornRightLeg
            ? [
                { t: 0.0,  rx: 0.062, rz: 0.062, ox: 0, oz: 0, color: pants },
                { t: 0.36, rx: 0.070, rz: 0.068, ox: 0.006, oz: 0, color: pants }, // рваный край штанины!
                { t: 0.39, rx: 0.043, rz: 0.043, ox: 0, oz: 0, color: skin },      // оголённая голень зомби!
                { t: 1.0,  rx: 0.036, rz: 0.036, ox: 0, oz: 0, color: skin }
              ]
            : [
                { t: 0.0, rx: 0.060, rz: 0.060, ox: 0, oz: 0 },
                { t: 1.0, rx: 0.048, rz: 0.048, ox: 0, oz: 0 }
              ]
        },
        {
          id: 'part_foot_' + side, label: 'Ботинок ' + sideRu, bone: 'foot_' + side,
          mirrorId: 'part_foot_' + (side === 'L' ? 'R' : 'L'),
          kind: 'loft', sides: 8, color: boot, accentColor: boot, capJoint: true,
          rings: [
            { t: 0.0, rx: 0.046, rz: 0.052, ox: 0, oz: 0 },
            { t: 1.0, rx: 0.050, rz: 0.042, ox: 0, oz: 0.02 }
          ]
        }
      );
    }

    // Шарнирный плащ из 3 сегментов (если включён)
    if (opts.withCape) {
      const cMain = opts.capeColor || '#c92a2a';
      const cTrim = opts.capeTrimColor || '#ffd43b';
      parts.push(
        { id: 'part_cape_1', label: 'Плащ: верх (плечи)', bone: 'cape_1', kind: 'cape_plate', wTop: 0.21, wBot: 0.25, thick: 0.018, color: cMain, accentColor: cMain },
        { id: 'part_cape_2', label: 'Плащ: середина',     bone: 'cape_2', kind: 'cape_plate', wTop: 0.25, wBot: 0.30, thick: 0.016, color: cMain, accentColor: cMain },
        { id: 'part_cape_3', label: 'Плащ: подол',        bone: 'cape_3', kind: 'cape_plate', wTop: 0.30, wBot: 0.35, thick: 0.016, color: cMain, accentColor: cTrim }
      );
    }

    return parts;
  }

  // Набор стандартных поз + 5 живых игровых анимаций (включая запрокидывание головы с разгоном и плавным возвратом!)
  function buildStandardPosesAndAnims() {
    const poseStand = {
      rootOffset: v3(0, 0, 0),
      bones: {
        upperArm_L: { rx: 0, ry: 0, rz: -68 },
        forearm_L:  { rx: -18, ry: 0, rz: 0 },
        upperArm_R: { rx: 0, ry: 0, rz: 68 },
        forearm_R:  { rx: -22, ry: 0, rz: 0 },
        thigh_L:    { rx: -4, ry: 0, rz: 2 },
        shin_L:     { rx: 8, ry: 0, rz: 0 },
        thigh_R:    { rx: -4, ry: 0, rz: -2 },
        shin_R:     { rx: 8, ry: 0, rz: 0 },
        cape_1:     { rx: 8, ry: 0, rz: 0 },
        cape_2:     { rx: 5, ry: 0, rz: 0 },
        cape_3:     { rx: 4, ry: 0, rz: 0 }
      }
    };

    const poseT = { rootOffset: v3(0, 0, 0), bones: {} };

    const poseWalkA = {
      rootOffset: v3(0, 0.02, 0),
      bones: {
        pelvis:     { rx: 4, ry: -7, rz: 0 },
        chest:      { rx: 5, ry: 9, rz: 0 },
        upperArm_L: { rx: 28, ry: 0, rz: -68 },
        forearm_L:  { rx: -28, ry: 0, rz: 0 },
        upperArm_R: { rx: -26, ry: 0, rz: 68 },
        forearm_R:  { rx: -35, ry: 0, rz: 0 },
        thigh_L:    { rx: -28, ry: 0, rz: 0 },
        shin_L:     { rx: 14, ry: 0, rz: 0 },
        thigh_R:    { rx: 24, ry: 0, rz: 0 },
        shin_R:     { rx: 32, ry: 0, rz: 0 },
        cape_1:     { rx: 18, ry: 4, rz: 3 },
        cape_2:     { rx: 14, ry: 0, rz: 2 },
        cape_3:     { rx: 12, ry: 0, rz: 0 }
      }
    };

    const poseWalkB = {
      rootOffset: v3(0, 0.02, 0),
      bones: {
        pelvis:     { rx: 4, ry: 7, rz: 0 },
        chest:      { rx: 5, ry: -9, rz: 0 },
        upperArm_L: { rx: -26, ry: 0, rz: -68 },
        forearm_L:  { rx: -35, ry: 0, rz: 0 },
        upperArm_R: { rx: 28, ry: 0, rz: 68 },
        forearm_R:  { rx: -28, ry: 0, rz: 0 },
        thigh_L:    { rx: 24, ry: 0, rz: 0 },
        shin_L:     { rx: 32, ry: 0, rz: 0 },
        thigh_R:    { rx: -28, ry: 0, rz: 0 },
        shin_R:     { rx: 14, ry: 0, rz: 0 },
        cape_1:     { rx: 18, ry: -4, rz: -3 },
        cape_2:     { rx: 14, ry: 0, rz: -2 },
        cape_3:     { rx: 12, ry: 0, rz: 0 }
      }
    };

    const poseSwingWindup = {
      rootOffset: v3(0, -0.04, 0),
      bones: {
        pelvis:     { rx: -4, ry: -18, rz: 0 },
        spine:      { rx: -8, ry: -14, rz: 0 },
        chest:      { rx: -10, ry: -18, rz: 0 },
        head:       { rx: 8, ry: 22, rz: 0 },
        upperArm_R: { rx: -105, ry: -15, rz: 35 },
        forearm_R:  { rx: -42, ry: 0, rz: 0 },
        upperArm_L: { rx: -25, ry: 18, rz: -52 },
        forearm_L:  { rx: -45, ry: 0, rz: 0 },
        thigh_L:    { rx: -22, ry: 0, rz: 5 },
        shin_L:     { rx: 26, ry: 0, rz: 0 },
        thigh_R:    { rx: 12, ry: 0, rz: -5 },
        shin_R:     { rx: 18, ry: 0, rz: 0 },
        cape_1:     { rx: 14, ry: 12, rz: 8 },
        cape_2:     { rx: 18, ry: 8, rz: 6 },
        cape_3:     { rx: 22, ry: 4, rz: 4 }
      }
    };

    const poseSwingStrike = {
      rootOffset: v3(0, -0.07, 0.06),
      bones: {
        pelvis:     { rx: 10, ry: 20, rz: 0 },
        spine:      { rx: 14, ry: 16, rz: 0 },
        chest:      { rx: 16, ry: 22, rz: 0 },
        head:       { rx: -10, ry: -18, rz: 0 },
        upperArm_R: { rx: 38, ry: 25, rz: 55 },
        forearm_R:  { rx: -12, ry: 0, rz: 0 },
        hand_R:     { rx: 32, ry: 0, rz: 0 },
        upperArm_L: { rx: 24, ry: -12, rz: -58 },
        forearm_L:  { rx: -32, ry: 0, rz: 0 },
        thigh_L:    { rx: -32, ry: 0, rz: 4 },
        shin_L:     { rx: 36, ry: 0, rz: 0 },
        thigh_R:    { rx: 22, ry: 0, rz: -4 },
        shin_R:     { rx: 22, ry: 0, rz: 0 },
        cape_1:     { rx: 42, ry: -14, rz: -10 },
        cape_2:     { rx: 34, ry: -10, rz: -8 },
        cape_3:     { rx: 28, ry: -6, rz: -5 }
      }
    };

    // Поза запрокидывания головы и груди (для демонстрации разгона + плавного возврата)
    const poseHeadThrowBack = {
      rootOffset: v3(0, -0.02, -0.03),
      bones: {
        spine:      { rx: -12, ry: 0, rz: 0 },
        chest:      { rx: -18, ry: 0, rz: 0 },
        neck:       { rx: -28, ry: 0, rz: 0 },
        head:       { rx: -42, ry: 4, rz: 0 },
        upperArm_L: { rx: 16, ry: 0, rz: -52 },
        forearm_L:  { rx: -32, ry: 0, rz: 0 },
        upperArm_R: { rx: 16, ry: 0, rz: 52 },
        forearm_R:  { rx: -32, ry: 0, rz: 0 },
        thigh_L:    { rx: -8, ry: 0, rz: 2 },
        shin_L:     { rx: 14, ry: 0, rz: 0 },
        thigh_R:    { rx: -8, ry: 0, rz: -2 },
        shin_R:     { rx: 14, ry: 0, rz: 0 },
        cape_1:     { rx: 26, ry: 0, rz: 0 },
        cape_2:     { rx: 24, ry: 0, rz: 0 },
        cape_3:     { rx: 22, ry: 0, rz: 0 }
      }
    };

    const poses = [
      { id: 'stand',       label: 'Спокойная стойка',         pose: clonePose(poseStand) },
      { id: 'tpose',       label: 'T-Поза (База рига)',       pose: clonePose(poseT) },
      { id: 'walk_l',      label: 'Шаг левой',                pose: clonePose(poseWalkA) },
      { id: 'walk_r',      label: 'Шаг правой',               pose: clonePose(poseWalkB) },
      { id: 'windup',      label: 'Замах оружием / посохом',  pose: clonePose(poseSwingWindup) },
      { id: 'strike',      label: 'Удар + вылет плаща',       pose: clonePose(poseSwingStrike) },
      { id: 'head_recoil', label: 'Запрокидывание головы',    pose: clonePose(poseHeadThrowBack) }
    ];

    const idleBreathe = clonePose(poseStand);
    idleBreathe.rootOffset = v3(0, -0.015, 0);
    idleBreathe.bones.chest = { rx: -3, ry: 0, rz: 0 };
    idleBreathe.bones.cape_1 = { rx: 13, ry: 0, rz: 0 };
    idleBreathe.bones.cape_2 = { rx: 10, ry: 0, rz: 0 };
    idleBreathe.bones.cape_3 = { rx: 9, ry: 0, rz: 0 };

    // Бег с наклоном и развевающимся плащом
    const runA = clonePose(poseWalkA);
    runA.rootOffset = v3(0, 0.05, 0);
    runA.bones.spine = { rx: 16, ry: 0, rz: 0 };
    runA.bones.thigh_L = { rx: -48, ry: 0, rz: 0 };
    runA.bones.shin_L  = { rx: 28, ry: 0, rz: 0 };
    runA.bones.thigh_R = { rx: 38, ry: 0, rz: 0 };
    runA.bones.shin_R  = { rx: 65, ry: 0, rz: 0 };
    runA.bones.cape_1  = { rx: 46, ry: 6, rz: 4 };
    runA.bones.cape_2  = { rx: 32, ry: 0, rz: 3 };
    runA.bones.cape_3  = { rx: 24, ry: 0, rz: 0 };

    const runB = clonePose(poseWalkB);
    runB.rootOffset = v3(0, 0.05, 0);
    runB.bones.spine = { rx: 16, ry: 0, rz: 0 };
    runB.bones.thigh_R = { rx: -48, ry: 0, rz: 0 };
    runB.bones.shin_R  = { rx: 28, ry: 0, rz: 0 };
    runB.bones.thigh_L = { rx: 38, ry: 0, rz: 0 };
    runB.bones.shin_L  = { rx: 65, ry: 0, rz: 0 };
    runB.bones.cape_1  = { rx: 46, ry: -6, rz: -4 };
    runB.bones.cape_2  = { rx: 32, ry: 0, rz: -3 };
    runB.bones.cape_3  = { rx: 24, ry: 0, rz: 0 };

    const animations = [
      {
        id: 'idle',
        name: 'Покой и дыхание (Idle)',
        duration: 2.0,
        loop: true,
        keyframes: [
          { time: 0.0, easing: 'easeInOut', pose: clonePose(poseStand) },
          { time: 1.0, easing: 'easeInOut', pose: clonePose(idleBreathe) },
          { time: 2.0, easing: 'easeInOut', pose: clonePose(poseStand) }
        ]
      },
      {
        id: 'walk',
        name: 'Ходьба (Walk)',
        duration: 1.2,
        loop: true,
        keyframes: [
          { time: 0.0, easing: 'easeInOut', pose: clonePose(poseWalkA) },
          { time: 0.6, easing: 'easeInOut', pose: clonePose(poseWalkB) },
          { time: 1.2, easing: 'easeInOut', pose: clonePose(poseWalkA) }
        ]
      },
      {
        id: 'run_cape',
        name: 'Бег + развевающийся плащ',
        duration: 0.8,
        loop: true,
        keyframes: [
          { time: 0.0, easing: 'easeInOut', pose: clonePose(runA) },
          { time: 0.4, easing: 'easeInOut', pose: clonePose(runB) },
          { time: 0.8, easing: 'easeInOut', pose: clonePose(runA) }
        ]
      },
      {
        id: 'attack_swing',
        name: 'Взмах топором / палкой (с перехлёстом)',
        duration: 1.3,
        loop: true,
        keyframes: [
          { time: 0.0,  easing: 'easeInOut', pose: clonePose(poseStand) },
          { time: 0.38, easing: 'easeOut',   pose: clonePose(poseSwingWindup) },
          { time: 0.58, easing: 'overshoot', pose: clonePose(poseSwingStrike) },
          { time: 1.30, easing: 'easeOut',   pose: clonePose(poseStand) }
        ]
      },
      {
        id: 'head_recoil',
        name: 'Запрокидывание головы (разгон → плавный возврат)',
        duration: 1.4,
        loop: true,
        keyframes: [
          { time: 0.0,  easing: 'linear',    pose: clonePose(poseStand) },
          { time: 0.28, easing: 'easeIn',    pose: clonePose(poseHeadThrowBack) }, // НАРАСТАНИЕ СКОРОСТИ!
          { time: 1.40, easing: 'easeOut',   pose: clonePose(poseStand) }          // ДОЛГИЙ ПЛАВНЫЙ ВОЗВРАТ!
        ]
      }
    ];

    return { poses, animations, defaultPose: clonePose(poseStand) };
  }

  function createArchetypeCharacter(archetypeId) {
    const std = buildStandardPosesAndAnims();

    if (archetypeId === 'king_cape') {
      const jointsRest = createDefaultJointPositions(1.82, false);
      const parts = makeBodyPartsForArchetype({
        skinColor: '#f3c6a0',
        shirtColor: '#364fc7',
        collarColor: '#ffd43b',
        sleeveColor: '#4263eb',
        pantsColor: '#1e2638',
        bootColor: '#5c3c24',
        withCape: true,
        capeColor: '#c92a2a',
        capeTrimColor: '#ffd43b'
      });
      // Корона на сокете головы + Скипетр в правой руке + Щит в левой руке
      parts.push(
        {
          id: 'prop_crown', label: 'Корона короля', bone: 'socket_head', kind: 'loft', sides: 8,
          color: '#ffd43b', accentColor: '#f59f00', capJoint: false, openBottom: true,
          rings: [
            { t: -0.25, rx: 0.088, rz: 0.095, ox: 0, oz: 0.008 },
            { t:  0.85, rx: 0.105, rz: 0.112, ox: 0, oz: 0.008 }
          ]
        },
        {
          id: 'prop_scepter_shaft', label: 'Скипетр: древко', bone: 'socket_hand_R', kind: 'loft', sides: 6,
          color: '#8d5524', accentColor: '#ffd43b', capJoint: false,
          rings: [
            { t: -2.2, rx: 0.018, rz: 0.018, ox: 0, oz: 0.02 },
            { t:  5.8, rx: 0.022, rz: 0.022, ox: 0, oz: 0.02 }
          ]
        },
        {
          id: 'prop_scepter_gem', label: 'Скипетр: навершие', bone: 'socket_hand_R', kind: 'sphere',
          color: '#ffd43b', radius: { x: 0.055, y: 0.065, z: 0.055 }, offset: { x: 0, y: 0.48, z: 0.02 }
        },
        {
          id: 'prop_shield', label: 'Королевский щит', bone: 'socket_hand_L', kind: 'box',
          color: '#1c7ed6', accentColor: '#ffd43b',
          size: { x: 0.04, y: 0.36, z: 0.28 }, offset: { x: 0.05, y: 0.02, z: 0.04 }
        }
      );
      return {
        format: 'RAGDOLL_3D_CHARACTER',
        version: 1,
        name: 'king_cape',
        title: 'Король в плаще (Tower Defense)',
        heightM: 1.82,
        symmetry: true,
        jointsRest,
        parts,
        poses: std.poses,
        animations: std.animations,
        activePose: std.defaultPose
      };
    }

    if (archetypeId === 'mage_staff') {
      const jointsRest = createDefaultJointPositions(1.78, false);
      const parts = makeBodyPartsForArchetype({
        skinColor: '#f1c29b',
        shirtColor: '#5f3dc4',
        collarColor: '#d0bfff',
        sleeveColor: '#6741d9',
        wideSleeves: true,
        pantsColor: '#3b2874',
        bootColor: '#343a40',
        withCape: true,
        capeColor: '#4c2889',
        capeTrimColor: '#74c0fc'
      });
      parts.push(
        {
          id: 'prop_wizard_hat', label: 'Шляпа мага (конус с полями)', bone: 'socket_head', kind: 'loft', sides: 10,
          color: '#3b2874', accentColor: '#9775fa', capJoint: false,
          rings: [
            { t: -0.25, rx: 0.22,  rz: 0.22,  ox: 0, oz: 0.01, color: '#3b2874' },
            { t:  0.10, rx: 0.095, rz: 0.102, ox: 0, oz: 0.01, color: '#7950f2' },
            { t:  1.85, rx: 0.055, rz: 0.055, ox: 0, oz: -0.02, color: '#4c2889' },
            { t:  3.40, rx: 0.008, rz: 0.008, ox: 0, oz: -0.09, color: '#4c2889' }
          ]
        },
        {
          id: 'prop_staff_pole', label: 'Посох мага', bone: 'socket_hand_R', kind: 'loft', sides: 6,
          color: '#6c472b', accentColor: '#5c3c24', capJoint: false,
          rings: [
            { t: -6.0, rx: 0.018, rz: 0.018, ox: 0, oz: 0.02 },
            { t:  8.5, rx: 0.025, rz: 0.025, ox: 0, oz: 0.02 }
          ]
        },
        {
          id: 'prop_staff_orb', label: 'Кристалл посоха', bone: 'socket_hand_R', kind: 'sphere',
          color: '#4dabf7', radius: { x: 0.06, y: 0.075, z: 0.06 }, offset: { x: 0, y: 0.72, z: 0.02 }
        }
      );
      return {
        format: 'RAGDOLL_3D_CHARACTER',
        version: 1,
        name: 'mage_staff',
        title: 'Маг в шляпе и плаще',
        heightM: 1.78,
        symmetry: true,
        jointsRest,
        parts,
        poses: std.poses,
        animations: std.animations,
        activePose: std.defaultPose
      };
    }

    if (archetypeId === 'zombie_suit') {
      const jointsRest = createDefaultJointPositions(1.79, false);
      const parts = makeBodyPartsForArchetype({
        skinColor: '#8ce99a',
        shirtColor: '#495057',      // пиджак
        collarColor: '#adb5bd',     // рубашка
        sleeveColor: '#495057',     // рукава-цилиндры
        pantsColor: '#2c3340',      // брюки костюма
        bootColor: '#212529',
        tornRightPants: true,       // АСИММЕТРИЯ: оторванная правая штанина!
        singleLeftGlove: true,      // АСИММЕТРИЯ: одна перчатка на левой руке!
        withCape: false
      });
      parts.push(
        {
          id: 'prop_axe_handle', label: 'Топор: топорище', bone: 'socket_hand_R', kind: 'loft', sides: 6,
          color: '#7f4f24', accentColor: '#7f4f24', capJoint: false,
          rings: [
            { t: -1.8, rx: 0.017, rz: 0.022, ox: 0, oz: 0.02 },
            { t:  5.2, rx: 0.020, rz: 0.026, ox: 0, oz: 0.02 }
          ]
        },
        {
          id: 'prop_axe_blade', label: 'Топор: лезвие', bone: 'socket_hand_R', kind: 'box',
          color: '#ced4da', accentColor: '#868e96',
          size: { x: 0.024, y: 0.16, z: 0.19 }, offset: { x: 0, y: 0.36, z: 0.09 }
        }
      );
      return {
        format: 'RAGDOLL_3D_CHARACTER',
        version: 1,
        name: 'zombie_suit',
        title: 'Зомби в рваном костюме с топором',
        heightM: 1.79,
        symmetry: false,
        jointsRest,
        parts,
        poses: std.poses,
        animations: std.animations,
        activePose: std.defaultPose
      };
    }

    // base_human (Базовый шарнирный манекен)
    const jointsRest = createDefaultJointPositions(1.80, false);
    const parts = makeBodyPartsForArchetype({
      skinColor: '#dee2e6',
      shirtColor: '#4dabf7',
      sleeveColor: '#74c0fc',
      pantsColor: '#364fc7',
      bootColor: '#2b303a',
      withCape: false
    });
    return {
      format: 'RAGDOLL_3D_CHARACTER',
      version: 1,
      name: 'base_human',
      title: 'Базовый манекен (Муж / Жен 1.80 м)',
      heightM: 1.80,
      symmetry: true,
      jointsRest,
      parts,
      poses: std.poses,
      animations: std.animations,
      activePose: std.defaultPose
    };
  }

  return {
    DEG2RAD, RAD2DEG,
    v3, v3Clone, v3Add, v3Sub, v3Scale, v3Lerp, v3Dot, v3Cross, v3Len, v3Norm,
    qIdent, qNorm, qMul, qConj, qRotateVec, qFromAxisAngle, qFromUnitVectors, qFromEulerDeg, qToEulerDeg, qSlerp,
    EASING_DEFS, evalEasing,
    BONE_HIERARCHY, IK_CHAINS,
    createDefaultJointPositions,
    evaluateSkeletonFK,
    solveTwoBoneIK,
    buildPartLocalGeometry,
    parseGlbArrayBuffer,
    createBuiltinReferenceGlbSlot,
    getCalibratedRefVertices,
    exportCharacterToGlbArrayBuffer,
    sampleAnimationPose,
    clonePose,
    uidPart,
    createArchetypeCharacter
  };
})();
