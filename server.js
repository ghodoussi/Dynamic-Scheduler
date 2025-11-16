// server.js
// Scheduler with full prerequisite enforcement + per-task windows + repeat-days
// US-based week is handled entirely by frontend (Sunday = 0)
// FIXED-event double-day bug fixed here

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Constants ----
const SLOTS_PER_DAY = 24 * 4; // 96
const SLOTS_PER_WEEK = 7 * SLOTS_PER_DAY;

// ---- Helpers ----
function minutesToSlotIndex(minutesFromMidnight) {
  return Math.floor(minutesFromMidnight / 15);
}
function absoluteSlot(dayIndex, slotOfDay) {
  return dayIndex * SLOTS_PER_DAY + slotOfDay;
}
function slotToDayAndTime(slotIndex) {
  const day = Math.floor(slotIndex / SLOTS_PER_DAY);
  const slotOfDay = slotIndex % SLOTS_PER_DAY;
  const minutes = slotOfDay * 15;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return { day, hh, mm, slotOfDay };
}
function ceilDiv(a, b) { return Math.floor((a + b - 1) / b); }

// ---- Topological sort ----
function topoSortTasks(tasks) {
  const idToTask = new Map(tasks.map(t => [t.id, t]));
  const inDeg = new Map();
  const adj = new Map();
  for (const t of tasks) {
    inDeg.set(t.id, 0);
    adj.set(t.id, []);
  }
  for (const t of tasks) {
    for (const p of (t.prerequisites || [])) {
      if (!idToTask.has(p)) continue;
      adj.get(p).push(t.id);
      inDeg.set(t.id, (inDeg.get(t.id) || 0) + 1);
    }
  }
  const q = [];
  for (const [id, deg] of inDeg.entries()) if (deg === 0) q.push(id);
  const order = [];
  while (q.length) {
    const u = q.shift();
    order.push(u);
    for (const v of adj.get(u)) {
      inDeg.set(v, inDeg.get(v) - 1);
      if (inDeg.get(v) === 0) q.push(v);
    }
  }
  if (order.length !== tasks.length) return { ok: false };
  return { ok: true, order };
}

// ---- API: schedule ----
app.post('/api/schedule', (req, res) => {
  try {
    const body = req.body || {};
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    const dailyActiveHours = body.dailyActiveHours || { start: 8 * 60, end: 22 * 60 };

    const schedule = Array(SLOTS_PER_WEEK).fill(null);
    const slotTakenBy = Array(SLOTS_PER_WEEK).fill(null);
    const unscheduled = [];

    // ---------- FIXED TASKS ----------
    function assignFixedTaskToSlots(task) {
      const tw = task.timeWindow;
      if (!tw) {
        unscheduled.push({ taskId: task.id, reason: 'FIXED task missing timeWindow' });
        return;
      }

      // ✔ FIX: tw.startMinutes and tw.endMinutes are ALREADY absolute.
      const startAbs = tw.startMinutes;
      const endAbs = tw.endMinutes;

      const startSlot = Math.ceil(startAbs / 15);
      const endSlot = Math.floor(endAbs / 15);

      if (startSlot >= endSlot) {
        unscheduled.push({ taskId: task.id, reason: 'FIXED task has zero or negative length window' });
        return;
      }

      for (let s = startSlot; s < endSlot; s++) {
        slotTakenBy[s] = task.id;
        schedule[s] = task.id;
      }
    }

    for (const t of tasks.filter(x => x.type === 'FIXED')) assignFixedTaskToSlots(t);

    // ---------- FLEXIBLE TASK INSTANCES ----------
    const flexibleTasks = tasks.filter(t => t.type === 'FLEXIBLE');
    const taskInstances = [];

    for (const t of flexibleTasks) {
      const days = Array.isArray(t.days) ? t.days : [0,1,2,3,4,5,6];
      const durSlots = Math.max(1, ceilDiv((t.duration || 0), 15));
      const allowedWindow = t.allowedWindow || { startMinutes: dailyActiveHours.start, endMinutes: dailyActiveHours.end };

      for (const dayIndex of days) {
        const dayBaseMinutes = dayIndex * 24 * 60;

        const startAbs = dayBaseMinutes + allowedWindow.startMinutes;
        const endAbs = dayBaseMinutes + allowedWindow.endMinutes;

        const allowedStartSlot = Math.ceil(startAbs / 15);
        const allowedEndSlot = Math.floor(endAbs / 15);

        if (allowedStartSlot >= allowedEndSlot) {
          unscheduled.push({ instanceId: `${t.id}__d${dayIndex}`, taskId: t.id, dayIndex, reason: 'allowed window too small' });
          continue;
        }

        taskInstances.push({
          instanceId: `${t.id}__d${dayIndex}`,
          taskId: t.id,
          task: t,
          dayIndex,
          units: durSlots,
          allowedStartSlot,
          allowedEndSlot
        });
      }
    }

    // ---------- prerequisites ----------
    const topo = topoSortTasks(tasks);
    if (!topo.ok) return res.json({ success: false, error: 'Cycle detected', schedule: null });

    const topoOrder = topo.order;
    const instancesByTask = new Map();
    for (const inst of taskInstances) {
      if (!instancesByTask.has(inst.taskId)) instancesByTask.set(inst.taskId, []);
      instancesByTask.get(inst.taskId).push(inst);
    }
    for (const arr of instancesByTask.values()) arr.sort((a,b)=>a.dayIndex-b.dayIndex);

    function canPlace(startSlot, units) {
      if (startSlot < 0 || startSlot + units > SLOTS_PER_WEEK) return false;
      for (let i = 0; i < units; i++) if (slotTakenBy[startSlot + i] !== null) return false;
      return true;
    }
    function place(startSlot, units, taskId) {
      for (let i = 0; i < units; i++) {
        slotTakenBy[startSlot + i] = taskId;
        schedule[startSlot + i] = taskId;
      }
    }

    const scheduledInstanceInfo = new Map();

    for (const taskId of topoOrder) {
      const instList = instancesByTask.get(taskId) || [];
      for (const inst of instList) {
        const { instanceId, dayIndex, units, allowedStartSlot, allowedEndSlot } = inst;

        let earliestStart = allowedStartSlot;

        for (const pid of (inst.task.prerequisites || [])) {
          const prereqs = instancesByTask.get(pid) || [];
          const sameDay = prereqs.find(x => x.dayIndex === dayIndex);
          if (sameDay) {
            const info = scheduledInstanceInfo.get(sameDay.instanceId);
            if (!info) {
              earliestStart = Infinity;
              break;
            }
            if (info.endSlotExclusive > earliestStart)
              earliestStart = info.endSlotExclusive;
          }
        }

        if (earliestStart === Infinity) {
          unscheduled.push({ instanceId, taskId, dayIndex, reason: 'prerequisite instance unscheduled' });
          continue;
        }

        const maxStart = allowedEndSlot - units;
        if (earliestStart > maxStart) {
          unscheduled.push({ instanceId, taskId, dayIndex, reason: 'no feasible start' });
          continue;
        }

        let placed = false;
        for (let s = earliestStart; s <= maxStart; s++) {
          const dayOfS = Math.floor(s / SLOTS_PER_DAY);
          if (dayOfS !== dayIndex) continue;
          if (canPlace(s, units)) {
            place(s, units, taskId);
            scheduledInstanceInfo.set(instanceId, { startSlot: s, endSlotExclusive: s + units, taskId, dayIndex });
            placed = true;
            break;
          }
        }

        if (!placed) unscheduled.push({ instanceId, taskId, dayIndex, reason: 'no contiguous block' });
      }
    }

    return res.json({
      success: true,
      schedule,
      unscheduled
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'internal server error' });
  }
});

// Fallback
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scheduler API running on port ${PORT}`));
